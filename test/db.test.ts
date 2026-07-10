/** Тесты движка хранения: запись, чтение, перезапись, удаление, replay. */

import { Database } from "../src/db.ts";
import { decodeLog, encodeSet, encodeDel } from "../src/record.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDbPath } from "./util.ts";

// --- базовые операции ---------------------------------------------------
{
  section("базовые операции set/get/delete");
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);

  db.set("a", "1");
  db.set("b", "2");
  checkEqual(db.get("a"), "1", "get возвращает записанное значение");
  checkEqual(db.get("b"), "2", "второй ключ читается");
  checkEqual(db.get("missing"), undefined, "отсутствующий ключ -> undefined");
  checkEqual(db.size, 2, "size = число ключей");

  db.set("a", "42"); // перезапись
  checkEqual(db.get("a"), "42", "перезапись обновляет значение");
  checkEqual(db.size, 2, "перезапись не увеличивает size");

  checkEqual(db.delete("b"), true, "delete существующего -> true");
  checkEqual(db.get("b"), undefined, "удалённый ключ не читается");
  checkEqual(db.delete("b"), false, "delete отсутствующего -> false");
  checkEqual(db.size, 1, "size уменьшился после удаления");

  check(db.keys().includes("a") && db.keys().length === 1, "keys() = живые ключи");

  db.close();
  cleanup();
}

// --- replay в новом экземпляре (тот же файл) ----------------------------
{
  section("replay: новый экземпляр восстанавливает состояние из лога");
  const { path, cleanup } = tmpDbPath();

  const db1 = new Database(path);
  db1.set("x", "10");
  db1.set("y", "20");
  db1.set("x", "11"); // перезапись
  db1.delete("y"); // надгробие
  db1.set("z", "30");
  db1.close();

  const db2 = new Database(path);
  checkEqual(db2.get("x"), "11", "replay: последняя запись побеждает");
  checkEqual(db2.get("y"), undefined, "replay: tombstone убирает ключ");
  checkEqual(db2.get("z"), "30", "replay: обычный ключ на месте");
  checkEqual(db2.size, 2, "replay: size корректный");
  db2.close();
  cleanup();
}

// --- binary-safe значения ------------------------------------------------
{
  section("binary-safe: спецсимволы в ключах и значениях");
  const { path, cleanup } = tmpDbPath();
  const tricky = "line1\nline2\t\0end 🚀 кириллица";

  const db1 = new Database(path);
  db1.set("k\nnewline", tricky);
  db1.close();

  const db2 = new Database(path);
  checkEqual(db2.get("k\nnewline"), tricky, "значение с \\n \\t \\0 emoji читается точно");
  db2.close();
  cleanup();
}

// --- кодек записи (unit) -------------------------------------------------
{
  section("кодек: encode -> decodeLog круговой рейс");
  const log = Buffer.concat([
    encodeSet("a", "1"),
    encodeSet("b", "два"),
    encodeDel("a"),
    encodeSet("b", "2"),
  ]);
  const recs = decodeLog(log);
  checkEqual(recs.length, 4, "разобрано 4 записи");
  check(recs[0]?.op === 0 && recs[2]?.op === 1, "типы операций сохранены");

  section("кодек: оборванная запись в конце отбрасывается");
  const torn = Buffer.concat([encodeSet("ok", "yes"), encodeSet("bad", "x").subarray(0, 3)]);
  const recs2 = decodeLog(torn);
  checkEqual(recs2.length, 1, "torn write в хвосте не ломает replay");
  check(recs2[0]?.op === 0 && recs2[0]?.key === "ok", "целая запись до обрыва цела");
}

// --- пустой лог ----------------------------------------------------------
{
  section("пустая БД");
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  checkEqual(db.size, 0, "новая БД пустая");
  check(db.keys().length === 0, "keys() пуст");
  db.close();
  cleanup();
}
