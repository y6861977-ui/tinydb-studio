/**
 * Сериализация строки таблицы в байты и кодирование первичного ключа (этап 4).
 *
 * Строка (row) -> байты:
 *   колонки идут в порядке схемы, каждое значение кодируется по своему типу:
 *     INTEGER — 8 байт signed big-endian (BigInt64BE)
 *     TEXT    — [len :4B][utf8-байты]
 *
 * Первичный ключ -> строковый ключ B+-дерева:
 *   дерево сравнивает ключи лексикографически, поэтому INTEGER кодируем в
 *   «order-preserving» вид: сдвигаем signed в unsigned (прибавляем 2^63) и
 *   пишем 8 байт big-endian. Тогда порядок байтов == числовой порядок (и для
 *   отрицательных). Байты представляем latin1-строкой (по байту на символ).
 *   TEXT-ключ используем как есть — строковый порядок естественный.
 */

import type { ColumnType, TableSchema, Value } from "./types.ts";
import { columnOf } from "./types.ts";

// --- строка <-> байты ------------------------------------------------------

export function serializeRow(schema: TableSchema, row: Record<string, Value>): Buffer {
  const parts: Buffer[] = [];
  for (const col of schema.columns) {
    const v = row[col.name]!;
    if (col.type === "INTEGER") {
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(BigInt(v as number));
      parts.push(b);
    } else {
      const s = Buffer.from(v as string, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(s.length);
      parts.push(len, s);
    }
  }
  return Buffer.concat(parts);
}

export function deserializeRow(schema: TableSchema, buf: Buffer): Record<string, Value> {
  const row: Record<string, Value> = {};
  let off = 0;
  for (const col of schema.columns) {
    if (col.type === "INTEGER") {
      row[col.name] = Number(buf.readBigInt64BE(off));
      off += 8;
    } else {
      const len = buf.readUInt32BE(off);
      off += 4;
      row[col.name] = buf.toString("utf8", off, off + len);
      off += len;
    }
  }
  return row;
}

// --- значение ключа <-> строковый ключ дерева ------------------------------

/** Закодировать значение произвольной колонки в order-preserving строковый ключ. */
export function encodeValueKey(type: ColumnType, value: Value): string {
  if (type === "INTEGER") {
    const b = Buffer.alloc(8);
    // сдвиг диапазона: signed -> unsigned, чтобы порядок байтов = числовой порядок
    b.writeBigUInt64BE(BigInt(value as number) + (1n << 63n));
    return b.toString("latin1");
  }
  return value as string; // TEXT — как есть
}

/** Закодировать значение первичного ключа в строковый ключ B+-дерева. */
export function encodeKey(schema: TableSchema, value: Value): string {
  return encodeValueKey(columnOf(schema, schema.primaryKey).type, value);
}

// --- значение строки <-> строковое значение дерева -------------------------

/** Байты строки -> строковое значение для хранения в B+-дереве (без потерь). */
export function rowToTreeValue(buf: Buffer): string {
  return buf.toString("latin1");
}

/** Обратно: строковое значение дерева -> байты строки. */
export function treeValueToBuf(s: string): Buffer {
  return Buffer.from(s, "latin1");
}
