/**
 * AST — структура, в которую парсер превращает строку SQL (этап 5).
 * Здесь только типы. Разбор — в parser.ts, исполнение — в executor.ts (этап 6).
 */

export type ColumnType = "INTEGER" | "TEXT";

/** Литеральное значение в SQL: число или строка. */
export type Literal =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string };

// --- CREATE TABLE ----------------------------------------------------------

export interface ColumnDef {
  name: string;
  dataType: ColumnType;
  primaryKey: boolean;
}

export interface CreateTable {
  type: "create_table";
  table: string;
  columns: ColumnDef[];
  /** Имя PK-колонки, если объявлена PRIMARY KEY; иначе null. */
  primaryKey: string | null;
}

/** CREATE INDEX name ON table (column) — вторичный индекс (этап 7). */
export interface CreateIndex {
  type: "create_index";
  name: string;
  table: string;
  column: string;
}

// --- INSERT ----------------------------------------------------------------

export interface Insert {
  type: "insert";
  table: string;
  /** Явный список колонок или null (значения по порядку схемы). */
  columns: string[] | null;
  /** Одна или несколько строк-кортежей значений. */
  rows: Literal[][];
}

// --- SELECT ----------------------------------------------------------------

export type CompareOp = "=" | "!=" | "<" | ">" | "<=" | ">=";

/** Ссылка на колонку, возможно с именем/алиасом таблицы: `col` или `t.col`. */
export interface ColumnRef {
  table: string | null;
  column: string;
}

/**
 * Сравнение колонки с литералом: `age >= 18` или `u.age >= 18`.
 * `table` опционально — при отсутствии квалификатора поля нет вовсе, поэтому
 * JSON неквалифицированного сравнения не меняется (совместимость с этапом 5).
 */
export interface Comparison {
  type: "compare";
  column: string;
  table?: string;
  op: CompareOp;
  value: Literal;
}

/** Логическое AND/OR над двумя выражениями. */
export interface Logical {
  type: "logical";
  op: "AND" | "OR";
  left: WhereExpr;
  right: WhereExpr;
}

export type WhereExpr = Comparison | Logical;

// --- элементы SELECT: колонки и агрегаты (этап 10) --------------------------

export type AggFunc = "COUNT" | "SUM" | "MIN" | "MAX" | "AVG";

export type SelectItem =
  | { kind: "star" } // *
  | { kind: "column"; ref: ColumnRef } // col или t.col
  | { kind: "aggregate"; func: AggFunc; arg: ColumnRef | null }; // FUNC(col) или COUNT(*)

/** Таблица во FROM/JOIN с необязательным алиасом. */
export interface TableRef {
  table: string;
  alias: string | null;
}

/** INNER JOIN t ON left = right (эквиджойн). */
export interface JoinClause {
  table: string;
  alias: string | null;
  left: ColumnRef;
  right: ColumnRef;
}

export interface Select {
  type: "select";
  items: SelectItem[];
  from: TableRef;
  joins: JoinClause[];
  where: WhereExpr | null;
  groupBy: ColumnRef[];
}

// --- UPDATE / DELETE --------------------------------------------------------

/** DELETE FROM t [WHERE ...] */
export interface Delete {
  type: "delete";
  table: string;
  where: WhereExpr | null;
}

/** UPDATE t SET col = literal [, ...] [WHERE ...] */
export interface Update {
  type: "update";
  table: string;
  sets: { column: string; value: Literal }[];
  where: WhereExpr | null;
}

// --- управление транзакциями (этап 8) --------------------------------------

export interface TxnControl {
  type: "txn";
  action: "begin" | "commit" | "rollback";
}

// --- корень ----------------------------------------------------------------

export type Statement =
  | CreateTable
  | CreateIndex
  | Insert
  | Select
  | Delete
  | Update
  | TxnControl;
