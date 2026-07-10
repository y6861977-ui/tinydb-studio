/**
 * Движок хранения (этап 1) — log-structured key-value store.
 *
 * Идея:
 *   - Данные на диске лежат в append-only логе: каждая операция set/delete
 *     дописывается в конец файла и никогда не переписывается на месте.
 *   - В памяти держим индекс Map<key, value> — актуальное состояние.
 *   - При старте проигрываем (replay) весь лог и восстанавливаем индекс:
 *     последняя запись по ключу побеждает, DEL убирает ключ (tombstone).
 *
 * Durability: запись сначала уходит на диск (writeSync + fsyncSync) и только
 * потом отражается в памяти. Поэтому после падения/перезапуска процесса в
 * индексе не окажется данных, которых нет в логе.
 */

import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

import { encodeSet, encodeDel, decodeLog, OP_SET } from "./record.ts";

export class Database {
  /** Актуальное состояние: ключ -> значение. */
  private readonly index = new Map<string, string>();
  /** Дескриптор лога, открытый в режиме дозаписи ("a"). */
  private fd: number;
  private closed = false;
  /** Сколько записей физически лежит в логе (живые + мёртвые версии). */
  private logRecords = 0;

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      this.replay();
    }
    // "a" — все записи гарантированно уходят в конец файла.
    this.fd = openSync(path, "a");
  }

  /** Проиграть лог с диска и восстановить индекс в памяти. */
  private replay(): void {
    const buf = readFileSync(this.path);
    const records = decodeLog(buf);
    this.logRecords = records.length;
    for (const rec of records) {
      if (rec.op === OP_SET) {
        this.index.set(rec.key, rec.value);
      } else {
        this.index.delete(rec.key);
      }
    }
  }

  /** Дописать запись в лог и дождаться её попадания на диск. */
  private append(buf: Buffer): void {
    if (this.closed) throw new Error("Database закрыта");
    writeSync(this.fd, buf);
    fsyncSync(this.fd); // durability: не возвращаемся, пока байты не на диске
    this.logRecords++;
  }

  /** Записать/перезаписать значение по ключу. */
  set(key: string, value: string): void {
    this.append(encodeSet(key, value));
    this.index.set(key, value);
  }

  /** Прочитать значение; undefined, если ключа нет. */
  get(key: string): string | undefined {
    return this.index.get(key);
  }

  /** Есть ли ключ. */
  has(key: string): boolean {
    return this.index.has(key);
  }

  /** Удалить ключ. Возвращает true, если ключ существовал. */
  delete(key: string): boolean {
    if (!this.index.has(key)) return false;
    this.append(encodeDel(key)); // пишем надгробие в лог
    this.index.delete(key);
    return true;
  }

  /** Все живые ключи. */
  keys(): string[] {
    return [...this.index.keys()];
  }

  /** Число живых ключей. */
  get size(): number {
    return this.index.size;
  }

  /** Сколько записей физически в логе (включая устаревшие и надгробия). */
  get logLength(): number {
    return this.logRecords;
  }

  /**
   * Доля «мусора» в логе: сколько записей лишние сверх числа живых ключей.
   * 0.0 — лог идеально плотный, 0.9 — 90% записей устарели.
   */
  get fragmentation(): number {
    if (this.logRecords === 0) return 0;
    return (this.logRecords - this.index.size) / this.logRecords;
  }

  /**
   * Компакция: переписать лог, оставив по одной SET-записи на каждый живой
   * ключ. Старые версии и надгробия исчезают, данные не меняются.
   *
   * Безопасность (атомарность):
   *   1. пишем свежий лог во ВРЕМЕННЫЙ файл и fsync-аем его;
   *   2. атомарно rename поверх старого — на этом шаге данные точно целы
   *      либо в старом, либо уже в новом файле, промежуточного состояния нет;
   *   3. fsync каталога, чтобы сама операция rename дожила до перезапуска;
   *   4. переоткрываем дескриптор дозаписи на новом файле.
   * Если процесс упадёт до шага 2 — остаётся исходный лог, ничего не потеряно.
   */
  compact(): void {
    if (this.closed) throw new Error("Database закрыта");

    const tmp = `${this.path}.compact`;
    const parts: Buffer[] = [];
    for (const [key, value] of this.index) {
      parts.push(encodeSet(key, value));
    }

    // 1. свежий лог во временный файл + fsync
    const tmpFd = openSync(tmp, "w");
    try {
      if (parts.length > 0) writeSync(tmpFd, Buffer.concat(parts));
      fsyncSync(tmpFd);
    } finally {
      closeSync(tmpFd);
    }

    // 2. атомарная замена; старый дескриптор больше не нужен
    closeSync(this.fd);
    renameSync(tmp, this.path);

    // 3. fsync каталога — чтобы rename пережил падение питания
    syncDir(dirname(this.path));

    // 4. новый дескриптор дозаписи; лог теперь плотный
    this.fd = openSync(this.path, "a");
    this.logRecords = this.index.size;
  }

  /** Закрыть дескриптор лога. После этого запись невозможна. */
  close(): void {
    if (this.closed) return;
    closeSync(this.fd);
    this.closed = true;
  }
}

/**
 * fsync каталога — фиксирует на диске саму запись в директории (появление
 * файла под новым именем после rename). Без этого при падении питания rename
 * может «откатиться». Не на всех платформах каталог можно fsync-нуть, поэтому
 * ошибку тихо глотаем — на прочность данных в файле это не влияет.
 */
function syncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, "r");
    fsyncSync(dfd);
  } catch {
    // напр. Windows не даёт fsync каталога — не критично для наших целей
  } finally {
    if (dfd !== undefined) closeSync(dfd);
  }
}
