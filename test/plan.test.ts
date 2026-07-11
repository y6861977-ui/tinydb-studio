/** Тесты дерева плана выполнения (EXPLAIN-визуализатор): выбор пути доступа
 *  (скан / индекс / PK), фильтр, джойн, агрегаты; и что EXPLAIN не трогает данные. */

import { Database } from "../src/database.ts";
import { execute, explain } from "../src/sql/executor.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

function shop(): { db: Database } {
  const db = new Database(tmpDir());
  execute(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT)");
  execute(db, "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount INTEGER)");
  execute(db, "CREATE INDEX ix_city ON users (city)");
  execute(db, "INSERT INTO users VALUES (1,'A','MSK'),(2,'B','SPB'),(3,'C','MSK')");
  execute(db, "INSERT INTO orders VALUES (10,1,100),(11,1,200),(12,2,50),(13,3,300)");
  return { db };
}

{
  section("EXPLAIN: seq scan без WHERE");
  const { db } = shop();
  const p = explain(db, "SELECT id, name FROM users").plan!;
  checkEqual(p.op, "Projection", "корень = Projection");
  checkEqual(p.children![0]!.op, "Seq Scan", "под ним Seq Scan");
  checkEqual(p.children![0]!.access, "seq", "доступ = seq");
  db.close();
}

{
  section("EXPLAIN: WHERE по первичному ключу -> Index Seek");
  const { db } = shop();
  const seek = explain(db, "SELECT * FROM users WHERE id = 2").plan!.children![0]!;
  checkEqual(seek.op, "Index Seek", "Index Seek");
  checkEqual(seek.access, "index", "доступ = index");
  check(/PK/.test(seek.detail || ""), "в detail упомянут PK");
  db.close();
}

{
  section("EXPLAIN: WHERE по вторичному индексу -> Index Seek");
  const { db } = shop();
  const seek = explain(db, "SELECT * FROM users WHERE city = 'MSK'").plan!.children![0]!;
  checkEqual(seek.op, "Index Seek", "Index Seek по индексу city");
  check(/индекс|index/i.test(seek.detail || ""), "detail про индекс");
  db.close();
}

{
  section("EXPLAIN: WHERE по неиндексированной колонке -> Filter поверх Seq Scan");
  const { db } = shop();
  const filter = explain(db, "SELECT * FROM users WHERE name = 'A'").plan!.children![0]!;
  checkEqual(filter.op, "Filter", "Filter");
  checkEqual(filter.children![0]!.op, "Seq Scan", "под фильтром Seq Scan");
  db.close();
}

{
  section("EXPLAIN: JOIN -> узел джойна с двумя входами");
  const { db } = shop();
  const p = explain(db, "SELECT u.name, o.amount FROM users u JOIN orders o ON o.user_id = u.id").plan!;
  checkEqual(p.op, "Projection", "Projection");
  const join = p.children![0]!;
  check(/Join/.test(join.op), "узел джойна");
  checkEqual(join.children!.length, 2, "у джойна два входа");
  checkEqual(join.children![0]!.op, "Seq Scan", "левый вход = Seq Scan (ведущая users)");
  db.close();
}

{
  section("EXPLAIN: агрегаты -> Aggregate / Group Aggregate");
  const { db } = shop();
  checkEqual(explain(db, "SELECT COUNT(*) FROM orders").plan!.op, "Aggregate", "Aggregate без GROUP BY");
  checkEqual(
    explain(db, "SELECT user_id, SUM(amount) FROM orders GROUP BY user_id").plan!.op,
    "Group Aggregate",
    "Group Aggregate с GROUP BY",
  );
  db.close();
}

{
  section("EXPLAIN: не-SELECT отвергается и не имеет побочных эффектов");
  const { db } = shop();
  let threw = false;
  try {
    explain(db, "INSERT INTO orders VALUES (99,1,1)");
  } catch {
    threw = true;
  }
  check(threw, "INSERT через explain бросает");
  const r = execute(db, "SELECT COUNT(*) FROM orders");
  if (r.kind !== "selected") throw new Error("ожидался SELECT");
  checkEqual(r.rows[0]!["COUNT(*)"], 4, "в orders по-прежнему 4 строки (INSERT не выполнился)");
  db.close();
}
