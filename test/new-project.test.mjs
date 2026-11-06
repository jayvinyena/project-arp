// 2단계: 새 프로젝트 만들기 검사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { launchSnapshot, compareLaunchModes, applyLaunchEdit } from '../core/launch.ts';
import { defaultNewProject, checkNewProject, writeNewProject, fixedKoreanHolidays } from '../core/new-project.ts';

const TODAY = new Date(Date.UTC(2026, 10, 5));

function create(input) {
  const raw = new DatabaseSync(':memory:');
  const db = nodeDb(raw);
  writeNewProject(db, SCHEMA_SQL, input);
  return { raw, db, session: new ProjectSession(db) };
}

test('기본값: 문제없이 만들어지고, 검증 오류가 없고, 런칭 화면이 열린다', () => {
  const input = defaultNewProject(TODAY);
  assert.deepEqual(checkNewProject(input), []);
  assert.equal(input.horizonStart, '2026-12');
  const { raw, db, session } = create(input);
  assert.equal(raw.prepare('PRAGMA application_id').get().application_id, 1095913521);
  const snap = launchSnapshot(db);
  assert.equal(snap.projectName, '새 프로젝트');
  assert.equal(snap.rows.length, 6);
  assert.deepEqual(snap.rows.find(r => r.name === '코스튬').parts.map(p => p.name), ['원화', '모델링', '애니메이션']);
  const cmp = compareLaunchModes(db, session);
  assert.equal(cmp.blocked, false, JSON.stringify(cmp.findings));
  // 물량이 0이라 "물량 없는 업데이트" 주의만 있다
  assert.deepEqual([...new Set(cmp.findings.map(f => f.code))], ['U07']);
  // 물량을 입력하면 계산된다
  const ctx = { editor: '검사', batchId: 'b' };
  for (const f of ['min_qty', 'target_qty', 'stretch_qty']) applyLaunchEdit(db, session, { kind: 'volume', resourceTypeId: 'R001', field: f, value: 5 }, ctx);
  const after = compareLaunchModes(db, session).modes.find(m => m.planMode === 'TARGET');
  assert.ok(after.launchDays > 0);
  assert.ok(after.launch.expectedCompletionDate);
  raw.close();
});

test('인력은 계획 기간 모든 달 × 파트에 있고, 고정 공휴일이 들어간다', () => {
  const input = defaultNewProject(TODAY);
  const { raw } = create(input);
  const months = raw.prepare('SELECT count(DISTINCT month) AS n FROM capacity').get().n;
  const rows = raw.prepare('SELECT count(*) AS n FROM capacity').get().n;
  assert.equal(months, 24); // 2026-12 ~ 2028-11
  assert.equal(rows, 24 * 4);
  assert.ok(raw.prepare("SELECT 1 FROM holidays WHERE date = '2027-03-01'").get());
  raw.close();
  assert.equal(fixedKoreanHolidays('2027-01', '2027-12').length, 8);
});

test('런칭 없이도 만들 수 있다', () => {
  const input = { ...defaultNewProject(TODAY), launch: null };
  const { raw, db } = create(input);
  assert.equal(launchSnapshot(db).launch, null);
  raw.close();
});

test('입력 문제를 단계별로 알려 준다', () => {
  const base = defaultNewProject(TODAY);
  const steps = input => checkNewProject(input).map(p => p.step);
  assert.deepEqual(steps({ ...base, name: ' ' }), ['basic']);
  assert.deepEqual(steps({ ...base, horizonEnd: '2026-01' }), ['basic', 'launch']); // 기간이 거꾸로이고 출시일도 기간 밖
  assert.deepEqual(steps({ ...base, workWeekdays: '0000000' }), ['basic']);
  assert.deepEqual(steps({ ...base, parts: [] , resources: [] }).sort(), ['parts', 'resources']);
  assert.deepEqual(steps({ ...base, parts: [...base.parts, { name: '원화', headcount: 1, utilization: 0.8 }], resources: base.resources.map(r => ({ ...r, efforts: [...r.efforts, null] })) }), ['parts']);
  assert.deepEqual(steps({ ...base, resources: [{ group: 'A', name: '빈 리소스', efforts: [null, null, null, null] }] }), ['resources']);
  assert.deepEqual(steps({ ...base, resources: [{ group: 'A', name: '음수', efforts: [0, null, null, null] }] }), ['resources']);
  assert.deepEqual(steps({ ...base, launch: { ...base.launch, releaseDate: '2026-12-01', startDate: '2027-01-01' } }), ['launch', 'launch']);
  assert.deepEqual(steps({ ...base, launch: { ...base.launch, releaseDate: '2030-01-31' } }), ['launch']);
  assert.throws(() => create({ ...base, name: '' }));
});
