// 4단계: 구조 전환 · 시나리오 동작 · 비교 · 민감도 · 원본에 반영 · 속도
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { buildScaleData } from '../tools/gen-scale.mjs';
import { openProjectFile, createProjectFile, SCHEMA_SQL } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { migrate, LATEST_SCHEMA } from '../core/migrate.ts';
import { applyScenarioOp, listScenarios, compareScenarios, sensitivity, applyScenarioToBase } from '../core/scenarios.ts';
import { planView } from '../core/plan.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-scenarios', import.meta.url));
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
const add = (db, scenarioId, action) => applyScenarioOp(db, { kind: 'addAction', scenarioId, action });
const launchOf = (v, i) => v.rows.find(r => r.updateId === 'LAUNCH').cells[i];

test('구조 전환: v1 파일을 최신으로(동작 묶음은 줄마다 하나), 다시 해도 그대로, 더 새 버전은 거절', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA_SQL);
  raw.exec("INSERT INTO meta VALUES ('data_version', '1')");
  raw.exec("INSERT INTO scenarios (scenario_id, name, base_data_version, created_at, updated_at) VALUES ('A', 'a', 1, 'x', 'x')");
  raw.exec("INSERT INTO scenario_changes (scenario_id, seq, op, target, target_key, field, value_json) VALUES ('A', 1, 'SET', 'settings', 'settings', 'buffer_rate', '0.2'), ('A', 2, 'SET', 'settings', 'settings', 'default_overlap_rate', '0.1')");
  const db = nodeDb(raw);
  const r = migrate(db);
  assert.deepEqual([r.from, r.to], [1, LATEST_SCHEMA]);
  assert.deepEqual(raw.prepare('SELECT group_no FROM scenario_changes ORDER BY seq').all().map(x => x.group_no), [1, 2]);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, LATEST_SCHEMA);
  assert.deepEqual(migrate(db).notes, []);
  raw.exec('PRAGMA user_version = 9');
  assert.throws(() => migrate(db), /더 새 구조/);
  raw.close();
});

test('시나리오: 만들기 · 동작 더하기(이름 붙음) · 빼기 · 복제 · 이름 바꾸기 · 지우기', () => {
  const { raw, db } = open();
  const { createdId: id } = applyScenarioOp(db, { kind: 'create', name: '모델링 충원' });
  assert.equal(id, 'S01');
  add(db, id, { kind: 'headcount', partId: 'MODELING', fromMonth: '2027-01', toMonth: '2027-03', delta: 2 });
  add(db, id, { kind: 'aiShare', partId: 'CONCEPT', share: 0.8 });
  add(db, id, { kind: 'volumeScale', updateId: 'LAUNCH', scale: 1.2 });
  let s = listScenarios(db).find(x => x.scenarioId === id);
  assert.deepEqual(s.actions.map(a => a.label), ['모델링 인원 +2명 (2027-01~2027-03)', '원화 AI 비율 80%', '런칭 물량 ×120%']);
  assert.deepEqual(s.actions.map(a => a.count), [3, 2, 18]);
  applyScenarioOp(db, { kind: 'removeAction', scenarioId: id, groupNo: 2 });
  const copy = applyScenarioOp(db, { kind: 'create', name: '복제', copyFrom: id }).createdId;
  assert.equal(listScenarios(db).find(x => x.scenarioId === copy).actions.length, 2);
  applyScenarioOp(db, { kind: 'rename', scenarioId: copy, name: '복제본' });
  applyScenarioOp(db, { kind: 'delete', scenarioId: copy });
  s = listScenarios(db);
  assert.deepEqual(s.map(x => x.name).sort(), ['모델링 1명 조기 채용 + 원화 AI 80%', '모델링 충원'].sort());
  assert.throws(() => add(db, id, { kind: 'headcount', partId: 'NOPE', fromMonth: '2027-01', toMonth: '2027-01', delta: 1 }));
  assert.throws(() => add(db, id, { kind: 'headcount', partId: 'FX', fromMonth: '2027-05', toMonth: '2027-01', delta: 1 }));
  raw.close();
});

test('비교: 인원을 늘리면 당겨지고(음수 차이), 물량을 늘리면 늦어지고, 빼면 빠지고, 가상 업데이트가 줄로 생긴다', () => {
  const { raw, db, session } = open('overload');
  const more = applyScenarioOp(db, { kind: 'create', name: '충원' }).createdId;
  for (const p of ['CONCEPT', 'MODELING', 'ANIMATION', 'FX']) add(db, more, { kind: 'headcount', partId: p, fromMonth: '2026-11', toMonth: '2027-12', delta: 6 });
  const less = applyScenarioOp(db, { kind: 'create', name: '정리' }).createdId;
  add(db, less, { kind: 'exclude', updateId: 'MINI1' });
  add(db, less, { kind: 'addUpdate', name: '가상 이벤트', typeId: 'MINI', startDate: '2027-03-01', freezeDate: '2027-05-01', releaseDate: '2027-05-15' });
  const v = compareScenarios(db, session, [more, less], 'TARGET');
  raw.close();
  assert.deepEqual(v.columns.map(c => c.name), ['원본', '충원', '정리']);
  assert.ok(v.columns.every(c => !c.blocked));
  const l = v.rows.find(r => r.updateId === 'LAUNCH');
  assert.equal(l.cells[0].status, 'UNFINISHED');
  assert.ok(l.cells[1].completion, '충원하면 런칭이 기간 안에 끝난다');
  assert.equal(v.rows.find(r => r.updateId === 'MINI1').cells[2].excluded, true);
  const x = v.rows.find(r => r.virtual);
  assert.equal(x.name, '가상 이벤트');
  assert.equal(x.cells[0].completion, null);
  assert.ok(v.parts.every(p => p.loads[1] < p.loads[0]), '충원하면 모든 파트 부하율이 준다');
});

test('비교: 정상 샘플에서 차이(영업일)가 계산된다 · 시나리오는 원본을 바꾸지 않는다', () => {
  const { raw, db, session } = open();
  const id = applyScenarioOp(db, { kind: 'create', name: '확장 물량' }).createdId;
  add(db, id, { kind: 'volumeScale', updateId: 'LAUNCH', scale: 1.5 });
  const before = planView(db, session).rows.find(r => r.updateId === 'LAUNCH').result.completion;
  const v = compareScenarios(db, session, [id]);
  const after = planView(db, session).rows.find(r => r.updateId === 'LAUNCH').result.completion;
  raw.close();
  assert.equal(before, after);
  assert.equal(launchOf(v, 0).delta, 0);
  assert.ok(launchOf(v, 1).delta > 0, `${launchOf(v, 1).delta}`);
});

test('민감도: 파트마다 +1명 효과, 늘려도 늦어지지 않는다(런칭), 병목 파트가 가장 크게 당긴다', () => {
  const { raw, session } = open('overload');
  const data = session.currentData();
  raw.close();
  const s = sensitivity(data, 'S1', 'TARGET');
  assert.equal(s.parts.length, 4);
  const launch = sensitivity({ ...data, capacity: data.capacity.map(c => ({ ...c, headcount: c.headcount * 4 })) }, 'LAUNCH', 'TARGET');
  assert.ok(launch.baseCompletion);
  assert.ok(launch.parts.every(p => p.deltaWorkdays === null || p.deltaWorkdays <= 0), JSON.stringify(launch.parts));
  assert.ok(launch.parts.some(p => p.deltaWorkdays < 0));
});

test('원본에 반영: 값이 옮겨지고 이력(이유 = 시나리오 이름)이 남고, 반영 표시 · 두 번은 거절', () => {
  const { raw, db, session } = open();
  const id = applyScenarioOp(db, { kind: 'create', name: '충원안' }).createdId;
  add(db, id, { kind: 'headcount', partId: 'FX', fromMonth: '2027-01', toMonth: '2027-02', delta: 1 });
  add(db, id, { kind: 'addUpdate', name: '가상', typeId: 'MINI', startDate: '2027-03-01', freezeDate: null, releaseDate: '2027-05-15' });
  const expected = compareScenarios(db, session, [id]).rows.map(r => [r.updateId, r.cells[1].completion]);
  const res = applyScenarioToBase(db, session, id, ctx);
  assert.equal(res.skipped, 0);
  assert.equal(db.get("SELECT headcount FROM capacity WHERE part_id = 'FX' AND month = '2027-02'").headcount, 2);
  assert.ok(db.get("SELECT 1 AS ok FROM updates WHERE update_id = 'X001'"));
  assert.ok(db.all("SELECT reason FROM change_log").every(r => r.reason === '시나리오 반영: 충원안'));
  // 반영한 원본 = 시나리오 결과
  const now = compareScenarios(db, session, []).rows.map(r => [r.updateId, r.cells[0].completion]);
  assert.deepEqual(now, expected);
  assert.ok(listScenarios(db).find(s => s.scenarioId === id).appliedAt);
  assert.throws(() => applyScenarioToBase(db, session, id, ctx), /이미/);
  raw.close();
});

test('원본에 반영: 원본이 바뀐 뒤면 확인을 요구하고, 오류가 생기면 되돌린다', () => {
  const { raw, db, session } = open();
  const id = applyScenarioOp(db, { kind: 'create', name: '날짜' }).createdId;
  add(db, id, { kind: 'updateDates', updateId: 'S1', releaseDate: '2027-03-01' }); // 시작일(4/1)보다 앞 → 날짜 순서 오류
  applyEdit(db, session, { kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'outsource_qty', value: 12 }, { ...ctx });
  assert.equal(listScenarios(db).find(s => s.scenarioId === id).stale, true);
  assert.throws(() => applyScenarioToBase(db, session, id, ctx), /원본이 변경되었습니다/);
  assert.throws(() => applyScenarioToBase(db, session, id, ctx, true), /되돌렸습니다/);
  assert.equal(db.get("SELECT release_date FROM updates WHERE update_id = 'S1'").release_date, '2027-08-31');
  assert.equal(listScenarios(db).find(s => s.scenarioId === id).appliedAt, null);
  raw.close();
});

test('속도: 현실 규모에서 원본 + 시나리오 3개 비교가 0.3초 안', () => {
  const path = `${OUT}/scale.arp`;
  createProjectFile(path, buildScaleData()).close();
  const raw = openProjectFile(path);
  const db = nodeDb(raw);
  const session = new ProjectSession(db);
  const ids = [1, 2, 3].map(i => {
    const id = applyScenarioOp(db, { kind: 'create', name: `안 ${i}` }).createdId;
    add(db, id, { kind: 'headcount', partId: `P${i}`, fromMonth: '2027-01', toMonth: '2029-12', delta: i });
    add(db, id, { kind: 'volumeScale', updateId: 'U01', scale: 1 + i / 10 });
    return id;
  });
  compareScenarios(db, session, ids); // 데우기
  const times = [1, 2, 3].map(() => compareScenarios(db, session, ids).ms);
  raw.close();
  const best = Math.min(...times);
  console.log(`  원본 + 시나리오 3개 비교: ${best.toFixed(1)}ms`);
  assert.ok(best < 300, `${best}ms`);
});

test('검증 줄이기: 모든 규칙에 읽는 표가 적혀 있고, 시나리오의 일부 검증 결과 = 전체 검증 결과', async () => {
  const { RULES, RULE_TABLES } = await import('../rules/validation-rules.mjs');
  for (const r of RULES) assert.ok(RULE_TABLES[r.code]?.length, `${r.code}에 읽는 표가 없다`);
  const { raw, db, session } = open('normal');
  const sort = fs => fs.map(f => `${f.code}|${f.key}|${f.detail}`).sort();
  const actions = [
    { kind: 'headcount', partId: 'FX', fromMonth: '2027-01', toMonth: '2027-03', delta: -1 },
    { kind: 'volumeScale', updateId: 'S1', scale: 0 },
    { kind: 'updateDates', updateId: 'S1', releaseDate: '2027-03-01' },      // 날짜 순서 오류(U03)
    { kind: 'exclude', updateId: 'MINI1' },
    { kind: 'overlap', rate: 1.5 > 1 ? 0.9 : 0 },
  ];
  const base = session.prepare().findings;
  for (const action of actions) {
    const id = applyScenarioOp(db, { kind: 'create', name: action.kind }).createdId;
    add(db, id, action);
    const full = session.prepare(id).findings;
    const partial = session.prepare(id, { baseFindings: base }).findings;
    assert.deepEqual(sort(partial), sort(full), action.kind);
  }
  raw.close();
});

// ───────── 전체 점검(2026-11-05)에서 찾아 수정한 것 ─────────
const capOf = (session, id, part, month) => session.prepare(id).data.capacity.find(c => c.part_id === part && c.month === month).headcount;

test('인원 동작을 같은 칸에 두 번: 더해지고(+2 +1 = +3), 앞 동작을 빼도 뒤 동작은 그대로(+1)', () => {
  const { raw, db, session } = open();
  const base = capOf(session, undefined, 'MODELING', '2027-02');
  const id = applyScenarioOp(db, { kind: 'create', name: '충원 두 번' }).createdId;
  const g1 = add(db, id, { kind: 'headcount', partId: 'MODELING', fromMonth: '2027-01', toMonth: '2027-03', delta: 2 }).groupNo;
  add(db, id, { kind: 'headcount', partId: 'MODELING', fromMonth: '2027-02', toMonth: '2027-02', delta: 1 });
  assert.equal(capOf(session, id, 'MODELING', '2027-02'), base + 3);
  assert.equal(capOf(session, id, 'MODELING', '2027-01'), base + 2);
  applyScenarioOp(db, { kind: 'removeAction', scenarioId: id, groupNo: g1 });
  assert.equal(capOf(session, id, 'MODELING', '2027-02'), base + 1);
  assert.equal(capOf(session, id, 'MODELING', '2027-01'), base);
  // 줄이기는 0 밑으로 가지 않는다
  add(db, id, { kind: 'headcount', partId: 'MODELING', fromMonth: '2027-01', toMonth: '2027-01', delta: -99 });
  assert.equal(capOf(session, id, 'MODELING', '2027-01'), 0);
  // 원본에 반영해도 같은 값
  applyScenarioToBase(db, session, id, ctx);
  assert.equal(db.get("SELECT headcount FROM capacity WHERE part_id = 'MODELING' AND month = '2027-02'").headcount, base + 1);
  assert.equal(db.get("SELECT headcount FROM capacity WHERE part_id = 'MODELING' AND month = '2027-01'").headcount, 0);
  raw.close();
});

test('반영한 시나리오의 복제본(가상 업데이트가 이미 원본에 있음) · AI 비율 두 번: 비교가 멈추지 않는다', () => {
  const { raw, db, session } = open();
  const a = applyScenarioOp(db, { kind: 'create', name: 'A' }).createdId;
  add(db, a, { kind: 'addUpdate', name: '가상', typeId: 'MINI', startDate: '2027-03-01', freezeDate: null, releaseDate: '2027-05-15' });
  const b = applyScenarioOp(db, { kind: 'create', name: 'B', copyFrom: a }).createdId;
  applyScenarioToBase(db, session, a, ctx);
  add(db, b, { kind: 'aiShare', partId: 'MODELING', share: 0.5 });
  add(db, b, { kind: 'aiShare', partId: 'MODELING', share: 0.3 });
  const v = compareScenarios(db, session, [b]);
  assert.ok(v.columns.every(c => !c.blocked));
  assert.ok(v.rows.some(r => r.updateId === 'X001'));
  // 두 번째 AI 비율이 이긴다
  const mix = session.prepare(b).data.effort_mix.filter(m => m.part_id === 'MODELING');
  assert.deepEqual(mix.map(m => [m.profile_id, m.share]).sort(), [['AI', 0.3], ['BASE', 0.7]]);
  // 복제본도 원본에 반영된다(이미 있는 가상 업데이트는 넣지 않고 다른 칸만 바꾼다)
  applyScenarioToBase(db, session, b, ctx, true);
  assert.equal(db.get("SELECT count(*) AS n FROM updates WHERE update_id = 'X001'").n, 1);
  raw.close();
});

test('시나리오 줄 하나가 넣을 수 없어도 나머지는 계산하고 이유를 알린다 · 달력에 없는 날짜는 거절', () => {
  const { raw, db, session } = open();
  const id = applyScenarioOp(db, { kind: 'create', name: '깨진 줄' }).createdId;
  assert.throws(() => add(db, id, { kind: 'updateDates', updateId: 'S1', releaseDate: '2027-09-31' }), /날짜/);
  // 파일에 직접 들어간 깨진 줄(형식 위반)
  db.run("INSERT INTO scenario_changes (scenario_id, seq, op, target, target_key, field, value_json, group_no, label) VALUES (?, 1, 'SET', 'updates', 'S1', 'release_date', '\"2027-09-31\"', 1, '깨진 줄')", [id]);
  add(db, id, { kind: 'headcount', partId: 'FX', fromMonth: '2027-01', toMonth: '2027-01', delta: 1 });
  const p = session.prepare(id);
  assert.ok(p.data, '계산은 된다');
  assert.ok(p.skipped.some(x => x.target_key === 'S1' && x.why.startsWith('넣을 수 없음')), JSON.stringify(p.skipped));
  assert.equal(p.data.capacity.find(c => c.part_id === 'FX' && c.month === '2027-01').headcount, capOf(session, undefined, 'FX', '2027-01') + 1);
  raw.close();
});

test('가상 업데이트: 사용 안 함 리소스는 템플릿에 있어도 넣지 않는다(진짜 업데이트 만들기와 같게)', () => {
  const { raw, db } = open();
  db.run("UPDATE resource_types SET active = 0 WHERE resource_type_id = 'VFX'");
  const id = applyScenarioOp(db, { kind: 'create', name: '가상' }).createdId;
  add(db, id, { kind: 'addUpdate', name: '가상 미니', typeId: 'MINI', startDate: '2027-03-01', freezeDate: null, releaseDate: '2027-05-15' });
  const vols = db.all("SELECT target_key FROM scenario_changes WHERE scenario_id = ? AND target = 'volumes'", [id]).map(r => r.target_key.split('|')[1]).sort();
  raw.close();
  assert.deepEqual(vols, ['COSTUME', 'ICON']);
});
