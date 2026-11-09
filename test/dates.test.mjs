// 날짜 검사(2026-11-09 발견): 13월 · 32일 · 0월처럼 Date가 만들 수 없는 값이 내부 오류(RangeError) 대신 "형식" 안내로 거절되는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit, DATE } from '../core/edits.ts';
import { applyScenarioOp } from '../core/scenarios.ts';
import { importProgress } from '../core/progress-io.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-dates', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
const ctx = { editor: '검사', batchId: 'd1' };

test('날짜 형식: 13월 · 0월 · 32일 · 2월 30일은 거절, 정상 날짜는 통과(예외 없음)', () => {
  for (const d of ['2027-13-01', '2027-00-10', '2027-01-32', '2027-02-30']) assert.equal(DATE.test(d), false, d);
  assert.equal(DATE.test('2027-12-31'), true);
});

test('고치기 · 시나리오 · 작업 진척 엑셀: 13월 날짜는 안내 문구로 거절하거나 건너뛴다', () => {
  copyFileSync(samples.normal, `${OUT}/n.arp`);
  const raw = openProjectFile(`${OUT}/n.arp`);
  const db = nodeDb(raw);
  const session = new ProjectSession(db);
  assert.throws(() => applyEdit(db, session, { kind: 'updateField', updateId: 'S1', field: 'release_date', value: '2027-13-01' }, ctx), /형식/);
  const sid = applyScenarioOp(db, { kind: 'create', name: '날짜' }).createdId;
  assert.throws(() => applyScenarioOp(db, { kind: 'addAction', scenarioId: sid, action: { kind: 'updateDates', updateId: 'S1', releaseDate: '2027-13-01' } }), /날짜를 확인/);
  const sheets = { '작업 진척': [['업데이트 ID', '리소스 ID', '파트 ID', '완료 수량', '기준일'], ['LAUNCH', 'BG_MAP', 'CONCEPT', 2, '2027-13-01']] };
  const r = importProgress(db, session, sheets, ctx, '2026-11-09');
  assert.equal(r.changedCells, 1, '달력에 없는 기준일은 버리고 넣는 날로');
  assert.equal(db.get("SELECT as_of FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'BG_MAP' AND part_id = 'CONCEPT'").as_of, '2026-11-09');
  raw.close();
});
