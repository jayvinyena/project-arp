// 브라우저: SQLite WebAssembly로 .arp 파일을 메모리에 열고 core SqlDb 모양으로 감싼다.
import type { SqlDb } from '../../core/db.ts';
import { migrate, LATEST_SCHEMA } from '../../core/migrate.ts';
import type { MigrationResult } from '../../core/migrate.ts';

// sqlite-wasm 자료형은 크고 이 파일에서만 쓰므로 필요한 부분만 적는다
export interface Sqlite3 {
  version: { libVersion: string };
  oo1: { DB: new () => WasmDb };
  wasm: { allocFromTypedArray(bytes: Uint8Array): number };
  capi: {
    sqlite3_deserialize(db: number, schema: string, data: number, dbSize: number, bufferSize: number, flags: number): number;
    sqlite3_js_db_export(db: number): Uint8Array;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
  };
}

export interface WasmDb {
  pointer: number;
  exec(sql: string | { sql: string; bind?: unknown[]; rowMode?: string; returnValue?: string }): unknown;
  changes(): number;
  close(): void;
}

export const APP_ID = 1095913521;
export const SCHEMA_VERSION = LATEST_SCHEMA;

/** 파일 바이트 → 메모리 DB. ARP 파일이 아니거나 더 새 구조면 거절한다 */
export function openFromBytes(sqlite3: Sqlite3, bytes: Uint8Array): WasmDb & { migration?: MigrationResult } {
  const db = new sqlite3.oo1.DB();
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer, 'main', pointer, bytes.byteLength, bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== 0) { db.close(); throw new Error(`파일을 열지 못함 (sqlite ${rc})`); }
  const sql = wrap(db);
  const appId = Number(sql.get('PRAGMA application_id')?.application_id);
  const version = Number(sql.get('PRAGMA user_version')?.user_version);
  if (appId !== APP_ID) { db.close(); throw new Error('ARP 파일이 아닙니다'); }
  if (version > SCHEMA_VERSION) { db.close(); throw new Error(`더 새 구조(v${version})의 파일입니다`); }
  sql.exec('PRAGMA foreign_keys = ON');
  // 옛 구조면 메모리에서 최신으로 바꾼다. 저장할 때 바뀐 구조로 쓰인다
  const migration = migrate(sql);
  return Object.assign(db, { migration });
}

/** 메모리 DB → 파일 바이트 (저장할 때) */
export function exportBytes(sqlite3: Sqlite3, db: WasmDb): Uint8Array {
  return sqlite3.capi.sqlite3_js_db_export(db.pointer);
}

const cache = new WeakMap<WasmDb, SqlDb>();

export function wrap(db: WasmDb): SqlDb {
  const hit = cache.get(db);
  if (hit) return hit;
  const all = (sql: string, params?: unknown[]) =>
    db.exec({ sql, bind: params && params.length ? params : undefined, rowMode: 'object', returnValue: 'resultRows' }) as Record<string, unknown>[];
  const wrapped: SqlDb = {
    exec: sql => { db.exec(sql); },
    all,
    get: (sql, params) => all(sql, params)[0],
    run: (sql, params) => { db.exec({ sql, bind: params && params.length ? params : undefined }); return db.changes(); },
  };
  cache.set(db, wrapped);
  return wrapped;
}
