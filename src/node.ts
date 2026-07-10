/**
 * Узлы B+-дерева и их сериализация в страницу 4 КБ.
 *
 * Два вида узлов:
 *   LEAF     — хранит сами пары ключ→значение (все данные лежат в листьях).
 *   INTERNAL — хранит разделительные ключи и ссылки на дочерние страницы.
 *
 * B+-дерево: значения только в листьях; листья связаны в список (next) для
 * упорядоченного обхода. Внутренние узлы — лишь «указатели пути».
 *
 * Формат страницы (big-endian):
 *   LEAF:      [type=1 :1B][numKeys :2B][next :4B]
 *              затем numKeys записей: [keyLen :2B][key][valLen :4B][value]
 *   INTERNAL:  [type=0 :1B][numKeys :2B][child0 :4B]
 *              затем numKeys раз: [keyLen :2B][key][child :4B]
 *              (итого numKeys ключей и numKeys+1 детей)
 */

import { PAGE_SIZE } from "./pager.ts";

const TYPE_INTERNAL = 0;
const TYPE_LEAF = 1;

export interface LeafNode {
  type: "leaf";
  pageNo: number;
  keys: string[];
  values: string[];
  next: number; // номер следующего листа (0 = нет)
}

export interface InternalNode {
  type: "internal";
  pageNo: number;
  keys: string[]; // разделители, отсортированы
  children: number[]; // длина = keys.length + 1
}

export type Node = LeafNode | InternalNode;

// --- размеры (чтобы решать, влезает ли узел в страницу) --------------------

const LEAF_HEADER = 1 + 2 + 4; // type + numKeys + next
const INTERNAL_HEADER = 1 + 2 + 4; // type + numKeys + child0

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Сколько байт займёт сериализованный узел. */
export function nodeSize(node: Node): number {
  if (node.type === "leaf") {
    let n = LEAF_HEADER;
    for (let i = 0; i < node.keys.length; i++) {
      n += 2 + byteLen(node.keys[i]!) + 4 + byteLen(node.values[i]!);
    }
    return n;
  }
  let n = INTERNAL_HEADER;
  for (const k of node.keys) n += 2 + byteLen(k) + 4;
  return n;
}

/** Помещается ли узел в одну страницу. */
export function fits(node: Node): boolean {
  return nodeSize(node) <= PAGE_SIZE;
}

// --- сериализация ----------------------------------------------------------

export function serialize(node: Node): Buffer {
  const buf = Buffer.alloc(PAGE_SIZE);
  if (node.type === "leaf") {
    buf.writeUInt8(TYPE_LEAF, 0);
    buf.writeUInt16BE(node.keys.length, 1);
    buf.writeUInt32BE(node.next, 3);
    let off = LEAF_HEADER;
    for (let i = 0; i < node.keys.length; i++) {
      off = writeStr(buf, off, node.keys[i]!);
      off = writeStr32(buf, off, node.values[i]!);
    }
    return buf;
  }
  buf.writeUInt8(TYPE_INTERNAL, 0);
  buf.writeUInt16BE(node.keys.length, 1);
  buf.writeUInt32BE(node.children[0]!, 3);
  let off = INTERNAL_HEADER;
  for (let i = 0; i < node.keys.length; i++) {
    off = writeStr(buf, off, node.keys[i]!);
    off = buf.writeUInt32BE(node.children[i + 1]!, off);
  }
  return buf;
}

export function parse(pageNo: number, buf: Buffer): Node {
  const type = buf.readUInt8(0);
  const numKeys = buf.readUInt16BE(1);

  if (type === TYPE_LEAF) {
    const next = buf.readUInt32BE(3);
    const keys: string[] = [];
    const values: string[] = [];
    let off = LEAF_HEADER;
    for (let i = 0; i < numKeys; i++) {
      let k: string;
      [k, off] = readStr(buf, off);
      let v: string;
      [v, off] = readStr32(buf, off);
      keys.push(k);
      values.push(v);
    }
    return { type: "leaf", pageNo, keys, values, next };
  }

  if (type === TYPE_INTERNAL) {
    const children: number[] = [buf.readUInt32BE(3)];
    const keys: string[] = [];
    let off = INTERNAL_HEADER;
    for (let i = 0; i < numKeys; i++) {
      let k: string;
      [k, off] = readStr(buf, off);
      keys.push(k);
      children.push(buf.readUInt32BE(off));
      off += 4;
    }
    return { type: "internal", pageNo, keys, children };
  }

  throw new Error(`неизвестный тип узла: ${type} (страница ${pageNo})`);
}

// --- примитивы записи/чтения строк -----------------------------------------

function writeStr(buf: Buffer, off: number, s: string): number {
  const b = Buffer.from(s, "utf8");
  off = buf.writeUInt16BE(b.length, off);
  off += b.copy(buf, off);
  return off;
}

function writeStr32(buf: Buffer, off: number, s: string): number {
  const b = Buffer.from(s, "utf8");
  off = buf.writeUInt32BE(b.length, off);
  off += b.copy(buf, off);
  return off;
}

function readStr(buf: Buffer, off: number): [string, number] {
  const len = buf.readUInt16BE(off);
  off += 2;
  const s = buf.toString("utf8", off, off + len);
  return [s, off + len];
}

function readStr32(buf: Buffer, off: number): [string, number] {
  const len = buf.readUInt32BE(off);
  off += 4;
  const s = buf.toString("utf8", off, off + len);
  return [s, off + len];
}
