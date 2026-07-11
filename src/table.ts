/**
 * Таблица (этап 4, + вторичные индексы на этапе 7) — типизированные строки
 * поверх B+-дерева.
 *
 * Данные: ключ = order-preserving кодировка первичного ключа, значение =
 * сериализованные байты строки. Доступ по PK — O(log n), обход all() — по
 * возрастанию PK.
 *
 * Вторичный индекс (этап 7): отдельное B+-дерево на колонку, отображающее
 * значение колонки -> список первичных ключей строк с этим значением
 * (индекс не уникален). WHERE col = X идёт через индекс за O(log n + k)
 * вместо полного скана. Индекс поддерживается в согласии при insert/delete.
 */

import { BTree } from "./btree.ts";
import type { PageTxn } from "./pager.ts";
import {
  type TableSchema,
  type Row,
  type Value,
  validateSchema,
  validateRow,
  checkValue,
  columnOf,
} from "./types.ts";
import {
  serializeRow,
  deserializeRow,
  encodeKey,
  encodeValueKey,
  decodeValueKey,
  rowToTreeValue,
  treeValueToBuf,
} from "./row.ts";

/** Узел дерева таблицы с декодированными ключами (для визуализации). */
export interface TableTreeNode {
  pageNo: number;
  type: "leaf" | "internal";
  keys: Value[];
  children?: number[];
  next?: number;
  bytes: number;
}

/** Структурная карта дерева таблицы (ключи = значения первичного ключа). */
export interface TableTreeView {
  table: string;
  primaryKey: string;
  root: number;
  depth: number;
  pageCount: number;
  count: number;
  pageSize: number;
  nodes: TableTreeNode[];
}

export class Table {
  readonly schema: TableSchema;
  private readonly tree: BTree;
  /** column -> B+-дерево индекса (значение колонки -> JSON-список PK). */
  private readonly indexes = new Map<string, BTree>();

  constructor(schema: TableSchema, treePath: string) {
    validateSchema(schema);
    this.schema = schema;
    this.tree = new BTree(treePath);
  }

  // --- строки -------------------------------------------------------------

  /** Вставить типизированную строку. Бросает при дубликате первичного ключа. */
  insert(row: Row): void {
    validateRow(this.schema, row);
    const pk = row[this.schema.primaryKey]!;
    const key = encodeKey(this.schema, pk);
    if (this.tree.has(key)) {
      throw new Error(`дубликат первичного ключа ${this.schema.primaryKey}=${JSON.stringify(pk)}`);
    }
    this.tree.set(key, rowToTreeValue(serializeRow(this.schema, row)));
    for (const [col, idx] of this.indexes) this.indexAdd(idx, col, row[col]!, pk);
  }

  /** Найти строку по значению первичного ключа. */
  get(pk: Value): Row | undefined {
    checkValue(columnOf(this.schema, this.schema.primaryKey), pk);
    const raw = this.tree.get(encodeKey(this.schema, pk));
    return raw === undefined ? undefined : deserializeRow(this.schema, treeValueToBuf(raw));
  }

  /** Удалить строку по первичному ключу. true, если существовала. */
  delete(pk: Value): boolean {
    const row = this.get(pk);
    if (row === undefined) return false;
    this.tree.delete(encodeKey(this.schema, pk));
    for (const [col, idx] of this.indexes) this.indexRemove(idx, col, row[col]!, pk);
    return true;
  }

  /** Все строки по возрастанию первичного ключа. */
  all(): Row[] {
    return this.tree.entries().map(([, v]) => deserializeRow(this.schema, treeValueToBuf(v)));
  }

  /** Число строк. */
  get count(): number {
    return this.tree.size;
  }

  /**
   * Структурная карта основного B+-дерева таблицы с ключами, декодированными
   * в значения первичного ключа (для визуализации в Studio).
   */
  treeStructure(): TableTreeView {
    const s = this.tree.structure();
    const pkType = columnOf(this.schema, this.schema.primaryKey).type;
    return {
      table: this.schema.name,
      primaryKey: this.schema.primaryKey,
      root: s.root,
      depth: s.depth,
      pageCount: s.pageCount,
      count: s.count,
      pageSize: s.pageSize,
      nodes: s.nodes.map((n) => ({
        pageNo: n.pageNo,
        type: n.type,
        keys: n.keys.map((k) => decodeValueKey(pkType, k)),
        children: n.children,
        next: n.next,
        bytes: n.bytes,
      })),
    };
  }

  // --- вторичные индексы --------------------------------------------------

  hasIndex(column: string): boolean {
    return this.indexes.has(column);
  }

  indexedColumns(): string[] {
    return [...this.indexes.keys()];
  }

  /** Создать индекс на колонку и наполнить его из уже существующих строк. */
  createIndex(column: string, indexPath: string): void {
    columnOf(this.schema, column); // проверка, что колонка есть
    if (column === this.schema.primaryKey) {
      throw new Error(`колонка ${column} уже первичный ключ — индекс не нужен`);
    }
    if (this.indexes.has(column)) throw new Error(`индекс на ${column} уже есть`);
    const idx = new BTree(indexPath);
    this.indexes.set(column, idx);
    // backfill: пройти по существующим строкам
    for (const row of this.all()) {
      this.indexAdd(idx, column, row[column]!, row[this.schema.primaryKey]!);
    }
  }

  /** Подключить уже существующий на диске индекс (при переоткрытии БД). */
  attachIndex(column: string, indexPath: string): void {
    columnOf(this.schema, column);
    this.indexes.set(column, new BTree(indexPath));
  }

  /** Найти строки по значению индексированной колонки (WHERE col = value). */
  getByIndex(column: string, value: Value): Row[] {
    const idx = this.indexes.get(column);
    if (!idx) throw new Error(`нет индекса на колонке ${column}`);
    const col = columnOf(this.schema, column);
    checkValue(col, value);
    const raw = idx.get(encodeValueKey(col.type, value));
    if (raw === undefined) return [];
    const pks = JSON.parse(raw) as Value[];
    const rows = pks.map((pk) => this.get(pk)).filter((r): r is Row => r !== undefined);
    // возвращаем по возрастанию PK — как и полный скан, для предсказуемости
    rows.sort((a, b) => comparePk(a[this.schema.primaryKey]!, b[this.schema.primaryKey]!));
    return rows;
  }

  /** Подключить транзакцию ко всем деревьям таблицы (основному и индексам). */
  attachTxn(txn: PageTxn): void {
    this.tree.attachTxn(txn);
    for (const idx of this.indexes.values()) idx.attachTxn(txn);
  }

  /** Отключить транзакцию ото всех деревьев. */
  detachTxn(): void {
    this.tree.detachTxn();
    for (const idx of this.indexes.values()) idx.detachTxn();
  }

  close(): void {
    this.tree.close();
    for (const idx of this.indexes.values()) idx.close();
  }

  // --- служебное: правка записи индекса -----------------------------------

  private indexAdd(idx: BTree, column: string, colValue: Value, pk: Value): void {
    const type = columnOf(this.schema, column).type;
    const k = encodeValueKey(type, colValue);
    const cur = idx.get(k);
    const list: Value[] = cur ? (JSON.parse(cur) as Value[]) : [];
    list.push(pk);
    idx.set(k, JSON.stringify(list));
  }

  private indexRemove(idx: BTree, column: string, colValue: Value, pk: Value): void {
    const type = columnOf(this.schema, column).type;
    const k = encodeValueKey(type, colValue);
    const cur = idx.get(k);
    if (cur === undefined) return;
    const list = (JSON.parse(cur) as Value[]).filter((x) => x !== pk);
    if (list.length === 0) idx.delete(k);
    else idx.set(k, JSON.stringify(list));
  }
}

function comparePk(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return a < b ? -1 : a > b ? 1 : 0;
}
