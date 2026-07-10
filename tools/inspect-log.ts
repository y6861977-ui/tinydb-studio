/**
 * Просмотр append-only лога (движок этапов 1–2).
 * Печатает каждую запись с байтовым смещением и итог по «мусору».
 *
 * Запуск:  npx tsx tools/inspect-log.ts <файл>   (по умолчанию data.db)
 */

import { readFileSync, existsSync } from "node:fs";
import { decodeLog } from "../src/record.ts";

const path = process.argv[2] ?? "data.db";
if (!existsSync(path)) {
  console.error(`нет файла: ${path}`);
  process.exit(1);
}

const buf = readFileSync(path);
const records = decodeLog(buf);

console.log(`файл: ${path} (${buf.length} байт, записей: ${records.length})`);
console.log("offset  op   запись");
console.log("------  ---  ----------------------------------------");

const live = new Map<string, string>();
let off = 0;
for (const r of records) {
  const start = off;
  if (r.op === 0) {
    off += 1 + 4 + Buffer.byteLength(r.key, "utf8") + 4 + Buffer.byteLength(r.value, "utf8");
    console.log(`${String(start).padStart(5)}   SET  ${JSON.stringify(r.key)} = ${JSON.stringify(r.value)}`);
    live.set(r.key, r.value);
  } else {
    off += 1 + 4 + Buffer.byteLength(r.key, "utf8");
    console.log(`${String(start).padStart(5)}   DEL  ${JSON.stringify(r.key)}  надгробие`);
    live.delete(r.key);
  }
}

const garbage = records.length - live.size;
console.log("----------------------------------------------------");
console.log(`живых ключей: ${live.size}, мёртвых записей: ${garbage} (компакция уберёт их)`);
