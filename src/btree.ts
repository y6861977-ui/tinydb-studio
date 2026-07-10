/**
 * B+-дерево на диске (этап 3).
 *
 * Хранит пары ключ→значение в страницах через Pager. Поиск, вставка и
 * удаление идут за O(log n): спускаемся от корня к листу, читая лишь несколько
 * страниц по пути, — весь датасет в память не загружаем.
 *
 * Что реализовано:
 *   - get / has / set (со split-ом узлов и ростом дерева вверх)
 *   - delete (без слияния узлов — см. «граница» в README/ответе)
 *   - keys / entries — упорядоченный обход по связанным листьям
 *   - persistence: после переоткрытия файла всё на месте
 *
 * Ключи сравниваются как строки (порядок кодовых единиц UTF-16).
 */

import { Pager, PAGE_SIZE, type PageTxn } from "./pager.ts";
import {
  type Node,
  type LeafNode,
  type InternalNode,
  parse,
  serialize,
  fits,
  nodeSize,
} from "./node.ts";

/** Результат вставки, если узел разделился: ключ-разделитель и правая страница. */
interface Split {
  sepKey: string;
  rightPageNo: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class BTree {
  private readonly pager: Pager;

  constructor(path: string) {
    this.pager = new Pager(path);
    if (this.pager.root === 0) {
      // дерева ещё нет — создаём пустой корневой лист
      const root = this.pager.allocatePage();
      this.writeNode({ type: "leaf", pageNo: root, keys: [], values: [], next: 0 });
      this.pager.root = root;
      this.pager.saveMeta();
      this.pager.flush();
    }
  }

  // --- чтение -------------------------------------------------------------

  private loadNode(pageNo: number): Node {
    return parse(pageNo, this.pager.readPage(pageNo));
  }

  private writeNode(node: Node): void {
    this.pager.writePage(node.pageNo, serialize(node));
  }

  /** Прочитать значение по ключу; undefined, если ключа нет. */
  get(key: string): string | undefined {
    let node = this.loadNode(this.pager.root);
    while (node.type === "internal") {
      node = this.loadNode(node.children[childIndex(node, key)]!);
    }
    const i = leafFind(node, key);
    return i === -1 ? undefined : node.values[i];
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get size(): number {
    return this.pager.count;
  }

  get pageCount(): number {
    return this.pager.pageCount;
  }

  get path(): string {
    return this.pager.path;
  }

  // --- вставка ------------------------------------------------------------

  /** Записать/перезаписать значение по ключу. */
  set(key: string, value: string): void {
    // одна запись обязана влезать в страницу, иначе разделить лист невозможно
    const entry = 7 + 2 + Buffer.byteLength(key, "utf8") + 4 + Buffer.byteLength(value, "utf8");
    if (entry > PAGE_SIZE) {
      throw new Error(`пара ключ+значение слишком большая: ${entry}B > ${PAGE_SIZE}B страница`);
    }
    const existed = this.has(key);
    const split = this.insertInto(this.pager.root, key, value);

    if (split) {
      // корень разделился — создаём новый корень на уровень выше
      const newRoot = this.pager.allocatePage();
      const node: InternalNode = {
        type: "internal",
        pageNo: newRoot,
        keys: [split.sepKey],
        children: [this.pager.root, split.rightPageNo],
      };
      this.writeNode(node);
      this.pager.root = newRoot;
    }

    if (!existed) this.pager.count++;
    this.pager.saveMeta();
    this.pager.flush(); // durability: изменения на диске до возврата
  }

  private insertInto(pageNo: number, key: string, value: string): Split | null {
    const node = this.loadNode(pageNo);

    if (node.type === "leaf") {
      upsertLeaf(node, key, value);
      if (fits(node)) {
        this.writeNode(node);
        return null;
      }
      return this.splitLeaf(node);
    }

    // внутренний узел: спускаемся в нужного ребёнка
    const ci = childIndex(node, key);
    const childSplit = this.insertInto(node.children[ci]!, key, value);
    if (!childSplit) return null;

    // ребёнок разделился — вставляем разделитель и новую ссылку
    node.keys.splice(ci, 0, childSplit.sepKey);
    node.children.splice(ci + 1, 0, childSplit.rightPageNo);
    if (fits(node)) {
      this.writeNode(node);
      return null;
    }
    return this.splitInternal(node);
  }

  private splitLeaf(node: LeafNode): Split {
    const mid = node.keys.length >> 1;
    const rightPageNo = this.pager.allocatePage();

    const right: LeafNode = {
      type: "leaf",
      pageNo: rightPageNo,
      keys: node.keys.splice(mid),
      values: node.values.splice(mid),
      next: node.next,
    };
    node.next = rightPageNo; // связываем листья для обхода

    this.writeNode(node);
    this.writeNode(right);
    // в B+-дереве разделитель = первый ключ правого листа (сам ключ остаётся в листе)
    return { sepKey: right.keys[0]!, rightPageNo };
  }

  private splitInternal(node: InternalNode): Split {
    const mid = node.keys.length >> 1;
    const sepKey = node.keys[mid]!; // средний ключ уходит наверх, в узлах его нет
    const rightPageNo = this.pager.allocatePage();

    const right: InternalNode = {
      type: "internal",
      pageNo: rightPageNo,
      keys: node.keys.slice(mid + 1),
      children: node.children.slice(mid + 1),
    };
    node.keys = node.keys.slice(0, mid);
    node.children = node.children.slice(0, mid + 1);

    this.writeNode(node);
    this.writeNode(right);
    return { sepKey, rightPageNo };
  }

  // --- удаление (без слияния/перебалансировки) ----------------------------

  /**
   * Удалить ключ. Возвращает true, если ключ существовал.
   * Узлы не сливаются: дерево может остаться неплотным, но поиск корректен —
   * разделители лишь маршрутизируют, отсутствие ключа в листе даёт undefined.
   */
  delete(key: string): boolean {
    let node = this.loadNode(this.pager.root);
    while (node.type === "internal") {
      node = this.loadNode(node.children[childIndex(node, key)]!);
    }
    const i = leafFind(node, key);
    if (i === -1) return false;

    node.keys.splice(i, 1);
    node.values.splice(i, 1);
    this.writeNode(node);
    this.pager.count--;
    this.pager.saveMeta();
    this.pager.flush();
    return true;
  }

  // --- упорядоченный обход ------------------------------------------------

  private leftmostLeaf(): LeafNode {
    let node = this.loadNode(this.pager.root);
    while (node.type === "internal") node = this.loadNode(node.children[0]!);
    return node;
  }

  /** Все пары ключ→значение по возрастанию ключа. */
  entries(): [string, string][] {
    const out: [string, string][] = [];
    let leaf: LeafNode | null = this.leftmostLeaf();
    while (leaf) {
      for (let i = 0; i < leaf.keys.length; i++) out.push([leaf.keys[i]!, leaf.values[i]!]);
      leaf = leaf.next === 0 ? null : (this.loadNode(leaf.next) as LeafNode);
    }
    return out;
  }

  /** Все ключи по возрастанию. */
  keys(): string[] {
    return this.entries().map(([k]) => k);
  }

  /** Диапазонный скан [start, end) по возрастанию (границы включительно/нет). */
  range(start?: string, end?: string): [string, string][] {
    return this.entries().filter(
      ([k]) => (start === undefined || k >= start) && (end === undefined || k < end),
    );
  }

  // --- служебное ----------------------------------------------------------

  /** Высота дерева: 1 — только корень-лист. */
  depth(): number {
    let d = 1;
    let node = this.loadNode(this.pager.root);
    while (node.type === "internal") {
      node = this.loadNode(node.children[0]!);
      d++;
    }
    return d;
  }

  /** Текстовая карта дерева — для наглядной инспекции на диске. */
  dump(): string {
    const lines: string[] = [];
    const walk = (pageNo: number, indent: string): void => {
      const node = this.loadNode(pageNo);
      if (node.type === "leaf") {
        const preview = node.keys.map((k, i) => `${k}=${node.values[i]}`).join(", ");
        lines.push(
          `${indent}LEAF #${pageNo} (${node.keys.length} kv, ${nodeSize(node)}B, next=${node.next}) ${preview}`,
        );
        return;
      }
      lines.push(
        `${indent}INTERNAL #${pageNo} (${node.keys.length} keys) sep=[${node.keys.join(", ")}]`,
      );
      for (const c of node.children) walk(c, indent + "  ");
    };
    walk(this.pager.root, "");
    return [
      `файл: ${this.path}`,
      `страниц: ${this.pageCount}, ключей: ${this.size}, высота: ${this.depth()}, корень: #${this.pager.root}`,
      ...lines,
    ].join("\n");
  }

  flush(): void {
    this.pager.flush();
  }

  /** Подключить транзакцию (запись пойдёт в буфер, а не в файл). */
  attachTxn(txn: PageTxn): void {
    this.pager.attach(txn);
  }

  /** Отключить транзакцию. */
  detachTxn(): void {
    this.pager.detach();
  }

  close(): void {
    this.pager.close();
  }
}

// --- помощники поиска внутри узла --------------------------------------------

/** Индекс ребёнка во внутреннем узле для данного ключа. */
function childIndex(node: InternalNode, key: string): number {
  // идём вправо, пока key >= разделителя
  let i = 0;
  while (i < node.keys.length && cmp(key, node.keys[i]!) >= 0) i++;
  return i;
}

/** Точный поиск ключа в листе (бинарный). -1, если нет. */
function leafFind(node: LeafNode, key: string): number {
  let lo = 0;
  let hi = node.keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cmp(key, node.keys[mid]!);
    if (c === 0) return mid;
    if (c < 0) hi = mid - 1;
    else lo = mid + 1;
  }
  return -1;
}

/** Вставить/обновить пару в листе, сохраняя порядок ключей. */
function upsertLeaf(node: LeafNode, key: string, value: string): void {
  // lower bound: первый индекс, где keys[i] >= key
  let lo = 0;
  let hi = node.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(node.keys[mid]!, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  if (lo < node.keys.length && cmp(node.keys[lo]!, key) === 0) {
    node.values[lo] = value; // перезапись существующего
  } else {
    node.keys.splice(lo, 0, key);
    node.values.splice(lo, 0, value);
  }
}
