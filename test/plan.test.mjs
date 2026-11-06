// 3단계: 업데이트 계획 · 유형 템플릿 · 인력 · 계획 기간
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { planView, typesView, capacityView, updateDetail, updateDays } from '../core/plan.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-plan', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
const ctx = { editor: '검사', batchId: 'b' };
let copies = 0;
function open(name = 'normal') {
  const path = `${OUT}/${name}-copy${(copies += 1)}.arp`;
  copyFileSync(samples[name], path);
  const raw = openProjectFile(path);
  const db = nodeDb(raw);
  return { raw, db, session: new ProjectSession(db), edit: e => applyEdit(db, new ProjectSession(db), e, ctx) };
}

test('계획 보기: 모든 업데이트가 우선순위 순서로, 결과와 전망 범위(최저 ≤ 목표 ≤ 확장)가 붙는다', () => {
  const { raw, db, session } = open();
  const v = planView(db, session, 'TARGET');
  raw.close();
  assert.equal(v.blocked, false);
  assert.deepEqual(v.rows.map(r => r.updateId), ['LAUNCH', 'S1', 'MINI1', 'S2']);
  assert.equal(v.horizon.months.length, 14);
  for (const r of v.rows) {
    assert.ok(r.result && r.range);
    assert.ok(r.range.min <= r.result.completion && r.result.completion <= r.range.stretch, `${r.updateId} ${r.range.min} ${r.result.completion} ${r.range.stretch}`);
  }
  assert.deepEqual(v.rows.find(r => r.updateId === 'S1').totals, { min: 32, target: 53, stretch: 74 });
  assert.equal(v.parts.length, 4);
  assert.equal(v.parts[0].months.length, 14);
});

test('업데이트 만들기: 유형 템플릿 물량을 복사하고, 우선순위는 맨 뒤, 계산에 들어간다', () => {
  const { raw, db, session } = open();
  const r = applyEdit(db, session, { kind: 'createUpdate', name: '시즌 3', typeId: 'SEASON', startDate: '2027-10-01', freezeDate: '2027-12-10', releaseDate: '2027-12-24' }, ctx);
  assert.equal(r.createdId, 'U001');
  const d = updateDetail(db, 'U001');
  assert.equal(d.rows.length, 6);
  assert.equal(d.rows.find(x => x.resourceTypeId === 'CHAR_NEW').target, 3);
  const v = planView(db, session);
  const row = v.rows.find(x => x.updateId === 'U001');
  assert.equal(row.priority, 5);
  assert.ok(row.result.requiredDays > 0);
  assert.ok(updateDays(db, session, 'U001', 'TARGET').total > 0);
  raw.close();
});

test('우선순위 옮기기: 이웃과 바꾸고 1..n으로 다시 매긴다. 순서가 바뀌면 결과도 바뀐다', () => {
  const { raw, db, session } = open('overload');
  const before = planView(db, session).rows.map(r => r.updateId);
  applyEdit(db, session, { kind: 'movePriority', updateId: 'S2', direction: -1 }, ctx);
  const after = planView(db, session).rows;
  raw.close();
  assert.deepEqual(before, ['LAUNCH', 'S1', 'MINI1', 'S2']);
  assert.deepEqual(after.map(r => r.updateId), ['LAUNCH', 'S1', 'S2', 'MINI1']);
  assert.deepEqual(after.map(r => r.priority), [1, 2, 3, 4]);
});

test('업데이트 고치기·지우기: 날짜·상태 바꾸고, 지우면 물량도 사라지고, 취소하면 계산에서 빠진다', () => {
  const { raw, db, session } = open();
  applyEdit(db, session, { kind: 'updateField', updateId: 'S2', field: 'release_date', value: '2027-12-15' }, ctx);
  assert.equal(updateDetail(db, 'S2').releaseDate, '2027-12-15');
  assert.throws(() => applyEdit(db, session, { kind: 'updateField', updateId: 'S2', field: 'start_date', value: null }, ctx));
  applyEdit(db, session, { kind: 'updateField', updateId: 'MINI1', field: 'status', value: 'CANCELLED' }, ctx);
  const v = planView(db, session);
  const mini = v.rows.find(r => r.updateId === 'MINI1');
  assert.equal(mini.live, false);
  assert.equal(mini.result, null);
  assert.equal(v.rows[v.rows.length - 1].updateId, 'MINI1', '계산 밖 업데이트는 맨 아래');
  applyEdit(db, session, { kind: 'deleteUpdate', updateId: 'S2' }, ctx);
  assert.equal(updateDetail(db, 'S2'), null);
  assert.equal(db.get("SELECT count(*) AS n FROM volumes WHERE update_id = 'S2'").n, 0);
  assert.equal(planView(db, session).blocked, false);
  raw.close();
});

test('유형·템플릿: 만들기, 이름 바꾸기, 템플릿 물량 고치기, 사용하는 업데이트가 있으면 지우기 거절', () => {
  const { raw, db, session } = open();
  const t = applyEdit(db, session, { kind: 'createType', name: '이벤트' }, ctx);
  assert.equal(t.createdId, 'T01');
  assert.throws(() => applyEdit(db, session, { kind: 'createType', name: '이벤트' }, ctx));
  applyEdit(db, session, { kind: 'addTemplateResource', typeId: 'T01', resourceTypeId: 'ICON' }, ctx);
  applyEdit(db, session, { kind: 'template', typeId: 'T01', resourceTypeId: 'ICON', field: 'target_qty', value: 12 }, ctx);
  applyEdit(db, session, { kind: 'renameType', typeId: 'T01', name: '이벤트 업데이트' }, ctx);
  const tv = typesView(db).find(x => x.typeId === 'T01');
  assert.equal(tv.name, '이벤트 업데이트');
  assert.equal(tv.rows[0].target, 12);
  assert.ok(tv.addable.length === 5);
  assert.throws(() => applyEdit(db, session, { kind: 'deleteType', typeId: 'SEASON' }, ctx), /2개/);
  assert.throws(() => applyEdit(db, session, { kind: 'deleteType', typeId: 'LAUNCH' }, ctx));
  applyEdit(db, session, { kind: 'deleteType', typeId: 'T01' }, ctx);
  assert.equal(typesView(db).some(x => x.typeId === 'T01'), false);
  raw.close();
});

test('인력: 한 달 고치기, 기간 채우기, 범위 밖 값 거절, 결과에 반영', () => {
  const { raw, db, session } = open();
  const cap = () => planView(db, session).parts.find(p => p.partId === 'FX').months.reduce((a, m) => a + m.capacity, 0);
  const before = cap();
  applyEdit(db, session, { kind: 'fillCapacity', partId: 'FX', fromMonth: '2027-01', toMonth: '2027-06', field: 'headcount', value: 3 }, ctx);
  assert.ok(cap() > before);
  applyEdit(db, session, { kind: 'capacity', partId: 'FX', month: '2027-02', field: 'outsource_days', value: 15 }, ctx);
  const v = capacityView(db);
  const fx = v.parts.find(p => p.partId === 'FX');
  assert.equal(fx.cells[v.months.indexOf('2027-03')].headcount, 3);
  assert.equal(fx.cells[v.months.indexOf('2027-02')].outsource_days, 15);
  assert.equal(fx.cells[v.months.indexOf('2027-07')].headcount, 2);
  assert.throws(() => applyEdit(db, session, { kind: 'capacity', partId: 'FX', month: '2027-02', field: 'utilization', value: 1.2 }, ctx));
  assert.throws(() => applyEdit(db, session, { kind: 'capacity', partId: 'FX', month: '2027-02', field: 'headcount', value: -1 }, ctx));
  raw.close();
});

test('계획 기간 늘리기: 새 달의 인력은 앞 달 값을 복사하고(외주·지원은 0), 검증 오류가 없다. 줄였다 늘리면 값이 그대로', () => {
  const { raw, db, session } = open();
  applyEdit(db, session, { kind: 'capacity', partId: 'MODELING', month: '2027-12', field: 'outsource_days', value: 9 }, ctx);
  applyEdit(db, session, { kind: 'horizon', startMonth: '2026-11', endMonth: '2028-06' }, ctx);
  let v = capacityView(db);
  assert.equal(v.months.length, 20);
  const m = v.parts.find(p => p.partId === 'MODELING');
  assert.equal(m.cells[v.months.indexOf('2028-06')].headcount, 5);
  assert.equal(m.cells[v.months.indexOf('2028-06')].outsource_days, 0);
  assert.equal(planView(db, session).blocked, false);
  applyEdit(db, session, { kind: 'capacity', partId: 'MODELING', month: '2028-03', field: 'headcount', value: 7 }, ctx);
  applyEdit(db, session, { kind: 'horizon', startMonth: '2026-11', endMonth: '2027-12' }, ctx);
  applyEdit(db, session, { kind: 'horizon', startMonth: '2026-11', endMonth: '2028-06' }, ctx);
  v = capacityView(db);
  assert.equal(v.parts.find(p => p.partId === 'MODELING').cells[v.months.indexOf('2028-03')].headcount, 7);
  assert.throws(() => applyEdit(db, session, { kind: 'horizon', startMonth: '2026-11', endMonth: '2031-12' }, ctx), /60개월/);
  raw.close();
});
