/**
 * Пейджер (этап 3) — работа с файлом как с массивом страниц фиксированного
 * размера (4 КБ). Больше никакого «весь индекс в памяти»: данные живут на
 * диске в страницах, читаем/пишем их позиционно по номеру страницы.
 *
 * Раскладка файла:
 *   страница 0  — МЕТА (magic, число страниц, корень дерева, число ключей)
 *   страницы 1..N — узлы B+-дерева (см. btree.ts)
 *
 * Страница 0 никогда не бывает узлом, поэтому rootPageNo === 0 используется
 * как «дерева ещё нет».
 */

import { openSync, existsSync, readSync, writeSync, fsyncSync, closeSync } from "node:fs";

export const PAGE_SIZE = 4096;

const MAGIC = 0x54444231; // "TDB1"

/** Метаданные из страницы 0. */
interface Meta {
  pageCount: number; // всего выделено страниц (включая мета-страницу)
  root: number; // номер корневой страницы дерева (0 = дерева нет)
  count: number; // число живых ключей (для O(1) size)
}

/** Снимок меты для отката транзакции. */
export interface MetaSnapshot {
  pageCount: number;
  root: number;
  count: number;
}

/**
 * То, что Pager ожидает от транзакции (реализует Transaction в wal.ts).
 * Разрыв цикла зависимостей: pager не импортирует wal.
 */
export interface PageTxn {
  register(pager: Pager, snap: MetaSnapshot): void;
  stage(path: string, no: number, buf: Buffer): void;
  staged(path: string, no: number): Buffer | undefined;
}

export class Pager {
  private readonly fd: number;
  private closed = false;
  private meta: Meta;
  /** Активная транзакция или null (обычный режим прямой записи). */
  private txn: PageTxn | null = null;

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    const fresh = !existsSync(path);
    // r+ — чтение и запись без обрезания; w+ — создать новый.
    this.fd = openSync(path, fresh ? "w+" : "r+");

    if (fresh) {
      this.meta = { pageCount: 1, root: 0, count: 0 }; // только мета-страница
      this.saveMeta();
      this.flush();
    } else {
      this.meta = this.loadMeta();
    }
  }

  // --- мета-страница ------------------------------------------------------

  private loadMeta(): Meta {
    const buf = this.readPage(0);
    const magic = buf.readUInt32BE(0);
    if (magic !== MAGIC) throw new Error("не файл tiny-db (неверная сигнатура)");
    return {
      pageCount: buf.readUInt32BE(4),
      root: buf.readUInt32BE(8),
      count: buf.readUInt32BE(12),
    };
  }

  /** Записать мета-страницу на диск (страница 0). */
  saveMeta(): void {
    const buf = Buffer.alloc(PAGE_SIZE);
    buf.writeUInt32BE(MAGIC, 0);
    buf.writeUInt32BE(this.meta.pageCount, 4);
    buf.writeUInt32BE(this.meta.root, 8);
    buf.writeUInt32BE(this.meta.count, 12);
    this.writePage(0, buf);
  }

  get root(): number {
    return this.meta.root;
  }
  set root(pageNo: number) {
    this.meta.root = pageNo;
  }

  get count(): number {
    return this.meta.count;
  }
  set count(n: number) {
    this.meta.count = n;
  }

  /** Всего страниц в файле (включая мета). */
  get pageCount(): number {
    return this.meta.pageCount;
  }

  // --- страницы -----------------------------------------------------------

  /** Прочитать страницу целиком в новый буфер PAGE_SIZE. */
  readPage(pageNo: number): Buffer {
    if (this.closed) throw new Error("Pager закрыт");
    // в транзакции сначала смотрим на буфер несохранённых изменений
    if (this.txn) {
      const staged = this.txn.staged(this.path, pageNo);
      if (staged) return staged;
    }
    const buf = Buffer.alloc(PAGE_SIZE);
    readSync(this.fd, buf, 0, PAGE_SIZE, pageNo * PAGE_SIZE);
    return buf;
  }

  /** Записать страницу (буфер ровно PAGE_SIZE) по её номеру. */
  writePage(pageNo: number, buf: Buffer): void {
    if (this.closed) throw new Error("Pager закрыт");
    if (buf.length !== PAGE_SIZE) throw new Error(`страница должна быть ${PAGE_SIZE} байт`);
    // в транзакции запись буферизуется, а не идёт в файл
    if (this.txn) {
      this.txn.stage(this.path, pageNo, buf);
      return;
    }
    writeSync(this.fd, buf, 0, PAGE_SIZE, pageNo * PAGE_SIZE);
  }

  /** Выделить новую страницу; возвращает её номер (файл вырастет при записи). */
  allocatePage(): number {
    const no = this.meta.pageCount;
    this.meta.pageCount++;
    return no;
  }

  /** Гарантировать попадание всех записей на диск (durability). */
  flush(): void {
    if (this.closed) throw new Error("Pager закрыт");
    if (this.txn) return; // в транзакции долговечность откладывается до COMMIT
    fsyncSync(this.fd);
  }

  // --- транзакции ---------------------------------------------------------

  /** Подключить транзакцию: запись начнёт буферизоваться. */
  attach(txn: PageTxn): void {
    txn.register(this, { pageCount: this.meta.pageCount, root: this.meta.root, count: this.meta.count });
    this.txn = txn;
  }

  /** Отключить транзакцию (после commit/rollback). */
  detach(): void {
    this.txn = null;
  }

  /** Вернуть мету к снимку (при откате). */
  restoreMeta(snap: MetaSnapshot): void {
    this.meta.pageCount = snap.pageCount;
    this.meta.root = snap.root;
    this.meta.count = snap.count;
  }

  close(): void {
    if (this.closed) return;
    closeSync(this.fd);
    this.closed = true;
  }
}
