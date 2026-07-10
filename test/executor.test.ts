/** Тесты исполнения SQL (этап 6): AST выполняется на движке таблиц. */

import { rmSync } from "node:fs";

import { Database } from "../src/database.ts";
import { execute, executeProgram } from "../src/sql/executor.ts";
import type { Row } from "../src/types.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

/** SELECT и вернуть строки (упрощает проверки). */
function select(db: Database, sql: string): Row[] {
  const res = execute(db, sql);
  if (res.kind !== "selected") throw new Error("ожидался SELECT");
  return res.rows;
}

// --- CREATE + INSERT + SELECT (главный сценарий этапа 6) ------------------
{
  section("SQL end-to-end: CREATE, INSERT, SELECT");
  const dir = tmpDir();
  const db = new Database(dir);

  const created = execute(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
  checkEqual(created.kind, "created", "CREATE TABLE исполнен");
  check(db.hasTable("users"), "таблица реально создана в движке");

  execute(db, "INSERT INTO users (id, name, age) VALUES (1, 'Алиса', 30)");
  const ins = execute(db, "INSERT INTO users VALUES (2, 'Боб', 25), (3, 'Ева', 40)");
  checkEqual(ins.kind === "inserted" && ins.count, 2, "INSERT нескольких строк");

  // ключевая проверка из плана: SELECT ... WHERE id = 1 возвращает строку
  const one = select(db, "SELECT * FROM users WHERE id = 1");
  checkEqual(one.length, 1, "WHERE id = 1 вернул одну строку");
  checkEqual(JSON.stringify(one[0]), JSON.stringify({ id: 1, name: "Алиса", age: 30 }), "и это правильная строка");

  const all = select(db, "SELECT * FROM users");
  checkEqual(all.map((r) => r.id).join(","), "1,2,3", "SELECT * по возрастанию ключа");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- проекция колонок ----------------------------------------------------
{
  section("SQL: проекция колонок SELECT a, b");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
  execute(db, "INSERT INTO t VALUES (1, 'A', 10), (2, 'B', 20)");

  const rows = select(db, "SELECT name, age FROM t");
  checkEqual(JSON.stringify(rows[0]), JSON.stringify({ name: "A", age: 10 }), "вернулись только выбранные колонки");
  check(!("id" in rows[0]!), "невыбранная колонка id отсутствует");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- WHERE: операторы, AND/OR, не-ключевая колонка -----------------------
{
  section("SQL: фильтрация WHERE");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE p (id INTEGER PRIMARY KEY, city TEXT, age INTEGER)");
  execute(db, "INSERT INTO p VALUES (1,'MSK',30),(2,'SPB',17),(3,'MSK',40),(4,'KZN',25),(5,'MSK',15)");

  checkEqual(select(db, "SELECT id FROM p WHERE age >= 18").map((r) => r.id).join(","), "1,3,4", ">= по не-ключевой колонке");
  checkEqual(select(db, "SELECT id FROM p WHERE city = 'MSK'").map((r) => r.id).join(","), "1,3,5", "= по TEXT-колонке (скан)");
  checkEqual(
    select(db, "SELECT id FROM p WHERE city = 'MSK' AND age >= 18").map((r) => r.id).join(","),
    "1,3",
    "AND двух условий",
  );
  checkEqual(
    select(db, "SELECT id FROM p WHERE city = 'KZN' OR age > 35").map((r) => r.id).join(","),
    "3,4",
    "OR двух условий",
  );
  checkEqual(
    select(db, "SELECT id FROM p WHERE city = 'MSK' AND (age < 18 OR age > 35)").map((r) => r.id).join(","),
    "3,5",
    "скобки в WHERE меняют группировку",
  );
  checkEqual(select(db, "SELECT id FROM p WHERE id != 3").length, 4, "!= отбирает всё кроме одного");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- durability: SQL-данные переживают перезапуск ------------------------
{
  section("SQL: данные переживают перезапуск (переоткрытие директории)");
  const dir = tmpDir();

  const db1 = new Database(dir);
  executeProgram(
    db1,
    "CREATE TABLE k (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO k VALUES (1,'a'),(2,'b'),(3,'c');",
  );
  db1.close();

  const db2 = new Database(dir); // «перезапуск»
  check(db2.hasTable("k"), "таблица восстановлена из каталога");
  const rows = select(db2, "SELECT * FROM k WHERE id = 2");
  checkEqual(JSON.stringify(rows[0]), JSON.stringify({ id: 2, v: "b" }), "SELECT после перезапуска возвращает строку");
  db2.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- программа из нескольких инструкций одной строкой --------------------
{
  section("SQL: несколько инструкций через ';'");
  const dir = tmpDir();
  const db = new Database(dir);
  const results = executeProgram(
    db,
    "CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT); INSERT INTO t VALUES (1,'x'); SELECT * FROM t;",
  );
  checkEqual(results.length, 3, "исполнено 3 инструкции");
  checkEqual(results[2]!.kind, "selected", "последняя — SELECT");
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- семантические ошибки ------------------------------------------------
{
  section("SQL: семантические ошибки отвергаются");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

  checkThrows(() => execute(db, "SELECT * FROM missing"), "SELECT из несуществующей таблицы");
  checkThrows(() => execute(db, "INSERT INTO missing VALUES (1)"), "INSERT в несуществующую таблицу");
  checkThrows(() => execute(db, "SELECT nope FROM t"), "SELECT несуществующей колонки");
  checkThrows(() => execute(db, "SELECT * FROM t WHERE nope = 1"), "WHERE по несуществующей колонке");
  checkThrows(() => execute(db, "INSERT INTO t (id) VALUES (1, 'lishnee')"), "несовпадение числа значений");
  checkThrows(() => execute(db, "INSERT INTO t VALUES (1, 5)"), "TEXT-колонка не принимает число");
  checkThrows(() => execute(db, "SELECT * FROM t WHERE id = 'строка'"), "сравнение INTEGER со строкой");
  checkThrows(() => execute(db, "CREATE TABLE bad (a INTEGER, b TEXT)"), "CREATE без PRIMARY KEY");
  execute(db, "INSERT INTO t VALUES (1, 'A')");
  checkThrows(() => execute(db, "INSERT INTO t VALUES (1, 'B')"), "дубликат первичного ключа");

  db.close();
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
