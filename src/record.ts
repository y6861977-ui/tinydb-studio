/**
 * Бинарный формат одной записи append-only лога.
 *
 * Формат (binary-safe, любые байты в ключе/значении допустимы):
 *
 *   SET:  [ op=0 : 1B ][ keyLen : 4B BE ][ key ][ valLen : 4B BE ][ value ]
 *   DEL:  [ op=1 : 1B ][ keyLen : 4B BE ][ key ]
 *
 * Длины хранятся как uint32 big-endian, ключ/значение — UTF-8.
 * Формат длино-префиксный, поэтому в данных могут быть любые символы
 * (переводы строк, нули и т.п.) — в отличие от построчного текстового лога.
 */

export const OP_SET = 0;
export const OP_DEL = 1;

/** Одна операция, восстановленная из лога. */
export type Record =
  | { op: typeof OP_SET; key: string; value: string }
  | { op: typeof OP_DEL; key: string };

/** Закодировать SET в буфер для дозаписи в лог. */
export function encodeSet(key: string, value: string): Buffer {
  const keyBuf = Buffer.from(key, "utf8");
  const valBuf = Buffer.from(value, "utf8");
  const buf = Buffer.allocUnsafe(1 + 4 + keyBuf.length + 4 + valBuf.length);
  let off = 0;
  off = buf.writeUInt8(OP_SET, off);
  off = buf.writeUInt32BE(keyBuf.length, off);
  off += keyBuf.copy(buf, off);
  off = buf.writeUInt32BE(valBuf.length, off);
  valBuf.copy(buf, off);
  return buf;
}

/** Закодировать DEL (надгробие/tombstone) в буфер для дозаписи в лог. */
export function encodeDel(key: string): Buffer {
  const keyBuf = Buffer.from(key, "utf8");
  const buf = Buffer.allocUnsafe(1 + 4 + keyBuf.length);
  let off = 0;
  off = buf.writeUInt8(OP_DEL, off);
  off = buf.writeUInt32BE(keyBuf.length, off);
  keyBuf.copy(buf, off);
  return buf;
}

/**
 * Разобрать лог из буфера в последовательность записей.
 *
 * Если в конце файла оказалась «оборванная» запись (процесс упал посреди
 * записи — torn write), она отбрасывается: возвращаются только полностью
 * прочитанные записи. Так лог остаётся восстановимым после сбоя.
 */
export function decodeLog(buf: Buffer): Record[] {
  const records: Record[] = [];
  let off = 0;

  while (off < buf.length) {
    // op(1) + keyLen(4)
    if (off + 5 > buf.length) break;
    const op = buf.readUInt8(off);
    const keyLen = buf.readUInt32BE(off + 1);
    let p = off + 5;

    if (p + keyLen > buf.length) break;
    const key = buf.toString("utf8", p, p + keyLen);
    p += keyLen;

    if (op === OP_DEL) {
      records.push({ op: OP_DEL, key });
      off = p;
      continue;
    }

    if (op === OP_SET) {
      if (p + 4 > buf.length) break;
      const valLen = buf.readUInt32BE(p);
      p += 4;
      if (p + valLen > buf.length) break;
      const value = buf.toString("utf8", p, p + valLen);
      p += valLen;
      records.push({ op: OP_SET, key, value });
      off = p;
      continue;
    }

    // Неизвестный байт операции — дальше лог считаем повреждённым.
    break;
  }

  return records;
}
