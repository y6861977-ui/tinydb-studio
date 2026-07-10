/** Тесты таблиц/схемы/типов (этап 4). */

import { Database } from "../src/database.ts";
import { Table } from "../src/table.ts";
import { serializeRow, deserializeRow, encodeKey } from "../src/row.ts";
import type { TableSchema } from "../src/types.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

const usersSchema: TableSchema = {
  name: "users",
  primaryKey: "id",
  columns: [
    { name: "id", type: "INTEGER" },
    { name: "name", type: "TEXT" },
    { name: "age", type: "INTEGER" },
  ],
};

// --- сериализация строки (unit) -----------------------------------------
{
  section("сериализация строки в байты и обратно");
  const row = { id: 42, name: "Клод", age: 3 };
  const buf = serializeRow(usersSchema, row);
  const back = deserializeRow(usersSchema, buf);
  checkEqual(back.id, 42, "INTEGER id восстановлен");
  checkEqual(back.name, "Клод", "TEXT name восстановлен (UTF-8)");
  checkEqual(back.age, 3, "второй INTEGER восстановлен");
  // байтовая раскладка: 8 (id) + 4+8 (name='Клод'=8 байт utf8) + 8 (age)
  checkEqual(buf.length, 8 + 4 + 8 + 8, "длина сериализации соответствует типам");
}

// --- CREATE TABLE + INSERT + get ----------------------------------------
{
  section("CREATE TABLE, вставка и чтение типизированных строк");
  const dir = tmpDir();
  const db = new Database(dir);
  const users = db.createTable(usersSchema);

  users.insert({ id: 1, name: "Алиса", age: 30 });
  users.insert({ id: 2, name: "Боб", age: 25 });

  const a = users.get(1);
  check(a !== undefined && a.name === "Алиса" && a.age === 30, "строка читается по первичному ключу");
  checkEqual(users.get(99), undefined, "отсутствующий ключ -> undefined");
  checkEqual(users.count, 2, "count = 2");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- проверки типов -----------------------------------------------------
{
  section("схема отвергает неверные данные");
  const dir = tmpDir();
  const db = new Database(dir);
  const users = db.createTable(usersSchema);

  checkThrows(() => users.insert({ id: "нет", name: "X", age: 1 }), "INTEGER-колонка не принимает строку");
  checkThrows(() => users.insert({ id: 1, name: 5, age: 1 }), "TEXT-колонка не принимает число");
  checkThrows(() => users.insert({ id: 1, name: "X" }), "нельзя вставить строку без колонки");
  checkThrows(() => users.insert({ id: 1.5, name: "X", age: 1 }), "INTEGER не принимает дробное");
  checkThrows(() => users.insert({ id: 1, name: "X", age: 1, extra: 9 }), "лишняя колонка отвергается");

  users.insert({ id: 1, name: "A", age: 1 });
  checkThrows(() => users.insert({ id: 1, name: "B", age: 2 }), "дубликат первичного ключа отвергается");
  checkEqual(users.count, 1, "после отказов ровно одна строка");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- порядок INTEGER-ключей (order-preserving) --------------------------
{
  section("INTEGER первичный ключ упорядочивается численно (в т.ч. отрицательные)");
  const dir = tmpDir();
  const db = new Database(dir);
  const t = db.createTable({
    name: "nums",
    primaryKey: "n",
    columns: [{ name: "n", type: "INTEGER" }, { name: "label", type: "TEXT" }],
  });

  for (const n of [5, -3, 100, 0, -100, 42, -1]) t.insert({ n, label: `n=${n}` });
  const order = t.all().map((r) => r.n);
  checkEqual(order.join(","), "-100,-3,-1,0,5,42,100", "all() идёт по возрастанию числа, не байтов");

  // и лексикографический порядок закодированных ключей совпадает с числовым
  const encOrdered = [-100, -1, 0, 1, 100].map((n) =>
    encodeKey({ name: "nums", primaryKey: "n", columns: [{ name: "n", type: "INTEGER" }] }, n),
  );
  let sorted = true;
  for (let i = 1; i < encOrdered.length; i++) if (encOrdered[i - 1]! >= encOrdered[i]!) sorted = false;
  check(sorted, "закодированные INTEGER-ключи лексикографически растут");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- TEXT первичный ключ ------------------------------------------------
{
  section("TEXT первичный ключ");
  const dir = tmpDir();
  const db = new Database(dir);
  const t = db.createTable({
    name: "cities",
    primaryKey: "code",
    columns: [{ name: "code", type: "TEXT" }, { name: "pop", type: "INTEGER" }],
  });
  t.insert({ code: "MSK", pop: 13000000 });
  t.insert({ code: "SPB", pop: 5600000 });
  t.insert({ code: "KZN", pop: 1300000 });
  checkEqual(t.get("SPB")?.pop, 5600000, "чтение по TEXT-ключу");
  checkEqual(t.all().map((r) => r.code).join(","), "KZN,MSK,SPB", "порядок по TEXT-ключу");
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- durability каталога и данных ---------------------------------------
{
  section("таблицы и данные переживают перезапуск (переоткрытие директории)");
  const dir = tmpDir();

  const db1 = new Database(dir);
  const u = db1.createTable(usersSchema);
  for (let i = 1; i <= 100; i++) u.insert({ id: i, name: `user${i}`, age: 20 + (i % 50) });
  u.delete(7);
  db1.close();

  const db2 = new Database(dir); // перезапуск: схема из каталога, данные из дерева
  check(db2.hasTable("users"), "таблица восстановлена из каталога");
  checkEqual(db2.tableNames().join(","), "users", "список таблиц верный");
  const u2 = db2.table("users");
  checkEqual(u2.schema.columns.length, 3, "схема восстановлена (3 колонки)");
  checkEqual(u2.count, 99, "число строк восстановлено");
  checkEqual(u2.get(50)?.name, "user50", "строка читается после перезапуска");
  checkEqual(u2.get(7), undefined, "удалённая строка не воскресла");
  checkEqual(u2.all()[0]?.id, 1, "обход начинается с наименьшего id");
  db2.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- несколько таблиц независимы ----------------------------------------
{
  section("несколько таблиц в одной БД независимы");
  const dir = tmpDir();
  const db = new Database(dir);
  const a = db.createTable({ name: "a", primaryKey: "id", columns: [{ name: "id", type: "INTEGER" }] });
  const b = db.createTable({ name: "b", primaryKey: "id", columns: [{ name: "id", type: "INTEGER" }] });
  a.insert({ id: 1 });
  b.insert({ id: 2 });
  checkEqual(a.get(1)?.id, 1, "таблица a хранит своё");
  checkEqual(a.get(2), undefined, "данные b не протекают в a");
  checkEqual(b.get(2)?.id, 2, "таблица b хранит своё");
  checkThrows(() => db.createTable({ name: "a", primaryKey: "id", columns: [{ name: "id", type: "INTEGER" }] }), "повторный CREATE TABLE a отвергается");
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
