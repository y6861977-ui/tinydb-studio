/**
 * Лексер SQL (этап 5) — режет строку на токены.
 *
 * Токены: keyword | ident | number | string | punct | eof.
 * Ключевые слова регистронезависимы (в токене хранится верхний регистр).
 * Идентификаторы сохраняют регистр. Строки — в одинарных кавычках, кавычка
 * внутри удваивается ('O''Brien'). Поддержаны комментарии `-- до конца строки`.
 */

export type TokenType = "keyword" | "ident" | "number" | "string" | "punct" | "eof";

export interface Token {
  type: TokenType;
  value: string; // для keyword — ВЕРХНИЙ регистр; для string — уже раскодированное значение
  pos: number; // индекс начала токена в исходной строке
}

const KEYWORDS = new Set([
  "CREATE",
  "TABLE",
  "INDEX",
  "ON",
  "INSERT",
  "UPDATE",
  "SET",
  "DELETE",
  "INTO",
  "VALUES",
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "PRIMARY",
  "KEY",
  "INTEGER",
  "TEXT",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "JOIN",
  "ON",
  "AS",
  "GROUP",
  "BY",
]);

// многосимвольные операторы проверяем раньше односимвольных
const PUNCT2 = new Set(["<=", ">=", "<>", "!="]);
const PUNCT1 = new Set(["(", ")", ",", ";", "*", "=", "<", ">", "-", "."]);

class LexError extends Error {}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

/** Разобрать всю строку в массив токенов, заканчивающийся eof. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i]!;

    // пробелы
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    // комментарий -- до конца строки
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    const start = i;

    // число: [0-9]+  (знак минуса разбирает парсер)
    if (isDigit(c)) {
      while (i < n && isDigit(sql[i]!)) i++;
      if (i < n && (sql[i] === "." || isIdentStart(sql[i]!))) {
        throw new LexError(`недопустимое число на позиции ${start}: только целые (INTEGER)`);
      }
      tokens.push({ type: "number", value: sql.slice(start, i), pos: start });
      continue;
    }

    // идентификатор или ключевое слово
    if (isIdentStart(c)) {
      i++;
      while (i < n && isIdentPart(sql[i]!)) i++;
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();
      if (KEYWORDS.has(upper)) tokens.push({ type: "keyword", value: upper, pos: start });
      else tokens.push({ type: "ident", value: word, pos: start });
      continue;
    }

    // строковый литерал в одинарных кавычках
    if (c === "'") {
      i++;
      let str = "";
      let closed = false;
      while (i < n) {
        const ch = sql[i]!;
        if (ch === "'") {
          if (sql[i + 1] === "'") {
            str += "'"; // удвоенная кавычка -> одна
            i += 2;
            continue;
          }
          i++; // закрывающая кавычка
          closed = true;
          break;
        }
        str += ch;
        i++;
      }
      if (!closed) throw new LexError(`незакрытая строка на позиции ${start}`);
      tokens.push({ type: "string", value: str, pos: start });
      continue;
    }

    // пунктуация / операторы
    const two = sql.slice(i, i + 2);
    if (PUNCT2.has(two)) {
      tokens.push({ type: "punct", value: two, pos: start });
      i += 2;
      continue;
    }
    if (PUNCT1.has(c)) {
      tokens.push({ type: "punct", value: c, pos: start });
      i++;
      continue;
    }

    throw new LexError(`неизвестный символ ${JSON.stringify(c)} на позиции ${start}`);
  }

  tokens.push({ type: "eof", value: "", pos: n });
  return tokens;
}
