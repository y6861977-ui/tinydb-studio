/**
 * Точка входа тестов: импортирует все *.test.ts (они выполняются при импорте)
 * и печатает общий итог. Запуск: `npm test` или `tsx test/run.ts`.
 */

import "./db.test.ts";
import "./durability.test.ts";
import "./compaction.test.ts";
import "./btree.test.ts";
import "./table.test.ts";
import "./sql.test.ts";
import "./executor.test.ts";
import "./index.test.ts";
import "./wal.test.ts";
import "./concurrency.test.ts";
import "./query.test.ts";
import "./mutations.test.ts";
import "./droptable.test.ts";
import "./tree-structure.test.ts";
import { report } from "./harness.ts";

report();
