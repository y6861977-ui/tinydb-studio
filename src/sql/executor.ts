/**
 * Исполнитель SQL (этап 6) — берёт AST от парсера и выполняет его на движке
 * таблиц (этап 4). Здесь SQL наконец «оживает»: строка запроса меняет данные
 * и возвращает строки.
 *
 *   CREATE TABLE -> db.createTable (схема из AST)
 *   INSERT       -> table.insert для каждого кортежа
 *   SELECT       -> скан таблицы + фильтр WHERE + проекция колонок
 *
 * WHERE вычисляется полным сканом (скан + фильтр). Быстрый поиск по не-ключевым
 * колонкам через индексы — это этап 7.
 */

import { Database } from "../database.ts";
import { Table } from "../table.ts";
import { parse, parseProgram } from "./parser.ts";
import type {
  Statement,
  CreateTable,
  CreateIndex,
  TxnControl,
  Insert,
  Delete,
  Update,
  Select,
  SelectItem,
  ColumnRef,
  JoinClause,
  AggFunc,
  WhereExpr,
  CompareOp,
} from "./ast.ts";
import type { Row, TableSchema, Value } from "../types.ts";
import type { Tx } from "../database.ts";

/** Результат исполнения одной инструкции. */
export type ExecResult =
  | { kind: "created"; table: string }
  | { kind: "created_index"; name: string; table: string; column: string }
  | { kind: "inserted"; table: string; count: number }
  | { kind: "deleted"; table: string; count: number }
  | { kind: "updated"; table: string; count: number }
  | { kind: "txn"; action: "begin" | "commit" | "rollback" }
  | {
      kind: "selected";
      columns: string[];
      rows: Row[];
      /** Сколько строк реально просмотрено (для наглядности работы индекса). */
      scanned: number;
      /** Какой путь доступа выбран: "PRIMARY", имя колонки-индекса или null (скан). */
      usedIndex: string | null;
    };

/** Разобрать и выполнить ОДНУ инструкцию SQL. */
export function execute(db: Database, sql: string): ExecResult {
  return run(db, parse(sql));
}

/** Разобрать и выполнить несколько инструкций (через ';'). */
export function executeProgram(db: Database, sql: string): ExecResult[] {
  return parseProgram(sql).map((s) => run(db, s));
}

function run(db: Database, stmt: Statement): ExecResult {
  switch (stmt.type) {
    case "create_table":
      return runCreate(db, stmt);
    case "create_index":
      return runCreateIndex(db, stmt);
    case "insert":
      return runInsert(db, stmt);
    case "delete":
      return runDelete(db, stmt);
    case "update":
      return runUpdate(db, stmt);
    case "select":
      return runSelect(db, stmt);
    case "txn":
      return runTxn(db, stmt);
  }
}

// --- DELETE / UPDATE -------------------------------------------------------

function runDelete(db: Database, ast: Delete): ExecResult {
  return db.runAutocommit((tx) => {
    const table = tx.write(ast.table);
    const schema = table.schema;
    if (ast.where !== null) validateWhere(ast.where, schema);
    // снимок совпавших строк ДО изменения (чтобы не мутировать во время обхода)
    const matched = table.all().filter((r) => ast.where === null || evalWhere(ast.where!, r, schema));
    for (const row of matched) table.delete(row[schema.primaryKey]!);
    return { kind: "deleted", table: ast.table, count: matched.length };
  });
}

function runUpdate(db: Database, ast: Update): ExecResult {
  return db.runAutocommit((tx) => {
    const table = tx.write(ast.table);
    const schema = table.schema;

    // проверяем колонки и типы SET заранее — понятные ошибки до мутаций
    for (const s of ast.sets) {
      const col = schema.columns.find((c) => c.name === s.column);
      if (!col) throw new Error(`нет колонки ${s.column} в таблице ${ast.table}`);
      const litType = s.value.kind === "number" ? "INTEGER" : "TEXT";
      if (col.type !== litType) {
        throw new Error(`колонка ${s.column} (${col.type}) не принимает ${s.value.kind === "number" ? "число" : "строку"}`);
      }
    }
    if (ast.where !== null) validateWhere(ast.where, schema);

    const matched = table.all().filter((r) => ast.where === null || evalWhere(ast.where!, r, schema));
    for (const row of matched) {
      const newRow: Row = { ...row };
      for (const s of ast.sets) newRow[s.column] = s.value.value;
      // delete+insert поддерживает индексы согласованно и позволяет менять PK
      table.delete(row[schema.primaryKey]!);
      table.insert(newRow);
    }
    return { kind: "updated", table: ast.table, count: matched.length };
  });
}

// --- BEGIN / COMMIT / ROLLBACK ---------------------------------------------

function runTxn(db: Database, ast: TxnControl): ExecResult {
  if (ast.action === "begin") db.begin();
  else if (ast.action === "commit") db.commit();
  else db.rollback();
  return { kind: "txn", action: ast.action };
}

// --- CREATE INDEX ----------------------------------------------------------

function runCreateIndex(db: Database, ast: CreateIndex): ExecResult {
  db.createIndex(ast.name, ast.table, ast.column);
  return { kind: "created_index", name: ast.name, table: ast.table, column: ast.column };
}

// --- CREATE TABLE ----------------------------------------------------------

function runCreate(db: Database, ast: CreateTable): ExecResult {
  if (ast.primaryKey === null) {
    throw new Error(`CREATE TABLE ${ast.table}: нужна колонка PRIMARY KEY`);
  }
  const schema: TableSchema = {
    name: ast.table,
    columns: ast.columns.map((c) => ({ name: c.name, type: c.dataType })),
    primaryKey: ast.primaryKey,
  };
  db.createTable(schema);
  return { kind: "created", table: ast.table };
}

// --- INSERT ----------------------------------------------------------------

function runInsert(db: Database, ast: Insert): ExecResult {
  // atomic + isolated: в транзакции берётся X-блокировка на таблицу,
  // все деревья (основное + индексы) фиксируются одним WAL-коммитом.
  return db.runAutocommit((tx) => {
    const table = tx.write(ast.table);
    const cols = ast.columns ?? table.schema.columns.map((c) => c.name);
    for (const tuple of ast.rows) {
      if (tuple.length !== cols.length) {
        throw new Error(`INSERT в ${ast.table}: ожидалось ${cols.length} значений, получено ${tuple.length}`);
      }
      const row: Row = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]!] = tuple[i]!.value;
      }
      table.insert(row); // здесь же проверка типов/полноты строки (этап 4)
    }
    return { kind: "inserted", table: ast.table, count: ast.rows.length };
  });
}

// --- SELECT ----------------------------------------------------------------

/** Источник данных для SELECT: таблица под алиасом. */
interface Source {
  alias: string;
  table: Table;
  schema: TableSchema;
}

function makeSource(tx: Tx, table: string, alias: string | null): Source {
  const t = tx.read(table);
  return { alias: alias ?? table, table: t, schema: t.schema };
}

function runSelect(db: Database, ast: Select): ExecResult {
  return db.runAutocommit((tx) => {
    const from = makeSource(tx, ast.from.table, ast.from.alias);
    const hasAgg = ast.items.some((i) => i.kind === "aggregate");

    // простой путь (одна таблица, без агрегатов/группировки) — как в этапах 6–7:
    // с планировщиком точечного доступа и строками по «плоским» именам колонок
    if (ast.joins.length === 0 && !hasAgg && ast.groupBy.length === 0) {
      return simpleSelect(from, ast);
    }

    // сложный путь: джойны и/или агрегаты
    const sources = [from, ...ast.joins.map((j) => makeSource(tx, j.table, j.alias))];
    return joinAggSelect(sources, ast);
  });
}

// --- простой SELECT (одна таблица) -----------------------------------------

function simpleSelect(src: Source, ast: Select): ExecResult {
  const schema = src.schema;
  const quals = new Set([src.alias, src.table.schema.name]);

  const outCols = starColumns(ast, schema);
  for (const c of outCols) {
    if (!schema.columns.some((sc) => sc.name === c)) {
      throw new Error(`нет колонки ${c} в таблице ${ast.from.table}`);
    }
  }
  if (ast.where !== null) validateWhere(ast.where, schema, quals);

  const plan = planPointLookup(ast.where, src.table);
  if (plan) {
    return {
      kind: "selected",
      columns: outCols,
      rows: plan.rows.map((r) => project(r, outCols)),
      scanned: plan.rows.length,
      usedIndex: plan.usedIndex,
    };
  }

  const all = src.table.all();
  const rows = all
    .filter((r) => ast.where === null || evalWhere(ast.where, r, schema))
    .map((r) => project(r, outCols));
  return { kind: "selected", columns: outCols, rows, scanned: all.length, usedIndex: null };
}

/** Имена колонок вывода для одиночной таблицы (star или список колонок). */
function starColumns(ast: Select, schema: TableSchema): string[] {
  if (ast.items.length === 1 && ast.items[0]!.kind === "star") {
    return schema.columns.map((c) => c.name);
  }
  return ast.items.map((it) => {
    if (it.kind !== "column") throw new Error("агрегат требует GROUP BY или отдельного пути");
    return it.ref.column;
  });
}

/**
 * Если WHERE — это ровно `col = литерал`, и col это PK или индексированная
 * колонка, вернуть строки точечным доступом (O(log n)) вместо скана.
 */
function planPointLookup(
  where: WhereExpr | null,
  table: Table,
): { rows: Row[]; usedIndex: string } | null {
  if (where === null || where.type !== "compare" || where.op !== "=") return null;
  const col = where.column;
  const value = where.value.value;

  if (col === table.schema.primaryKey) {
    const row = table.get(value);
    return { rows: row ? [row] : [], usedIndex: "PRIMARY" };
  }
  if (table.hasIndex(col)) {
    return { rows: table.getByIndex(col, value), usedIndex: col };
  }
  return null;
}

function project(row: Row, cols: string[]): Row {
  const out: Row = {};
  for (const c of cols) out[c] = row[c]!;
  return out;
}

// --- джойны и агрегаты (этап 10) -------------------------------------------

/** Объединённая строка: ключи вида "alias.column". */
type Combined = Record<string, Value>;

function prefixRow(alias: string, row: Row): Combined {
  const out: Combined = {};
  for (const [k, v] of Object.entries(row)) out[`${alias}.${k}`] = v;
  return out;
}

/** По какому источнику идёт ссылка на колонку (по алиасу или по единственному владельцу). */
function refAlias(ref: ColumnRef, sources: Source[]): string {
  if (ref.table !== null) {
    const s = sources.find((x) => x.alias === ref.table || x.schema.name === ref.table);
    if (!s) throw new Error(`неизвестная таблица ${ref.table}`);
    if (!s.schema.columns.some((c) => c.name === ref.column)) {
      throw new Error(`нет колонки ${ref.column} в ${s.alias}`);
    }
    return s.alias;
  }
  const owners = sources.filter((s) => s.schema.columns.some((c) => c.name === ref.column));
  if (owners.length === 0) throw new Error(`нет колонки ${ref.column}`);
  if (owners.length > 1) throw new Error(`колонка ${ref.column} неоднозначна — уточните таблицу`);
  return owners[0]!.alias;
}

function refKey(ref: ColumnRef, sources: Source[]): string {
  return `${refAlias(ref, sources)}.${ref.column}`;
}

function refType(ref: ColumnRef, sources: Source[]): "INTEGER" | "TEXT" {
  const alias = refAlias(ref, sources);
  const s = sources.find((x) => x.alias === alias)!;
  return s.schema.columns.find((c) => c.name === ref.column)!.type;
}

function joinAggSelect(sources: Source[], ast: Select): ExecResult {
  let combined: Combined[] = sources[0]!.table.all().map((r) => prefixRow(sources[0]!.alias, r));
  let scanned = combined.length;
  let usedIndex: string | null = null;

  // INDEX NESTED LOOP JOIN: для каждого join берём ключ из уже собранной строки
  // и ищем совпадения в новой таблице — по PK/индексу, иначе сканом.
  for (let j = 0; j < ast.joins.length; j++) {
    const join = ast.joins[j]!;
    const src = sources[j + 1]!;
    const scope = sources.slice(0, j + 1);
    const { newRef, existRef } = orientJoin(join, src, scope);

    const next: Combined[] = [];
    for (const row of combined) {
      const key = row[refKey(existRef, scope)]!;
      let matches: Row[];
      if (newRef.column === src.schema.primaryKey) {
        const m = src.table.get(key);
        matches = m ? [m] : [];
        usedIndex ??= `PK:${src.alias}`;
      } else if (src.table.hasIndex(newRef.column)) {
        matches = src.table.getByIndex(newRef.column, key);
        usedIndex ??= `index:${src.alias}.${newRef.column}`;
      } else {
        const all = src.table.all();
        scanned += all.length;
        matches = all.filter((r) => r[newRef.column] === key);
        usedIndex ??= `scan:${src.alias}`;
      }
      for (const m of matches) next.push({ ...row, ...prefixRow(src.alias, m) });
    }
    combined = next;
  }

  // WHERE по объединённым строкам
  if (ast.where !== null) validateWhereRefs(ast.where, sources);
  const filtered =
    ast.where === null ? combined : combined.filter((r) => evalCombined(ast.where!, r, sources));

  const hasAgg = ast.items.some((i) => i.kind === "aggregate");
  if (hasAgg || ast.groupBy.length > 0) {
    return aggregate(filtered, ast, sources, scanned, usedIndex);
  }
  return projectJoined(filtered, ast, sources, scanned, usedIndex);
}

/** Определить, какая сторона ON относится к новой таблице, а какая — к уже собранным. */
function orientJoin(join: JoinClause, src: Source, scope: Source[]): { newRef: ColumnRef; existRef: ColumnRef } {
  const leftAlias = refAlias(join.left, [...scope, src]);
  const rightAlias = refAlias(join.right, [...scope, src]);
  if (leftAlias === src.alias && rightAlias !== src.alias) return { newRef: join.left, existRef: join.right };
  if (rightAlias === src.alias && leftAlias !== src.alias) return { newRef: join.right, existRef: join.left };
  throw new Error(`ON должен связывать ${src.alias} с уже присоединённой таблицей`);
}

/** Проекция объединённых строк (джойн без агрегатов). Имена колонок — alias.column. */
function projectJoined(
  rows: Combined[],
  ast: Select,
  sources: Source[],
  scanned: number,
  usedIndex: string | null,
): ExecResult {
  let outCols: string[];
  if (ast.items.length === 1 && ast.items[0]!.kind === "star") {
    outCols = sources.flatMap((s) => s.schema.columns.map((c) => `${s.alias}.${c.name}`));
  } else {
    outCols = ast.items.map((it) => {
      if (it.kind !== "column") throw new Error("агрегат без GROUP BY нельзя смешивать с колонками");
      return refKey(it.ref, sources);
    });
  }
  const out = rows.map((r) => {
    const o: Row = {};
    for (const c of outCols) o[c] = r[c]!;
    return o;
  });
  return { kind: "selected", columns: outCols, rows: out, scanned, usedIndex };
}

/** Агрегация (COUNT/SUM/MIN/MAX/AVG) с необязательным GROUP BY. */
function aggregate(
  rows: Combined[],
  ast: Select,
  sources: Source[],
  scanned: number,
  usedIndex: string | null,
): ExecResult {
  // не-агрегатные колонки в выборке обязаны присутствовать в GROUP BY
  const groupKeys = ast.groupBy.map((g) => refKey(g, sources));
  for (const it of ast.items) {
    if (it.kind === "star") throw new Error("нельзя SELECT * вместе с агрегатами");
    if (it.kind === "column" && !groupKeys.includes(refKey(it.ref, sources))) {
      throw new Error(`колонка ${it.ref.column} должна быть в GROUP BY`);
    }
  }

  // сгруппировать (без GROUP BY — одна группа со всеми строками)
  const groups = new Map<string, Combined[]>();
  if (ast.groupBy.length === 0) {
    groups.set("", rows);
  } else {
    for (const r of rows) {
      const gk = JSON.stringify(groupKeys.map((k) => r[k]));
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = []));
      g.push(r);
    }
  }

  const outCols = ast.items.map((it) => itemName(it, sources));
  const outRows: Row[] = [];
  for (const group of groups.values()) {
    const o: Row = {};
    for (let i = 0; i < ast.items.length; i++) {
      const it = ast.items[i]!;
      const name = outCols[i]!;
      if (it.kind === "column") o[name] = group[0]![refKey(it.ref, sources)]!;
      else if (it.kind === "aggregate") o[name] = computeAgg(it.func, it.arg, group, sources);
    }
    outRows.push(o);
  }
  return { kind: "selected", columns: outCols, rows: outRows, scanned, usedIndex };
}

function itemName(it: SelectItem, sources: Source[]): string {
  if (it.kind === "star") throw new Error("* недопустимо здесь");
  if (it.kind === "column") {
    return sources.length > 1 ? refKey(it.ref, sources) : it.ref.column;
  }
  const arg = it.arg ? (it.arg.table ? `${it.arg.table}.${it.arg.column}` : it.arg.column) : "*";
  return `${it.func}(${arg})`;
}

function computeAgg(func: AggFunc, arg: ColumnRef | null, group: Combined[], sources: Source[]): Value {
  if (func === "COUNT") return group.length;
  if (!arg) throw new Error(`${func} требует колонку`);
  const key = refKey(arg, sources);
  const values = group.map((r) => r[key]!);
  if (values.length === 0) return 0;

  if (func === "MIN" || func === "MAX") {
    return values.reduce((acc, v) => {
      const cmp = compareVals(v, acc);
      return func === "MIN" ? (cmp < 0 ? v : acc) : (cmp > 0 ? v : acc);
    });
  }
  // SUM / AVG — только по числам
  let sum = 0;
  for (const v of values) {
    if (typeof v !== "number") throw new Error(`${func} применим только к INTEGER`);
    sum += v;
  }
  return func === "SUM" ? sum : sum / values.length;
}

function compareVals(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// --- проверка и вычисление WHERE -------------------------------------------

/** Статическая проверка условия по схеме одной таблицы (+ допустимые квалификаторы). */
function validateWhere(expr: WhereExpr, schema: TableSchema, quals?: Set<string>): void {
  if (expr.type === "logical") {
    validateWhere(expr.left, schema, quals);
    validateWhere(expr.right, schema, quals);
    return;
  }
  if (expr.table !== undefined && quals && !quals.has(expr.table)) {
    throw new Error(`неизвестная таблица ${expr.table} в условии`);
  }
  const col = schema.columns.find((c) => c.name === expr.column);
  if (!col) throw new Error(`нет колонки ${expr.column} в таблице ${schema.name}`);
  const litType = expr.value.kind === "number" ? "INTEGER" : "TEXT";
  if (col.type !== litType) {
    const litName = expr.value.kind === "number" ? "числом" : "строкой";
    throw new Error(`нельзя сравнивать колонку ${expr.column} (${col.type}) с ${litName}`);
  }
}

/** Проверка WHERE по нескольким источникам (джойн). */
function validateWhereRefs(expr: WhereExpr, sources: Source[]): void {
  if (expr.type === "logical") {
    validateWhereRefs(expr.left, sources);
    validateWhereRefs(expr.right, sources);
    return;
  }
  const ref: ColumnRef = { table: expr.table ?? null, column: expr.column };
  const litType = expr.value.kind === "number" ? "INTEGER" : "TEXT";
  if (refType(ref, sources) !== litType) {
    const litName = expr.value.kind === "number" ? "числом" : "строкой";
    throw new Error(`нельзя сравнивать колонку ${expr.column} с ${litName}`);
  }
}

/** Вычислить WHERE по объединённой строке (джойн). */
function evalCombined(expr: WhereExpr, row: Combined, sources: Source[]): boolean {
  if (expr.type === "logical") {
    const left = evalCombined(expr.left, row, sources);
    return expr.op === "AND"
      ? left && evalCombined(expr.right, row, sources)
      : left || evalCombined(expr.right, row, sources);
  }
  const ref: ColumnRef = { table: expr.table ?? null, column: expr.column };
  return compare(row[refKey(ref, sources)]!, expr.value.value, expr.op);
}

/** Вычислить условие для конкретной строки (после validateWhere). */
function evalWhere(expr: WhereExpr, row: Row, schema: TableSchema): boolean {
  if (expr.type === "logical") {
    const left = evalWhere(expr.left, row, schema);
    return expr.op === "AND"
      ? left && evalWhere(expr.right, row, schema)
      : left || evalWhere(expr.right, row, schema);
  }
  return compare(row[expr.column]!, expr.value.value, expr.op);
}

function compare(a: Value, b: Value, op: CompareOp): boolean {
  let c: number;
  if (typeof a === "number" && typeof b === "number") {
    c = a - b;
  } else {
    const sa = String(a);
    const sb = String(b);
    c = sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  switch (op) {
    case "=":
      return c === 0;
    case "!=":
      return c !== 0;
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case ">=":
      return c >= 0;
  }
}
