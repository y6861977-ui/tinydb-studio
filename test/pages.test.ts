/** Тесты инспектора страниц (Table.pageMap) и WAL (inspectWal):
 *  мета-страница, узлы, заполнение; состояние журнала до/после checkpoint. */

import { join } from "node:path";

import { Database } from "../src/database.ts";
import { execute } from "../src/sql/executor.ts";
import { Transaction, inspectWal } from "../src/wal.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

const MAGIC = 0x54444231; // "TDB1"

// --- физическая карта страниц ----------------------------------------------
{
  section("Table.pageMap: мета-страница и узлы");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  for (let i = 1; i <= 300; i++) execute(db, `INSERT INTO t VALUES (${i}, 'row${i}')`);

  const pm = db.table("t").pageMap();
  checkEqual(pm.pageSize, 4096, "размер страницы 4096");
  checkEqual(pm.count, 300, "count = 300");
  checkEqual(pm.pages.length, pm.pageCount, "число страниц = pageCount");

  const meta = pm.pages[0]!;
  checkEqual(meta.kind, "meta", "страница 0 — мета");
  checkEqual(meta.meta!.magic, MAGIC, "сигнатура TDB1");
  checkEqual(meta.meta!.count, 300, "в мете count = 300");
  checkEqual(meta.meta!.root, pm.root, "root в мете совпадает");

  const nodes = pm.pages.slice(1);
  check(nodes.every((p) => p.kind === "leaf" || p.kind === "internal"), "остальные страницы — узлы");
  check(nodes.some((p) => p.kind === "internal"), "есть внутренние узлы");
  check(nodes.some((p) => p.kind === "leaf"), "есть листья");
  check(nodes.every((p) => p.bytes > 0 && p.bytes <= 4096), "заполнение узла в пределах страницы");

  const rootPage = pm.pages.find((p) => p.pageNo === pm.root)!;
  checkEqual(rootPage.isRoot, true, "корневая страница помечена isRoot");

  const leaf = nodes.find((p) => p.kind === "leaf")!;
  check(leaf.keys!.every((k) => typeof k === "number"), "ключи листа декодированы в числа");

  db.close();
}

// --- WAL: пусто после обычной работы (autocommit -> checkpoint) -------------
{
  section("inspectWal: после autocommit журнал пуст (checkpoint выполнен)");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  execute(db, "INSERT INTO t VALUES (1,'a')");
  const w = db.walInfo();
  checkEqual(w.exists, false, "wal.log отсутствует");
  checkEqual(w.frames.length, 0, "кадров нет");
  db.close();
}

// --- WAL: зафиксированная транзакция видна до checkpoint --------------------
{
  section("inspectWal: кадры и статус committed зафиксированной транзакции");
  const dir = tmpDir();
  const walPath = join(dir, "wal.log");
  // смоделируем persist() без checkpoint: WAL записан, но не применён
  const tx = new Transaction(walPath);
  tx.stage(join(dir, "users.tbl"), 5, Buffer.alloc(4096, 7));
  tx.stage(join(dir, "users.tbl"), 6, Buffer.alloc(4096, 9));
  tx.persist();

  const w = inspectWal(walPath);
  checkEqual(w.exists, true, "wal.log существует");
  checkEqual(w.committed, true, "транзакция зафиксирована (маркер COMMIT сходится)");
  checkEqual(w.frames.length, 2, "два кадра страниц");
  checkEqual(w.frames[0]!.file, "users.tbl", "имя файла в кадре — basename");
  check(w.frames.some((f) => f.pageNo === 5) && w.frames.some((f) => f.pageNo === 6), "номера страниц 5 и 6");
  checkEqual(w.frames[0]!.bytes, 4096, "размер образа страницы = 4096");
}
