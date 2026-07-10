/** Тесты транзакций и WAL (этап 8). */

import { writeFileSync, readFileSync, truncateSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Database } from "../src/database.ts";
import { execute } from "../src/sql/executor.ts";
import { Transaction, recover } from "../src/wal.ts";
import { PAGE_SIZE } from "../src/pager.ts";
import type { Row } from "../src/types.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

function sel(db: Database, sql: string): Row[] {
  const r = execute(db, sql);
  if (r.kind !== "selected") throw new Error("ожидался SELECT");
  return r.rows;
}

// --- COMMIT фиксирует, ROLLBACK отменяет ---------------------------------
{
  section("BEGIN/COMMIT/ROLLBACK: базовая семантика");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

  execute(db, "BEGIN");
  check(db.inTransaction, "после BEGIN транзакция открыта");
  execute(db, "INSERT INTO t VALUES (1, 'a')");
  checkEqual(sel(db, "SELECT id FROM t").length, 1, "read-your-writes: видим свою вставку до COMMIT");
  execute(db, "ROLLBACK");
  check(!db.inTransaction, "после ROLLBACK транзакция закрыта");
  checkEqual(sel(db, "SELECT id FROM t").length, 0, "ROLLBACK отменил вставку");
  checkEqual(db.table("t").count, 0, "count вернулся к 0 после отката");

  execute(db, "BEGIN");
  execute(db, "INSERT INTO t VALUES (2, 'b')");
  execute(db, "INSERT INTO t VALUES (3, 'c')");
  execute(db, "COMMIT");
  checkEqual(sel(db, "SELECT id FROM t").map((r) => r.id).join(","), "2,3", "COMMIT зафиксировал обе вставки");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- атомарность группы: ошибка в середине -> ничего не записано ----------
{
  section("атомарность: сбой внутри транзакции откатывает всю группу");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  execute(db, "INSERT INTO t VALUES (1, 'exists')");

  execute(db, "BEGIN");
  execute(db, "INSERT INTO t VALUES (2, 'ok')");
  let threw = false;
  try {
    execute(db, "INSERT INTO t VALUES (1, 'dup')"); // дубликат PK -> ошибка
  } catch {
    threw = true;
  }
  check(threw, "дубликат PK внутри транзакции бросает ошибку");
  execute(db, "ROLLBACK");
  checkEqual(sel(db, "SELECT id FROM t").map((r) => r.id).join(","), "1", "после отката осталась только исходная строка (2 не записалась)");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- транзакция согласованно откатывает и индекс -------------------------
{
  section("транзакция атомарна по всем файлам (данные + индекс)");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE u (id INTEGER PRIMARY KEY, city TEXT)");
  execute(db, "CREATE INDEX ci ON u (city)");
  execute(db, "INSERT INTO u VALUES (1, 'MSK')");

  execute(db, "BEGIN");
  execute(db, "INSERT INTO u VALUES (2, 'MSK')");
  const during = sel(db, "SELECT id FROM u WHERE city = 'MSK'"); // через индекс, видит буфер
  checkEqual(during.map((r) => r.id).join(","), "1,2", "внутри транзакции индекс видит новую строку");
  execute(db, "ROLLBACK");

  const after = execute(db, "SELECT id FROM u WHERE city = 'MSK'");
  if (after.kind !== "selected") throw new Error("select");
  checkEqual(after.rows.map((r) => r.id).join(","), "1", "после отката индекс тоже откатился (2 исчезла)");
  checkEqual(after.usedIndex, "city", "и индекс по-прежнему используется");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- durability: COMMIT переживает перезапуск ----------------------------
{
  section("durability: зафиксированная транзакция переживает перезапуск");
  const dir = tmpDir();
  const db1 = new Database(dir);
  execute(db1, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  execute(db1, "BEGIN");
  execute(db1, "INSERT INTO t VALUES (1,'x'),(2,'y')");
  execute(db1, "COMMIT");
  db1.close();

  const db2 = new Database(dir);
  checkEqual(sel(db2, "SELECT id FROM t").map((r) => r.id).join(","), "1,2", "данные на месте после перезапуска");
  check(!existsSync(join(dir, "wal.log")), "WAL очищен после успешного COMMIT");
  db2.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- незакрытая транзакция при close откатывается ------------------------
{
  section("незакрытая транзакция откатывается при закрытии БД");
  const dir = tmpDir();
  const db1 = new Database(dir);
  execute(db1, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
  execute(db1, "BEGIN");
  execute(db1, "INSERT INTO t VALUES (1)");
  db1.close(); // COMMIT не вызывали

  const db2 = new Database(dir);
  checkEqual(db2.table("t").count, 0, "незафиксированная вставка потеряна (как и должно быть)");
  db2.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- ошибки управления транзакциями --------------------------------------
{
  section("ошибки BEGIN/COMMIT/ROLLBACK и DDL в транзакции");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY)");

  checkThrows(() => execute(db, "COMMIT"), "COMMIT без BEGIN");
  checkThrows(() => execute(db, "ROLLBACK"), "ROLLBACK без BEGIN");
  execute(db, "BEGIN");
  checkThrows(() => execute(db, "BEGIN"), "вложенный BEGIN");
  checkThrows(() => execute(db, "CREATE TABLE x (id INTEGER PRIMARY KEY)"), "DDL внутри транзакции запрещён");
  execute(db, "ROLLBACK");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- WAL redo: восстановление после сбоя между persist и checkpoint -------
{
  section("WAL recover(): redo зафиксированной, но не применённой транзакции");
  const dir = tmpDir();
  const fileA = join(dir, "a.bin");
  const fileB = join(dir, "b.bin");
  // два файла по 3 страницы, забиты нулями
  writeFileSync(fileA, Buffer.alloc(3 * PAGE_SIZE));
  writeFileSync(fileB, Buffer.alloc(3 * PAGE_SIZE));

  const walPath = join(dir, "wal.log");
  const txn = new Transaction(walPath);
  const pageA = Buffer.alloc(PAGE_SIZE, 0xaa);
  const pageB = Buffer.alloc(PAGE_SIZE, 0xbb);
  txn.stage(fileA, 1, pageA);
  txn.stage(fileB, 2, pageB);
  txn.persist(); // WAL долговечен, но checkpoint НЕ вызван — имитируем сбой

  // файлы ещё не изменены
  check(readFileSync(fileA)[PAGE_SIZE] === 0x00, "до recover: файл A не изменён");
  check(existsSync(walPath), "WAL существует после сбоя");

  const redone = recover(walPath); // старт после сбоя
  check(redone, "recover сообщил, что транзакция была зафиксирована");
  check(readFileSync(fileA)[PAGE_SIZE] === 0xaa, "redo применил страницу к файлу A");
  check(readFileSync(fileB)[2 * PAGE_SIZE] === 0xbb, "redo применил страницу к файлу B");
  check(!existsSync(walPath), "WAL удалён после восстановления");

  rmSync(dir, { recursive: true, force: true });
}

// --- WAL без маркера COMMIT (оборван) не применяется ----------------------
{
  section("WAL recover(): оборванная (незакоммиченная) транзакция отбрасывается");
  const dir = tmpDir();
  const fileA = join(dir, "a.bin");
  writeFileSync(fileA, Buffer.alloc(2 * PAGE_SIZE));

  const walPath = join(dir, "wal.log");
  const txn = new Transaction(walPath);
  txn.stage(fileA, 1, Buffer.alloc(PAGE_SIZE, 0xcc));
  txn.persist();
  // «обрубаем» WAL — теряем маркер COMMIT в хвосте
  truncateSync(walPath, 10);

  const redone = recover(walPath);
  check(!redone, "оборванный WAL не считается зафиксированным");
  check(readFileSync(fileA)[PAGE_SIZE] === 0x00, "файл не изменён — торн-транзакция отброшена");
  check(!existsSync(walPath), "WAL всё равно очищен");

  rmSync(dir, { recursive: true, force: true });
}

function checkThrows(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(threw, message);
}
