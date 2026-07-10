/**
 * REPL — интерактивная оболочка над движком хранения.
 *
 * Команды:
 *   SET <key> <value...>   записать значение (value может содержать пробелы)
 *   GET <key>              прочитать значение
 *   DEL <key>              удалить ключ
 *   KEYS                   вывести все ключи
 *   SIZE                   число ключей
 *   COMPACT                схлопнуть лог
 *   HELP                   справка
 *   EXIT                   выход
 *
 * Оформление — только ANSI-коды и встроенный readline (цвет, история по ↑),
 * никаких новых зависимостей. Логика базы не меняется.
 *
 * Файл лога берётся из аргумента: `tsx src/repl.ts data.db` (по умолчанию data.db).
 */

import { createInterface } from "node:readline";
import { Database } from "./db.ts";
import { green, red, cyan, yellow, dim, bold, magenta } from "./ansi.ts";

const path = process.argv[2] ?? "data.db";
const db = new Database(path);

/** Список команд для справки: имя, аргументы, описание. */
const COMMANDS: [cmd: string, args: string, desc: string][] = [
  ["SET", "<key> <value>", "записать значение"],
  ["GET", "<key>", "прочитать значение"],
  ["DEL", "<key>", "удалить ключ"],
  ["KEYS", "", "все ключи"],
  ["SIZE", "", "число ключей"],
  ["COMPACT", "", "схлопнуть лог (убрать мёртвые записи)"],
  ["HELP", "", "эта справка"],
  ["EXIT", "", "выход"],
];

function helpText(): string {
  const lines = COMMANDS.map(([cmd, args, desc]) => {
    const left = `${yellow(cmd)} ${dim(args)}`.padEnd(args ? 34 : 22);
    return `  ${left}${dim(desc)}`;
  });
  return `${bold("Команды:")}\n${lines.join("\n")}`;
}

function banner(): void {
  const bar = magenta("─".repeat(44));
  console.log(bar);
  console.log(`  ${bold(magenta("tiny-db"))} ${dim("— своя БД на append-only логе")}`);
  console.log(bar);
  console.log(`  файл: ${cyan(path)}   ключей: ${yellow(String(db.size))}`);
  console.log(`  ${dim("подсказка: ↑ — история команд, HELP — справка")}`);
  console.log(bar);
  console.log(helpText());
  console.log(bar);
}

banner();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY), // включает историю по ↑ и редактирование строки
  historySize: 1000,
  prompt: `${bold(magenta("tiny-db"))} ${dim("›")} `,
});
rl.prompt();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed !== "") handle(trimmed);
  rl.prompt();
});

rl.on("close", () => {
  db.close();
  console.log(dim("пока!"));
  process.exit(0);
});

/** Печать: успех / значение / ошибка / пусто. */
const ok = (s: string) => console.log(green(s));
const val = (s: string) => console.log(cyan(s));
const err = (s: string) => console.log(red(s));
const nil = () => console.log(dim("(nil)"));

function handle(input: string): void {
  const sp = input.indexOf(" ");
  const cmd = (sp === -1 ? input : input.slice(0, sp)).toUpperCase();
  const rest = sp === -1 ? "" : input.slice(sp + 1).trim();

  switch (cmd) {
    case "SET": {
      const sp2 = rest.indexOf(" ");
      if (sp2 === -1) {
        err("использование: SET <key> <value>");
        return;
      }
      const key = rest.slice(0, sp2);
      const value = rest.slice(sp2 + 1);
      db.set(key, value);
      ok("OK");
      return;
    }
    case "GET": {
      if (rest === "") return err("использование: GET <key>");
      const v = db.get(rest);
      if (v === undefined) nil();
      else val(v);
      return;
    }
    case "DEL": {
      if (rest === "") return err("использование: DEL <key>");
      if (db.delete(rest)) ok("OK");
      else nil();
      return;
    }
    case "KEYS": {
      const ks = db.keys();
      if (ks.length === 0) console.log(dim("(пусто)"));
      else console.log(ks.map((k) => yellow(k)).join("\n"));
      return;
    }
    case "SIZE": {
      val(String(db.size));
      return;
    }
    case "COMPACT": {
      const before = db.logLength;
      db.compact();
      ok(`OK: записей в логе ${before} → ${db.logLength} (живых ключей ${db.size})`);
      return;
    }
    case "HELP": {
      console.log(helpText());
      return;
    }
    case "EXIT":
    case "QUIT": {
      rl.close();
      return;
    }
    default:
      err(`неизвестная команда: ${cmd}`);
      console.log(dim("HELP — список команд"));
  }
}
