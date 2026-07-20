/**
 * SQLite Adapter
 *
 * Prefers better-sqlite3 (native — real SQLite with WAL + FTS5). Falls back to
 * node-sqlite3-wasm when the native binding is unavailable (optionalDependency
 * install failed / no prebuild / no local compile toolchain).
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

/** `native` = better-sqlite3; `wasm` = node-sqlite3-wasm fallback. */
export type SqliteBackend = 'native' | 'wasm';

/**
 * One-line recovery hint when WASM is active (no WAL — slower / lock-prone).
 */
export const WASM_FALLBACK_FIX_RECIPE =
  '`xcode-select --install` (macOS) or `apt install build-essential` (Debian/Ubuntu), ' +
  'then `npm rebuild better-sqlite3`, or `npm install better-sqlite3 --save` to force-include it.';

/**
 * Banner shown to stderr when falling back to WASM (better-sqlite3 unavailable).
 */
export function buildWasmFallbackBanner(nativeError?: string): string {
  const sep = '─'.repeat(72);
  const lines = [
    sep,
    '[HomeGraph] WASM SQLite fallback active (better-sqlite3 unavailable)',
    sep,
    'Indexing and sync will be 5-10x slower than the native backend.',
    '',
    'Fix on macOS:',
    '  xcode-select --install        # install C build tools',
    '  npm rebuild better-sqlite3    # rebuild native binding for current Node',
    '',
    'Fix on Linux:',
    '  sudo apt install build-essential python3 make    # Debian/Ubuntu',
    '  # or: sudo yum groupinstall "Development Tools"  # RHEL/Fedora',
    '  npm rebuild better-sqlite3',
    '',
    'Or force-include as a hard dependency on any platform:',
    '  npm install better-sqlite3 --save',
    '',
    'Verify after fix: `homegraph status` should show `Backend: native`.',
  ];
  if (nativeError) {
    lines.push('', `Native load error: ${nativeError}`);
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

class WasmDatabaseAdapter implements SqliteDatabase {
  private _db: any;
  private _openStmts = new Set<any>();

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('node-sqlite3-wasm');
    this._db = new Database(dbPath);
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
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
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

/**
 * Create a database connection.
 * Prefer better-sqlite3; fall back to node-sqlite3-wasm when unavailable.
 */
export function createDatabase(dbPath: string): { db: SqliteDatabase; backend: SqliteBackend } {
  let nativeError: string | undefined;
  let wasmError: string | undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    return { db: db as SqliteDatabase, backend: 'native' };
  } catch (error) {
    nativeError = error instanceof Error ? error.message : String(error);
  }

  try {
    const db = new WasmDatabaseAdapter(dbPath);
    console.warn(buildWasmFallbackBanner(nativeError));
    return { db, backend: 'wasm' };
  } catch (error) {
    wasmError = error instanceof Error ? error.message : String(error);
  }

  throw new Error(
    `Failed to load any SQLite backend.\n` +
      `  Native (better-sqlite3): ${nativeError}\n` +
      `  WASM (node-sqlite3-wasm): ${wasmError}`
  );
}
