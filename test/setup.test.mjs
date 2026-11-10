// 만든 뒤 고치기(프로젝트·파트·리소스·공수)와 물량 템플릿 이름·복사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { undoBatch } from '../core/history.ts';
import { setupView } from '../core/plan.ts';
import { readModeNames } from '../core/modes.ts';
import { exportSheets } from '../core/export.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-setup', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let n = 0;
const lastBatch = db => db.get('SELECT batch_id FROM change_log ORDER BY log_id DESC LIMIT 1').batch_id;
function open() {
  const path = `${OUT}/normal-copy${(n += 1)}.arp`;
  copyFileSync(samples.normal, path);
  const raw = openProjectFile(path);
  const db = nodeDb(raw);
  const session = new ProjectSession(db);
  let b = 0;
  const edit = e => applyEdit(db, session, e, { editor: '검사', batchId: `B${(b += 1)}` });
  const undo = (id, force) => undoBatch(db, session, id, { editor: '검사', batchId: `U${(b += 1)}` }, force);
  return { raw, db, session, edit, undo };
}

test('물량 템플릿: 기본 이름 최소안·기본안·최대안, 이름 바꾸기(같은 이름 거절)·되돌리기, 엑셀에도 그 이름', () => {
  const { raw, db, session, edit, undo } = open();
  assert.deepEqual(readModeNames(db), { MIN: '최소안', TARGET: '기본안', STRETCH: '최대안' });
  edit({ kind: 'modeName', mode: 'STRETCH', name: '도전안' });
  assert.equal(readModeNames(db).STRETCH, '도전안');
  assert.throws(() => edit({ kind: 'modeName', mode: 'MIN', name: '기본안' }), /같은 이름/);
  const sheets = exportSheets(db, session, 'STRETCH');
  assert.ok(JSON.stringify(sheets).includes('도전안'));
  undo('B1');
  assert.equal(readModeNames(db).STRETCH, '최대안');
  raw.close();
});

test('물량 템플릿 복사: 기본안 수량을 최대안으로(한 묶음, 되돌리기)', () => {
  const { raw, db, edit, undo } = open();
  const before = db.all("SELECT resource_type_id, stretch_qty FROM volumes WHERE update_id = 'LAUNCH' ORDER BY resource_type_id");
  edit({ kind: 'copyQty', updateId: 'LAUNCH', from: 'target_qty', to: 'stretch_qty' });
  assert.ok(db.all("SELECT target_qty AS t, stretch_qty AS s FROM volumes WHERE update_id = 'LAUNCH'").every(r => r.t === r.s));
  undo('B1');
  assert.deepEqual(db.all("SELECT resource_type_id, stretch_qty FROM volumes WHERE update_id = 'LAUNCH' ORDER BY resource_type_id"), before);
  raw.close();
});

test('프로젝트: 이름·여유율·근무 요일·휴일을 수정하면 계산에 바로 들고, 되돌릴 수 있다', () => {
  const { raw, db, session, edit, undo } = open();
  const base = session.calculate().result.parts.find(p => p.partId === 'MODELING').capacityDays;
  edit({ kind: 'projectName', name: '새 이름' });
  edit({ kind: 'setting', field: 'buffer_rate', value: 0.3 });
  edit({ kind: 'setting', field: 'work_weekdays', value: '1111000' });
  const fewer = session.calculate().result.parts.find(p => p.partId === 'MODELING').capacityDays;
  assert.ok(fewer < base, '주 4일이면 작업 가능량이 준다');
  edit({ kind: 'addHoliday', date: '2027-01-11', name: '창립기념일', holidayKind: 'COMPANY' });
  assert.ok(setupView(db).project.holidays.some(h => h.name === '창립기념일'));
  assert.throws(() => edit({ kind: 'setting', field: 'work_weekdays', value: '0000000' }), /하루 이상/);
  assert.throws(() => edit({ kind: 'setting', field: 'buffer_rate', value: 1.5 }), /여유율/);
  for (const b of ['B4', 'B3', 'B2', 'B1']) undo(b);
  const v = setupView(db);
  assert.equal(v.project.bufferRate, 0.1);
  assert.equal(v.project.workWeekdays, '1111100');
  assert.ok(!v.project.holidays.some(h => h.name === '창립기념일'));
  assert.equal(session.calculate().result.parts.find(p => p.partId === 'MODELING').capacityDays, base);
  raw.close();
});

test('파트: 만들기(계획 기간 인력 행 함께)·이름·순서·사용 안 함·지우기(쓰이면 거절)·되돌리기', () => {
  const { raw, db, session, edit, undo } = open();
  const id = edit({ kind: 'createPart', name: '테크아트' }).createdId;
  const months = db.get('SELECT count(*) AS n FROM capacity WHERE part_id = ?', [id]).n;
  assert.ok(months > 0);
  edit({ kind: 'renamePart', partId: id, name: 'TA' });
  edit({ kind: 'movePart', partId: id, direction: -1 });
  const order = setupView(db).parts.map(p => p.name);
  assert.equal(order.indexOf('TA'), order.length - 2);
  assert.throws(() => edit({ kind: 'deletePart', partId: 'MODELING' }), /거치는 리소스/);
  assert.throws(() => edit({ kind: 'partActive', partId: 'FX', active: false }), /거치는 리소스/);
  edit({ kind: 'partActive', partId: id, active: false });
  assert.ok(session.calculate().result.parts.every(p => p.partId !== id), '사용 안 함 파트는 계산에서 빠진다');
  edit({ kind: 'partActive', partId: id, active: true });
  edit({ kind: 'deletePart', partId: id });
  assert.equal(db.get('SELECT count(*) AS n FROM capacity WHERE part_id = ?', [id]).n, 0);
  undo(lastBatch(db));
  assert.equal(db.get('SELECT name FROM parts WHERE part_id = ?', [id]).name, 'TA');
  assert.equal(db.get('SELECT count(*) AS n FROM capacity WHERE part_id = ?', [id]).n, months, '지운 파트를 되돌리면 인력 행도 돌아온다');
  raw.close();
});

test('파트 기본 인원·가동률: 계획 기간 전체에 적용(fillCapacity)하면 화면의 기본값도 바뀐다', () => {
  const { raw, db, edit } = open();
  const v = setupView(db);
  edit({ kind: 'fillCapacity', partId: 'FX', fromMonth: v.horizon.start, toMonth: v.horizon.end, field: 'utilization', value: 0.65 });
  edit({ kind: 'fillCapacity', partId: 'FX', fromMonth: v.horizon.start, toMonth: v.horizon.end, field: 'headcount', value: 3 });
  const fx = setupView(db).parts.find(p => p.partId === 'FX');
  assert.equal(fx.utilization, 0.65);
  assert.equal(fx.headcount, 3);
  raw.close();
});

test('리소스: 만들기(새 분류)·이름·분류 옮기기·공수 넣기(거치는 파트 생김)·AI 공수·재작업률·파트 빼기·지우기·되돌리기', () => {
  const { raw, db, session, edit, undo } = open();
  const id = edit({ kind: 'createResource', name: '탈것', groupName: '오브젝트' }).createdId;
  assert.equal(setupView(db).resources.find(r => r.resourceTypeId === id).groupName, '오브젝트');
  edit({ kind: 'renameResource', resourceTypeId: id, name: '탈것(소형)' });
  edit({ kind: 'resourceGroup', resourceTypeId: id, groupName: '캐릭터' });
  edit({ kind: 'effort', resourceTypeId: id, partId: 'CONCEPT', profileId: 'BASE', days: 2 });
  edit({ kind: 'effort', resourceTypeId: id, partId: 'MODELING', profileId: 'BASE', days: 4 });
  edit({ kind: 'effort', resourceTypeId: id, partId: 'MODELING', profileId: 'AI', days: 3 });
  edit({ kind: 'rework', resourceTypeId: id, partId: 'MODELING', rate: 0.1 });
  let r = setupView(db).resources.find(x => x.resourceTypeId === id);
  assert.equal(r.name, '탈것(소형)');
  assert.equal(r.groupName, '캐릭터');
  assert.deepEqual(r.efforts.MODELING, { base: 4, ai: 3, rework: 0.1, done: 0, assets: 0 });
  // 물량에 입력하면 계산된다
  edit({ kind: 'addResource', updateId: 'LAUNCH', resourceTypeId: id });
  edit({ kind: 'volume', updateId: 'LAUNCH', resourceTypeId: id, field: 'target_qty', value: 5 });
  assert.ok(session.calculate().result.stages.some(g => g.resourceTypeId === id && g.partId === 'MODELING'));
  assert.throws(() => edit({ kind: 'deleteResource', resourceTypeId: id }), /쓰이는 리소스/);
  // 기본 공수를 비우면 그 파트를 거치지 않는다(되돌리면 공수도 돌아옴)
  edit({ kind: 'effort', resourceTypeId: id, partId: 'MODELING', profileId: 'BASE', days: null });
  r = setupView(db).resources.find(x => x.resourceTypeId === id);
  assert.deepEqual(Object.keys(r.efforts), ['CONCEPT']);
  undo(lastBatch(db));
  assert.deepEqual(setupView(db).resources.find(x => x.resourceTypeId === id).efforts.MODELING, { base: 4, ai: 3, rework: 0.1, done: 0, assets: 0 });
  // 실적이 있는 파트는 뺄 수 없다
  assert.throws(() => edit({ kind: 'effort', resourceTypeId: 'CHAR_NEW', partId: 'CONCEPT', profileId: 'BASE', days: null }), /작업 진척/);
  // 쓰이지 않으면 지울 수 있고, 되돌리면 공수까지 돌아온다
  edit({ kind: 'removeResource', updateId: 'LAUNCH', resourceTypeId: id });
  const del = edit({ kind: 'deleteResource', resourceTypeId: id });
  assert.ok(del.changed);
  undo(lastBatch(db));
  assert.deepEqual(setupView(db).resources.find(x => x.resourceTypeId === id).efforts.MODELING, { base: 4, ai: 3, rework: 0.1, done: 0, assets: 0 });
  raw.close();
});

test('AI 활용 비율(파트별): 공수 = 기본 × (1 − 비율) + AI × 비율, AI 공수가 빈 리소스는 기본 공수, 0이면 비율 없음, 되돌리기', () => {
  const { raw, db, session, edit, undo } = open();
  const req = () => session.calculate().result.stages.filter(g => g.updateId === 'LAUNCH' && g.partId === 'CONCEPT').reduce((a, g) => a + g.requiredDays, 0);
  edit({ kind: 'aiShare', partId: 'CONCEPT', share: 0 });
  const base = req();
  // 신규 캐릭터 원화: 기본 공수의 절반을 AI 공수로
  const rt = 'CHAR_NEW';
  const b = db.get("SELECT days FROM efforts WHERE resource_type_id = ? AND part_id = 'CONCEPT' AND profile_id = 'BASE'", [rt]).days;
  edit({ kind: 'effort', resourceTypeId: rt, partId: 'CONCEPT', profileId: 'AI', days: b / 2 });
  edit({ kind: 'aiShare', partId: 'CONCEPT', share: 1 });
  const full = req();
  assert.ok(full < base, `AI 100%면 줄어든다 ${full} < ${base}`);
  edit({ kind: 'aiShare', partId: 'CONCEPT', share: 0.5 });
  const half = req();
  assert.ok(Math.abs(half - (base + full) / 2) < 1e-6, '50%면 그 가운데');
  assert.equal(setupView(db).parts.find(p => p.partId === 'CONCEPT').aiShare, 0.5);
  assert.throws(() => edit({ kind: 'aiShare', partId: 'CONCEPT', share: 1.2 }), /0~100%/);
  undo(lastBatch(db));
  assert.equal(setupView(db).parts.find(p => p.partId === 'CONCEPT').aiShare, 1);
  edit({ kind: 'aiShare', partId: 'CONCEPT', share: 0 });
  assert.equal(db.get("SELECT count(*) AS n FROM effort_mix WHERE part_id = 'CONCEPT'").n, 0);
  assert.equal(req(), base);
  raw.close();
});
