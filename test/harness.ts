/**
 * Мини-раннер тестов без фреймворка.
 *
 * Использование:
 *   import { check, section, report } from "./harness.ts";
 *   section("что проверяем");
 *   check(2 + 2 === 4, "арифметика");
 *   report(); // в конце — печатает итог и выставляет код выхода
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

/** Заголовок группы проверок. */
export function section(name: string): void {
  console.log(`\n▸ ${name}`);
}

/** Проверка: условие должно быть истинным. */
export function check(cond: boolean, message: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

/** Проверка равенства с понятным выводом ожидаемого/полученного. */
export function checkEqual<T>(actual: T, expected: T, message: string): void {
  const ok = actual === expected;
  check(ok, ok ? message : `${message} — ожидалось ${fmt(expected)}, получено ${fmt(actual)}`);
}

function fmt(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** Итог. Выставляет код выхода 1, если есть провалы. */
export function report(): void {
  console.log(`\n${"─".repeat(40)}`);
  console.log(`итог: ${passed} прошло, ${failed} провалено`);
  if (failed > 0) {
    console.log("провалено:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log("все тесты зелёные ✓");
  }
}
