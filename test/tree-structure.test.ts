/** Тесты структурной карты B+-дерева (для визуализатора в Studio):
 *  декодирование ключей и корректность структуры (уровни, листья, next-цепочка). */

import { Database } from "../src/database.ts";
import { execute } from "../src/sql/executor.ts";
import { encodeValueKey, decodeValueKey } from "../src/row.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDir } from "./util.ts";

// --- декодирование ключа обратно в значение --------------------------------
{
  section("decodeValueKey обратен encodeValueKey");
  for (const n of [0, 1, -1, 42, -42, 1000000, -1000000, 2147483647, -2147483648]) {
    checkEqual(decodeValueKey("INTEGER", encodeValueKey("INTEGER", n)), n, `INTEGER ${n}`);
  }
  for (const s of ["", "abc", "Привет", "zzz"]) {
    checkEqual(decodeValueKey("TEXT", encodeValueKey("TEXT", s)), s, `TEXT ${JSON.stringify(s)}`);
  }
}

// --- структура дерева с несколькими уровнями --------------------------------
{
  section("Table.treeStructure: структура многоуровневого дерева");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const N = 300;
  for (let i = 1; i <= N; i++) execute(db, `INSERT INTO t VALUES (${i}, 'row${i}')`);

  const tv = db.table("t").treeStructure();
  checkEqual(tv.table, "t", "имя таблицы");
  checkEqual(tv.primaryKey, "id", "первичный ключ");
  checkEqual(tv.count, N, `count = ${N}`);
  check(tv.depth >= 2, "дерево имеет внутренние уровни (depth >= 2)");

  const leaves = tv.nodes.filter((n) => n.type === "leaf");
  const internals = tv.nodes.filter((n) => n.type === "internal");
  check(internals.length >= 1, "есть хотя бы один внутренний узел");
  check(leaves.length >= 2, "есть несколько листьев");

  const leafKeyCount = leaves.reduce((a, n) => a + n.keys.length, 0);
  checkEqual(leafKeyCount, N, "сумма ключей в листьях = число строк");

  // обход по next-цепочке от самого левого листа должен дать все ключи по порядку
  const byPage = new Map(tv.nodes.map((n) => [n.pageNo, n]));
  let node = byPage.get(tv.root)!;
  while (node.type === "internal") node = byPage.get(node.children![0]!)!;
  const ordered: number[] = [];
  let leaf: (typeof tv.nodes)[number] | undefined = node;
  while (leaf) {
    for (const k of leaf.keys) ordered.push(k as number);
    leaf = leaf.next && leaf.next !== 0 ? byPage.get(leaf.next) : undefined;
  }
  checkEqual(ordered.length, N, "обход по next-цепочке даёт все ключи");
  checkEqual(ordered[0], 1, "первый ключ = 1");
  checkEqual(ordered[ordered.length - 1], N, `последний ключ = ${N}`);
  let sorted = true;
  for (let i = 1; i < ordered.length; i++) if (ordered[i]! <= ordered[i - 1]!) sorted = false;
  check(sorted, "ключи по next-цепочке строго возрастают");

  let childrenValid = true;
  for (const n of internals) for (const c of n.children!) if (!byPage.has(c)) childrenValid = false;
  check(childrenValid, "все child-ссылки указывают на существующие узлы");

  db.close();
}

// --- маленькое дерево: только корень-лист -----------------------------------
{
  section("Table.treeStructure: маленькая таблица — корень-лист");
  const dir = tmpDir();
  const db = new Database(dir);
  execute(db, "CREATE TABLE s (id INTEGER PRIMARY KEY, name TEXT)");
  execute(db, "INSERT INTO s VALUES (3,'c'),(1,'a'),(2,'b')");

  const tv = db.table("s").treeStructure();
  checkEqual(tv.depth, 1, "высота = 1 (только корень-лист)");
  checkEqual(tv.nodes.length, 1, "один узел");
  checkEqual(tv.nodes[0]!.type, "leaf", "узел — лист");
  checkEqual(JSON.stringify(tv.nodes[0]!.keys), "[1,2,3]", "ключи листа отсортированы: 1,2,3");

  db.close();
}
