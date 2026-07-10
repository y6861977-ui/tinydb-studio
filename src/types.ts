/**
 * Система типов таблиц (этап 4).
 *
 * Пока два типа колонок: INTEGER (целое, в безопасном диапазоне Number) и
 * TEXT (строка UTF-8). У таблицы есть схема — упорядоченный список колонок и
 * имя колонки первичного ключа. Значение первичного ключа становится ключом
 * B+-дерева, поэтому доступ по нему идёт за O(log n).
 */

export type ColumnType = "INTEGER" | "TEXT";

/** Значение ячейки. NULL пока не поддерживаем — все колонки обязательны. */
export type Value = number | string;

export interface Column {
  name: string;
  type: ColumnType;
}

export interface TableSchema {
  name: string;
  columns: Column[];
  /** Имя колонки первичного ключа (должна быть среди columns). */
  primaryKey: string;
}

/** Строка: имя колонки -> значение. */
export type Row = Record<string, Value>;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Проверить корректность схемы; бросает при ошибке. */
export function validateSchema(schema: TableSchema): void {
  if (!NAME_RE.test(schema.name)) {
    throw new Error(`недопустимое имя таблицы: ${JSON.stringify(schema.name)}`);
  }
  if (schema.columns.length === 0) {
    throw new Error(`таблица ${schema.name}: нужна хотя бы одна колонка`);
  }
  const seen = new Set<string>();
  for (const col of schema.columns) {
    if (!NAME_RE.test(col.name)) {
      throw new Error(`недопустимое имя колонки: ${JSON.stringify(col.name)}`);
    }
    if (seen.has(col.name)) {
      throw new Error(`дублирующаяся колонка: ${col.name}`);
    }
    seen.add(col.name);
    if (col.type !== "INTEGER" && col.type !== "TEXT") {
      throw new Error(`неизвестный тип колонки ${col.name}: ${col.type}`);
    }
  }
  if (!seen.has(schema.primaryKey)) {
    throw new Error(`первичный ключ ${schema.primaryKey} не найден среди колонок`);
  }
}

/** Найти колонку по имени. */
export function columnOf(schema: TableSchema, name: string): Column {
  const col = schema.columns.find((c) => c.name === name);
  if (!col) throw new Error(`нет колонки ${name} в таблице ${schema.name}`);
  return col;
}

/**
 * Проверить строку на соответствие схеме: все колонки на месте и нужного типа.
 * INTEGER должен быть целым в безопасном диапазоне, TEXT — строкой.
 */
export function validateRow(schema: TableSchema, row: Row): void {
  for (const col of schema.columns) {
    if (!(col.name in row)) {
      throw new Error(`строка без колонки ${col.name}`);
    }
    checkValue(col, row[col.name]!);
  }
  for (const key of Object.keys(row)) {
    if (!schema.columns.some((c) => c.name === key)) {
      throw new Error(`лишняя колонка в строке: ${key}`);
    }
  }
}

/** Проверить одно значение против типа колонки. */
export function checkValue(col: Column, value: Value): void {
  if (col.type === "INTEGER") {
    if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`колонка ${col.name}: ожидалось целое INTEGER, получено ${JSON.stringify(value)}`);
    }
  } else {
    if (typeof value !== "string") {
      throw new Error(`колонка ${col.name}: ожидалась строка TEXT, получено ${JSON.stringify(value)}`);
    }
  }
}
