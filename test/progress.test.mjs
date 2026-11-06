// 실적 입력: 고치기 · 보기 · 계산 반영
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { progressView, planView } from '../core/plan.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-progress', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
const ctx = { editor: '검사', batchId: 'b' };
let copies = 0;
function open(name = 'normal') {
  const path = `${OUT}/${name}-copy${(copies += 1)}.arp`;
  copyFileSync(samples[name], path);
  const raw = openProjectFile(path);
  const db = nodeDb(raw);
  return { raw, db, session: new ProjectSession(db) };
}
const P = (updateId, resourceTypeId, partId, value, asOf = '2026-11-20') => ({ kind: 'progress', updateId, resourceTypeId, partId, value, asOf });

test('보기: 런칭의 리소스 × 파트, 거치지 않는 칸, 기존 실적, 진행률', () => {
  const { raw, db } = open();
  const v = progressView(db, null);
  raw.close();
  assert.equal(v.updateId, 'LAUNCH');
  assert.equal(v.rows.length, 6);
  const char = v.rows.find(r => r.resourceTypeId === 'CHAR_NEW');
  assert.deepEqual(char.cells.map(c => c.passes), [true, true, true, true]);
  assert.equal(char.cells[0].completed, 3);
  const icon = v.rows.find(r => r.resourceTypeId === 'ICON');
  assert.deepEqual(icon.cells.map(c => c.passes), [true, false, false, false]);
  assert.ok(v.summary.doneDays > 0 && v.summary.doneDays < v.summary.totalDays);
  assert.equal(v.latestAsOf, '2026-11-04');
});

test('고치기: 넣기·바꾸기·0이면 지우기, 이력이 남고, 남은 일이 줄어 완료 예정이 당겨진다', () => {
  const { raw, db, session } = open('overload');
  const before = planView(db, session).rows.find(r => r.updateId === 'LAUNCH').result.requiredDays;
  assert.equal(applyEdit(db, session, P('LAUNCH', 'PROP', 'CONCEPT', 100), ctx).changed, true);
  assert.equal(applyEdit(db, session, P('LAUNCH', 'PROP', 'CONCEPT', 100), ctx).changed, false);
  applyEdit(db, session, P('LAUNCH', 'PROP', 'MODELING', 80), ctx);
  const after = planView(db, session).rows.find(r => r.updateId === 'LAUNCH').result.requiredDays;
  assert.ok(after < before, `${after} < ${before}`);
  applyEdit(db, session, P('LAUNCH', 'PROP', 'MODELING', 0), ctx);
  assert.equal(db.get("SELECT count(*) AS n FROM progress WHERE resource_type_id = 'PROP' AND part_id = 'MODELING'").n, 0);
  const log = db.all("SELECT action FROM change_log WHERE target = 'progress' ORDER BY log_id").map(r => r.action);
  assert.deepEqual(log, ['INSERT', 'INSERT', 'DELETE']);
  assert.equal(db.get("SELECT as_of FROM progress WHERE resource_type_id = 'PROP' AND part_id = 'CONCEPT'").as_of, '2026-11-20');
  raw.close();
});

test('고치기: 거치지 않는 파트, 물량에 없는 리소스, 음수·소수는 거절', () => {
  const { raw, db, session } = open();
  assert.throws(() => applyEdit(db, session, P('LAUNCH', 'ICON', 'MODELING', 1), ctx), /거치지 않는/);
  assert.throws(() => applyEdit(db, session, P('MINI1', 'CHAR_NEW', 'CONCEPT', 1), ctx), /물량에 없는/);
  assert.throws(() => applyEdit(db, session, P('LAUNCH', 'PROP', 'CONCEPT', -1), ctx));
  assert.throws(() => applyEdit(db, session, P('LAUNCH', 'PROP', 'CONCEPT', 1.5), ctx));
  raw.close();
});

test('다 끝남: 거치는 모든 파트를 (목표 − 외주)로, 그 리소스는 진행률 100%', () => {
  const { raw, db, session } = open();
  applyEdit(db, session, { kind: 'completeRow', updateId: 'LAUNCH', resourceTypeId: 'PROP', asOf: '2026-11-20' }, ctx);
  const prop = progressView(db, 'LAUNCH').rows.find(r => r.resourceTypeId === 'PROP');
  raw.close();
  assert.deepEqual(prop.cells.filter(c => c.passes).map(c => c.completed), [50, 50]); // 목표 60 − 외주 10
  assert.equal(prop.doneRate, 1);
});

test('주의 표시: 앞 공정보다 많이 끝났거나 확장 물량을 넘기면 그 칸에 표시', () => {
  const { raw, db, session } = open();
  applyEdit(db, session, P('LAUNCH', 'CHAR_NEW', 'ANIMATION', 2), ctx); // 모델링 1보다 많다
  applyEdit(db, session, P('LAUNCH', 'BG_MAP', 'CONCEPT', 9), ctx);     // 확장 5보다 많다
  const v = progressView(db, 'LAUNCH');
  raw.close();
  assert.equal(v.rows.find(r => r.resourceTypeId === 'CHAR_NEW').cells[2].flag, '앞 공정보다 많이 끝났습니다');
  assert.equal(v.rows.find(r => r.resourceTypeId === 'BG_MAP').cells[0].flag, '세 번째 템플릿 물량보다 많습니다');
});
