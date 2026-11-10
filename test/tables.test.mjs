// 표 목록 한 곳(core/tables.ts)이 실제 파일 구조와 맞는지(docs/25-maintenance-review.md B).
// 새 표 · 칸을 더하고 목록에 적지 않으면 여기서 실패한다 → 이력 · 되돌리기 · 예시 파일 · 옛 구조 시험이 조용히 틀리는 것을 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { TABLES, ADDED_COLUMNS } from '../core/tables.ts';
import { migrate, LATEST_SCHEMA } from '../core/migrate.ts';
import { nodeDb } from '../tools/lib/pipeline.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCHEMA = readFileSync(`${ROOT}schema/schema-v1.sql`, 'utf8');
const tablesOf = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const colsOf = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all();

const v1 = new DatabaseSync(':memory:');
v1.exec(SCHEMA);
const latest = new DatabaseSync(':memory:');
latest.exec(SCHEMA);
migrate(nodeDb(latest));

test('최신 구조의 모든 표가 목록에 있고, 목록의 모든 표가 구조에 있다', () => {
  assert.deepEqual(TABLES.map(t => t.name).sort(), tablesOf(latest));
  assert.equal(new Set(TABLES.map(t => t.name)).size, TABLES.length, '이름이 겹치지 않는다');
});

test('생긴 버전: v1 표는 schema-v1.sql에, 나중 표는 migrate.ts에서 생긴다', () => {
  const inV1 = new Set(tablesOf(v1));
  for (const t of TABLES) {
    assert.ok(t.since >= 1 && t.since <= LATEST_SCHEMA, `${t.name} since ${t.since}`);
    assert.equal(inV1.has(t.name), t.since === 1, `${t.name}: since ${t.since}`);
  }
});

test('되돌리기 키 칸 = 그 표의 기본 키', () => {
  for (const t of TABLES.filter(x => x.keys)) {
    const pk = colsOf(latest, t.name).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    assert.deepEqual(t.keys, pk, t.name);
  }
});

test('목록 순서 = 외래 키 순서(부모가 먼저): 예시 파일 넣기 · 딸린 행 다시 넣기에 쓴다', () => {
  const pos = new Map(TABLES.map((t, i) => [t.name, i]));
  for (const t of TABLES) {
    for (const fk of latest.prepare(`PRAGMA foreign_key_list(${t.name})`).all()) {
      if (fk.table === t.name) continue;
      assert.ok(pos.get(fk.table) < pos.get(t.name), `${t.name} → ${fk.table}`);
    }
  }
});

test('v1 표에 나중에 더한 칸은 ADDED_COLUMNS에 모두 있다(옛 구조 시험 파일)', () => {
  const added = [];
  for (const t of TABLES.filter(x => x.since === 1)) {
    const old = new Set(colsOf(v1, t.name).map(c => c.name));
    for (const c of colsOf(latest, t.name)) if (!old.has(c.name)) added.push(`${t.name}.${c.name}`);
  }
  assert.deepEqual(added.sort(), ADDED_COLUMNS.map(c => `${c.table}.${c.column}`).sort());
});
