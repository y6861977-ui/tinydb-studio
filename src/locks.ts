/**
 * Менеджер блокировок (этап 9) — блокировки на уровне таблиц для строгого
 * двухфазного протокола (strict 2PL).
 *
 * Режимы:
 *   S (shared)    — на чтение: несколько транзакций одновременно.
 *   X (exclusive) — на запись: только одна, без параллельных читателей.
 *
 * Стратегия no-wait: если запрошенная блокировка конфликтует с чужой —
 * сразу бросаем ConflictError (не ждём). Никакого ожидания => взаимоблокировок
 * (deadlock) не бывает в принципе. Приложение может повторить транзакцию.
 *
 * Блокировки держатся до конца транзакции (commit/rollback) — это и есть
 * «строгий» 2PL, дающий сериализуемость.
 */

export class ConflictError extends Error {}

interface LockEntry {
  shared: Set<number>; // id транзакций с S-блокировкой
  exclusive: number | null; // id транзакции с X-блокировкой
}

export class LockManager {
  private readonly locks = new Map<string, LockEntry>();

  private entry(table: string): LockEntry {
    let e = this.locks.get(table);
    if (!e) {
      e = { shared: new Set(), exclusive: null };
      this.locks.set(table, e);
    }
    return e;
  }

  /** Взять S-блокировку на таблицу (чтение). */
  acquireShared(table: string, tx: number): void {
    const e = this.entry(table);
    if (e.exclusive !== null && e.exclusive !== tx) {
      throw new ConflictError(`таблица ${table} занята на запись транзакцией ${e.exclusive}`);
    }
    e.shared.add(tx);
  }

  /** Взять X-блокировку на таблицу (запись); апгрейд с S при необходимости. */
  acquireExclusive(table: string, tx: number): void {
    const e = this.entry(table);
    if (e.exclusive !== null && e.exclusive !== tx) {
      throw new ConflictError(`таблица ${table} занята на запись транзакцией ${e.exclusive}`);
    }
    for (const holder of e.shared) {
      if (holder !== tx) {
        throw new ConflictError(`таблица ${table} занята на чтение транзакцией ${holder}`);
      }
    }
    e.shared.delete(tx); // апгрейд S -> X
    e.exclusive = tx;
  }

  /** Снять все блокировки транзакции (при commit/rollback). */
  releaseAll(tx: number): void {
    for (const e of this.locks.values()) {
      e.shared.delete(tx);
      if (e.exclusive === tx) e.exclusive = null;
    }
  }
}
