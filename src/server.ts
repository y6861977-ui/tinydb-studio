/**
 * tinydb Studio — HTTP-сервер поверх нашего движка (node:http, без зависимостей).
 *
 * Движок базы НЕ переписываем: импортируем Database и executeProgram как есть.
 *
 * Возможности:
 *   - авторизация по логину/паролю (сессия в cookie);
 *   - несколько баз данных внутри корневой директории, создание новой из UI;
 *   - выполнение SQL и просмотр таблиц выбранной базы.
 *
 * Маршруты:
 *   GET  /                      — страница админки (web/tinydb-studio.html)
 *   POST /api/login {user,pass} — вход, ставит cookie sid; иначе 401
 *   POST /api/logout            — выход
 *   GET  /api/databases         — [{ name, tables }]
 *   POST /api/databases {name}  — создать базу
 *   POST /api/databases/delete {name} — удалить базу (закрыть + стереть файлы)
 *   GET  /api/tables?db=NAME    — [{ name, rowCount, columns }]
 *   POST /api/query {db,sql,noHistory?} — выполнить SQL -> { columns, rows, stats } | 400 { error }
 *
 * Все /api (кроме login) требуют авторизации.
 *
 * Запуск: tsx src/server.ts [root=studio-data] [port=8080]
 *   логин/пароль: env STUDIO_USER / STUDIO_PASS (по умолчанию admin / admin)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Database } from "./database.ts";
import { executeProgram, type ExecResult } from "./sql/executor.ts";

const root = process.argv[2] ?? "studio-data";
const port = Number(process.argv[3] ?? process.env["PORT"] ?? 8080);
// Безопасность: по умолчанию слушаем ТОЛЬКО loopback (127.0.0.1), чтобы админка
// и данные не были доступны из локальной сети. Открыть наружу можно осознанно
// через STUDIO_HOST=0.0.0.0 (тогда обязательно смените логин/пароль).
const host = process.env["STUDIO_HOST"] ?? "127.0.0.1";
const USER = process.env["STUDIO_USER"] ?? "admin";
const PASS = process.env["STUDIO_PASS"] ?? "admin";

// Время жизни сессии и параметры анти-брутфорса для входа.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 часов
const LOGIN_MAX_FAILS = 10; // столько неудач с одного адреса...
const LOGIN_LOCK_MS = 60 * 1000; // ...затем блокировка входа на минуту

/** Сравнение строк за постоянное время (защита от timing-атак по паролю). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // всё равно тратим сопоставимое время
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

mkdirSync(root, { recursive: true });

// --- реестр открытых баз ----------------------------------------------------

const databases = new Map<string, Database>();

for (const entry of readdirSync(root)) {
  if (entry.startsWith("_")) continue; // служебные базы (напр. __studio) не показываем
  const p = join(root, entry);
  if (statSync(p).isDirectory() && existsSync(join(p, "catalog.log"))) {
    databases.set(entry, new Database(p));
  }
}

function createDatabase(name: string): void {
  if (!NAME_RE.test(name)) throw new Error("имя базы: латиница, цифры, _ и - (до 40 символов)");
  if (name.startsWith("_")) throw new Error("имя базы не может начинаться с _ (зарезервировано)");
  if (databases.has(name)) throw new Error(`база ${name} уже существует`);
  databases.set(name, new Database(join(root, name)));
}

function deleteDatabase(name: string): void {
  if (name.startsWith("_")) throw new Error("служебную базу удалить нельзя");
  const db = databases.get(name);
  if (!db) throw new Error(`базы ${name} нет`);
  db.close(); // закрыть файловые дескрипторы движка перед удалением файлов
  databases.delete(name);
  rmSync(join(root, name), { recursive: true, force: true });
}

// --- служебная база истории запросов (не видна пользователю) ----------------

const historyDb = new Database(join(root, "__studio"));
if (!historyDb.hasTable("query_history")) {
  executeProgram(historyDb, "CREATE TABLE query_history (id INTEGER PRIMARY KEY, sql TEXT, created_at TEXT)");
}
let historyCounter = historyDb
  .table("query_history")
  .all()
  .reduce((m, r) => Math.max(m, r["id"] as number), 0);

/** Записать успешно выполненный SQL в историю (через наш движок). Не критично. */
function recordHistory(sqlText: string): void {
  try {
    const id = ++historyCounter;
    const created = new Date().toISOString();
    executeProgram(
      historyDb,
      `INSERT INTO query_history (id, sql, created_at) VALUES (${id}, ${formatLiteral("TEXT", sqlText)}, ${formatLiteral("TEXT", created)})`,
    );
  } catch {
    // сбой записи истории не должен ломать основной запрос
  }
}

function handleHistory(res: ServerResponse): void {
  const list = historyDb
    .table("query_history")
    .all()
    .map((r) => ({ id: r["id"], sql: r["sql"], created_at: r["created_at"] }))
    .sort((a, b) => (b.id as number) - (a.id as number))
    .slice(0, 50);
  sendJson(res, 200, list);
}

/** Очистить историю запросов (через наш движок) и сбросить счётчик id. */
function handleClearHistory(res: ServerResponse): void {
  try {
    executeProgram(historyDb, "DELETE FROM query_history");
    historyCounter = 0;
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

// --- сессии -----------------------------------------------------------------

// токен -> время истечения (мс). Просроченные сессии не действуют и вычищаются.
const sessions = new Map<string, number>();
// адрес -> {число неудачных входов, время окончания блокировки}
const loginFails = new Map<string, { count: number; until: number }>();

function cookieSid(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === "sid") return v ?? null;
  }
  return null;
}

function isAuthed(req: IncomingMessage): boolean {
  const s = cookieSid(req);
  if (!s) return false;
  const expires = sessions.get(s);
  if (expires === undefined) return false;
  if (Date.now() > expires) {
    sessions.delete(s); // сессия протухла
    return false;
  }
  return true;
}

function clientAddr(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "?";
}

// --- ответы -----------------------------------------------------------------

interface QueryResponse {
  columns: string[];
  rows: (string | number)[][];
  stats: { rows: number; scanned: number; plan: string };
}

function toResponse(res: ExecResult): QueryResponse {
  if (res.kind === "selected") {
    return {
      columns: res.columns,
      rows: res.rows.map((r) => res.columns.map((c) => r[c] as string | number)),
      stats: { rows: res.rows.length, scanned: res.scanned, plan: res.usedIndex ?? "seq" },
    };
  }
  const plan =
    res.kind === "inserted"
      ? `вставлено строк: ${res.count} (в ${res.table})`
      : res.kind === "deleted"
        ? `удалено строк: ${res.count} (из ${res.table})`
        : res.kind === "updated"
          ? `обновлено строк: ${res.count} (в ${res.table})`
          : res.kind === "created"
            ? `таблица ${res.table} создана`
            : res.kind === "created_index"
              ? `индекс ${res.name} создан (${res.table}.${res.column})`
              : res.action;
  return { columns: [], rows: [], stats: { rows: 0, scanned: 0, plan } };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff", // не давать браузеру угадывать MIME
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        // явный reject и разрыв — иначе промис завис бы (нет 'end' после destroy)
        done(() => reject(new Error("тело запроса слишком большое")));
        req.destroy();
      }
    });
    req.on("end", () => done(() => resolve(data)));
    req.on("error", (e) => done(() => reject(e)));
    req.on("aborted", () => done(() => reject(new Error("запрос прерван"))));
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  return JSON.parse(await readBody(req)) as T;
}

// --- обработчики ------------------------------------------------------------

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const addr = clientAddr(req);
  const fail = loginFails.get(addr);
  if (fail && fail.until > Date.now()) {
    // адрес временно заблокирован после серии неудач (анти-брутфорс)
    sendJson(res, 429, { error: "слишком много попыток, попробуйте позже" });
    return;
  }

  let creds: { user?: string; password?: string };
  try {
    creds = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "ожидался JSON { user, password }" });
    return;
  }

  // оба сравнения выполняем всегда и за постоянное время (без short-circuit),
  // чтобы по времени ответа нельзя было угадывать логин/пароль
  const userOk = constantTimeEqual(typeof creds.user === "string" ? creds.user : "", USER);
  const passOk = constantTimeEqual(typeof creds.password === "string" ? creds.password : "", PASS);
  if (userOk && passOk) {
    loginFails.delete(addr); // успех сбрасывает счётчик неудач
    const token = randomBytes(24).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": `sid=${token}; HttpOnly; Path=/; SameSite=Strict` });
  } else {
    const count = (fail && fail.until > Date.now() ? fail.count : (fail?.count ?? 0)) + 1;
    loginFails.set(addr, { count, until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0 });
    sendJson(res, 401, { error: "неверный логин или пароль" });
  }
}

function handleLogout(req: IncomingMessage, res: ServerResponse): void {
  const s = cookieSid(req);
  if (s) sessions.delete(s);
  sendJson(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; Path=/; Max-Age=0" });
}

function handleListDatabases(res: ServerResponse): void {
  const list = [...databases.entries()].map(([name, db]) => ({ name, tables: db.tableNames().length }));
  sendJson(res, 200, list);
}

async function handleCreateDatabase(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { name } = await readJson<{ name?: string }>(req);
    createDatabase(name ?? "");
    sendJson(res, 200, { ok: true, name });
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

async function handleDeleteDatabase(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { name } = await readJson<{ name?: string }>(req);
    deleteDatabase(name ?? "");
    sendJson(res, 200, { ok: true, name });
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

async function handleDropTable(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { db: dbName, table } = await readJson<{ db?: string; table?: string }>(req);
    const db = resolveDb(dbName ?? null, res);
    if (!db) return;
    if (!table) throw new Error("не указана таблица");
    db.dropTable(table);
    sendJson(res, 200, { ok: true, table });
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

function handleTables(db: Database, res: ServerResponse): void {
  const tables = db.tableNames().map((name) => {
    const t = db.table(name);
    return {
      name,
      rowCount: t.count,
      columns: t.schema.columns.map((c) => c.name),
      primaryKey: t.schema.primaryKey,
      schema: t.schema.columns.map((c) => ({
        name: c.name,
        type: c.type,
        pk: c.name === t.schema.primaryKey,
      })),
    };
  });
  sendJson(res, 200, tables);
}

// --- редактирование строки: /api/update -------------------------------------

interface UpdateBody {
  db?: string;
  table?: string;
  primaryKey?: { column?: string; value?: string | number };
  changes?: Record<string, string | number>;
}

/** Отформатировать значение как SQL-литерал по типу колонки (безопасно). */
function formatLiteral(type: "INTEGER" | "TEXT", raw: unknown): string {
  if (type === "INTEGER") {
    if (raw === null || raw === undefined || String(raw).trim() === "") {
      throw new Error("ожидалось целое, получено пустое значение");
    }
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`ожидалось целое, получено ${JSON.stringify(raw)}`);
    return String(n);
  }
  return "'" + String(raw).replace(/'/g, "''") + "'";
}

/** Построить и выполнить UPDATE через движок, вернуть обновлённую строку. */
function doUpdate(db: Database, body: UpdateBody): Record<string, unknown> {
  const { table, primaryKey, changes } = body;
  if (!table) throw new Error("не указана таблица");
  if (!primaryKey || !primaryKey.column) throw new Error("не указан первичный ключ");
  if (!changes || Object.keys(changes).length === 0) throw new Error("нет изменений");

  const schema = db.table(table).schema; // бросит, если таблицы нет
  const typeOf = (name: string): "INTEGER" | "TEXT" => {
    const c = schema.columns.find((x) => x.name === name);
    if (!c) throw new Error(`нет колонки ${name} в таблице ${table}`);
    return c.type;
  };

  // идентификаторы (table/колонки) валидируются схемой -> инъекция невозможна;
  // значения подставляются как экранированные литералы.
  const setClause = Object.entries(changes)
    .map(([col, val]) => `${col} = ${formatLiteral(typeOf(col), val)}`)
    .join(", ");
  const pkType = typeOf(primaryKey.column);
  const pkLit = formatLiteral(pkType, primaryKey.value);
  const newPkRaw = primaryKey.column in changes ? changes[primaryKey.column] : primaryKey.value;
  const newPkLit = formatLiteral(pkType, newPkRaw);

  const sql =
    `UPDATE ${table} SET ${setClause} WHERE ${primaryKey.column} = ${pkLit};` +
    ` SELECT * FROM ${table} WHERE ${primaryKey.column} = ${newPkLit};`;

  const results = executeProgram(db, sql);
  const last = results[results.length - 1];
  return last && last.kind === "selected" && last.rows[0] ? last.rows[0] : {};
}

// --- добавление строки: /api/insert -----------------------------------------

interface InsertBody {
  db?: string;
  table?: string;
  values?: Record<string, string | number>;
}

/** Построить и выполнить INSERT через движок, вернуть обновлённый список строк. */
function doInsert(db: Database, body: InsertBody): QueryResponse {
  const { table, values } = body;
  if (!table) throw new Error("не указана таблица");
  if (!values || typeof values !== "object") throw new Error("нет значений");

  const schema = db.table(table).schema; // бросит, если таблицы нет
  const cols = schema.columns.map((c) => c.name);
  const lits = schema.columns.map((c) => {
    if (!(c.name in values)) throw new Error(`нет значения для колонки ${c.name}`);
    return formatLiteral(c.type, values[c.name]);
  });

  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${lits.join(", ")}); SELECT * FROM ${table};`;
  const results = executeProgram(db, sql);
  const last = results[results.length - 1];
  if (last && last.kind === "selected") return toResponse(last);
  return { columns: [], rows: [], stats: { rows: 0, scanned: 0, plan: "" } };
}

async function handleInsert(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: InsertBody;
  try {
    body = await readJson<InsertBody>(req);
  } catch {
    sendJson(res, 400, { error: "ожидался JSON { db, table, values }" });
    return;
  }
  const db = databases.get(body.db ?? "");
  if (!db) {
    sendJson(res, 404, { error: `нет базы ${body.db}` });
    return;
  }
  try {
    const r = doInsert(db, body);
    sendJson(res, 200, { ok: true, columns: r.columns, rows: r.rows });
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

// --- удаление строки: /api/delete -------------------------------------------

interface DeleteBody {
  db?: string;
  table?: string;
  primaryKey?: { column?: string; value?: string | number };
}

/** Построить и выполнить DELETE через движок, вернуть обновлённый список строк. */
function doDelete(db: Database, body: DeleteBody): QueryResponse {
  const { table, primaryKey } = body;
  if (!table) throw new Error("не указана таблица");
  if (!primaryKey || !primaryKey.column) throw new Error("не указан первичный ключ");

  const schema = db.table(table).schema; // бросит, если таблицы нет
  const col = schema.columns.find((c) => c.name === primaryKey.column);
  if (!col) throw new Error(`нет колонки ${primaryKey.column} в таблице ${table}`);
  const lit = formatLiteral(col.type, primaryKey.value);

  const sql = `DELETE FROM ${table} WHERE ${primaryKey.column} = ${lit}; SELECT * FROM ${table};`;
  const results = executeProgram(db, sql);
  const last = results[results.length - 1];
  if (last && last.kind === "selected") return toResponse(last);
  return { columns: [], rows: [], stats: { rows: 0, scanned: 0, plan: "" } };
}

async function handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: DeleteBody;
  try {
    body = await readJson<DeleteBody>(req);
  } catch {
    sendJson(res, 400, { error: "ожидался JSON { db, table, primaryKey }" });
    return;
  }
  const db = databases.get(body.db ?? "");
  if (!db) {
    sendJson(res, 404, { error: `нет базы ${body.db}` });
    return;
  }
  try {
    const r = doDelete(db, body);
    sendJson(res, 200, { ok: true, columns: r.columns, rows: r.rows });
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

async function handleUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: UpdateBody;
  try {
    body = await readJson<UpdateBody>(req);
  } catch {
    sendJson(res, 400, { error: "ожидался JSON { db, table, primaryKey, changes }" });
    return;
  }
  const db = databases.get(body.db ?? "");
  if (!db) {
    sendJson(res, 404, { error: `нет базы ${body.db}` });
    return;
  }
  try {
    sendJson(res, 200, { ok: true, row: doUpdate(db, body) });
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "web", "tinydb-studio.html");

// CSP: страница самодостаточна (inline-стили/скрипты, favicon как data:, запросы
// same-origin). Запрещаем любые внешние ресурсы, фреймы и отправку форм наружу —
// это ограничивает ущерб от потенциальной инъекции (эксфильтрацию, кликджекинг).
const CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  "img-src data:; " +
  "connect-src 'self'; " +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-ancestors 'none'";

function handlePage(res: ServerResponse): void {
  try {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY", // защита от кликджекинга (плюс frame-ancestors в CSP)
      "Content-Security-Policy": CSP,
    });
    res.end(readFileSync(htmlPath));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("не найден web/tinydb-studio.html");
  }
}

/** Достать базу из ?db= или из тела запроса; null -> ошибка уже отправлена. */
function resolveDb(name: string | null, res: ServerResponse): Database | null {
  if (!name) {
    sendJson(res, 400, { error: "не указана база (параметр db)" });
    return null;
  }
  const db = databases.get(name);
  if (!db) {
    sendJson(res, 404, { error: `нет базы ${name}` });
    return null;
  }
  return db;
}

// --- маршрутизация ----------------------------------------------------------

/**
 * Лог одного запроса в консоль: время, адрес, метод, путь, код ответа, длительность.
 * Тела НЕ логируем (в /api/login это пароль). В URL секретов нет — только имена баз.
 */
function accessLog(req: IncomingMessage, res: ServerResponse, startMs: number, addr: string): void {
  const time = new Date().toTimeString().slice(0, 8); // HH:MM:SS
  console.log(`${time} ${addr} ${req.method ?? "?"} ${req.url ?? "/"} ${res.statusCode} ${Date.now() - startMs}ms`);
}

const server = createServer((req, res) => {
  const startMs = Date.now();
  res.on("finish", () => accessLog(req, res, startMs, clientAddr(req)));

  const parsed = new URL(req.url ?? "/", "http://localhost");
  const path = parsed.pathname;
  const method = req.method ?? "GET";

  // страница и вход — без авторизации
  if (method === "GET" && (path === "/" || path === "/index.html")) return handlePage(res);
  if (method === "POST" && path === "/api/login") return void handleLogin(req, res);

  // всё остальное под /api требует сессии
  if (path.startsWith("/api/")) {
    if (!isAuthed(req)) {
      sendJson(res, 401, { error: "требуется вход" });
      return;
    }
    if (method === "POST" && path === "/api/logout") return handleLogout(req, res);
    if (method === "GET" && path === "/api/databases") return handleListDatabases(res);
    if (method === "GET" && path === "/api/history") return handleHistory(res);
    if (method === "POST" && path === "/api/history/clear") return handleClearHistory(res);
    if (method === "POST" && path === "/api/databases") return void handleCreateDatabase(req, res);
    if (method === "POST" && path === "/api/databases/delete") return void handleDeleteDatabase(req, res);
    if (method === "POST" && path === "/api/tables/delete") return void handleDropTable(req, res);
    if (method === "GET" && path === "/api/tables") {
      const db = resolveDb(parsed.searchParams.get("db"), res);
      if (db) handleTables(db, res);
      return;
    }
    if (method === "POST" && path === "/api/insert") return void handleInsert(req, res);
    if (method === "POST" && path === "/api/delete") return void handleDelete(req, res);
    if (method === "POST" && path === "/api/update") return void handleUpdate(req, res);
    if (method === "POST" && path === "/api/query") {
      void (async () => {
        // db берём из тела вместе с sql
        let name: string | null = null;
        let sqlBody = "";
        let noHistory = false; // авто-запросы (клик по таблице, импорт) в историю не пишем
        try {
          const body = await readBody(req);
          const parsedBody = JSON.parse(body) as { db?: string; sql?: string; noHistory?: boolean };
          name = parsedBody.db ?? null;
          sqlBody = parsedBody.sql ?? "";
          noHistory = parsedBody.noHistory === true;
        } catch {
          sendJson(res, 400, { error: "тело должно быть JSON { db, sql }" });
          return;
        }
        const db = resolveDb(name, res);
        if (!db) return;
        // переиспользуем логику через фиктивный req: проще выполнить здесь
        if (sqlBody.trim() === "") {
          sendJson(res, 400, { error: "пустой SQL" });
          return;
        }
        try {
          const results = executeProgram(db, sqlBody);
          const lastRes = results[results.length - 1];
          if (!lastRes) {
            sendJson(res, 400, { error: "нет инструкций" });
            return;
          }
          if (!noHistory) recordHistory(sqlBody); // успешный ручной запрос -> в историю
          sendJson(res, 200, toResponse(lastRes));
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
        }
      })();
      return;
    }
  }

  sendJson(res, 404, { error: `не найдено: ${method} ${path}` });
});

server.listen(port, host, () => {
  console.log(`tinydb Studio: http://localhost:${port}  (адрес: ${host}, корень баз: ${root}, вход: ${USER})`);
  if (USER === "admin" && PASS === "admin") {
    console.warn("⚠ вход по умолчанию admin/admin — задайте STUDIO_USER/STUDIO_PASS, особенно при STUDIO_HOST=0.0.0.0");
  }
});
