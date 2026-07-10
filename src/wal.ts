/**
 * Write-Ahead Log и транзакции (этап 8).
 *
 * Транзакция буферизует изменённые страницы в памяти (по всем задействованным
 * файлам — основное дерево таблицы и деревья индексов). Ничего не пишется в
 * файлы данных до COMMIT.
 *
 * COMMIT в два шага (в этом вся надёжность):
 *   persist()    — записать все грязные страницы и маркер COMMIT в WAL + fsync.
 *                  С этого момента транзакция ДОЛГОВЕЧНА, даже если упадём.
 *   checkpoint() — применить страницы к файлам данных (+fsync) и очистить WAL.
 *
 * Если процесс упал между persist() и checkpoint(), при следующем старте
 * recover() проиграет WAL заново (redo идемпотентен — те же байты в те же
 * места). Если WAL оборван до маркера COMMIT — транзакция не считается
 * зафиксированной и отбрасывается (как будто её не было).
 *
 * ROLLBACK: восстановить мета-данные пейджеров и выбросить буфер. WAL при этом
 * не пишется, файлы не тронуты.
 */

import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";

import { PAGE_SIZE, type Pager, type MetaSnapshot, type PageTxn } from "./pager.ts";

const REC_PAGE = 1;
const REC_COMMIT = 2;
const PAGE_HEADER = 1 + 2 + 4 + 4; // type + pathLen + pageNo + dataLen

export class Transaction implements PageTxn {
  /** Грязные страницы: путь файла -> (номер страницы -> байты). */
  private readonly dirty = new Map<string, Map<number, Buffer>>();
  /** Пейджеры и снимок их меты — для отката. */
  private readonly members: { pager: Pager; snap: MetaSnapshot }[] = [];

  constructor(private readonly walPath: string) {}

  // --- PageTxn: вызывается из Pager --------------------------------------

  register(pager: Pager, snap: MetaSnapshot): void {
    this.members.push({ pager, snap });
  }

  stage(path: string, no: number, buf: Buffer): void {
    let pages = this.dirty.get(path);
    if (!pages) {
      pages = new Map();
      this.dirty.set(path, pages);
    }
    pages.set(no, Buffer.from(buf)); // копия — источник могут переиспользовать
  }

  staged(path: string, no: number): Buffer | undefined {
    const b = this.dirty.get(path)?.get(no);
    return b ? Buffer.from(b) : undefined;
  }

  /** Есть ли что фиксировать (иначе WAL не нужен — например у читателя). */
  hasChanges(): boolean {
    return this.dirty.size > 0;
  }

  // --- фиксация / откат ---------------------------------------------------

  /** Записать грязные страницы и маркер COMMIT в WAL, дождаться диска. */
  persist(): void {
    const parts: Buffer[] = [];
    let count = 0;
    for (const [path, pages] of this.dirty) {
      const pathBytes = Buffer.from(path, "utf8");
      for (const [no, data] of pages) {
        const head = Buffer.alloc(PAGE_HEADER);
        head.writeUInt8(REC_PAGE, 0);
        head.writeUInt16BE(pathBytes.length, 1);
        head.writeUInt32BE(no, 3);
        head.writeUInt32BE(data.length, 7);
        parts.push(head, pathBytes, data);
        count++;
      }
    }
    const commit = Buffer.alloc(1 + 4);
    commit.writeUInt8(REC_COMMIT, 0);
    commit.writeUInt32BE(count, 1);
    parts.push(commit);

    const fd = openSync(this.walPath, "w");
    try {
      writeSync(fd, Buffer.concat(parts));
      fsyncSync(fd); // WAL на диске -> транзакция долговечна
    } finally {
      closeSync(fd);
    }
  }

  /** Применить грязные страницы к файлам данных и очистить WAL. */
  checkpoint(): void {
    applyPages(this.dirty);
    rmSync(this.walPath, { force: true });
  }

  /** Полная фиксация: сделать долговечной, затем применить. */
  commit(): void {
    this.persist();
    this.checkpoint();
  }

  /** Откат: вернуть мету пейджеров, выбросить буфер. Файлы не трогались. */
  rollback(): void {
    for (const { pager, snap } of this.members) pager.restoreMeta(snap);
    this.dirty.clear();
  }
}

// --- применение и восстановление -------------------------------------------

/** Записать набор страниц в файлы данных (позиционно) и fsync каждого файла. */
function applyPages(pages: Map<string, Map<number, Buffer>>): void {
  for (const [path, byNo] of pages) {
    const fd = openSync(path, "r+");
    try {
      for (const [no, data] of byNo) writeSync(fd, data, 0, data.length, no * PAGE_SIZE);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

interface ParsedWal {
  committed: boolean;
  pages: Map<string, Map<number, Buffer>>;
}

function parseWal(buf: Buffer): ParsedWal {
  const pages = new Map<string, Map<number, Buffer>>();
  let off = 0;
  let n = 0;
  let committed = false;

  while (off < buf.length) {
    const type = buf.readUInt8(off);
    if (type === REC_PAGE) {
      if (off + PAGE_HEADER > buf.length) break; // оборвано
      const pathLen = buf.readUInt16BE(off + 1);
      const no = buf.readUInt32BE(off + 3);
      const dataLen = buf.readUInt32BE(off + 7);
      let p = off + PAGE_HEADER;
      if (p + pathLen + dataLen > buf.length) break; // оборвано
      const path = buf.toString("utf8", p, p + pathLen);
      p += pathLen;
      const data = Buffer.from(buf.subarray(p, p + dataLen));
      p += dataLen;
      let byNo = pages.get(path);
      if (!byNo) {
        byNo = new Map();
        pages.set(path, byNo);
      }
      byNo.set(no, data);
      n++;
      off = p;
    } else if (type === REC_COMMIT) {
      if (off + 5 > buf.length) break;
      committed = buf.readUInt32BE(off + 1) === n; // счётчик сходится
      break; // COMMIT — последняя запись
    } else {
      break; // мусор
    }
  }
  return { committed, pages };
}

/**
 * Восстановление при старте: если WAL содержит зафиксированную транзакцию —
 * проиграть её в файлы данных (redo). В любом случае удалить WAL.
 */
export function recover(walPath: string): boolean {
  if (!existsSync(walPath)) return false;
  const { committed, pages } = parseWal(readFileSync(walPath));
  if (committed) applyPages(pages);
  rmSync(walPath, { force: true });
  return committed;
}
