/** Тесты конкурентности: блокировки таблиц, strict 2PL, изоляция (этап 9). */

import { rmSync } from "node:fs";

import { Database } from "../src/database.ts";
import { ConflictError } from "../src/locks.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

function setup(): { dir: string; db: Database } {
  const dir = tmpDir();
  const db = new Database(dir);
  db.createTable({
    name: "a",
    primaryKey: "id",
    columns: [{ name: "id", type: "INTEGER" }, { name: "v", type: "TEXT" }],
  });
  db.createTable({
    name: "b",
    primaryKey: "id",
    columns: [{ name: "id", type: "INTEGER" }, { name: "v", type: "TEXT" }],
  });
  return { dir, db };
}

// --- транзакции на РАЗНЫЕ таблицы идут параллельно ------------------------
{
  section("параллельные транзакции на разных таблицах не мешают");
  const { dir, db } = setup();

  const t1 = db.beginTransaction();
  const t2 = db.beginTransaction();
  t1.write("a").insert({ id: 1, v: "x" }); // X-блокировка на a
  t2.write("b").insert({ id: 1, v: "y" }); // X-блокировка на b — конфликта нет
  t1.commit();
  t2.commit();

  checkEqual(db.table("a").get(1)?.v, "x", "транзакция 1 записала a");
  checkEqual(db.table("b").get(1)?.v, "y", "транзакция 2 записала b параллельно");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- запись-запись на ОДНУ таблицу: конфликт -----------------------------
{
  section("две записи в одну таблицу конфликтуют (no-wait)");
  const { dir, db } = setup();

  const t1 = db.beginTransaction();
  const t2 = db.beginTransaction();
  t1.write("a").insert({ id: 1, v: "x" });

  let err: unknown;
  try {
    t2.write("a"); // X на a занята транзакцией 1
  } catch (e) {
    err = e;
  }
  check(err instanceof ConflictError, "вторая запись в ту же таблицу -> ConflictError");

  t1.commit();
  // после коммита t1 блокировка снята — теперь t2 может писать
  t2.write("a").insert({ id: 2, v: "y" });
  t2.commit();
  checkEqual(db.table("a").all().map((r) => r.id).join(","), "1,2", "после снятия блокировки запись прошла");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- чтение-запись на одну таблицу: конфликт ------------------------------
{
  section("читатель и писатель одной таблицы конфликтуют");
  const { dir, db } = setup();
  db.table("a").insert({ id: 1, v: "old" });

  const reader = db.beginTransaction();
  const writer = db.beginTransaction();
  reader.read("a"); // S-блокировка на a

  let err: unknown;
  try {
    writer.write("a"); // X несовместима с чужой S
  } catch (e) {
    err = e;
  }
  check(err instanceof ConflictError, "писатель при активном читателе -> ConflictError");
  reader.commit();
  writer.write("a").insert({ id: 2, v: "new" }); // теперь можно
  writer.commit();
  checkEqual(db.table("a").count, 2, "после коммита читателя запись прошла");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- несколько читателей одной таблицы совместимы ------------------------
{
  section("несколько читателей одной таблицы совместимы (S+S)");
  const { dir, db } = setup();
  db.table("a").insert({ id: 1, v: "shared" });

  const r1 = db.beginTransaction();
  const r2 = db.beginTransaction();
  const v1 = r1.read("a").get(1)?.v;
  const v2 = r2.read("a").get(1)?.v; // вторая S-блокировка — ок
  checkEqual(v1, "shared", "читатель 1 видит данные");
  checkEqual(v2, "shared", "читатель 2 читает ту же таблицу одновременно");
  r1.commit();
  r2.commit();

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- изоляция: чужие незафиксированные изменения не видны -----------------
{
  section("изоляция: незакоммиченные изменения не видны после отмены");
  const { dir, db } = setup();

  const writer = db.beginTransaction();
  writer.write("a").insert({ id: 1, v: "uncommitted" });
  checkEqual(writer.read("a").get(1)?.v, "uncommitted", "своя запись видна внутри транзакции");
  writer.rollback();

  // после отката отдельный читатель ничего не видит
  const reader = db.beginTransaction();
  checkEqual(reader.read("a").count, 0, "после rollback данных нет (никто не увидит отменённое)");
  reader.commit();

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- строгий 2PL: блокировки держатся до конца транзакции -----------------
{
  section("strict 2PL: блокировка держится до commit, а не до конца операции");
  const { dir, db } = setup();

  const t1 = db.beginTransaction();
  t1.write("a").insert({ id: 1, v: "x" });
  t1.read("a"); // повторное обращение своей же транзакции — ок (свои блокировки совместимы)

  const t2 = db.beginTransaction();
  let err: unknown;
  try {
    t2.read("a"); // t1 всё ещё держит X (не сняла после insert) -> конфликт
  } catch (e) {
    err = e;
  }
  check(err instanceof ConflictError, "блокировка держится между операциями, до commit");
  t1.commit();
  t2.read("a"); // теперь свободно
  t2.commit();

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- завершённой транзакцией пользоваться нельзя --------------------------
{
  section("после commit/rollback транзакция недоступна");
  const { dir, db } = setup();
  const t = db.beginTransaction();
  t.commit();
  checkThrows(() => t.read("a"), "чтение после commit запрещено");
  checkThrows(() => t.commit(), "повторный commit запрещён");

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
