/**
 * Минимальные ANSI-цвета для REPL. Без зависимостей.
 * Цвет автоматически отключается, если вывод не в терминал (пайп/файл) или
 * задан NO_COLOR — тогда функции возвращают строку как есть.
 */

const enabled = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];

function wrap(open: number, close: number) {
  return (s: string): string => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const colorEnabled = enabled;

export const green = wrap(32, 39); // OK / успех
export const red = wrap(31, 39); // ошибки
export const cyan = wrap(36, 39); // значения
export const yellow = wrap(33, 39); // ключи / акценты
export const dim = wrap(2, 22); // (nil), подсказки
export const bold = wrap(1, 22);
export const magenta = wrap(35, 39);
