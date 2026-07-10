/**
 * Парсер SQL (этап 5) — рекурсивный спуск, превращает токены в AST.
 *
 * Грамматика (подмножество):
 *   statement   := createTable | insert | select
 *   createTable := CREATE TABLE ident '(' columnDef (',' columnDef)* ')'
 *   columnDef   := ident ('INTEGER'|'TEXT') (PRIMARY KEY)?
 *   insert      := INSERT INTO ident ('(' ident (',' ident)* ')')?
 *                  VALUES tuple (',' tuple)*
 *   tuple       := '(' literal (',' literal)* ')'
 *   select      := SELECT ('*' | ident (',' ident)*) FROM ident (WHERE expr)?
 *   expr        := orExpr
 *   orExpr      := andExpr (OR andExpr)*
 *   andExpr     := primary (AND primary)*
 *   primary     := '(' expr ')' | comparison
 *   comparison  := ident op literal        op ∈ = != <> < > <= >=
 *   literal     := '-'? number | string
 *
 * Только разбор в структуру. Исполнение — executor.ts (этап 6).
 */

import { tokenize, type Token } from "./lexer.ts";
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
  TableRef,
  JoinClause,
  ColumnRef,
  AggFunc,
  ColumnDef,
  ColumnType,
  Literal,
  WhereExpr,
  Comparison,
  CompareOp,
} from "./ast.ts";

export class ParseError extends Error {}

const COMPARE_OPS = new Set(["=", "!=", "<>", "<", ">", "<=", ">="]);
const AGG_FUNCS = new Set(["COUNT", "SUM", "MIN", "MAX", "AVG"]);

function isAgg(ident: string): boolean {
  return AGG_FUNCS.has(ident.toUpperCase());
}

class Parser {
  private readonly toks: Token[];
  private pos = 0;

  constructor(sql: string) {
    this.toks = tokenize(sql);
  }

  // --- поток токенов ------------------------------------------------------

  private peek(): Token {
    return this.toks[this.pos]!;
  }

  private peekAt(offset: number): Token {
    return this.toks[this.pos + offset] ?? this.toks[this.toks.length - 1]!;
  }

  private next(): Token {
    return this.toks[this.pos++]!;
  }

  private atEnd(): boolean {
    return this.peek().type === "eof";
  }

  private fail(msg: string): never {
    const t = this.peek();
    const near = t.type === "eof" ? "конец ввода" : `${JSON.stringify(t.value)}`;
    throw new ParseError(`${msg} (у ${near}, позиция ${t.pos})`);
  }

  private isKeyword(kw: string): boolean {
    const t = this.peek();
    return t.type === "keyword" && t.value === kw;
  }

  private isPunct(p: string): boolean {
    const t = this.peek();
    return t.type === "punct" && t.value === p;
  }

  private expectKeyword(kw: string): void {
    if (!this.isKeyword(kw)) this.fail(`ожидалось ${kw}`);
    this.next();
  }

  private expectPunct(p: string): void {
    if (!this.isPunct(p)) this.fail(`ожидалось ${JSON.stringify(p)}`);
    this.next();
  }

  private expectIdent(what = "идентификатор"): string {
    const t = this.peek();
    if (t.type !== "ident") this.fail(`ожидался ${what}`);
    this.next();
    return t.value;
  }

  // --- верхний уровень ----------------------------------------------------

  /** Одна инструкция (без учёта ';'). */
  private parseOne(): Statement {
    if (this.isKeyword("CREATE")) return this.parseCreate();
    if (this.isKeyword("INSERT")) return this.parseInsert();
    if (this.isKeyword("SELECT")) return this.parseSelect();
    if (this.isKeyword("DELETE")) return this.parseDelete();
    if (this.isKeyword("UPDATE")) return this.parseUpdate();
    if (this.isKeyword("BEGIN")) return this.txnStmt("begin");
    if (this.isKeyword("COMMIT")) return this.txnStmt("commit");
    if (this.isKeyword("ROLLBACK")) return this.txnStmt("rollback");
    this.fail("ожидался CREATE, INSERT, SELECT, UPDATE, DELETE, BEGIN, COMMIT или ROLLBACK");
  }

  private txnStmt(action: "begin" | "commit" | "rollback"): TxnControl {
    this.next(); // поглотить ключевое слово
    return { type: "txn", action };
  }

  parseStatement(): Statement {
    const stmt = this.parseOne();
    if (this.isPunct(";")) this.next(); // необязательная точка с запятой
    if (!this.atEnd()) this.fail("лишние токены после инструкции");
    return stmt;
  }

  /** Несколько инструкций через ';'. */
  parseProgram(): Statement[] {
    const out: Statement[] = [];
    while (!this.atEnd()) {
      out.push(this.parseOne());
      if (this.isPunct(";")) this.next();
      else break;
    }
    if (!this.atEnd()) this.fail("лишние токены после инструкции");
    return out;
  }

  // --- CREATE TABLE -------------------------------------------------------

  private parseCreate(): CreateTable | CreateIndex {
    this.expectKeyword("CREATE");
    if (this.isKeyword("INDEX")) return this.parseCreateIndex();
    this.expectKeyword("TABLE");
    const table = this.expectIdent("имя таблицы");
    this.expectPunct("(");

    const columns: ColumnDef[] = [];
    let primaryKey: string | null = null;
    do {
      const name = this.expectIdent("имя колонки");
      const dataType = this.parseColumnType();
      let isPk = false;
      if (this.isKeyword("PRIMARY")) {
        this.next();
        this.expectKeyword("KEY");
        isPk = true;
        if (primaryKey !== null) this.fail("несколько PRIMARY KEY в одной таблице");
        primaryKey = name;
      }
      columns.push({ name, dataType, primaryKey: isPk });
    } while (this.consumeComma());

    this.expectPunct(")");
    return { type: "create_table", table, columns, primaryKey };
  }

  private parseCreateIndex(): CreateIndex {
    this.expectKeyword("INDEX");
    const name = this.expectIdent("имя индекса");
    this.expectKeyword("ON");
    const table = this.expectIdent("имя таблицы");
    this.expectPunct("(");
    const column = this.expectIdent("имя колонки");
    this.expectPunct(")");
    return { type: "create_index", name, table, column };
  }

  private parseColumnType(): ColumnType {
    if (this.isKeyword("INTEGER")) {
      this.next();
      return "INTEGER";
    }
    if (this.isKeyword("TEXT")) {
      this.next();
      return "TEXT";
    }
    this.fail("ожидался тип колонки INTEGER или TEXT");
  }

  // --- INSERT -------------------------------------------------------------

  private parseInsert(): Insert {
    this.expectKeyword("INSERT");
    this.expectKeyword("INTO");
    const table = this.expectIdent("имя таблицы");

    let columns: string[] | null = null;
    if (this.isPunct("(")) {
      this.next();
      columns = [];
      do {
        columns.push(this.expectIdent("имя колонки"));
      } while (this.consumeComma());
      this.expectPunct(")");
    }

    this.expectKeyword("VALUES");
    const rows: Literal[][] = [];
    do {
      rows.push(this.parseTuple());
    } while (this.consumeComma());

    return { type: "insert", table, columns, rows };
  }

  private parseTuple(): Literal[] {
    this.expectPunct("(");
    const vals: Literal[] = [];
    do {
      vals.push(this.parseLiteral());
    } while (this.consumeComma());
    this.expectPunct(")");
    return vals;
  }

  // --- DELETE / UPDATE ----------------------------------------------------

  private parseDelete(): Delete {
    this.expectKeyword("DELETE");
    this.expectKeyword("FROM");
    const table = this.expectIdent("имя таблицы");
    const where = this.parseOptionalWhere();
    return { type: "delete", table, where };
  }

  private parseUpdate(): Update {
    this.expectKeyword("UPDATE");
    const table = this.expectIdent("имя таблицы");
    this.expectKeyword("SET");
    const sets: { column: string; value: Literal }[] = [];
    do {
      const column = this.expectIdent("имя колонки");
      if (!this.isPunct("=")) this.fail("ожидался '=' в SET");
      this.next();
      sets.push({ column, value: this.parseLiteral() });
    } while (this.consumeComma());
    const where = this.parseOptionalWhere();
    return { type: "update", table, sets, where };
  }

  private parseOptionalWhere(): WhereExpr | null {
    if (!this.isKeyword("WHERE")) return null;
    this.next();
    return this.parseExpr();
  }

  // --- SELECT -------------------------------------------------------------

  private parseSelect(): Select {
    this.expectKeyword("SELECT");

    // список элементов выборки: * либо колонки/агрегаты
    const items: SelectItem[] = [];
    if (this.isPunct("*")) {
      this.next();
      items.push({ kind: "star" });
    } else {
      do {
        items.push(this.parseSelectItem());
      } while (this.consumeComma());
    }

    this.expectKeyword("FROM");
    const from = this.parseTableRef();

    // JOIN ... ON left = right
    const joins: JoinClause[] = [];
    while (this.isKeyword("JOIN")) {
      this.next();
      const t = this.parseTableRef();
      this.expectKeyword("ON");
      const left = this.parseColumnRef();
      this.expectPunct("=");
      const right = this.parseColumnRef();
      joins.push({ table: t.table, alias: t.alias, left, right });
    }

    let where: WhereExpr | null = null;
    if (this.isKeyword("WHERE")) {
      this.next();
      where = this.parseExpr();
    }

    const groupBy: ColumnRef[] = [];
    if (this.isKeyword("GROUP")) {
      this.next();
      this.expectKeyword("BY");
      do {
        groupBy.push(this.parseColumnRef());
      } while (this.consumeComma());
    }

    return { type: "select", items, from, joins, where, groupBy };
  }

  private parseSelectItem(): SelectItem {
    // агрегат: FUNC( * | colref )
    const t = this.peek();
    if (t.type === "ident" && isAgg(t.value) && this.peekAt(1).value === "(" && this.peekAt(1).type === "punct") {
      const func = t.value.toUpperCase() as AggFunc;
      this.next(); // имя функции
      this.expectPunct("(");
      let arg: ColumnRef | null = null;
      if (this.isPunct("*")) this.next();
      else arg = this.parseColumnRef();
      this.expectPunct(")");
      return { kind: "aggregate", func, arg };
    }
    return { kind: "column", ref: this.parseColumnRef() };
  }

  private parseTableRef(): TableRef {
    const table = this.expectIdent("имя таблицы");
    let alias: string | null = null;
    if (this.isKeyword("AS")) {
      this.next();
      alias = this.expectIdent("алиас");
    } else if (this.peek().type === "ident") {
      alias = this.next().value; // алиас без AS
    }
    return { table, alias };
  }

  private parseColumnRef(): ColumnRef {
    const first = this.expectIdent("имя колонки");
    if (this.isPunct(".")) {
      this.next();
      const column = this.expectIdent("имя колонки после '.'");
      return { table: first, column };
    }
    return { table: null, column: first };
  }

  // --- выражение WHERE (с приоритетами) -----------------------------------

  private parseExpr(): WhereExpr {
    return this.parseOr();
  }

  private parseOr(): WhereExpr {
    let left = this.parseAnd();
    while (this.isKeyword("OR")) {
      this.next();
      const right = this.parseAnd();
      left = { type: "logical", op: "OR", left, right };
    }
    return left;
  }

  private parseAnd(): WhereExpr {
    let left = this.parsePrimary();
    while (this.isKeyword("AND")) {
      this.next();
      const right = this.parsePrimary();
      left = { type: "logical", op: "AND", left, right };
    }
    return left;
  }

  private parsePrimary(): WhereExpr {
    if (this.isPunct("(")) {
      this.next();
      const e = this.parseExpr();
      this.expectPunct(")");
      return e;
    }
    return this.parseComparison();
  }

  private parseComparison(): Comparison {
    const ref = this.parseColumnRef();
    const t = this.peek();
    if (t.type !== "punct" || !COMPARE_OPS.has(t.value)) {
      this.fail("ожидался оператор сравнения (=, !=, <>, <, >, <=, >=)");
    }
    this.next();
    const op: CompareOp = t.value === "<>" ? "!=" : (t.value as CompareOp);
    const value = this.parseLiteral();
    const cmp: Comparison = { type: "compare", column: ref.column, op, value };
    if (ref.table !== null) cmp.table = ref.table; // квалификатор только если есть
    return cmp;
  }

  // --- литералы -----------------------------------------------------------

  private parseLiteral(): Literal {
    let negative = false;
    if (this.isPunct("*")) this.fail("здесь ожидался литерал, а не *");
    // унарный минус перед числом
    const t0 = this.peek();
    if (t0.type === "punct" && t0.value === "-") {
      this.next();
      negative = true;
    }
    const t = this.peek();
    if (t.type === "number") {
      this.next();
      const num = Number(t.value);
      if (!Number.isSafeInteger(num)) this.fail(`число вне безопасного диапазона: ${t.value}`);
      return { kind: "number", value: negative ? -num : num };
    }
    if (t.type === "string") {
      if (negative) this.fail("унарный минус применим только к числу");
      this.next();
      return { kind: "string", value: t.value };
    }
    this.fail("ожидался литерал (число или строка)");
  }

  // --- утилиты ------------------------------------------------------------

  private consumeComma(): boolean {
    if (this.isPunct(",")) {
      this.next();
      return true;
    }
    return false;
  }
}

/** Разобрать ОДНУ инструкцию SQL в AST. */
export function parse(sql: string): Statement {
  return new Parser(sql).parseStatement();
}

/** Разобрать несколько инструкций (через ';'). */
export function parseProgram(sql: string): Statement[] {
  return new Parser(sql).parseProgram();
}
