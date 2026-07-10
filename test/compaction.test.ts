/** Тесты компакции лога (этап 2): лог схлопывается, данные целы. */

import { statSync } from "node:fs";

import { Database } from "../src/db.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDbPath } from "./util.ts";

// --- лог схлопывается после многих перезаписей ---------------------------
{
  section("компакция: многие перезаписи одного ключа схлопываются");
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);

  for (let i = 0; i < 1000; i++) db.set("counter", String(i));
  checkEqual(db.logLength, 1000, "в логе 1000 записей до компакции");
  checkEqual(db.size, 1, "но живой ключ всего один");
  const sizeBefore = statSync(path).size;

  db.compact();
  checkEqual(db.logLength, 1, "после компакции в логе 1 запись");
  checkEqual(db.get("counter"), "999", "значение цело (последнее победившее)");
  const sizeAfter = statSync(path).size;
  check(sizeAfter < sizeBefore / 100, `файл резко ужался: ${sizeBefore} -> ${sizeAfter} байт`);

  db.close();
  cleanup();
}

// --- надгробия исчезают, данные целы -------------------------------------
{
  section("компакция: надгробия удаляются, живые данные сохраняются");
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);

  db.set("a", "1");
  db.set("b", "2");
  db.set("c", "3");
  db.delete("b"); // надгробие
  db.set("a", "11"); // старая версия a станет мусором
  checkEqual(db.logLength, 5, "5 физических записей до компакции");

  db.compact();
  checkEqual(db.logLength, 2, "после компакции ровно 2 записи (a и c)");
  checkEqual(db.get("a"), "11", "a = актуальное значение");
  checkEqual(db.get("b"), undefined, "удалённый b не воскрес");
  checkEqual(db.get("c"), "3", "c на месте");
  checkEqual(db.size, 2, "size верный");

  db.close();
  cleanup();
}

// --- данные переживают перезапуск ПОСЛЕ компакции ------------------------
{
  section("компакция + replay: новый экземпляр читает схлопнутый лог");
  const { path, cleanup } = tmpDbPath();

  const db1 = new Database(path);
  for (let i = 0; i < 50; i++) db1.set("k", String(i));
  db1.set("stable", "да");
  db1.delete("k");
  db1.compact();
  checkEqual(db1.logLength, 1, "после компакции осталась только 'stable'");
  db1.close();

  const db2 = new Database(path);
  checkEqual(db2.get("stable"), "да", "replay после компакции: данные целы");
  checkEqual(db2.get("k"), undefined, "удалённый ключ так и удалён");
  checkEqual(db2.size, 1, "размер после перезапуска верный");
  checkEqual(db2.logLength, 1, "лог остался плотным");
  db2.close();
  cleanup();
}

// --- запись продолжает работать после компакции --------------------------
{
  section("компакция: после неё можно продолжать писать");
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);

  db.set("x", "1");
  db.compact();
  db.set("y", "2"); // дозапись в уже переоткрытый лог
  db.set("x", "3");
  checkEqual(db.get("x"), "3", "запись после компакции применяется");
  checkEqual(db.get("y"), "2", "новый ключ записан");
  checkEqual(db.logLength, 3, "1 (после компакции) + 2 дозаписи");

  const db2 = new Database(path); // и это всё переживает перезапуск
  checkEqual(db2.get("x"), "3", "дозаписи после компакции переживают replay");
  checkEqual(db2.get("y"), "2", "и второй ключ тоже");
  db.close();
  db2.close();
  cleanup();
}

// --- компакция пустой БД -------------------------------------------------
{
  section("компакция: пустая БД не ломается");
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  db.set("tmp", "x");
  db.delete("tmp"); // всё удалено -> живых ключей 0
  db.compact();
  checkEqual(db.logLength, 0, "пустой лог после компакции");
  checkEqual(db.size, 0, "живых ключей нет");
  check(statSync(path).size === 0, "файл лога стал нулевого размера");
  db.close();
  cleanup();
}

// --- фрагментация как метрика -------------------------------------------
{
  section("метрика фрагментации");
  const { path, cleanup } = tmpDbPath();
  const db = new Database(path);
  for (let i = 0; i < 10; i++) db.set("k", String(i)); // 10 записей, 1 живая
  check(Math.abs(db.fragmentation - 0.9) < 1e-9, "фрагментация 0.9 (9 из 10 мусор)");
  db.compact();
  checkEqual(db.fragmentation, 0, "после компакции фрагментация 0");
  db.close();
  cleanup();
}
