/** Вспомогательное для тестов: уникальные временные файлы лога. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Создать пустую временную директорию под тест. */
export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "tiny-db-"));
}

/** Уникальный путь к файлу лога внутри временной директории. */
export function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = tmpDir();
  return {
    path: join(dir, "data.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
