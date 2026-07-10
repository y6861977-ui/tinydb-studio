/**
 * Отдельный процесс-писатель для теста durability.
 * Пишет данные, закрывает БД и завершается. Тест затем запускает ДРУГОЙ
 * процесс (реальный перезапуск), открывает тот же файл и проверяет данные.
 *
 * Запуск: node --import tsx test/_writer.ts <путь-к-логу>
 */

import { Database } from "../src/db.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: _writer.ts <path>");
  process.exit(2);
}

const db = new Database(path);
db.set("lang", "typescript");
db.set("year", "2026");
db.set("temp", "удалить-меня");
db.delete("temp"); // ключ должен исчезнуть после перезапуска
db.set("lang", "TypeScript"); // перезапись: должно победить последнее
db.set("многострочный", "строка1\nстрока2\tтаб"); // binary-safe проверка
db.close();
