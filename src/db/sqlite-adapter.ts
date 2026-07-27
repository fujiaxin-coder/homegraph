/**
 * SQLite Adapter
 *
 * Three-tier selection (first success wins):
 *   1. `node:sqlite` (`DatabaseSync`) — real SQLite + WAL + FTS5, Node ≥22.5
 *   2. `better-sqlite3` — native addon (optionalDependency)
 *   3. `node-sqlite3-wasm` — last-resort fallback (no WAL; slower / lock-prone)
 *
 * Library hosts on Node 20–22.4 land on (2) or (3). Node ≥22.5 prefers (1) and
 * skips the native build. Override with `HOMEGRAPH_SQLITE_BACKEND=node-sqlite|native|wasm`.
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  /**
   * Lazily yield result rows one at a time instead of materializing the whole
   * set with `all()`. Use for unbounded scans (e.g. every function/method node)
   * so memory stays O(1) in the row count rather than O(rows) — see #610.
   */
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

/** Active SQLite backend after {@link createDatabase}. */
export type SqliteBackend = 'node-sqlite' | 'native' | 'wasm';

/**
 * One-line recovery hint when WASM is active (no WAL — slower / lock-prone).
 */
export const WASM_FALLBACK_FIX_RECIPE =
  'upgrade to Node.js 22.5+ (uses built-in node:sqlite), or ' +
  '`xcode-select --install` (macOS) / `apt install build-essential` (Debian/Ubuntu) ' +
  'then `npm rebuild better-sqlite3`.';

/**
 * Banner shown to stderr when falling back to WASM.
 */
export function buildWasmFallbackBanner(priorErrors?: string): string {
  const sep = '─'.repeat(72);
  const lines = [
    sep,
    '[HomeGraph] WASM SQLite fallback active (node:sqlite + better-sqlite3 unavailable)',
    sep,
    'Indexing and sync will be 5-10x slower than a WAL backend, and concurrent',
    'reads can hit "database is locked". Prefer Node 22.5+ or better-sqlite3.',
    '',
    'Fix — use built-in SQLite (best when you can):',
    '  Use Node.js 22.5 or newer, then restart homegraph',
    '',
    'Fix — native better-sqlite3:',
    '  macOS:  xcode-select --install && npm rebuild better-sqlite3',
    '  Linux:  sudo apt install build-essential python3 make && npm rebuild better-sqlite3',
    '  Any:    npm install better-sqlite3 --save',
    '',
    'Verify after fix: `homegraph status` should show Backend: node-sqlite or native.',
  ];
  if (priorErrors) {
    lines.push('', `Prior load errors: ${priorErrors}`);
  }
  lines.push(sep);
  return lines.join('\n');
}

function translateNamedParams(sql: string): { sql: string; paramOrder: string[] | null } {
  const paramOrder: string[] = [];
  const rewritten = sql.replace(/@(\w+)/g, (_match, name: string) => {
    paramOrder.push(name);
    return '?';
  });
  if (paramOrder.length === 0) {
    return { sql, paramOrder: null };
  }
  return { sql: rewritten, paramOrder };
}

function resolveParams(params: any[], paramOrder: string[] | null): any {
  if (params.length === 0) return undefined;
  if (
    paramOrder &&
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0]) &&
    !(params[0] instanceof Buffer) &&
    !(params[0] instanceof Uint8Array)
  ) {
    const obj = params[0];
    return paramOrder.map(name => obj[name]);
  }
  if (params.length === 1) return params[0];
  return params;
}

function isBusyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

function sleepSync(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    Atomics.wait(ia, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy-wait */
    }
  }
}

function withBusyRetry<T>(fn: () => T, attempts = 10, baseDelayMs = 50): T {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (error) {
      last = error;
      if (!isBusyError(error) || i === attempts - 1) throw error;
      sleepSync(baseDelayMs * (i + 1));
    }
  }
  throw last;
}

/** True when `require('node:sqlite').DatabaseSync` succeeds. */
export function isNodeSqliteAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('node:sqlite');
    return typeof mod?.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

/** True when `require('better-sqlite3')` succeeds. */
export function isNativeSqliteAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

/**
 * Wraps Node's built-in `node:sqlite` (`DatabaseSync`) to match the
 * better-sqlite3 interface the rest of the code expects.
 */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;
  private _txDepth = 0;

  constructor(dbPath: string, opts?: { readOnly?: boolean }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    this._db = opts?.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...params);
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        return stmt.get(...params);
      },
      all(...params: any[]) {
        return stmt.all(...params);
      },
      iterate(...params: any[]) {
        return stmt.iterate(...params);
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return row && typeof row === 'object' ? Object.values(row)[0] : row;
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      if (this._txDepth > 0) {
        this._txDepth++;
        try {
          return fn(...args);
        } finally {
          this._txDepth--;
        }
      }
      this._db.exec('BEGIN');
      this._txDepth = 1;
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        this._txDepth = 0;
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        this._txDepth = 0;
        throw error;
      }
    };
  }

  close(): void {
    if (this._db.isOpen) this._db.close();
  }
}

class WasmDatabaseAdapter implements SqliteDatabase {
  private _db: any;
  private _openStmts = new Set<any>();
  private _txDepth = 0;

  constructor(dbPath: string, opts?: { readOnly?: boolean }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('node-sqlite3-wasm');
    this._db = opts?.readOnly ? new Database(dbPath, 'readonly') : new Database(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    const { sql: rewrittenSql, paramOrder } = translateNamedParams(sql);
    const stmt = this._db.prepare(rewrittenSql);
    this._openStmts.add(stmt);
    return {
      run(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        const result = resolved !== undefined ? stmt.run(resolved) : stmt.run();
        return {
          changes: result?.changes ?? 0,
          lastInsertRowid: result?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        return withBusyRetry(() =>
          resolved !== undefined ? stmt.get(resolved) : stmt.get()
        );
      },
      all(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        return withBusyRetry(() =>
          resolved !== undefined ? stmt.all(resolved) : stmt.all()
        );
      },
      iterate(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        if (typeof stmt.iterate === 'function') {
          return withBusyRetry(() =>
            resolved !== undefined ? stmt.iterate(resolved) : stmt.iterate()
          );
        }
        const rows = withBusyRetry(() =>
          resolved !== undefined ? stmt.all(resolved) : stmt.all()
        ) as any[];
        return rows[Symbol.iterator]();
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    if (trimmed.includes('=')) {
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (key === 'journal_mode' && value.toUpperCase() === 'WAL') {
        this._db.exec('PRAGMA journal_mode = DELETE');
        return;
      }
      if (key === 'mmap_size') return;
      if (key === 'synchronous' && value.toUpperCase() === 'NORMAL') {
        this._db.exec('PRAGMA synchronous = FULL');
        return;
      }
      this._db.exec(`PRAGMA ${key} = ${value}`);
      return;
    }
    const readStmt = this._db.prepare(`PRAGMA ${trimmed}`);
    const result = readStmt.get();
    readStmt.finalize();
    if (options?.simple) {
      return result && typeof result === 'object' ? Object.values(result)[0] : result;
    }
    return result;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      if (this._txDepth > 0) {
        this._txDepth++;
        try {
          return fn(...args);
        } finally {
          this._txDepth--;
        }
      }
      this._db.exec('BEGIN');
      this._txDepth = 1;
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        this._txDepth = 0;
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        this._txDepth = 0;
        throw error;
      }
    };
  }

  close(): void {
    for (const stmt of this._openStmts) {
      try {
        stmt.finalize();
      } catch {
        /* already finalized */
      }
    }
    this._openStmts.clear();
    this._db.close();
  }
}

function resolveBackendOrder(): SqliteBackend[] {
  const raw = process.env.HOMEGRAPH_SQLITE_BACKEND?.trim().toLowerCase();
  if (raw === 'node-sqlite' || raw === 'native' || raw === 'wasm') {
    return [raw];
  }
  return ['node-sqlite', 'native', 'wasm'];
}

function tryOpenBackend(
  backend: SqliteBackend,
  dbPath: string,
  opts?: { readOnly?: boolean }
): { db: SqliteDatabase; backend: SqliteBackend } | { error: string } {
  try {
    if (backend === 'node-sqlite') {
      return { db: new NodeSqliteAdapter(dbPath, opts), backend: 'node-sqlite' };
    }
    if (backend === 'native') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = opts?.readOnly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
      return { db: db as SqliteDatabase, backend: 'native' };
    }
    return { db: new WasmDatabaseAdapter(dbPath, opts), backend: 'wasm' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Create a database connection.
 * Order: node:sqlite → better-sqlite3 → node-sqlite3-wasm (unless overridden).
 */
export function createDatabase(
  dbPath: string,
  opts?: { readOnly?: boolean }
): { db: SqliteDatabase; backend: SqliteBackend } {
  const order = resolveBackendOrder();
  const errors: string[] = [];

  for (const backend of order) {
    const result = tryOpenBackend(backend, dbPath, opts);
    if ('db' in result) {
      if (result.backend === 'wasm') {
        console.warn(buildWasmFallbackBanner(errors.join(' | ') || undefined));
      }
      return result;
    }
    errors.push(`${backend}: ${result.error}`);
  }

  throw new Error(
    `Failed to load any SQLite backend (tried ${order.join(' → ')}).\n` +
      errors.map(e => `  ${e}`).join('\n')
  );
}
