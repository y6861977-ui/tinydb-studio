/**
 * SQL-REPL (этап 6) — интерактивная оболочка, исполняющая SQL на движке.
 *
 * Печатай запросы: CREATE TABLE / INSERT / SELECT ... WHERE — они реально
 * меняют данные и возвращают строки. Можно несколько инструкций через ';'.
 * Мета-команды начинаются с точки: .tables .schema .help .exit
 *
 * Данные лежат в директории (аргумент, по умолчанию ./data).
 * Оформление — только ANSI + встроенный readline (цвет, история по ↑).
 */

import { createInterface } from "node:readline";
import { Database } from "./database.ts";
import { executeProgram, type ExecResult } from "./sql/executor.ts";
import { green, red, cyan, yellow, dim, bold, magenta } from "./ansi.ts";

const dir = process.argv[2] ?? "data";
const db = new Database(dir);

function banner(): void {
  const bar = magenta("─".repeat(52));
  console.log(bar);
  console.log(`  ${bold(magenta("tiny-db"))} ${dim("— своя SQL-база с нуля")}`);
  console.log(bar);
  console.log(`  данные: ${cyan(dir)}   таблиц: ${yellow(String(db.tableNames().length))}`);
  console.log(`  ${dim("↑ — история · инструкции через ';' · мета-команды с точки")}`);
  console.log(bar);
  console.log(bold("Примеры SQL:"));
  console.log(`  ${cyan("CREATE TABLE")} users (id ${cyan("INTEGER")} ${cyan("PRIMARY KEY")}, name ${cyan("TEXT")}, age ${cyan("INTEGER")});`);
  console.log(`  ${cyan("INSERT INTO")} users ${dim("(id, name, age)")} ${cyan("VALUES")} (1, 'Алиса', 30);`);
  console.log(`  ${cyan("SELECT")} * ${cyan("FROM")} users ${cyan("WHERE")} age >= 18;`);
  console.log(bold("Мета-команды:"));
  console.log(`  ${yellow(".tables")}  ${yellow(".schema <table>")}  ${yellow(".help")}  ${yellow(".exit")}`);
  console.log(bar);
}

banner();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
  historySize: 1000,
  prompt: `${bold(magenta("sql"))} ${dim("›")} `,
});
rl.prompt();

rl.on("line", (line) => {
  const input = line.trim();
  if (input !== "") {
    if (input.startsWith(".")) meta(input);
    else runSql(input);
  }
  refreshPrompt();
  rl.prompt();
});

/** Приглашение помечает открытую транзакцию звёздочкой: sql* › */
function refreshPrompt(): void {
  const mark = db.inTransaction ? red("*") : "";
  rl.setPrompt(`${bold(magenta("sql"))}${mark} ${dim("›")} `);
}

rl.on("close", () => {
  db.close();
  console.log(dim("пока!"));
  process.exit(0);
});

// --- исполнение SQL --------------------------------------------------------

function runSql(sql: string): void {
  try {
    for (const res of executeProgram(db, sql)) printResult(res);
  } catch (e) {
    console.log(red(`ошибка: ${(e as Error).message}`));
  }
}

const TXN_WORD = { begin: "транзакция начата", commit: "зафиксировано", rollback: "откат" } as const;

function printResult(res: ExecResult): void {
  if (res.kind === "created") {
    console.log(green(`таблица ${res.table} создана`));
  } else if (res.kind === "created_index") {
    console.log(green(`индекс ${res.name} создан (${res.table}.${res.column})`));
  } else if (res.kind === "inserted") {
    console.log(green(`вставлено строк: ${res.count} (в ${res.table})`));
  } else if (res.kind === "deleted") {
    console.log(green(`удалено строк: ${res.count} (из ${res.table})`));
  } else if (res.kind === "updated") {
    console.log(green(`обновлено строк: ${res.count} (в ${res.table})`));
  } else if (res.kind === "txn") {
    console.log(green(TXN_WORD[res.action]));
  } else {
    printTable(res.columns, res.rows);
    const plan = res.usedIndex ? `план: ${res.usedIndex}` : "полный скан";
    console.log(dim(`строк: ${res.rows.length} · просмотрено: ${res.scanned} · ${plan}`));
  }
}

/** Аккуратная таблица результата SELECT: заголовок жёлтым, значения голубым. */
function printTable(columns: string[], rows: Record<string, unknown>[]): void {
  if (columns.length === 0) return;
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c]).length), 0),
  );
  const sep = (l: string, m: string, r: string) =>
    dim(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const fmtRow = (cells: string[], paint: (s: string) => string) =>
    dim("│") + cells.map((c, i) => " " + paint(c.padEnd(widths[i]!)) + " ").join(dim("│")) + dim("│");

  console.log(sep("┌", "┬", "┐"));
  console.log(fmtRow(columns, yellow));
  console.log(sep("├", "┼", "┤"));
  for (const row of rows) {
    console.log(fmtRow(columns.map((c) => String(row[c])), cyan));
  }
  console.log(sep("└", "┴", "┘"));
}

// --- мета-команды ----------------------------------------------------------

function meta(input: string): void {
  const [cmd, ...args] = input.split(/\s+/);
  switch (cmd) {
    case ".tables": {
      const names = db.tableNames();
      console.log(names.length === 0 ? dim("(таблиц нет)") : names.map((n) => yellow(n)).join("\n"));
      return;
    }
    case ".schema": {
      const name = args[0];
      if (!name) return void console.log(red("использование: .schema <table>"));
      if (!db.hasTable(name)) return void console.log(red(`нет таблицы ${name}`));
      const s = db.table(name).schema;
      const cols = s.columns
        .map((c) => `${yellow(c.name)} ${cyan(c.type)}${c.name === s.primaryKey ? dim(" PK") : ""}`)
        .join(", ");
      console.log(`${bold(name)}(${cols})`);
      return;
    }
    case ".help": {
      console.log("SQL: CREATE TABLE / INSERT / SELECT ... WHERE (несколько через ';')");
      console.log(`Мета: ${yellow(".tables")} ${yellow(".schema <t>")} ${yellow(".help")} ${yellow(".exit")}`);
      return;
    }
    case ".exit":
    case ".quit": {
      rl.close();
      return;
    }
    default:
      console.log(red(`неизвестная мета-команда: ${cmd}`), dim("(.help)"));
  }
}
