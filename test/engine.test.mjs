// 1단계 엔진 검사: 손 계산 예시, 성질 검사, 판정, 시나리오, 골든 결과, 속도
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { buildScaleData } from '../tools/gen-scale.mjs';
import { openProjectFile, createProjectFile } from '../tools/lib/project-db.mjs';
import { calculate, readProjectData } from '../tools/lib/pipeline.mjs';
import { runPlan } from '../engine/index.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EPS = 1e-6;
const OUT = `${ROOT}samples/out/test-engine`;
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));

function loadData(name) {
  const db = openProjectFile(samples[name]);
  const data = readProjectData(db);
  db.close();
  return data;
}
const clone = d => structuredClone(d);
const launchOf = r => r.updates.find(u => u.isLaunch);

// ───────── 손 계산 예시 (docs/04-engine-rules.md 4절) ─────────

function tinyData(overlapRate) {
  return {
    settings: {
      horizon_start_month: '2027-03', horizon_end_month: '2027-04', work_weekdays: '1111100', buffer_rate: 0,
      default_overlap_rate: 0, load_warn_rate: 0.8, load_over_rate: 1, load_critical_rate: 1.2, late_warn_workdays: 10, default_plan_mode: 'TARGET',
    },
    holidays: [],
    parts: [{ part_id: 'A', name: '원화', sort_order: 1, active: 1 }, { part_id: 'B', name: '모델링', sort_order: 2, active: 1 }],
    part_overlaps: [{ from_part_id: 'A', to_part_id: 'B', overlap_rate: overlapRate }],
    resource_types: [{ resource_type_id: 'R', group_id: null, name: '리소스', sort_order: 1, active: 1 }],
    resource_parts: [{ resource_type_id: 'R', part_id: 'A', rework_rate: 0 }, { resource_type_id: 'R', part_id: 'B', rework_rate: 0 }],
    efforts: [{ resource_type_id: 'R', part_id: 'A', profile_id: 'BASE', days: 10 }, { resource_type_id: 'R', part_id: 'B', profile_id: 'BASE', days: 15 }],
    effort_mix: [],
    update_types: [{ update_type_id: 'L', name: '런칭', is_launch: 1, sort_order: 1, active: 1 }],
    updates: [{ update_id: 'U', name: '런칭', update_type_id: 'L', start_date: '2027-03-01', freeze_date: null, release_date: '2027-04-30', priority: 1, status: 'PLANNED', sort_order: 1 }],
    volumes: [{ update_id: 'U', resource_type_id: 'R', min_qty: 1, target_qty: 1, stretch_qty: 1, required: 1, priority: 1, difficulty: 1, reuse_rate: 0, outsource_qty: 0 }],
    progress: [],
    capacity: ['2027-03', '2027-04'].flatMap(month => ['A', 'B'].map(part_id => ({
      part_id, month, headcount: 1, utilization: 1, productivity: 1, outsource_days: 0, support_days: 0,
    }))),
  };
}

test('손 계산: 원화 10일 · 모델링 15일 · 겹침 20% → 모델링 9일째 시작, 23일째 완료', () => {
  const r = runPlan(tinyData(0.2));
  const days = r.daily.dates;
  const [a, b] = r.stages;
  assert.equal(a.startDate, days[0]);
  assert.equal(a.workDoneDate, days[9]);
  assert.equal(b.startDate, days[8]);
  assert.equal(b.completionDate, days[22]);
});

/** 수량 2개(원화 5일/개 · 모델링 7.5일/개 = 원화 10일 · 모델링 15일), 원화 1개는 이미 끝냄(작업 진척) */
function tinyWithProgress(overlapRate, asOf) {
  const d = tinyData(overlapRate);
  d.efforts[0].days = 5; d.efforts[1].days = 7.5;
  Object.assign(d.volumes[0], { min_qty: 2, target_qty: 2, stretch_qty: 2 });
  d.progress = [{ update_id: 'U', resource_type_id: 'R', part_id: 'A', completed_qty: 1, as_of: asOf }];
  return d;
}

test('작업 진척 · 앞 공정 진행률은 이미 끝낸 몫을 넣어 센다: 원화 절반 완료, 겹침 20% → 원화 3일 더 하면(전체 80%) 모델링 시작', () => {
  const r = runPlan(tinyWithProgress(0.2, '2027-02-26'));
  const days = r.daily.dates;
  const [a, b] = r.stages;
  assert.equal(a.startDate, days[0]);
  assert.equal(a.workDoneDate, days[4], '남은 원화 5일');
  assert.equal(b.startDate, days[3], '(5 + 3) ÷ 10 = 80%가 된 다음 날 아침');
  // 옛 방식(남은 일 기준 진행률)은 남은 5일의 80% = 4일 뒤
  const old = runPlan(tinyWithProgress(0.2, '2027-02-26'), { legacyProgress: true });
  assert.equal(old.stages[1].startDate, old.daily.dates[4]);
});

test('작업 진척 · 남은 일은 기준일 다음 날부터: 기준일 3/10 → 3/11부터 배정, 완료 예정은 기준일보다 빠르지 않다', () => {
  const r = runPlan(tinyWithProgress(0.2, '2027-03-10'));
  const days = r.daily.dates;
  assert.equal(r.stages[0].startDate, '2027-03-11');
  assert.equal(r.stages[0].startDate, days[8]);
  assert.ok(r.updates[0].expectedCompletionDate > '2027-03-10');
  // 기준일이 시작일보다 앞이면 시작일 그대로 · 옛 방식은 기준일을 보지 않는다
  assert.equal(runPlan(tinyWithProgress(0.2, '2027-02-26')).stages[0].startDate, days[0]);
  assert.equal(runPlan(tinyWithProgress(0.2, '2027-03-10'), { legacyProgress: true }).stages[0].startDate, days[0]);
  // 완료 수량이 0인 진척 행은 기준일로 치지 않는다
  const zero = tinyWithProgress(0.2, '2027-03-10'); zero.progress[0].completed_qty = 0;
  assert.equal(runPlan(zero).stages[0].startDate, days[0]);
});

/** 원화 10일 → (모델링 15일 ∥ 이펙트 원화 6일) → 애니 8일(docs/30 5.3). parallel이 false면 한 줄 */
function tinyParallel(parallel, overlapRate = 0) {
  const d = tinyData(overlapRate);
  d.part_overlaps = [];
  d.settings.default_overlap_rate = overlapRate;
  d.parts.push({ part_id: 'C', name: '이펙트 원화', sort_order: 3, active: 1 }, { part_id: 'D', name: '애니', sort_order: 4, active: 1 });
  d.resource_parts.push({ resource_type_id: 'R', part_id: 'C', rework_rate: 0 }, { resource_type_id: 'R', part_id: 'D', rework_rate: 0 });
  d.efforts.push({ resource_type_id: 'R', part_id: 'C', profile_id: 'BASE', days: 6 }, { resource_type_id: 'R', part_id: 'D', profile_id: 'BASE', days: 8 });
  d.capacity = ['2027-03', '2027-04', '2027-05'].flatMap(month => ['A', 'B', 'C', 'D'].map(part_id => ({ part_id, month, headcount: 1, utilization: 1, productivity: 1, outsource_days: 0, support_days: 0 })));
  d.settings.horizon_end_month = '2027-05';
  d.resource_types[0].pipeline_id = 'P';
  d.pipeline_steps = [
    { pipeline_id: 'P', part_id: 'A', seq: 1, overlap_rate: null, with_prev: 0 },
    { pipeline_id: 'P', part_id: 'B', seq: 2, overlap_rate: null, with_prev: 0 },
    { pipeline_id: 'P', part_id: 'C', seq: 3, overlap_rate: null, with_prev: parallel ? 1 : 0 },
    { pipeline_id: 'P', part_id: 'D', seq: 4, overlap_rate: null, with_prev: 0 },
  ];
  return d;
}

test('손 계산(병렬 묶음, docs/30): 원화 10 → (모델링 15 ∥ 이펙트 원화 6) → 애니 8, 겹침 0%', () => {
  const r = runPlan(tinyParallel(true));
  const days = r.daily.dates;
  const by = Object.fromEntries(r.stages.map(s => [s.partId, s]));
  assert.equal(by.B.startDate, days[10], '모델링 11일째');
  assert.equal(by.C.startDate, days[10], '이펙트 원화도 11일째(같은 앞 공정을 기다림)');
  assert.deepEqual([by.B.predecessorPartIds, by.C.predecessorPartIds], [['A'], ['A']]);
  assert.equal(by.C.workDoneDate, days[15], '이펙트 원화 16일째에 일을 마침');
  assert.equal(by.C.completionDate, days[15], '같은 묶음끼리는 완료 제약 없음(원화보다 늦으면 그대로)');
  assert.equal(by.B.completionDate, days[24]);
  assert.deepEqual(by.D.predecessorPartIds, ['B', 'C'], '애니는 앞 묶음 모두를 기다린다');
  assert.equal(by.D.startDate, days[25], '모델링이 끝난 다음 날(26일째)');
  assert.equal(by.D.completionDate, days[32]);
  // 한 줄이면: 이펙트 원화는 모델링(25일째)을 기다려 26일째, 애니는 32일째에 시작
  const seq = runPlan(tinyParallel(false));
  const sb = Object.fromEntries(seq.stages.map(s => [s.partId, s]));
  assert.equal(sb.C.startDate, days[25]);
  assert.equal(sb.D.startDate, days[31]);
  assert.ok(r.updates[0].expectedCompletionDate < seq.updates[0].expectedCompletionDate, '병렬이 더 일찍 끝난다');
  // 늦어진 이유: 애니의 완료를 정한 앞 공정 쪽으로 거슬러 간다(병렬 묶음에서도 깨지지 않음)
  assert.ok(r.updates[0].reason);
});

test('손 계산(병렬 묶음): 앞 묶음 중 하나라도 겹침 조건을 못 채우면 시작하지 않는다', () => {
  // 겹침 50%: 애니는 모델링(15일)이 50% · 이펙트 원화(6일)가 50% 진행돼야 시작 → 모델링 쪽이 늦다
  const r = runPlan(tinyParallel(true, 0.5));
  const days = r.daily.dates;
  const by = Object.fromEntries(r.stages.map(s => [s.partId, s]));
  assert.equal(by.B.startDate, days[5], '원화 50% 뒤 6일째');
  assert.equal(by.C.startDate, days[5]);
  // 모델링 7.5일 진행 = 6+7.5 → 13일째 저녁에 50% 넘음 → 14일째 아침
  assert.equal(by.D.startDate, days[13]);
  assert.ok(by.D.predecessorProgressAtStart >= 0.5 - 1e-9);
});

test('손 계산: 겹침 0% → 모델링 11일째 시작, 25일째 완료 (2영업일 늦음)', () => {
  const r = runPlan(tinyData(0));
  const days = r.daily.dates;
  assert.equal(r.stages[1].startDate, days[10]);
  assert.equal(r.stages[1].completionDate, days[24]);
});

test('손 계산: 겹침 100% → 앞 공정 시작 다음 날 시작, 완료는 앞 공정보다 빠르지 않다', () => {
  const data = tinyData(1);
  data.efforts[1].days = 5; // 모델링이 더 짧으면 완료 제약이 걸린다
  const r = runPlan(data);
  const days = r.daily.dates;
  assert.equal(r.stages[1].startDate, days[1]);
  assert.equal(r.stages[1].workDoneDate, days[5]);
  assert.equal(r.stages[1].completionDate, r.stages[0].completionDate);
});

// ───────── 성질 검사 (정상·과부하·현실 규모) ─────────

function checkProperties(r, data, label) {
  // 하루 배정량은 하루 작업 가능량을 넘지 않는다
  r.daily.assigned.forEach((row, pi) => row.forEach((v, d) => {
    assert.ok(v <= r.daily.capacity[pi][d] + EPS, `${label}: ${r.daily.partIds[pi]} ${r.daily.dates[d]} 배정 ${v} > ${r.daily.capacity[pi][d]}`);
  }));
  // 배정 합 = 끝낸 일 합
  r.daily.partIds.forEach((partId, pi) => {
    const assigned = r.daily.assigned[pi].reduce((a, b) => a + b, 0);
    const worked = r.stages.filter(s => s.partId === partId).reduce((sum, s) => sum + (s.requiredDays - s.remainingDays), 0);
    assert.ok(Math.abs(assigned - worked) < 1e-4, `${label}: ${partId} 배정 ${assigned} ≠ 작업 ${worked}`);
  });
  const starts = new Map(data.updates.map(u => [u.update_id, u.start_date]));
  const byKey = new Map(r.stages.map(s => [`${s.updateId}|${s.resourceTypeId}|${s.partId}`, s]));
  for (const s of r.stages) {
    if (s.startDate) assert.ok(s.startDate >= starts.get(s.updateId), `${label}: 업데이트 시작 전 배정 ${s.updateId}`);
    if (s.workDoneDate && s.completionDate) assert.ok(s.completionDate >= s.workDoneDate);
    if (!s.predecessorPartId || s.alreadyDone || !s.startDate) continue;
    const p = byKey.get(`${s.updateId}|${s.resourceTypeId}|${s.predecessorPartId}`);
    if (p.alreadyDone) continue;
    assert.ok(p.startDate < s.startDate, `${label}: 앞 공정보다 먼저/같은 날 시작`);
    assert.ok(s.predecessorProgressAtStart >= 1 - s.overlapRate - EPS, `${label}: 겹침 조건 위반 ${s.predecessorProgressAtStart} < ${1 - s.overlapRate}`);
    if (s.completionDate) assert.ok(p.completionDate && s.completionDate >= p.completionDate, `${label}: 앞 공정보다 먼저 완료`);
  }
}

test('성질: 정상·과부하 샘플', () => {
  for (const name of ['normal', 'overload']) {
    const data = loadData(name);
    for (const planMode of ['MIN', 'TARGET', 'STRETCH']) checkProperties(runPlan(data, { planMode }), data, `${name}/${planMode}`);
  }
});

test('성질: 현실 규모 (파트 8 · 리소스 500 · 업데이트 50)', () => {
  const path = `${OUT}/scale.arp`;
  createProjectFile(path, buildScaleData()).close();
  const db = openProjectFile(path);
  const data = readProjectData(db);
  db.close();
  checkProperties(runPlan(data), data, 'scale');
});

// ───────── 단조성 (같은 조건에서 더 좋게 바꾸면 늦어지지 않는다) ─────────

test('겹침률을 올리면 런칭이 늦어지지 않는다 (0 → 0.2 → 1)', () => {
  const base = loadData('normal');
  const finish = rate => {
    const d = clone(base);
    d.part_overlaps = d.part_overlaps.map(o => ({ ...o, overlap_rate: rate }));
    d.settings.default_overlap_rate = rate;
    return launchOf(runPlan(d)).expectedCompletionDate;
  };
  const [r0, r2, r10] = [finish(0), finish(0.2), finish(1)];
  assert.ok(r10 <= r2 && r2 <= r0, `${r10} ≤ ${r2} ≤ ${r0}`);
});

test('모델링 인원을 늘리면 런칭이 늦어지지 않는다', () => {
  const base = loadData('normal');
  const more = clone(base);
  more.capacity = more.capacity.map(c => (c.part_id === 'MODELING' ? { ...c, headcount: c.headcount + 1 } : c));
  assert.ok(launchOf(runPlan(more)).expectedCompletionDate <= launchOf(runPlan(base)).expectedCompletionDate);
});

test('물량 구간: 최저 ≤ 목표 ≤ 확장 순으로 런칭 완료가 늦어진다', () => {
  const data = loadData('normal');
  const [min, target, stretch] = ['MIN', 'TARGET', 'STRETCH'].map(planMode => launchOf(runPlan(data, { planMode })).expectedCompletionDate);
  assert.ok(min <= target && target <= stretch, `${min} ≤ ${target} ≤ ${stretch}`);
});

// ───────── 판정 ─────────

test('판정: 정상 샘플 런칭은 목표 안, 과부하 샘플은 늦거나 못 끝내고 근거가 붙는다', () => {
  assert.equal(launchOf(runPlan(loadData('normal'))).status, 'ON_TRACK');
  const over = launchOf(runPlan(loadData('overload')));
  assert.ok(['LATE', 'UNFINISHED'].includes(over.status));
  assert.ok(over.critical);
  assert.ok(over.reason && over.reason.partId);
  const overParts = runPlan(loadData('overload')).parts;
  assert.ok(overParts.every(p => p.level === 'CRITICAL'));
});

test('판정: 출시일이 없으면 늦음 판단 없이 완료 예정일만', () => {
  const data = loadData('normal');
  data.updates.find(u => u.update_id === 'S2').release_date = null;
  const s2 = runPlan(data).updates.find(u => u.updateId === 'S2');
  assert.equal(s2.status, 'NO_RELEASE_DATE');
  assert.ok(s2.expectedCompletionDate);
});

// ───────── 계산 흐름 · 시나리오 ─────────

test('흐름: 오류가 있는 파일은 계산하지 않고 이유를 돌려준다', () => {
  const db = openProjectFile(samples.broken);
  const out = calculate(db);
  db.close();
  assert.equal(out.blocked, true);
  assert.equal(out.result, null);
  assert.ok(out.findings.some(f => f.code === 'U01'));
});

test('시나리오: 결과는 바뀌고 원본 파일은 그대로다', () => {
  const db = openProjectFile(samples.normal);
  const before = db.prepare("SELECT headcount FROM capacity WHERE part_id = 'MODELING' AND month = '2027-01'").get().headcount;
  const base = calculate(db);
  const sc = calculate(db, { scenarioId: 'SC1' });
  const after = db.prepare("SELECT headcount FROM capacity WHERE part_id = 'MODELING' AND month = '2027-01'").get().headcount;
  db.close();
  assert.equal(before, after);
  assert.equal(sc.skipped.length, 0);
  const concept = r => r.parts.find(p => p.partId === 'CONCEPT').requiredDays;
  assert.ok(concept(sc.result) < concept(base.result), '원화 AI 비율을 올리면 원화 필요 공수가 준다');
  const modelingCap = r => r.parts.find(p => p.partId === 'MODELING').capacityDays;
  assert.ok(modelingCap(sc.result) > modelingCap(base.result));
});

// ───────── 골든 결과 ─────────

test('골든: 정상 샘플 목표안 결과가 바뀌지 않았다 (UPDATE_GOLDEN=1 이면 새로 씀)', () => {
  const r = runPlan(loadData('normal'));
  const snapshot = {
    updates: r.updates.map(u => ({ id: u.updateId, status: u.status, completion: u.expectedCompletionDate, late: u.lateWorkdays })),
    parts: r.parts.map(p => ({ id: p.partId, required: +p.requiredDays.toFixed(3), capacity: +p.capacityDays.toFixed(3), peak: p.peakMonth })),
    stages: r.stages.map(s => [s.updateId, s.resourceTypeId, s.partId, s.startDate, s.completionDate]),
  };
  const path = `${ROOT}test/golden/normal-target.json`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
    mkdirSync(`${ROOT}test/golden`, { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 1)}\n`);
  }
  assert.deepEqual(snapshot, JSON.parse(readFileSync(path, 'utf8')));
});

// ───────── 속도 ─────────

test('속도: 현실 규모 계산(검증 + 읽기 + 엔진)이 100ms 안', () => {
  const path = `${OUT}/scale.arp`;
  const db = openProjectFile(path);
  calculate(db); // 데우기
  const runs = Array.from({ length: 5 }, () => calculate(db).timings);
  db.close();
  const best = Math.min(...runs.map(t => t.totalMs));
  const engine = Math.min(...runs.map(t => t.engineMs));
  console.log(`  현실 규모: 합계 ${best.toFixed(1)}ms · 엔진 ${engine.toFixed(1)}ms`);
  assert.ok(best < 100, `${best}ms`);
});

// ───────── 작업 세션 (바뀐 표만 다시 읽기) ─────────

test('작업 세션: 고친 뒤·시나리오 계산 결과가 매번 전부 읽는 계산과 같다', async () => {
  const { ProjectSession } = await import('../core/pipeline.ts');
  const { nodeDb } = await import('../tools/lib/pipeline.mjs');
  const db = openProjectFile(samples.normal);
  const session = new ProjectSession(nodeDb(db));
  const same = (a, b) => assert.deepEqual(
    a.result.updates.map(u => [u.updateId, u.expectedCompletionDate, u.status]),
    b.result.updates.map(u => [u.updateId, u.expectedCompletionDate, u.status]),
  );
  same(session.calculate(), calculate(db));
  session.edit("UPDATE capacity SET headcount = headcount - 2 WHERE part_id = 'MODELING'", [], ['capacity']);
  const edited = session.calculate();
  same(edited, calculate(db));
  assert.notDeepEqual(edited.result.parts.find(p => p.partId === 'MODELING').capacityDays, 1213.6);
  same(session.calculate({ scenarioId: 'SC1' }), calculate(db, { scenarioId: 'SC1' }));
  same(session.calculate(), calculate(db)); // 시나리오 뒤 원본 캐시는 그대로
  db.close();
});

// ───────── 배치 예측(docs/33) ─────────
/** docs/33 4절: 원화 · 모델링 각 1명, 원화 2일/개 · 모델링 3일/개, 겹침 0%. X(1차 2 · 2차 2) · Y(1차 2) */
function batchData(withBatches = true) {
  const d = tinyData(0);
  d.efforts = ['X', 'Y'].flatMap(rt => [{ resource_type_id: rt, part_id: 'A', profile_id: 'BASE', days: 2 }, { resource_type_id: rt, part_id: 'B', profile_id: 'BASE', days: 3 }]);
  d.resource_types = [{ resource_type_id: 'X', group_id: null, name: 'X', sort_order: 1, active: 1 }, { resource_type_id: 'Y', group_id: null, name: 'Y', sort_order: 2, active: 1 }];
  d.resource_parts = ['X', 'Y'].flatMap(rt => ['A', 'B'].map(p => ({ resource_type_id: rt, part_id: p, rework_rate: 0 })));
  const vol = (rt, q) => ({ update_id: 'U', resource_type_id: rt, min_qty: q, target_qty: q, stretch_qty: q, required: 1, priority: 1, difficulty: 1, reuse_rate: 0, outsource_qty: 0 });
  d.volumes = [vol('X', 4), vol('Y', 2)];
  if (withBatches) {
    d.batches = [{ batch_id: 'B1', update_id: 'U', name: '1차', due_date: '2027-03-31', sort_order: 1 }, { batch_id: 'B2', update_id: 'U', name: '2차', due_date: '2027-03-26', sort_order: 2 }];
    const w = (rt, b, p, rem) => ({ update_id: 'U', resource_type_id: rt, part_id: p, batch_id: b, tier: 'TARGET', remaining_qty: rem, done_qty: 0 });
    d.batch_work = [w('X', 'B1', 'A', 2), w('X', 'B1', 'B', 2), w('X', 'B2', 'A', 2), w('X', 'B2', 'B', 2), w('Y', 'B1', 'A', 2), w('Y', 'B1', 'B', 2)];
  }
  return d;
}

test('손 계산(배치, docs/33 4절): 배치 순서로 배정 → 1차 16일째 · 2차 22일째, 배치가 없으면 업데이트 26일째', () => {
  const r = runPlan(batchData(true));
  const days = r.daily.dates;
  const by = Object.fromEntries(r.batches.map(b => [b.batchId, b]));
  assert.equal(by.B1.expectedCompletionDate, days[15], '1차: Y 1차 모델링 11 ~ 16일');
  assert.equal(by.B2.expectedCompletionDate, days[21], '2차: X 2차 모델링 17 ~ 22일');
  assert.equal(r.updates[0].expectedCompletionDate, days[21]);
  // 원화 순서: X 1차(1 ~ 4) → Y 1차(5 ~ 8) → X 2차(9 ~ 12)
  const st = (rt, b, p) => r.stages.find(s => s.resourceTypeId === rt && s.batchId === b && s.partId === p);
  assert.deepEqual([st('X', 'B1', 'A').startDate, st('Y', 'B1', 'A').startDate, st('X', 'B2', 'A').startDate], [days[0], days[4], days[8]]);
  assert.equal(st('X', 'B2', 'B').predecessorPartId, 'A', '배치마다 따로 이어진다');
  // 판정: 1차 3/22 완료 · 마감 3/31 → 여유 7영업일 < 늦음 경고 10 → 빠듯, 2차 마감 3/26인데 3/30 완료 → 늦음 2영업일
  assert.deepEqual([by.B1.status, by.B1.slackWorkdays], ['TIGHT', 7]);
  const later = batchData(true); later.batches[0].due_date = '2027-04-09';
  const b1 = runPlan(later).batches.find(b => b.batchId === 'B1');
  assert.deepEqual([b1.status, b1.slackWorkdays], ['ON_TRACK', 14], '마감 4/9 → 여유 14영업일');
  assert.deepEqual([by.B2.status, by.B2.lateWorkdays], ['LATE', 2]);
  assert.equal(by.B1.reason.resourceTypeId, 'Y');
  // 배치가 없으면 지금처럼 리소스 순서: X(원화 1 ~ 8 · 모델링 9 ~ 20) → Y(모델링 21 ~ 26)
  const plain = runPlan(batchData(false));
  assert.equal(plain.updates[0].expectedCompletionDate, days[25]);
  assert.deepEqual(plain.batches, []);
  assert.ok(plain.stages.every(s => s.batchId === null));
});

test('배치: 물량 밖(배치 에셋이 남은 물량보다 많음) · 배치 순서를 바꾸면 앞으로 간 배치가 먼저 · 포함 템플릿 · 이미 끝낸 몫', () => {
  // X 물량 3인데 배치 에셋 4개 → 2차는 1개만 계산, 물량 밖 1개
  const over = batchData(true); over.volumes[0] = { ...over.volumes[0], min_qty: 3, target_qty: 3, stretch_qty: 3 };
  const ro = runPlan(over);
  assert.deepEqual(ro.batches.map(b => [b.batchId, b.overQty]), [['B1', 0], ['B2', 1]]);
  // 순서를 바꾸면 2차가 먼저 끝난다
  const swap = batchData(true); swap.batches[0].sort_order = 3;
  const rs = runPlan(swap);
  const at = (r, id) => r.batches.find(b => b.batchId === id).expectedCompletionDate;
  assert.ok(at(rs, 'B2') < at(rs, 'B1'), `${at(rs, 'B2')} < ${at(rs, 'B1')}`);
  // 최소안 계획이면 기본안(TARGET) 에셋은 배치에 들지 않는다 → 배치 결과 없음, 모두 배치 밖
  const rm = runPlan(batchData(true), { planMode: 'MIN' });
  assert.deepEqual(rm.batches, []);
  // 1차 X 원화를 이미 끝냄(완료 2, 작업 진척) → X 1차 원화 남은 일 0, 모델링이 1일째부터
  const done = batchData(true);
  done.batch_work = done.batch_work.map(w => (w.resource_type_id === 'X' && w.batch_id === 'B1' && w.part_id === 'A' ? { ...w, remaining_qty: 0, done_qty: 2 } : w));
  done.progress = [{ update_id: 'U', resource_type_id: 'X', part_id: 'A', completed_qty: 2, as_of: null }];
  const rd = runPlan(done);
  const xb1b = rd.stages.find(s => s.resourceTypeId === 'X' && s.batchId === 'B1' && s.partId === 'B');
  assert.equal(xb1b.startDate, rd.daily.dates[0]);
});
