/**
 * Тест durability: данные должны пережить РЕАЛЬНЫЙ перезапуск процесса.
 *
 * Шаг 1: в отдельном дочернем процессе (_writer.ts) пишем данные и выходим.
 * Шаг 2: в текущем процессе открываем тот же файл заново и проверяем, что
 *        всё восстановилось из лога (это и есть настоящая долговечность).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Database } from "../src/db.ts";
import { checkEqual, section } from "./harness.ts";
import { tmpDbPath } from "./util.ts";

const here = dirname(fileURLToPath(import.meta.url));
const writer = join(here, "_writer.ts");

section("durability: данные переживают перезапуск процесса");
const { path, cleanup } = tmpDbPath();

// Шаг 1 — отдельный процесс пишет и завершается.
execFileSync(process.execPath, ["--import", "tsx", writer, path], {
  stdio: "inherit",
});

// Шаг 2 — новый процесс (этот) открывает файл заново.
const db = new Database(path);
checkEqual(db.get("lang"), "TypeScript", "перезапись пережила перезапуск (последняя победила)");
checkEqual(db.get("year"), "2026", "обычный ключ пережил перезапуск");
checkEqual(db.get("temp"), undefined, "удалённый ключ не воскрес");
checkEqual(db.get("многострочный"), "строка1\nстрока2\tтаб", "значение со спецсимволами цело");
checkEqual(db.size, 3, "итоговое число ключей верное");
db.close();
cleanup();
