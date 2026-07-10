/** Тесты лексера и парсера SQL (этап 5): строка SQL -> AST. */

import { tokenize } from "../src/sql/lexer.ts";
import { parse, parseProgram, ParseError } from "../src/sql/parser.ts";
import type { CreateTable, Insert, Select } from "../src/sql/ast.ts";
import { check, checkEqual, section } from "./harness.ts";

// удобное глубокое сравнение через JSON
function eq(actual: unknown, expected: unknown, msg: string): void {
  checkEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// --- лексер --------------------------------------------------------------
{
  section("лексер: типы токенов");
  const toks = tokenize("SELECT * FROM users WHERE id = 42");
  eq(
    toks.map((t) => `${t.type}:${t.value}`),
    [
      "keyword:SELECT",
      "punct:*",
      "keyword:FROM",
      "ident:users",
      "keyword:WHERE",
      "ident:id",
      "punct:=",
      "number:42",
      "eof:",
    ],
    "поток токенов SELECT",
  );

  const t2 = tokenize("name<>'O''Brien'");
  eq(
    t2.map((t) => `${t.type}:${t.value}`),
    ["ident:name", "punct:<>", "string:O'Brien", "eof:"],
    "оператор <> и удвоенная кавычка в строке",
  );

  section("лексер: регистр, пробелы, комментарии");
  const t3 = tokenize("  select\n\tID -- комментарий\nfrom t");
  eq(
    t3.map((t) => t.value),
    ["SELECT", "ID", "FROM", "t", ""],
    "ключевые слова к верхнему регистру, комментарий пропущен, ident сохраняет регистр",
  );
}

// --- CREATE TABLE --------------------------------------------------------
{
  section("парсер: CREATE TABLE");
  const ast = parse("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)") as CreateTable;
  checkEqual(ast.type, "create_table", "тип узла create_table");
  checkEqual(ast.table, "users", "имя таблицы");
  checkEqual(ast.primaryKey, "id", "первичный ключ определён");
  eq(
    ast.columns,
    [
      { name: "id", dataType: "INTEGER", primaryKey: true },
      { name: "name", dataType: "TEXT", primaryKey: false },
      { name: "age", dataType: "INTEGER", primaryKey: false },
    ],
    "колонки с типами и флагом PK",
  );

  const noPk = parse("CREATE TABLE t (a TEXT, b INTEGER)") as CreateTable;
  checkEqual(noPk.primaryKey, null, "без PRIMARY KEY -> primaryKey null");
}

// --- INSERT --------------------------------------------------------------
{
  section("парсер: INSERT");
  const ast = parse("INSERT INTO users (id, name) VALUES (1, 'Алиса')") as Insert;
  checkEqual(ast.type, "insert", "тип узла insert");
  checkEqual(ast.table, "users", "имя таблицы");
  eq(ast.columns, ["id", "name"], "явный список колонок");
  eq(ast.rows, [[{ kind: "number", value: 1 }, { kind: "string", value: "Алиса" }]], "одна строка значений");

  const noCols = parse("INSERT INTO t VALUES (1), (2), (3)") as Insert;
  checkEqual(noCols.columns, null, "без списка колонок -> null");
  checkEqual(noCols.rows.length, 3, "несколько кортежей VALUES");

  const neg = parse("INSERT INTO t (x) VALUES (-5)") as Insert;
  eq(neg.rows[0], [{ kind: "number", value: -5 }], "отрицательный числовой литерал");
}

// --- SELECT + WHERE ------------------------------------------------------
{
  section("парсер: SELECT");
  const star = parse("SELECT * FROM users") as Select;
  eq(star.items, [{ kind: "star" }], "SELECT * -> items [star]");
  checkEqual(star.from.table, "users", "таблица во from");
  checkEqual(star.where, null, "без WHERE -> where null");

  const cols = parse("SELECT id, name FROM users WHERE id = 1") as Select;
  eq(
    cols.items,
    [
      { kind: "column", ref: { table: null, column: "id" } },
      { kind: "column", ref: { table: null, column: "name" } },
    ],
    "явный список колонок в SELECT",
  );
  eq(
    cols.where,
    { type: "compare", column: "id", op: "=", value: { kind: "number", value: 1 } },
    "простое условие WHERE",
  );

  const ne = parse("SELECT * FROM t WHERE name <> 'x'") as Select;
  eq(
    ne.where,
    { type: "compare", column: "name", op: "!=", value: { kind: "string", value: "x" } },
    "<> нормализуется в !=",
  );
}

// --- приоритет AND/OR и скобки -------------------------------------------
{
  section("парсер: приоритет WHERE (AND выше OR) и скобки");
  const w = (parse("SELECT * FROM t WHERE a = 1 AND b = 2 OR c = 3") as Select).where;
  // должно разобраться как (a=1 AND b=2) OR c=3
  eq(
    w,
    {
      type: "logical",
      op: "OR",
      left: {
        type: "logical",
        op: "AND",
        left: { type: "compare", column: "a", op: "=", value: { kind: "number", value: 1 } },
        right: { type: "compare", column: "b", op: "=", value: { kind: "number", value: 2 } },
      },
      right: { type: "compare", column: "c", op: "=", value: { kind: "number", value: 3 } },
    },
    "AND связывает сильнее OR",
  );

  const paren = (parse("SELECT * FROM t WHERE a = 1 AND (b = 2 OR c = 3)") as Select).where;
  eq(
    paren,
    {
      type: "logical",
      op: "AND",
      left: { type: "compare", column: "a", op: "=", value: { kind: "number", value: 1 } },
      right: {
        type: "logical",
        op: "OR",
        left: { type: "compare", column: "b", op: "=", value: { kind: "number", value: 2 } },
        right: { type: "compare", column: "c", op: "=", value: { kind: "number", value: 3 } },
      },
    },
    "скобки меняют группировку",
  );
}

// --- операторы сравнения -------------------------------------------------
{
  section("парсер: все операторы сравнения");
  for (const op of ["=", "!=", "<", ">", "<=", ">="]) {
    const w = (parse(`SELECT * FROM t WHERE x ${op} 5`) as Select).where;
    eq(w, { type: "compare", column: "x", op, value: { kind: "number", value: 5 } }, `оператор ${op}`);
  }
}

// --- несколько инструкций и ; --------------------------------------------
{
  section("парсер: программа из нескольких инструкций");
  const prog = parseProgram("CREATE TABLE t (a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1); SELECT * FROM t;");
  checkEqual(prog.length, 3, "разобрано 3 инструкции");
  eq(prog.map((s) => s.type), ["create_table", "insert", "select"], "порядок типов инструкций");

  const trailing = parse("SELECT * FROM t;");
  checkEqual(trailing.type, "select", "необязательная ; в конце допустима");
}

// --- ошибки разбора ------------------------------------------------------
{
  section("парсер: синтаксические ошибки отвергаются");
  const bad = [
    "SELECT FROM t", // нет колонок/*
    "SELECT * users", // нет FROM
    "SELECT * FROM t WHERE x", // нет оператора
    "CREATE TABLE t (id BOOLEAN)", // неизвестный тип
    "INSERT INTO t VALUES 1", // нет скобок
    "SELECT * FROM t WHERE (a = 1", // незакрытая скобка
    "SELECT * FROM t WHERE name = 'unterminated", // незакрытая строка
    "DROP TABLE t", // неподдерживаемая инструкция
    "SELECT a.. FROM t", // битый квалификатор колонки
    "CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER PRIMARY KEY)", // два PK
  ];
  for (const sql of bad) {
    let threw = false;
    try {
      parse(sql);
    } catch (e) {
      threw = e instanceof Error;
    }
    check(threw, `отвергнуто: ${sql}`);
  }
}
