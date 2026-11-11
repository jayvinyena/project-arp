// 제작 현황판(core/dashboard.ts): 진행률 · 항목 × 파트 · 추이 · 이번 주 완료 · 처리할 것 · 단계 분포 · 배치
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { dashboardView } from '../core/dashboard.ts';
import { progressView } from '../core/plan.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-dashboard', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let n = 0;
function open(name) {
  const path = `${OUT}/${name}-${(n += 1)}.arp`;
  copyFileSync(samples[name], path);
  const raw = openProjectFile(path);
  const db = nodeDb(raw);
  return { raw, db, session: new ProjectSession(db) };
}
const TODAY = '2026-11-09';

test('진행률 = 작업 진척 화면의 기본 공수 기준 진행(에셋 · 손 입력 같은 기준) · 항목 × 파트 칸', () => {
  for (const name of ['normal', 'assets']) {
    const t = open(name);
    const d = dashboardView(t.db, 'LAUNCH', 'TARGET', TODAY);
    const p = progressView(t.db, 'LAUNCH').summary;
    assert.ok(Math.abs(d.summary.doneDays - p.doneDays) < 1e-6 && Math.abs(d.summary.totalDays - p.totalDays) < 1e-6, `${name}: ${d.summary.doneDays}/${d.summary.totalDays} vs ${p.doneDays}/${p.totalDays}`);
    const char = d.matrix.flatMap(g => g.rows).find(r => r.resourceTypeId === 'CHAR_NEW');
    assert.deepEqual(char.cells.map(c => c && c.done), [3, 1, 0, 0], name);
    assert.equal(char.cells[0].need, 10);
    // 코스튬은 FX를 거치지 않는다
    assert.equal(d.matrix.flatMap(g => g.rows).find(r => r.resourceTypeId === 'COSTUME').cells[3], null);
    t.raw.close();
  }
});

test('계획선: 시작 0% → 제작 완료 목표 100%, 앞섬 · 늦음(영업일 어림) · 추이 점은 주 단위, 오늘 뒤로는 실제 없음', () => {
  const t = open('assets');
  const d = dashboardView(t.db, 'LAUNCH', 'TARGET', TODAY);
  assert.equal(d.window.start, '2026-11-02');
  assert.equal(d.window.target, '2027-05-31');
  assert.ok(d.summary.idealRate > 0 && d.summary.idealRate < 0.05, String(d.summary.idealRate));
  assert.equal(typeof d.summary.aheadWorkdays, 'number');
  const pts = d.trend.points;
  assert.ok(pts.length >= 30);
  assert.ok(pts.every((p, i) => i === 0 || Date.parse(p.date) - Date.parse(pts[i - 1].date) === 7 * 86400000));
  assert.ok(pts.filter(p => p.actual != null).every(p => p.date <= '2026-11-15'), '오늘이 든 주까지만 실제 선');
  const last = pts.filter(p => p.actual != null).at(-1);
  assert.ok(Math.abs(last.actual - d.summary.doneDays) < 1e-6, '실제 선의 끝 = 지금 완료 공수');
  assert.ok(Math.abs(pts.at(-1).ideal - d.summary.totalDays) < 1e-6, '계획선은 목표일에 100%');
  t.raw.close();
});

test('이번 주 완료 · 처리할 것(검수 요청 · 수정 · 보류 · 마감 지남 · 오래 머문 진행) · 단계 분포 · 배치', () => {
  const t = open('assets');
  const ctx = { editor: '검사', batchId: 'x' };
  applyEdit(t.db, t.session, { kind: 'assetPart', assetIds: ['A00005'], partId: 'CONCEPT', status: 'DONE', doneAt: '2026-11-09' }, ctx);
  applyEdit(t.db, t.session, { kind: 'assetField', assetIds: ['A00002'], field: 'due_date', value: '2026-11-01' }, ctx);
  t.db.run("UPDATE asset_parts SET started_at = '2026-10-01' WHERE asset_id = 'A00013' AND part_id = 'CONCEPT'");
  const d = dashboardView(t.db, 'LAUNCH', 'TARGET', TODAY);
  assert.equal(d.summary.weekDone, 1, '이번 주(11-09 월요일부터) 완료 1');
  assert.equal(d.summary.lastWeekDone, 4, '지난주(11-02 ~ 11-08): 원화 3 + 모델링 1');
  assert.deepEqual(d.todo.review.map(x => x.name), ['닌자맛 쿠키']);
  assert.equal(d.todo.review[0].part, '원화');
  assert.deepEqual(d.todo.retake.map(x => x.name), ['딸기맛 쿠키']);
  assert.deepEqual(d.todo.hold.map(x => x.name), ['불꽃정령 쿠키']);
  assert.deepEqual(d.todo.overdue.map(x => x.name), ['딸기맛 쿠키']);
  assert.deepEqual(d.todo.stale.map(x => x.name), ['학교 교복']);
  assert.equal(d.stages.list.map(s => s.name).join(','), '대기,원화,모델링,애니메이션,FX,완료');
  const char = d.stages.groups.find(g => g.name === '캐릭터');
  assert.equal(char.total, 20);
  assert.equal(char.counts.reduce((a, b) => a + b, 0), 20);
  assert.equal(d.batches.length, 2);
  assert.equal(d.batches[0].daysLeft, 81, '1차 납품 2027-01-29까지 81일');
  assert.ok(d.batches[0].progress > 0);
  t.raw.close();
});

test('에셋이 없는 프로젝트도 현황판이 나온다(단계 분포 · 처리할 것은 비어 있음)', () => {
  const t = open('normal');
  const d = dashboardView(t.db, 'S1', 'TARGET', TODAY);
  assert.equal(d.stages, null);
  assert.equal(d.summary.assets, 0);
  assert.ok(d.matrix.length > 0);
  assert.ok(d.trend.points.length > 0);
  t.raw.close();
});

test('담당별(docs/32 7): 상태별 수 · 명단에 없는 이름 · 담당 없음 · 파트 인원 비교', () => {
  const t = open('assets');
  let k = 0;
  const apply = e => applyEdit(t.db, t.session, e, { editor: '검사', batchId: `dp${(k += 1)}` });
  const d = dashboardView(t.db, 'LAUNCH', 'TARGET', TODAY);
  const row = name => d.people.rows.find(r => r.name === name);
  // 예시: 김원화 4칸 · 이원화 3칸 · 박모델 2칸(명단에 있음)
  for (const [name, n] of [['김원화', 4], ['이원화', 3], ['박모델', 2]]) {
    const r = row(name);
    assert.ok(r && r.inRoster, name);
    assert.equal(r.todo + r.wip + r.review + r.retake + r.hold + r.done, n, name);
  }
  assert.equal(row('김원화').team, '원화');
  // 담당 없음 줄은 맨 뒤
  assert.equal(d.people.rows.at(-1).name, null);
  // 명단에 없는 이름(공백이 달라도 같은 사람은 한 줄)
  const a = String(t.db.get("SELECT asset_id FROM assets WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW' LIMIT 1").asset_id);
  apply({ kind: 'assetPart', assetIds: [a], partId: 'FX', assignee: '정이펙트' });
  const d2 = dashboardView(t.db, 'LAUNCH', 'TARGET', TODAY);
  const j = d2.people.rows.find(r => r.name === '정이펙트');
  assert.deepEqual([j.inRoster, j.team, j.todo], [false, null, 1]);
  assert.ok(d2.people.rows.indexOf(j) > d2.people.rows.findIndex(r => r.name === '박모델'), '명단에 없는 이름은 명단 사람 뒤');
  // 파트 인원: 이번 달(2026-11) 명단(참여 중, 소속팀 = 파트) vs 인력 표
  assert.equal(d2.people.headcount.month, '2026-11');
  const concept = d2.people.headcount.parts.find(p => p.name === '원화');
  assert.equal(concept.roster, 2);
  assert.equal(typeof concept.capacity, 'number');
});

test('파이프라인별 단계 분포(docs/32 8): 열 = 그 파이프라인 묶음(병렬은 한 칸), 합계 = 에셋 수', () => {
  const t = open('assets');
  let k = 0;
  const apply = e => applyEdit(t.db, t.session, e, { editor: '검사', batchId: `dq${(k += 1)}` });
  const pid = String(t.db.get("SELECT pipeline_id FROM resource_types WHERE resource_type_id = 'CHAR_NEW'").pipeline_id);
  apply({ kind: 'stepParallel', pipelineId: pid, partId: 'FX', withPrev: true });
  const d = dashboardView(t.db, 'LAUNCH', 'TARGET', TODAY);
  const ps = d.pipelineStages.find(p => p.pipelineId === pid);
  assert.deepEqual(ps.list.map(x => x.name), ['대기', '원화', '모델링', '애니메이션 ∥ FX', '완료']);
  const totalAssets = d.pipelineStages.reduce((s, p) => s + p.total, 0);
  assert.equal(totalAssets, d.summary.assets, '빠짐없이 센다');
  assert.equal(ps.counts.reduce((x, y) => x + y, 0), ps.total);
  // 항목별 분포와 합이 같다
  assert.equal(d.stages.groups.reduce((s, g) => s + g.total, 0), totalAssets);
});
