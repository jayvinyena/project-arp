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
