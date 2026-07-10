/** Тесты джойнов, агрегатов и планировщика (этап 10). */

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
function rows(db: Database, sql: string): Row[] {
  return sel(db, sql).rows;
}

function shop(): { dir: string; db: Database } {
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT)");
  execute(db, "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount INTEGER)");
  execute(db, "INSERT INTO users VALUES (1,'Алиса','MSK'),(2,'Боб','SPB'),(3,'Ева','MSK')");
  execute(db, "INSERT INTO orders VALUES (10,1,100),(11,1,200),(12,2,50),(13,3,300),(14,1,70)");
  return { dir, db };
}

// --- агрегаты без группировки --------------------------------------------
{
  section("агрегаты: COUNT / SUM / MIN / MAX / AVG по всей таблице");
  const { dir, db } = shop();

  checkEqual(rows(db, "SELECT COUNT(*) FROM orders")[0]!["COUNT(*)"], 5, "COUNT(*) = 5");
  checkEqual(rows(db, "SELECT SUM(amount) FROM orders")[0]!["SUM(amount)"], 720, "SUM(amount) = 720");
  checkEqual(rows(db, "SELECT MIN(amount) FROM orders")[0]!["MIN(amount)"], 50, "MIN = 50");
  checkEqual(rows(db, "SELECT MAX(amount) FROM orders")[0]!["MAX(amount)"], 300, "MAX = 300");
  checkEqual(rows(db, "SELECT AVG(amount) FROM orders")[0]!["AVG(amount)"], 144, "AVG = 720/5 = 144");
  checkEqual(rows(db, "SELECT MIN(name) FROM users")[0]!["MIN(name)"], "Алиса", "MIN по TEXT");

  // с WHERE
  checkEqual(rows(db, "SELECT COUNT(*) FROM orders WHERE amount >= 100")[0]!["COUNT(*)"], 3, "COUNT с WHERE");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- GROUP BY ------------------------------------------------------------
{
  section("GROUP BY: агрегаты по группам");
  const { dir, db } = shop();

  // сумма заказов по пользователю
  const byUser = rows(db, "SELECT user_id, SUM(amount) FROM orders GROUP BY user_id");
  const map = new Map(byUser.map((r) => [r.user_id, r["SUM(amount)"]]));
  checkEqual(map.get(1), 370, "user 1: 100+200+70 = 370");
  checkEqual(map.get(2), 50, "user 2: 50");
  checkEqual(map.get(3), 300, "user 3: 300");
  checkEqual(byUser.length, 3, "три группы");

  // COUNT по группам + группировка по TEXT
  const byCity = rows(db, "SELECT city, COUNT(*) FROM users GROUP BY city");
  const cmap = new Map(byCity.map((r) => [r.city, r["COUNT(*)"]]));
  checkEqual(cmap.get("MSK"), 2, "MSK: 2 пользователя");
  checkEqual(cmap.get("SPB"), 1, "SPB: 1 пользователь");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- INNER JOIN ----------------------------------------------------------
{
  section("JOIN: соединение двух таблиц по ключу");
  const { dir, db } = shop();

  const joined = rows(db, "SELECT users.name, orders.amount FROM users JOIN orders ON users.id = orders.user_id");
  checkEqual(joined.length, 5, "5 строк (по числу заказов)");
  // сумма amount по имени
  const total = new Map<string, number>();
  for (const r of joined) {
    const n = r["users.name"] as string;
    total.set(n, (total.get(n) ?? 0) + (r["orders.amount"] as number));
  }
  checkEqual(total.get("Алиса"), 370, "join связал заказы Алисы");
  checkEqual(total.get("Боб"), 50, "join связал заказ Боба");

  // join + WHERE по квалифицированной колонке
  const msk = rows(db, "SELECT users.name, orders.amount FROM users JOIN orders ON users.id = orders.user_id WHERE users.city = 'MSK'");
  checkEqual(msk.length, 4, "заказы пользователей из MSK (Алиса 3 + Ева 1)");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- JOIN с алиасами -----------------------------------------------------
{
  section("JOIN с алиасами таблиц");
  const { dir, db } = shop();
  const r = rows(db, "SELECT u.name, o.amount FROM users AS u JOIN orders o ON u.id = o.user_id WHERE o.amount > 150");
  checkEqual(r.length, 2, "заказы > 150: 200 и 300");
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- JOIN + GROUP BY + агрегат (комбинация) ------------------------------
{
  section("JOIN + GROUP BY + SUM");
  const { dir, db } = shop();
  const r = rows(db, "SELECT users.city, SUM(orders.amount) FROM users JOIN orders ON users.id = orders.user_id GROUP BY users.city");
  const m = new Map(r.map((x) => [x["users.city"], x["SUM(orders.amount)"]]));
  checkEqual(m.get("MSK"), 670, "MSK: Алиса 370 + Ева 300 = 670");
  checkEqual(m.get("SPB"), 50, "SPB: Боб 50");
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- планировщик: join использует PK/индекс ------------------------------
{
  section("планировщик: JOIN по первичному ключу — index nested loop");
  const { dir, db } = shop();
  // users.id — PK, поэтому join orders->users идёт точечным доступом
  const r = sel(db, "SELECT u.name, o.amount FROM orders o JOIN users u ON o.user_id = u.id");
  check(r.usedIndex !== null && r.usedIndex.includes("PK"), `join по PK помечен как PK-доступ (${r.usedIndex})`);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- ошибки --------------------------------------------------------------
{
  section("ошибки джойнов/агрегатов");
  const { dir, db } = shop();

  checkThrows(() => execute(db, "SELECT name, SUM(amount) FROM orders"), "колонка вне GROUP BY при агрегате");
  checkThrows(() => execute(db, "SELECT SUM(name) FROM users"), "SUM по TEXT-колонке");
  checkThrows(() => execute(db, "SELECT * FROM users JOIN orders ON users.id = orders.nope"), "нет колонки в ON");
  checkThrows(() => execute(db, "SELECT id FROM users JOIN orders ON users.id = orders.user_id"), "неоднозначная колонка id без квалификатора");
  checkThrows(() => execute(db, "SELECT COUNT(*), name FROM users"), "смешение агрегата и колонки без GROUP BY");

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
