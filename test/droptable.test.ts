/** Тесты DROP TABLE (Database.dropTable): удаление таблицы, её индексов и
 *  файлов с диска; durability (после переоткрытия таблицы нет); свобода имени. */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Database } from "../src/database.ts";
import { execute } from "../src/sql/executor.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

function threw(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// --- базовое удаление таблицы и её файлов ----------------------------------
{
  section("DROP TABLE: удаляет таблицу, индекс и файлы с диска");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT)");
  execute(db, "CREATE INDEX ix_city ON users (city)");
  execute(db, "INSERT INTO users VALUES (1,'Алиса','MSK'),(2,'Боб','SPB')");
  execute(db, "CREATE TABLE orders (id INTEGER PRIMARY KEY, amount INTEGER)");
  execute(db, "INSERT INTO orders VALUES (10,100)");

  const tblFile = join(dir, "users.tbl");
  const idxFile = join(dir, "users__city.idx");
  check(existsSync(tblFile), "файл users.tbl существует до удаления");
  check(existsSync(idxFile), "файл индекса users__city.idx существует до удаления");

  db.dropTable("users");

  check(!db.hasTable("users"), "hasTable('users') = false после удаления");
  check(db.tableNames().indexOf("users") === -1, "tableNames больше не содержит users");
  check(!existsSync(tblFile), "файл users.tbl стёрт с диска");
  check(!existsSync(idxFile), "файл индекса users__city.idx стёрт с диска");

  // другая таблица не пострадала
  check(db.hasTable("orders"), "таблица orders на месте");
  checkEqual(db.table("orders").count, 1, "данные orders целы");

  db.close();
}

// --- durability: после переоткрытия удалённой таблицы нет ------------------
{
  section("DROP TABLE durable: после переоткрытия базы таблицы нет");
  const dir = tmpDir();
  let db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  execute(db, "INSERT INTO t VALUES (1,'a')");
  db.dropTable("t");
  db.close();

  db = new Database(dir); // переоткрываем с диска
  check(!db.hasTable("t"), "после реоткрытия таблицы t нет (tombstone в каталоге)");
  db.close();
}

// --- имя освобождается: можно создать таблицу заново -----------------------
{
  section("DROP TABLE освобождает имя — можно создать таблицу заново");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  execute(db, "INSERT INTO t VALUES (1,'старая')");
  db.dropTable("t");

  // новая таблица с тем же именем, но другой схемой
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, n INTEGER)");
  execute(db, "INSERT INTO t VALUES (1,'новая',7)");
  const t = db.table("t");
  checkEqual(t.count, 1, "новая таблица t содержит 1 строку");
  checkEqual(t.schema.columns.length, 3, "у новой таблицы t 3 колонки");
  checkEqual(t.get(1)!["note"] as string, "новая", "данные новой таблицы читаются");

  db.close();
}

// --- ошибки ----------------------------------------------------------------
{
  section("DROP TABLE: ошибки");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY)");

  check(threw(() => db.dropTable("nope")), "удаление несуществующей таблицы бросает");
  db.begin();
  check(threw(() => db.dropTable("t")), "DROP внутри транзакции запрещён");
  db.rollback();

  db.close();
}
