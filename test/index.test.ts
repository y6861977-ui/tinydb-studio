/** Тесты вторичных индексов (этап 7). */

import { rmSync } from "node:fs";

import { Database } from "../src/database.ts";
import { execute } from "../src/sql/executor.ts";
import type { Row } from "../src/types.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

function sel(db: Database, sql: string) {
  const r = execute(db, sql);
  if (r.kind !== "selected") throw new Error("ожидался SELECT");
  return r;
}

// --- индекс на уровне движка (Table) -------------------------------------
{
  section("Table: индекс отдаёт строки по значению колонки");
  const dir = tmpDir();
  const db = new Database(dir);
  const t = db.createTable({
    name: "people",
    primaryKey: "id",
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "city", type: "TEXT" },
    ],
  });
  t.insert({ id: 1, city: "MSK" });
  t.insert({ id: 2, city: "SPB" });
  t.insert({ id: 3, city: "MSK" });

  db.createIndex("city_idx", "people", "city");
  check(t.hasIndex("city"), "индекс на city создан");
  checkEqual(t.getByIndex("city", "MSK").map((r) => r.id).join(","), "1,3", "backfill: индекс нашёл существующие строки");
  checkEqual(t.getByIndex("city", "SPB").map((r) => r.id).join(","), "2", "второе значение");
  checkEqual(t.getByIndex("city", "KZN").length, 0, "отсутствующее значение -> пусто");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- индекс поддерживается при insert/delete ------------------------------
{
  section("индекс обновляется при insert и delete");
  const dir = tmpDir();
  const db = new Database(dir);
  const t = db.createTable({
    name: "t",
    primaryKey: "id",
    columns: [{ name: "id", type: "INTEGER" }, { name: "g", type: "INTEGER" }],
  });
  db.createIndex("g_idx", "t", "g");

  t.insert({ id: 1, g: 100 });
  t.insert({ id: 2, g: 100 });
  t.insert({ id: 3, g: 200 });
  checkEqual(t.getByIndex("g", 100).map((r) => r.id).join(","), "1,2", "insert после создания индекса виден");

  t.delete(1);
  checkEqual(t.getByIndex("g", 100).map((r) => r.id).join(","), "2", "delete убрал PK из индекса");
  t.delete(2);
  checkEqual(t.getByIndex("g", 100).length, 0, "пустое значение выпадает из индекса");
  checkEqual(t.getByIndex("g", 200).map((r) => r.id).join(","), "3", "другое значение не задето");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- планировщик реально использует индекс (мало просмотренных строк) -----
{
  section("SELECT использует индекс вместо полного скана");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE u (id INTEGER PRIMARY KEY, city TEXT, age INTEGER)");
  // 1000 строк, из них только 3 в KZN
  for (let i = 1; i <= 1000; i++) {
    const city = i <= 3 ? "KZN" : i % 2 === 0 ? "MSK" : "SPB";
    execute(db, `INSERT INTO u VALUES (${i}, '${city}', ${20 + (i % 40)})`);
  }

  // без индекса — полный скан
  const before = sel(db, "SELECT id FROM u WHERE city = 'KZN'");
  checkEqual(before.usedIndex, null, "до индекса — полный скан");
  checkEqual(before.scanned, 1000, "просмотрены все 1000 строк");
  checkEqual(before.rows.map((r) => r.id).join(","), "1,2,3", "результат верный и без индекса");

  // создаём индекс и повторяем
  execute(db, "CREATE INDEX city_idx ON u (city)");
  const after = sel(db, "SELECT id FROM u WHERE city = 'KZN'");
  checkEqual(after.usedIndex, "city", "после индекса — путь через индекс");
  checkEqual(after.scanned, 3, "просмотрены только 3 совпавшие строки, а не 1000");
  checkEqual(after.rows.map((r) => r.id).join(","), "1,2,3", "результат идентичен скановому");

  // PK-равенство идёт по первичному ключу
  const pk = sel(db, "SELECT * FROM u WHERE id = 500");
  checkEqual(pk.usedIndex, "PRIMARY", "WHERE по PK -> точечный доступ PRIMARY");
  checkEqual(pk.scanned, 1, "по PK просмотрена одна строка");

  // не-равенство всё ещё скан
  const range = sel(db, "SELECT id FROM u WHERE age > 50");
  checkEqual(range.usedIndex, null, "неравенство (>) идёт сканом");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- durability: индекс переживает перезапуск ----------------------------
{
  section("индекс переживает перезапуск (переоткрытие директории)");
  const dir = tmpDir();

  const db1 = new Database(dir);
  execute(db1, "CREATE TABLE u (id INTEGER PRIMARY KEY, city TEXT)");
  execute(db1, "INSERT INTO u VALUES (1,'MSK'),(2,'SPB'),(3,'MSK'),(4,'MSK')");
  execute(db1, "CREATE INDEX ci ON u (city)");
  db1.close();

  const db2 = new Database(dir); // перезапуск: индекс подключается из indexes.log
  check(db2.table("u").hasIndex("city"), "индекс восстановлен после перезапуска");
  const r = sel(db2, "SELECT id FROM u WHERE city = 'MSK'");
  checkEqual(r.usedIndex, "city", "и продолжает использоваться");
  checkEqual(r.rows.map((x) => x.id).join(","), "1,3,4", "данные из индекса верны");

  // новая вставка после перезапуска попадает в индекс
  execute(db2, "INSERT INTO u VALUES (5,'MSK')");
  checkEqual(sel(db2, "SELECT id FROM u WHERE city = 'MSK'").rows.map((x) => x.id).join(","), "1,3,4,5", "индекс обновляется и после перезапуска");

  db2.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- ошибки индексов -----------------------------------------------------
{
  section("ошибки индексов отвергаются");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE u (id INTEGER PRIMARY KEY, city TEXT)");
  execute(db, "CREATE INDEX ci ON u (city)");

  checkThrows(() => execute(db, "CREATE INDEX ci ON u (city)"), "повтор имени индекса");
  checkThrows(() => execute(db, "CREATE INDEX c2 ON u (city)"), "повторный индекс на той же колонке");
  checkThrows(() => execute(db, "CREATE INDEX c3 ON u (nope)"), "индекс на несуществующей колонке");
  checkThrows(() => execute(db, "CREATE INDEX c4 ON u (id)"), "индекс на PK не нужен");
  checkThrows(() => execute(db, "CREATE INDEX c5 ON missing (x)"), "индекс на несуществующей таблице");

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
