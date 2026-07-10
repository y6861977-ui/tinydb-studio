/** Тесты B+-дерева на диске (этап 3): страницы, split, поиск, порядок, replay. */

import { statSync } from "node:fs";

import { BTree } from "../src/btree.ts";
import { PAGE_SIZE } from "../src/pager.ts";
import { check, checkEqual, section } from "./harness.ts";
import { tmpDbPath } from "./util.ts";

// --- базовые операции ----------------------------------------------------
{
  section("B+-дерево: базовые get/set/delete");
  const { path, cleanup } = tmpDbPath();
  const t = new BTree(path);

  t.set("banana", "жёлтый");
  t.set("apple", "красный");
  t.set("cherry", "тёмный");
  checkEqual(t.get("apple"), "красный", "get по ключу");
  checkEqual(t.get("nope"), undefined, "отсутствующий ключ -> undefined");
  checkEqual(t.size, 3, "size = 3");

  t.set("apple", "зелёный"); // перезапись
  checkEqual(t.get("apple"), "зелёный", "перезапись значения");
  checkEqual(t.size, 3, "перезапись не растит size");

  checkEqual(t.delete("banana"), true, "delete существующего -> true");
  checkEqual(t.get("banana"), undefined, "удалённый не читается");
  checkEqual(t.delete("banana"), false, "delete отсутствующего -> false");
  checkEqual(t.size, 2, "size уменьшился");

  t.close();
  cleanup();
}

// --- порядок обхода ------------------------------------------------------
{
  section("B+-дерево: обход возвращает ключи по возрастанию");
  const { path, cleanup } = tmpDbPath();
  const t = new BTree(path);
  for (const k of ["d", "a", "c", "b", "e"]) t.set(k, k.toUpperCase());
  checkEqual(t.keys().join(","), "a,b,c,d,e", "keys() отсортированы");
  checkEqual(t.range("b", "e").map(([k]) => k).join(","), "b,c,d", "range [b,e) корректен");
  t.close();
  cleanup();
}

// --- МНОГО ключей: дерево растёт в глубину, данных больше одной страницы ---
{
  section("B+-дерево: 2000 ключей -> многоуровневое дерево на диске");
  const { path, cleanup } = tmpDbPath();
  const t = new BTree(path);

  const N = 2000;
  for (let i = 0; i < N; i++) t.set(key(i), `значение-${i}`);

  checkEqual(t.size, N, `все ${N} ключей на месте`);
  check(t.depth() >= 2, `дерево стало многоуровневым (высота ${t.depth()})`);
  check(t.pageCount > 1, `данные разложены по многим страницам (${t.pageCount} шт.)`);

  const fileBytes = statSync(path).size;
  check(fileBytes > PAGE_SIZE, `файл больше одной страницы: ${fileBytes}B > ${PAGE_SIZE}B`);

  // выборочный и полный поиск
  checkEqual(t.get(key(0)), "значение-0", "первый ключ ищется");
  checkEqual(t.get(key(N - 1)), `значение-${N - 1}`, "последний ключ ищется");
  let allFound = true;
  for (let i = 0; i < N; i++) if (t.get(key(i)) !== `значение-${i}`) allFound = false;
  check(allFound, "все 2000 ключей находятся поиском по дереву");

  // порядок сохраняется на большом объёме
  const ks = t.keys();
  let sorted = ks.length === N;
  for (let i = 1; i < ks.length; i++) if (ks[i - 1]! >= ks[i]!) sorted = false;
  check(sorted, "полный обход упорядочен на 2000 ключах");

  t.close();
  cleanup();
}

// --- durability: данные переживают переоткрытие файла --------------------
{
  section("B+-дерево: данные переживают перезапуск (переоткрытие файла)");
  const { path, cleanup } = tmpDbPath();

  const t1 = new BTree(path);
  const N = 500;
  for (let i = 0; i < N; i++) t1.set(key(i), `v${i}`);
  t1.delete(key(7));
  t1.set(key(0), "перезаписано");
  const depthBefore = t1.depth();
  t1.close(); // «перезапуск»: закрыли файл

  const t2 = new BTree(path); // открыли заново — состояние строится из страниц
  checkEqual(t2.size, N - 1, "size восстановлен из мета-страницы");
  checkEqual(t2.get(key(0)), "перезаписано", "перезапись пережила перезапуск");
  checkEqual(t2.get(key(7)), undefined, "удалённый ключ не воскрес");
  checkEqual(t2.get(key(123)), "v123", "случайный ключ на месте");
  checkEqual(t2.depth(), depthBefore, "структура дерева та же после переоткрытия");
  let ok = true;
  for (let i = 1; i < N; i++) if (i !== 7 && t2.get(key(i)) !== `v${i}`) ok = false;
  check(ok, "все ключи читаются после перезапуска");

  t2.close();
  cleanup();
}

// --- сверка с эталоном (Map) ---------------------------------------------
{
  section("B+-дерево: поведение совпадает с эталонной Map");
  const { path, cleanup } = tmpDbPath();
  const t = new BTree(path);
  const ref = new Map<string, string>();

  // детерминированная псевдослучайная последовательность (без Math.random)
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

  for (let i = 0; i < 1500; i++) {
    const op = rnd() % 3;
    const k = `key${rnd() % 400}`;
    if (op === 0) {
      const v = `val${rnd()}`;
      t.set(k, v);
      ref.set(k, v);
    } else if (op === 1) {
      checkSilent(t.get(k) === ref.get(k));
    } else {
      checkEqual2(t.delete(k), ref.delete(k));
    }
  }
  // финальная полная сверка
  let match = t.size === ref.size;
  for (const [k, v] of ref) if (t.get(k) !== v) match = false;
  check(match, `после 1500 случайных операций дерево == Map (size ${t.size})`);

  t.close();
  cleanup();
}

// --- слишком большая запись отвергается ----------------------------------
{
  section("B+-дерево: пара больше страницы отвергается");
  const { path, cleanup } = tmpDbPath();
  const t = new BTree(path);
  let threw = false;
  try {
    t.set("big", "x".repeat(PAGE_SIZE));
  } catch {
    threw = true;
  }
  check(threw, "set с записью > 4КБ бросает ошибку, а не портит дерево");
  checkEqual(t.size, 0, "дерево осталось пустым");
  t.close();
  cleanup();
}

// ключ фиксированной ширины -> лексикографический порядок = числовой
function key(i: number): string {
  return `k${String(i).padStart(6, "0")}`;
}

// вспомогательные тихие проверки для сверки с Map
let silentFails = 0;
function checkSilent(cond: boolean): void {
  if (!cond) silentFails++;
}
function checkEqual2<T>(a: T, b: T): void {
  if (a !== b) silentFails++;
}
// отразим накопленные тихие расхождения одной проверкой в конце секции сверки
check(silentFails === 0, "промежуточные чтения/удаления совпадали с Map");
