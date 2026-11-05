// 2단계: 런칭 물량 설계 로직 검사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { copyFileSync } from 'node:fs';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { launchSnapshot, applyLaunchEdit, compareLaunchModes, maxLaunchScale, headcountForLaunch } from '../core/launch.ts';
import { runPlan } from '../engine/index.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-launch', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
const ctx = { editor: '검사', batchId: 'b1' };

// 검사마다 복사본을 연다(고치는 검사가 샘플을 바꾸지 않게)
let copies = 0;
function open(name) {
  const path = `${OUT}/${name}-copy${(copies += 1)}.arp`;
  copyFileSync(samples[name], path);
  const raw = openProjectFile(path);
  const db = nodeDb(raw);
  return { raw, db, session: new ProjectSession(db) };
}

test('요약: 런칭 정보, 리소스 행(분류·거치는 파트·완료), 더할 수 있는 리소스', () => {
  const { raw, db } = open('normal');
  const snap = launchSnapshot(db);
  raw.close();
  assert.equal(snap.launch.updateId, 'LAUNCH');
  assert.equal(snap.launch.freezeDate, '2027-05-31');
  assert.equal(snap.rows.length, 6);
  const char = snap.rows.find(r => r.resourceTypeId === 'CHAR_NEW');
  assert.deepEqual(char.parts.map(p => p.partId), ['CONCEPT', 'MODELING', 'ANIMATION', 'FX']);
  assert.equal(char.parts[0].completed, 3);
  assert.equal(char.groupName, '캐릭터');
  assert.deepEqual(snap.addable, []);
});

test('고치기: 물량을 바꾸면 계산이 바뀌고 변경 이력이 남는다. 같은 값이면 아무것도 안 한다', () => {
  const { raw, db, session } = open('normal');
  const before = compareLaunchModes(db, session).modes.find(m => m.planMode === 'TARGET');
  assert.equal(applyLaunchEdit(db, session, { kind: 'volume', resourceTypeId: 'BG_MAP', field: 'target_qty', value: 5 }, ctx), true);
  assert.equal(applyLaunchEdit(db, session, { kind: 'volume', resourceTypeId: 'BG_MAP', field: 'target_qty', value: 5 }, ctx), false);
  const after = compareLaunchModes(db, session).modes.find(m => m.planMode === 'TARGET');
  assert.ok(after.launchDays > before.launchDays);
  const log = db.all("SELECT * FROM change_log WHERE target = 'volumes'");
  raw.close();
  assert.equal(log.length, 1);
  assert.equal(log[0].old_json, '4');
  assert.equal(log[0].new_json, '5');
  assert.equal(log[0].editor, '검사');
});

test('고치기: 잘못된 값은 거절하고, 최저 > 목표처럼 규칙을 어기면 계산이 막히고 이유가 나온다', () => {
  const { raw, db, session } = open('normal');
  assert.throws(() => applyLaunchEdit(db, session, { kind: 'volume', resourceTypeId: 'PROP', field: 'target_qty', value: -1 }, ctx));
  assert.throws(() => applyLaunchEdit(db, session, { kind: 'volume', resourceTypeId: 'PROP', field: 'target_qty', value: 1.5 }, ctx));
  applyLaunchEdit(db, session, { kind: 'volume', resourceTypeId: 'PROP', field: 'min_qty', value: 70 }, ctx);
  const cmp = compareLaunchModes(db, session);
  raw.close();
  assert.equal(cmp.blocked, true);
  assert.ok(cmp.findings.some(f => f.code === 'V02' && f.key === 'LAUNCH|PROP'));
});

test('고치기: 리소스 더하기·빼기, 날짜 바꾸기', () => {
  const { raw, db, session } = open('normal');
  applyLaunchEdit(db, session, { kind: 'removeResource', resourceTypeId: 'VFX' }, ctx);
  assert.equal(launchSnapshot(db).rows.length, 5);
  assert.deepEqual(launchSnapshot(db).addable.map(a => a.resourceTypeId), ['VFX']);
  applyLaunchEdit(db, session, { kind: 'addResource', resourceTypeId: 'VFX' }, ctx);
  assert.equal(launchSnapshot(db).rows.find(r => r.resourceTypeId === 'VFX').target, 0);
  applyLaunchEdit(db, session, { kind: 'date', field: 'freeze_date', value: '2027-04-30' }, ctx);
  assert.equal(launchSnapshot(db).launch.freezeDate, '2027-04-30');
  assert.throws(() => applyLaunchEdit(db, session, { kind: 'date', field: 'release_date', value: '2027/06/30' }, ctx));
  raw.close();
});

test('구간 비교: 최저 ≤ 목표 ≤ 확장 순으로 필요 공수가 늘고, 파트별 런칭 부하가 나온다', () => {
  const { raw, db, session } = open('normal');
  const cmp = compareLaunchModes(db, session);
  raw.close();
  assert.equal(cmp.blocked, false);
  const [min, target, stretch] = cmp.modes;
  assert.ok(min.launchDays < target.launchDays && target.launchDays < stretch.launchDays);
  assert.equal(target.launch.status, 'ON_TRACK');
  assert.ok(target.slackWorkdays < 0, '목표안은 제작 완료 목표일보다 일찍 끝난다');
  assert.equal(target.parts.length, 4);
  assert.ok(target.parts.every(p => p.windowCapacity > 0));
  assert.ok(Math.abs(Object.values(target.byResource).reduce((a, b) => a + b, 0) - target.launchDays) < 1e-6);
});

test('역산(최대 물량): 정상 샘플은 지금보다 늘릴 수 있고, 그 비율에서는 맞고 1% 더하면 안 맞는다', () => {
  const { raw, session } = open('normal');
  const data = session.currentData();
  raw.close();
  const r = maxLaunchScale(data, 'LAUNCH', 'TARGET');
  assert.equal(r.currentOk, true);
  assert.ok(r.scale > 1, `비율 ${r.scale}`);
  const scaled = k => ({ ...data, volumes: data.volumes.map(v => (v.update_id === 'LAUNCH' ? { ...v, target_qty: v.target_qty * k } : v)) });
  const status = k => runPlan(scaled(k)).updates.find(u => u.updateId === 'LAUNCH').status;
  assert.equal(status(r.scale), 'ON_TRACK');
  assert.notEqual(status(r.scale + 0.02), 'ON_TRACK');
});

test('역산(최대 물량): 과부하 샘플은 줄여야 하고 줄인 수량을 제안한다', () => {
  const { raw, session } = open('overload');
  const data = session.currentData();
  raw.close();
  const r = maxLaunchScale(data, 'LAUNCH', 'TARGET');
  assert.equal(r.currentOk, false);
  assert.ok(r.scale !== null && r.scale < 1, `비율 ${r.scale}`);
  assert.ok(r.suggestion.every(s => s.suggested <= s.current));
});

test('역산(필요 인원): 과부하 샘플은 늦게 만드는 파트에 인원을 더해 제작 완료 목표일에 맞춘다', () => {
  const { raw, session } = open('overload');
  const data = session.currentData();
  raw.close();
  const r = headcountForLaunch(data, 'LAUNCH', 'TARGET');
  assert.equal(r.currentOk, false);
  assert.equal(r.feasible, true, `시도 ${r.runs}회`);
  assert.ok(r.additions.length > 0 && r.additions.every(a => a.heads > 0));
  assert.ok(r.completion <= '2027-05-31');
  // 찾은 조합으로 다시 계산하면 맞는다
  const added = new Map(r.additions.map(a => [a.partId, a.heads]));
  const check = { ...data, capacity: data.capacity.map(c => (added.has(c.part_id) && c.month >= r.months.from && c.month <= r.months.to ? { ...c, headcount: c.headcount + added.get(c.part_id) } : c)) };
  assert.equal(runPlan(check).updates.find(u => u.updateId === 'LAUNCH').status, 'ON_TRACK');
});

test('역산(필요 인원): 이미 맞으면 더하지 않는다', () => {
  const { raw, session } = open('normal');
  const r = headcountForLaunch(session.currentData(), 'LAUNCH');
  raw.close();
  assert.equal(r.currentOk, true);
  assert.deepEqual(r.additions, []);
});
