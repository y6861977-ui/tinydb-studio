/**
 * Просмотр B+-дерева на страницах (движок этапа 3).
 * Печатает карту дерева: внутренние узлы, листья, размеры страниц, связи.
 *
 * Запуск:  npx tsx tools/inspect-tree.ts <файл>
 */

import { existsSync } from "node:fs";
import { BTree } from "../src/btree.ts";

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.error("usage: tsx tools/inspect-tree.ts <файл-дерева>");
  process.exit(1);
}

const t = new BTree(path);
// длинные значения в листьях подрезаем, чтобы карта читалась
console.log(
  t
    .dump()
    .split("\n")
    .map((l) => (l.length > 100 ? l.slice(0, 100) + " …" : l))
    .join("\n"),
);
t.close();
