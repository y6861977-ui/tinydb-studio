/**
 * Свой парсер CSV (RFC 4180) — без внешних библиотек.
 *
 * Правила:
 *   - поля разделены запятой, записи — переводом строки (LF или CRLF);
 *   - поле можно взять в двойные кавычки; внутри кавычек допустимы запятые,
 *     переводы строк и сами кавычки, удвоенные ("" -> ").
 *   - ведущий BOM (﻿) игнорируется;
 *   - финальный перевод строки не создаёт лишней пустой записи.
 */

/** Разобрать CSV-текст в массив записей (каждая — массив строковых полей). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false; // было ли хоть что-то в текущей записи (для финальной)

  let i = 0;
  const n = text.length;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) i = 1; // BOM

  for (; i < n; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // пропустить вторую кавычку удвоенной пары
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else if (c === "\r") {
      // часть CRLF — сам перевод обработает следующий \n; одиночный \r игнорируем
    } else {
      field += c;
      sawAny = true;
    }
  }
  // последняя запись без завершающего перевода строки
  if (sawAny || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
