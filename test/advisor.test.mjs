// 7단계: 마감 일정 맞춤 제안
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { buildScaleData } from '../tools/gen-scale.mjs';
import { openProjectFile, createProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { applyScenarioOp, compareScenarios, listScenarios } from '../core/scenarios.ts';
import { adviseDeadlines, adviceToScenario } from '../core/advisor.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-advisor', import.meta.url));
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
/** 정상 샘플에서 런칭 제작 완료 목표를 3월 말로 당긴다 → 런칭만 늦음(32영업일) */
function tight() {
  const o = open();
  applyEdit(o.db, o.session, { kind: 'updateField', updateId: 'LAUNCH', field: 'freeze_date', value: '2027-03-31' }, ctx);
  return o;
}
const lateOf = (r, id) => r.after.find(o => o.updateId === id).late;

test('이미 다 맞으면 바꿀 것이 없다', () => {
  const { raw, session } = open();
  const r = adviseDeadlines(session.currentData());
  raw.close();
  assert.equal(r.alreadyOk, true);
  assert.equal(r.feasible, true);
  assert.deepEqual(r.actions, []);
  assert.equal(r.runs, 1);
});

test('마감을 당기면: 인원 위주로 맞추고, 아무도 늦어지지 않는다', () => {
  const { raw, session } = tight();
  const data = session.currentData();
  raw.close();
  const r = adviseDeadlines(data);
  assert.equal(r.before.find(o => o.updateId === 'LAUNCH').late, 32);
  assert.equal(r.alreadyOk, false);
  assert.equal(r.feasible, true);
  assert.ok(r.after.every(o => o.late === 0));
  // 인원이 물량 줄이기보다 싸다 → 인원만 쓴다
  assert.ok(r.actions.every(a => a.kind === 'headcount'), JSON.stringify(r.actions));
  assert.ok(r.totals.extraHeadMonths > 0 && r.totals.extraHeadMonths <= 15, `${r.totals.extraHeadMonths}`);
  assert.equal(r.totals.cutUnits, 0);
  // 인원은 런칭 시작 ~ 마감 달 사이에만
  assert.ok(r.actions.every(a => a.fromMonth === '2026-11' && a.toMonth === '2027-03'));
  // 원래 다 맞던 업데이트는 그대로 맞는다(걸음마다 아무도 나빠지지 않음)
  for (const o of r.after) assert.ok(o.late <= r.before.find(b => b.updateId === o.updateId).late);
});

test('수단 켜고 끄기: 물량만 허용하면 선택 → 모든 리소스 순서로 최저까지 줄인다', () => {
  const { raw, session } = tight();
  const data = session.currentData();
  raw.close();
  const r = adviseDeadlines(data, { levers: { headcount: false, priority: false } });
  assert.equal(r.feasible, true);
  assert.deepEqual(r.steps.map(s => s.kind), ['volumeToMin', 'volumeToMin']);
  assert.match(r.steps[0].label, /선택 리소스/);
  assert.match(r.steps[1].label, /모든 리소스/);
  assert.deepEqual(r.actions, [{ kind: 'volumeToMin', updateId: 'LAUNCH', onlyOptional: false }]);
  assert.ok(r.totals.cutUnits > 0);
  // 아무 수단도 없으면 못 맞추고 이유를 알린다
  const none = adviseDeadlines(data, { levers: { headcount: false, volume: false, priority: false } });
  assert.equal(none.feasible, false);
  assert.equal(none.stuck[0].name, '런칭');
  assert.match(none.stuck[0].why, /다 사용했습니다/);
});

test('상한: 외주는 파트·달마다 상한 안에서, 인원 상한이 낮으면 할 수 있는 만큼만 당기고 알린다', () => {
  const { raw, session } = tight();
  const data = session.currentData();
  raw.close();
  const r = adviseDeadlines(data, { levers: { headcount: false, outsource: true, volume: false, priority: false } });
  assert.equal(r.feasible, true);
  assert.ok(r.actions.every(a => a.kind === 'outsource' && a.days <= 40));
  const low = adviseDeadlines(data, { levers: { headcount: false, outsource: true, volume: false, priority: false }, maxOutsourceDays: 10 });
  assert.ok(low.actions.every(a => a.days <= 10));
  const one = adviseDeadlines(data, { levers: { volume: false, priority: false }, maxHeadsPerPart: 0.5 });
  assert.equal(one.feasible, false);
  assert.ok(lateOf(one, 'LAUNCH') > 0 && lateOf(one, 'LAUNCH') < 32, '못 맞춰도 할 수 있는 만큼은 당긴다');
  assert.ok(one.actions.every(a => a.delta <= 0.5));
  assert.equal(one.stuck[0].name, '런칭');
});

test('크게 넘치면(과부하 샘플): 상한 안에서 할 수 있는 만큼 당기고 남은 것과 이유를 알린다', () => {
  const { raw, session } = open('overload');
  const data = session.currentData();
  raw.close();
  const r = adviseDeadlines(data);
  assert.equal(r.feasible, false);
  assert.ok(r.stuck.length > 0 && r.stuck.every(s => s.why));
  const score = os => os.reduce((a, o) => a + o.late, 0);
  assert.ok(score(r.after) < score(r.before));
  // 다른 업데이트를 희생하지 않는다: 런칭(1순위)을 뒤로 미는 제안은 없다
  assert.ok(!r.actions.some(a => a.kind === 'priority' && a.updateId === 'LAUNCH'));
  for (const o of r.after) assert.ok(o.late <= r.before.find(b => b.updateId === o.updateId).late + 1e-9);
});

test('시나리오로 만들기: 제안 결과 = 그 시나리오의 비교 결과(완료 예정이 하나하나 같다)', () => {
  for (const levers of [undefined, { headcount: false, priority: false }, { headcount: false, outsource: true, volume: false }]) {
    const { raw, db, session } = tight();
    const r = adviseDeadlines(session.currentData(), { levers });
    const id = adviceToScenario(db, '마감 맞춤', r.actions);
    const v = compareScenarios(db, session, [id]);
    const sc = listScenarios(db).find(s => s.scenarioId === id);
    raw.close();
    assert.ok(v.columns.every(c => !c.blocked));
    for (const o of r.after) assert.equal(v.rows.find(x => x.updateId === o.updateId).cells[1].completion, o.completion, `${JSON.stringify(levers)} ${o.name}`);
    assert.equal(sc.actions.length, r.actions.length);
  }
});

test('시나리오로 만들기: 우선순위 바꾸기도 같은 결과, 동작이 틀리면 아무것도 남기지 않는다', () => {
  const path = `${OUT}/scale.arp`;
  createProjectFile(path, buildScaleData()).close();
  const raw = openProjectFile(path);
  const db = nodeDb(raw);
  const session = new ProjectSession(db);
  const r = adviseDeadlines(session.currentData());
  assert.equal(r.feasible, true);
  assert.ok(r.totals.reprioritized > 0, '현실 규모 샘플은 우선순위 바꾸기를 쓴다');
  const id = adviceToScenario(db, '마감 맞춤', r.actions);
  const v = compareScenarios(db, session, [id]);
  for (const o of r.after) assert.equal(v.rows.find(x => x.updateId === o.updateId).cells[1].completion, o.completion, o.name);
  const n = listScenarios(db).length;
  assert.throws(() => adviceToScenario(db, '틀림', [{ kind: 'headcount', partId: '없음', fromMonth: '2027-01', toMonth: '2027-01', delta: 1 }]), /없는 파트/);
  assert.equal(listScenarios(db).length, n);
  assert.throws(() => adviceToScenario(db, '빈', []), /없습니다/);
  raw.close();
});

test('최저 물량 동작: 목표·최대를 최저로 맞추는 변경 줄, 비교하면 당겨진다', () => {
  const { raw, db, session } = open();
  const id = applyScenarioOp(db, { kind: 'create', name: '최저' }).createdId;
  applyScenarioOp(db, { kind: 'addAction', scenarioId: id, action: { kind: 'volumeToMin', updateId: 'LAUNCH', onlyOptional: false } });
  const rows = db.all("SELECT field, value_json, label FROM scenario_changes WHERE scenario_id = ?", [id]);
  const mins = db.all("SELECT * FROM volumes WHERE update_id = 'LAUNCH' AND min_qty IS NOT NULL");
  assert.equal(rows.length, mins.length * 2);
  assert.match(rows[0].label, /런칭 모든 리소스를 최소안 물량으로/);
  const v = compareScenarios(db, session, [id]);
  raw.close();
  assert.ok(v.rows.find(x => x.updateId === 'LAUNCH').cells[1].delta < 0, '물량을 줄이면 당겨진다');
});

test('물량 줄이기는 지금 물량 구간 기준: 확장안이면 확장 → 최저, 최저안이면 제안하지 않는다(전체 점검에서 찾음)', () => {
  const { raw, session } = tight();
  const data = session.currentData();
  raw.close();
  // 목표 = 최저, 확장만 크다 → 목표안 기준으로는 줄일 것이 없지만 확장안에서는 있다
  const flat = { ...data, volumes: data.volumes.map(v => (v.update_id === 'LAUNCH' ? { ...v, target_qty: v.min_qty, stretch_qty: (v.min_qty ?? 0) + 5 } : v)) };
  const stretch = adviseDeadlines(flat, { planMode: 'STRETCH', levers: { headcount: false, priority: false } });
  assert.ok(stretch.steps.some(s => s.kind === 'volumeToMin'), JSON.stringify(stretch.steps));
  assert.ok(stretch.totals.cutUnits > 0);
  const min = adviseDeadlines(data, { planMode: 'MIN', levers: { headcount: false, priority: false } });
  assert.ok(!min.steps.some(s => s.kind === 'volumeToMin'));
});
