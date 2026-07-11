/** Тесты своего CSV-парсера (RFC 4180): кавычки, экранирование, переводы строк. */

import { parseCsv } from "../src/csv.ts";
import { checkEqual, section } from "./harness.ts";

function eq(actual: string[][], expected: string[][], msg: string): void {
  checkEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}

{
  section("parseCsv: базовые случаи");
  eq(parseCsv("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]], "две строки, три поля");
  eq(parseCsv("hello"), [["hello"]], "одно поле без перевода строки");
  eq(parseCsv("a,,c"), [["a", "", "c"]], "пустое поле в середине");
  eq(parseCsv("a,b\n"), [["a", "b"]], "финальный перевод строки не даёт пустой записи");
  eq(parseCsv(""), [], "пустой ввод — ноль записей");
}

{
  section("parseCsv: кавычки и экранирование");
  eq(parseCsv('"a,b",c'), [["a,b", "c"]], "запятая внутри кавычек");
  eq(parseCsv('"say ""hi""",x'), [['say "hi"', "x"]], "удвоенные кавычки -> одна");
  eq(parseCsv('"line1\nline2",b'), [["line1\nline2", "b"]], "перевод строки внутри кавычек");
  eq(parseCsv('"",x'), [["", "x"]], "пустое поле в кавычках");
}

{
  section("parseCsv: переводы строк и BOM");
  eq(parseCsv("a,b\r\nc,d"), [["a", "b"], ["c", "d"]], "CRLF как разделитель записей");
  eq(parseCsv("﻿a,b"), [["a", "b"]], "ведущий BOM игнорируется");
  eq(parseCsv("x\n\ny"), [["x"], [""], ["y"]], "пустая строка -> запись с одним пустым полем");
}
