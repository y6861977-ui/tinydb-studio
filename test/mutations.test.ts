/** Тесты UPDATE и DELETE (доработка движка: полный CRUD в SQL). */

import { rmSync } from "node:fs";

import { Database } from "../src/database.ts";
import { execute } from "../src/sql/executor.ts";
import { parse } from "../src/sql/parser.ts";
import type { Delete, Update } from "../src/sql/ast.ts";
import type { Row } from "../src/types.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

function rows(db: Database, sql: string): Row[] {
  const r = execute(db, sql);
  if (r.kind !== "selected") throw new Error("ожидался SELECT");
  return r.rows;
}

function seed(): { dir: string; db: Database } {
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT, age INTEGER)");
  execute(db, "INSERT INTO users VALUES (1,'Алиса','MSK',30),(2,'Боб','SPB',25),(3,'Ева','MSK',40),(4,'Ян','KZN',17)");
  return { dir, db };
}

// --- парсинг -------------------------------------------------------------
{
  section("парсер: DELETE и UPDATE -> AST");
  const d = parse("DELETE FROM t WHERE id = 5") as Delete;
  checkEqual(d.type, "delete", "тип delete");
  checkEqual(d.table, "t", "таблица");
  check(d.where !== null, "WHERE разобран");

  const dAll = parse("DELETE FROM t") as Delete;
  checkEqual(dAll.where, null, "DELETE без WHERE -> where null");

  const u = parse("UPDATE t SET name = 'X', age = 5 WHERE id = 1") as Update;
  checkEqual(u.type, "update", "тип update");
  checkEqual(u.sets.length, 2, "два присваивания SET");
  checkEqual(JSON.stringify(u.sets[0]), JSON.stringify({ column: "name", value: { kind: "string", value: "X" } }), "первое SET");
}

// --- DELETE --------------------------------------------------------------
{
  section("DELETE: удаление по условию");
  const { dir, db } = seed();

  const res = execute(db, "DELETE FROM users WHERE city = 'MSK'");
  checkEqual(res.kind === "deleted" && res.count, 2, "удалено 2 строки (MSK)");
  checkEqual(rows(db, "SELECT id FROM users").map((r) => r.id).join(","), "2,4", "остались только не-MSK");

  execute(db, "DELETE FROM users WHERE id = 2");
  checkEqual(rows(db, "SELECT id FROM users").map((r) => r.id).join(","), "4", "удаление по PK");

  execute(db, "DELETE FROM users"); // без WHERE — все
  checkEqual(db.table("users").count, 0, "DELETE без WHERE очищает таблицу");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- UPDATE --------------------------------------------------------------
{
  section("UPDATE: изменение по условию");
  const { dir, db } = seed();

  const res = execute(db, "UPDATE users SET city = 'MSK', age = 18 WHERE id = 4");
  checkEqual(res.kind === "updated" && res.count, 1, "обновлена 1 строка");
  const y = db.table("users").get(4);
  check(y!.city === "MSK" && y!.age === 18, "значения изменились");
  checkEqual(y!.name, "Ян", "нетронутые колонки на месте");

  // массовое обновление
  execute(db, "UPDATE users SET city = 'RU'");
  checkEqual(rows(db, "SELECT id FROM users WHERE city = 'RU'").length, 4, "UPDATE без WHERE затронул все строки");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- UPDATE меняет первичный ключ ----------------------------------------
{
  section("UPDATE может менять первичный ключ");
  const { dir, db } = seed();
  execute(db, "UPDATE users SET id = 100 WHERE id = 1");
  checkEqual(db.table("users").get(1), undefined, "старого ключа больше нет");
  checkEqual(db.table("users").get(100)?.name, "Алиса", "строка доступна по новому ключу");
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- индекс согласован после UPDATE/DELETE -------------------------------
{
  section("вторичный индекс согласован после UPDATE и DELETE");
  const { dir, db } = seed();
  execute(db, "CREATE INDEX ci ON users (city)");

  // до: MSK -> {1,3}
  checkEqual(rows(db, "SELECT id FROM users WHERE city = 'MSK'").map((r) => r.id).join(","), "1,3", "индекс: MSK = 1,3");

  execute(db, "UPDATE users SET city = 'SPB' WHERE id = 1"); // 1 уходит из MSK в SPB
  checkEqual(rows(db, "SELECT id FROM users WHERE city = 'MSK'").map((r) => r.id).join(","), "3", "после UPDATE индекс MSK = 3");
  checkEqual(rows(db, "SELECT id FROM users WHERE city = 'SPB'").map((r) => r.id).join(","), "1,2", "после UPDATE индекс SPB = 1,2");

  execute(db, "DELETE FROM users WHERE id = 3"); // последний MSK
  checkEqual(rows(db, "SELECT id FROM users WHERE city = 'MSK'").length, 0, "после DELETE индекс MSK пуст");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- транзакционность: откат UPDATE/DELETE -------------------------------
{
  section("UPDATE/DELETE участвуют в транзакции (ROLLBACK отменяет)");
  const { dir, db } = seed();

  execute(db, "BEGIN");
  execute(db, "DELETE FROM users WHERE city = 'MSK'");
  execute(db, "UPDATE users SET age = 0");
  checkEqual(rows(db, "SELECT id FROM users").length, 2, "внутри транзакции удаление видно");
  execute(db, "ROLLBACK");

  checkEqual(rows(db, "SELECT id FROM users").length, 4, "после ROLLBACK все строки на месте");
  checkEqual(db.table("users").get(1)!.age, 30, "после ROLLBACK значения не изменены");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- ошибки --------------------------------------------------------------
{
  section("ошибки UPDATE/DELETE");
  const { dir, db } = seed();
  checkThrows(() => execute(db, "DELETE FROM missing WHERE id = 1"), "DELETE из несуществующей таблицы");
  checkThrows(() => execute(db, "UPDATE users SET nope = 1"), "UPDATE несуществующей колонки");
  checkThrows(() => execute(db, "UPDATE users SET age = 'x'"), "UPDATE с несовпадением типа");
  checkThrows(() => execute(db, "UPDATE users SET id = 2 WHERE id = 1"), "UPDATE PK в дубликат отвергается");
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
