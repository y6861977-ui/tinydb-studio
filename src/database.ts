/**
 * Табличная база данных (этап 4) — управляет таблицами и их схемами.
 *
 * Раскладка на диске (директория):
 *   catalog.log   — каталог: имя таблицы -> схема (JSON). Хранится в нашем же
 *                   лог-движке из этапа 1 (переиспользуем собственный код).
 *   <table>.tbl   — B+-дерево с данными таблицы (этап 3).
 *
 * Каталог durable: после перезапуска схемы восстанавливаются из catalog.log,
 * и таблицы открываются снова.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Database as LogStore } from "./db.ts";
import { Table } from "./table.ts";
import { type TableSchema, validateSchema } from "./types.ts";
import { Transaction, recover } from "./wal.ts";
import { LockManager } from "./locks.ts";

interface IndexDef {
  table: string;
  column: string;
}

export class Database {
  private readonly dir: string;
  private readonly catalog: LogStore; // имя таблицы -> JSON(схема)
  private readonly indexCatalog: LogStore; // имя индекса -> JSON({table, column})
  private readonly tables = new Map<string, Table>();
  private readonly lockManager = new LockManager();
  private txCounter = 0;
  private session: Tx | null = null; // сессионная (SQL BEGIN) транзакция

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });

    // восстановление после сбоя: доиграть зафиксированный WAL в файлы данных
    // ДО открытия таблиц (пейджеры затем прочитают уже согласованное состояние)
    recover(join(dir, "wal.log"));

    this.catalog = new LogStore(join(dir, "catalog.log"));
    this.indexCatalog = new LogStore(join(dir, "indexes.log"));

    // восстановить таблицы из каталога
    for (const name of this.catalog.keys()) {
      const schema = JSON.parse(this.catalog.get(name)!) as TableSchema;
      this.tables.set(name, new Table(schema, this.tablePath(name)));
    }

    // подключить существующие индексы (данные уже на диске, backfill не нужен)
    for (const indexName of this.indexCatalog.keys()) {
      const def = JSON.parse(this.indexCatalog.get(indexName)!) as IndexDef;
      const table = this.tables.get(def.table);
      if (table) table.attachIndex(def.column, this.indexPath(def.table, def.column));
    }
  }

  private tablePath(name: string): string {
    return join(this.dir, `${name}.tbl`);
  }

  private indexPath(table: string, column: string): string {
    return join(this.dir, `${table}__${column}.idx`);
  }

  private walPath(): string {
    return join(this.dir, "wal.log");
  }

  // --- транзакции и конкурентность (этапы 8–9) ----------------------------

  /**
   * Начать НОВУЮ транзакцию. Несколько таких могут жить одновременно; их
   * взаимную безопасность обеспечивают блокировки таблиц (strict 2PL).
   */
  beginTransaction(): Tx {
    return new Tx(this, ++this.txCounter, new Transaction(this.walPath()), this.lockManager);
  }

  /** Идёт ли сейчас сессионная (SQL BEGIN) транзакция. */
  get inTransaction(): boolean {
    return this.session !== null;
  }

  /** BEGIN: начать сессионную транзакцию (для SQL/REPL). */
  begin(): void {
    if (this.session) throw new Error("транзакция уже открыта");
    this.session = this.beginTransaction();
  }

  /** COMMIT сессионной транзакции. */
  commit(): void {
    if (!this.session) throw new Error("нет открытой транзакции");
    this.session.commit();
    this.session = null;
  }

  /** ROLLBACK сессионной транзакции. */
  rollback(): void {
    if (!this.session) throw new Error("нет открытой транзакции");
    this.session.rollback();
    this.session = null;
  }

  /**
   * Выполнить операцию в транзакции: внутри открытой сессионной, иначе в
   * неявной (autocommit) с откатом при ошибке. Через переданный Tx операция
   * берёт нужные блокировки таблиц.
   */
  runAutocommit<T>(fn: (tx: Tx) => T): T {
    if (this.session) return fn(this.session);
    const tx = this.beginTransaction();
    try {
      const r = fn(tx);
      tx.commit();
      return r;
    } catch (e) {
      tx.rollback();
      throw e;
    }
  }

  /** Внутреннее: получить таблицу без блокировок (для Tx и инспекции). */
  tableRef(name: string): Table {
    return this.table(name);
  }

  /** CREATE TABLE: создать таблицу и durably записать её схему в каталог. */
  createTable(schema: TableSchema): Table {
    if (this.session) throw new Error("DDL (CREATE TABLE) внутри транзакции не поддерживается");
    validateSchema(schema);
    if (this.tables.has(schema.name)) {
      throw new Error(`таблица ${schema.name} уже существует`);
    }
    this.catalog.set(schema.name, JSON.stringify(schema)); // durable (fsync в логе)
    const table = new Table(schema, this.tablePath(schema.name));
    this.tables.set(schema.name, table);
    return table;
  }

  /** CREATE INDEX: создать индекс на колонке таблицы (durably). */
  createIndex(indexName: string, tableName: string, column: string): void {
    if (this.session) throw new Error("DDL (CREATE INDEX) внутри транзакции не поддерживается");
    const table = this.table(tableName);
    if (this.indexCatalog.has(indexName)) {
      throw new Error(`индекс ${indexName} уже существует`);
    }
    // сначала строим индекс (тут же проверки колонки/дубликата), потом фиксируем
    table.createIndex(column, this.indexPath(tableName, column));
    this.indexCatalog.set(indexName, JSON.stringify({ table: tableName, column }));
  }

  /**
   * DROP TABLE: удалить таблицу вместе с её вторичными индексами и стереть
   * файлы данных с диска. Схема убирается из каталога durable-tombstone'ом,
   * поэтому после этого имя свободно — можно создать таблицу заново.
   */
  dropTable(name: string): void {
    if (this.session) throw new Error("DDL (DROP TABLE) внутри транзакции не поддерживается");
    const table = this.tables.get(name);
    if (!table) throw new Error(`нет таблицы ${name}`);

    // собрать индексы этой таблицы и убрать их из каталога индексов
    const indexColumns: string[] = [];
    for (const indexName of this.indexCatalog.keys()) {
      const def = JSON.parse(this.indexCatalog.get(indexName)!) as IndexDef;
      if (def.table !== name) continue;
      indexColumns.push(def.column);
      this.indexCatalog.delete(indexName);
    }

    table.close(); // закрыть дескрипторы основного дерева и индексов
    this.tables.delete(name);
    this.catalog.delete(name); // durable: схема больше не восстановится

    // стереть файлы данных с диска
    rmSync(this.tablePath(name), { force: true });
    for (const col of indexColumns) rmSync(this.indexPath(name, col), { force: true });
  }

  /** Получить таблицу по имени. */
  table(name: string): Table {
    const t = this.tables.get(name);
    if (!t) throw new Error(`нет таблицы ${name}`);
    return t;
  }

  /** Есть ли такая таблица. */
  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  /** Имена всех таблиц. */
  tableNames(): string[] {
    return [...this.tables.keys()];
  }

  close(): void {
    if (this.session) this.rollback(); // незакрытая сессионная транзакция откатывается
    for (const t of this.tables.values()) t.close();
    this.catalog.close();
    this.indexCatalog.close();
  }
}

/**
 * Транзакция с блокировками (этап 9). Изолирует параллельные операции: при
 * первом обращении к таблице берёт S- (чтение) или X- (запись) блокировку и
 * держит её до commit/rollback (strict 2PL). При записи подключает свой буфер
 * WAL к деревьям таблицы. Конфликт блокировок -> ConflictError (no-wait).
 */
export class Tx {
  private readonly locked = new Map<string, "S" | "X">();
  private readonly attached = new Set<string>(); // таблицы, к которым подключён буфер
  private done = false;

  constructor(
    private readonly db: Database,
    readonly id: number,
    private readonly wal: Transaction,
    private readonly locks: LockManager,
  ) {}

  private ensureActive(): void {
    if (this.done) throw new Error("транзакция уже завершена");
  }

  /** Получить таблицу для чтения (S-блокировка). */
  read(name: string): Table {
    this.ensureActive();
    const table = this.db.tableRef(name);
    if (!this.locked.has(name)) {
      this.locks.acquireShared(name, this.id);
      this.locked.set(name, "S");
    }
    return table;
  }

  /** Получить таблицу для записи (X-блокировка + подключение буфера). */
  write(name: string): Table {
    this.ensureActive();
    const table = this.db.tableRef(name);
    if (this.locked.get(name) !== "X") {
      this.locks.acquireExclusive(name, this.id);
      this.locked.set(name, "X");
    }
    if (!this.attached.has(name)) {
      table.attachTxn(this.wal);
      this.attached.add(name);
    }
    return table;
  }

  /** Зафиксировать: применить буфер через WAL (если есть), снять блокировки. */
  commit(): void {
    this.ensureActive();
    if (this.wal.hasChanges()) this.wal.commit();
    this.finish();
  }

  /** Откатить: выбросить буфер, снять блокировки. */
  rollback(): void {
    this.ensureActive();
    this.wal.rollback();
    this.finish();
  }

  private finish(): void {
    for (const name of this.attached) this.db.tableRef(name).detachTxn();
    this.locks.releaseAll(this.id);
    this.done = true;
  }
}
