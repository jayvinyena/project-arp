// 에셋 관리(docs/20-asset-management.md): 구조 전환 · 배치 · 에셋 · 파트 상태 → 작업 진척 자동 집계 · 물량 대조 · 되돌리기 · 지우기 보호
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { undoBatch, historyView } from '../core/history.ts';
import { assetsView, assetThumbs } from '../core/assets.ts';
import { progressView, planView } from '../core/plan.ts';
import { migrate, LATEST_SCHEMA } from '../core/migrate.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-assets', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let copies = 0;
function open(name = 'normal') {
  const path = `${OUT}/${name}-copy${(copies += 1)}.arp`;
  copyFileSync(samples[name] ?? `${OUT}/${name}.arp`, path);
  const raw = openProjectFile(path);
  const db = nodeDb(raw);
  return { raw, db, session: new ProjectSession(db) };
}
let n = 0;
const ctx = () => ({ editor: '검사', batchId: `b${(n += 1)}` });
const apply = (t, e) => applyEdit(t.db, t.session, e, ctx());
const prog = (db, u, rt) => Object.fromEntries(db.all('SELECT part_id, completed_qty, as_of FROM progress WHERE update_id = ? AND resource_type_id = ?', [u, rt]).map(r => [r.part_id, [r.completed_qty, r.as_of]]));

test('구조 전환: v1 파일 → 최신(v6), 에셋 표 7개가 생긴다', () => {
  const path = `${OUT}/v1-copy.arp`;
  copyFileSync(`${OUT}/normal-v1.arp`, path);
  const raw = new DatabaseSync(path);
  const r = migrate(nodeDb(raw));
  assert.deepEqual([r.from, r.to], [1, LATEST_SCHEMA]);
  assert.equal(LATEST_SCHEMA, 7);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(x => x.name);
  for (const t of ['batches', 'assets', 'asset_parts', 'asset_thumbs', 'asset_links', 'asset_comments', 'asset_attrs']) assert.ok(tables.includes(t), t);
  raw.close();
});

test('에셋 만들기 · 파트 상태 → 작업 진척 자동 집계(완료 + 해당 없음, 기준일 = 가장 늦은 완료일), 손 입력은 막힘', () => {
  const t = open();
  const rt = 'COSTUME'; // 정상 예시: 진척 없음
  assert.ok(t.db.get("SELECT 1 AS ok FROM volumes WHERE update_id = 'LAUNCH' AND resource_type_id = ?", [rt]));
  const r = apply(t, { kind: 'createAssets', updateId: 'LAUNCH', resourceTypeId: rt, names: ['용감한 코스튬', '달빛 코스튬', '불꽃 코스튬'] });
  assert.ok(r.changed && r.createdId);
  const ids = t.db.all("SELECT asset_id FROM assets WHERE update_id = 'LAUNCH' AND resource_type_id = ? ORDER BY sort_order", [rt]).map(x => x.asset_id);
  assert.equal(ids.length, 3);
  const steps = t.db.all('SELECT rp.part_id FROM resource_parts rp JOIN parts p USING(part_id) WHERE rp.resource_type_id = ? ORDER BY p.sort_order', [rt]).map(x => x.part_id);
  apply(t, { kind: 'assetPart', assetIds: [ids[0], ids[1]], partId: steps[0], status: 'DONE', doneAt: '2026-11-03' });
  apply(t, { kind: 'assetPart', assetIds: [ids[2]], partId: steps[0], status: 'OMIT' });
  apply(t, { kind: 'assetPart', assetIds: [ids[0]], partId: steps[1], status: 'DONE', doneAt: '2026-11-05' });
  apply(t, { kind: 'assetPart', assetIds: [ids[1]], partId: steps[1], status: 'REVIEW' });
  const p = prog(t.db, 'LAUNCH', rt);
  assert.deepEqual(p[steps[0]], [3, '2026-11-03'], '완료 2 + 해당 없음 1');
  assert.deepEqual(p[steps[1]], [1, '2026-11-05'], '검수 요청은 완료가 아니다');
  assert.throws(() => apply(t, { kind: 'progress', updateId: 'LAUNCH', resourceTypeId: rt, partId: steps[0], value: 5, asOf: null }), /에셋 상태에서 집계/);
  assert.throws(() => apply(t, { kind: 'completeRow', updateId: 'LAUNCH', resourceTypeId: rt, asOf: null }), /에셋 상태에서 집계/);
  // 실투입 인·일은 계속 손으로 넣는다
  assert.equal(apply(t, { kind: 'progressSpent', updateId: 'LAUNCH', resourceTypeId: rt, partId: steps[0], value: 12, asOf: null }).changed, true);
  // 리테이크: 수정으로 돌리면 센다, 완료일은 지워진다
  apply(t, { kind: 'assetPart', assetIds: [ids[1]], partId: steps[1], status: 'RETAKE' });
  apply(t, { kind: 'assetPart', assetIds: [ids[0]], partId: steps[1], status: 'RETAKE' });
  const v = assetsView(t.db, 'LAUNCH');
  const a0 = v.assets.find(x => x.assetId === ids[0]);
  assert.equal(a0.parts[steps[1]].status, 'RETAKE');
  assert.equal(a0.parts[steps[1]].doneAt, null);
  assert.equal(a0.retakes, 1);
  assert.deepEqual(prog(t.db, 'LAUNCH', rt)[steps[1]], undefined, '완료가 0이 되면 실투입이 없는 칸은 지워진다');
  // 작업 진척 화면: 에셋에서 집계한 줄
  const pv = progressView(t.db, 'LAUNCH');
  assert.equal(pv.rows.find(x => x.resourceTypeId === rt).fromAssets, true);
  assert.equal(pv.rows.find(x => x.resourceTypeId !== rt).fromAssets, false);
  t.raw.close();
});

test('완료하면 엔진 결과가 당겨진다 · 되돌리면 상태와 작업 진척이 함께 돌아온다', () => {
  const t = open();
  const rt = 'COSTUME';
  const comp = () => planView(t.db, t.session, 'TARGET').rows.find(r => r.updateId === 'LAUNCH').result.completion;
  const before = comp();
  apply(t, { kind: 'fillAssets', updateId: 'LAUNCH', resourceTypeId: rt });
  const ids = t.db.all("SELECT asset_id FROM assets WHERE resource_type_id = ? AND update_id = 'LAUNCH'", [rt]).map(x => x.asset_id);
  const steps = t.db.all('SELECT part_id FROM resource_parts WHERE resource_type_id = ?', [rt]).map(x => x.part_id);
  const c = ctx();
  for (const part of steps) applyEdit(t.db, t.session, { kind: 'assetPart', assetIds: ids, partId: part, status: 'DONE', doneAt: '2026-11-04' }, c);
  const after = comp();
  assert.ok(after <= before, `${before} → ${after}`);
  assert.equal(t.db.get("SELECT completed_qty FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = ? AND part_id = ?", [rt, steps[0]]).completed_qty, ids.length);
  undoBatch(t.db, t.session, c.batchId, ctx());
  assert.equal(t.db.get("SELECT count(*) AS n FROM asset_parts ap JOIN assets a USING(asset_id) WHERE a.resource_type_id = ?", [rt]).n, 0);
  assert.equal(t.db.get("SELECT count(*) AS n FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = ?", [rt]).n, 0);
  assert.equal(comp(), before);
  // 이력 이름
  const h = historyView(t.db, 5).batches.map(b => b.summary).join(' / ');
  assert.match(h, /에셋 상태/);
  t.raw.close();
});

test('빈 에셋 만들기: 템플릿 구간별로 모자란 만큼, 손으로 넣은 완료 수량은 앞 에셋부터 완료로 옮긴다 · 물량을 에셋에 맞추기', () => {
  const t = open();
  const rt = 'CHAR_NEW'; // 정상 예시: 원화 3 · 모델링 1 완료(손 입력)
  const vol = t.db.get("SELECT * FROM volumes WHERE update_id = 'LAUNCH' AND resource_type_id = ?", [rt]);
  const manual = prog(t.db, 'LAUNCH', rt);
  apply(t, { kind: 'fillAssets', updateId: 'LAUNCH', resourceTypeId: rt });
  const v = assetsView(t.db, 'LAUNCH');
  const row = v.groups.flatMap(g => g.resources).find(r => r.resourceTypeId === rt);
  assert.equal(row.registered.total, vol.stretch_qty);
  assert.equal(row.registered.MIN, vol.min_qty);
  assert.equal(row.registered.MIN + row.registered.TARGET, vol.target_qty);
  assert.deepEqual(prog(t.db, 'LAUNCH', rt), manual, '완료 수량 · 기준일이 그대로 이어진다');
  // 다시 눌러도 더 만들지 않는다
  assert.equal(apply(t, { kind: 'fillAssets', updateId: 'LAUNCH', resourceTypeId: rt }).changed, false);
  // 기본안 에셋 하나를 지우고 물량 맞추기 → 기본안 · 최대안이 1씩 준다
  const one = t.db.get("SELECT asset_id FROM assets WHERE resource_type_id = ? AND tier = 'TARGET' ORDER BY sort_order DESC LIMIT 1", [rt]).asset_id;
  apply(t, { kind: 'deleteAssets', assetIds: [one] });
  apply(t, { kind: 'volumeFromAssets', updateId: 'LAUNCH', resourceTypeId: rt });
  const v2 = t.db.get("SELECT * FROM volumes WHERE update_id = 'LAUNCH' AND resource_type_id = ?", [rt]);
  assert.deepEqual([v2.min_qty, v2.target_qty, v2.stretch_qty], [vol.min_qty, vol.target_qty - 1, vol.stretch_qty - 1]);
  t.raw.close();
});

test('배치: 만들기 · 이름 · 마감일 · 순서 · 지우면 에셋은 미배정 · 되돌리면 다시 묶인다', () => {
  const t = open();
  const b1 = apply(t, { kind: 'createBatch', updateId: 'LAUNCH', name: '1차', dueDate: '2027-01-15' }).createdId;
  const b2 = apply(t, { kind: 'createBatch', updateId: 'LAUNCH', name: '2차', dueDate: null }).createdId;
  assert.throws(() => apply(t, { kind: 'createBatch', updateId: 'LAUNCH', name: '1차', dueDate: null }), /같은 이름/);
  assert.throws(() => apply(t, { kind: 'batchField', batchId: b2, field: 'due_date', value: '2027-02-30' }), /형식/);
  apply(t, { kind: 'batchField', batchId: b2, field: 'due_date', value: '2027-02-28' });
  apply(t, { kind: 'moveBatch', batchId: b2, direction: -1 });
  assert.deepEqual(assetsView(t.db, 'LAUNCH').batches.map(b => b.name), ['2차', '1차']);
  apply(t, { kind: 'createAssets', updateId: 'LAUNCH', resourceTypeId: 'COSTUME', names: ['가', '나'], batchId: b1 });
  const del = ctx();
  applyEdit(t.db, t.session, { kind: 'deleteBatch', batchId: b1 }, del);
  assert.equal(t.db.get('SELECT count(*) AS n FROM assets WHERE batch_id IS NULL').n, 2);
  undoBatch(t.db, t.session, del.batchId, ctx());
  assert.equal(t.db.get('SELECT count(*) AS n FROM assets WHERE batch_id = ?', [b1]).n, 2);
  // 다른 업데이트의 배치로는 옮길 수 없다
  const other = apply(t, { kind: 'createBatch', updateId: 'S1', name: 'S1 1차', dueDate: null }).createdId;
  const a = t.db.get('SELECT asset_id FROM assets LIMIT 1').asset_id;
  assert.throws(() => apply(t, { kind: 'assetField', assetIds: [a], field: 'batch_id', value: other }), /업데이트에 없는 배치/);
  t.raw.close();
});

test('에셋 칸 고치기 · Jira 키 · Jira 주소 · 썸네일(이력에는 사실만) · 지우기 되돌리기(상태 함께)', () => {
  const t = open();
  const id = apply(t, { kind: 'createAssets', updateId: 'LAUNCH', resourceTypeId: 'COSTUME', names: ['코스튬 A'] }).createdId;
  apply(t, { kind: 'assetField', assetIds: [id], field: 'jira_key', value: 'art-12' });
  assert.equal(t.db.get('SELECT jira_key FROM assets WHERE asset_id = ?', [id]).jira_key, 'ART-12');
  assert.throws(() => apply(t, { kind: 'assetField', assetIds: [id], field: 'jira_key', value: '12-ART' }), /ABC-123/);
  assert.throws(() => apply(t, { kind: 'assetField', assetIds: [id], field: 'name', value: '  ' }), /비울 수 없/);
  apply(t, { kind: 'assetField', assetIds: [id], field: 'tier', value: 'STRETCH' });
  assert.throws(() => apply(t, { kind: 'jiraBase', url: 'atlassian' }), /http/);
  apply(t, { kind: 'jiraBase', url: 'https://example.atlassian.net/browse' });
  assert.equal(assetsView(t.db, 'LAUNCH').jiraBase, 'https://example.atlassian.net/browse/');
  apply(t, { kind: 'assetThumb', assetId: id, data: new Uint8Array([1, 2, 3, 4]), mime: 'image/webp', width: 2, height: 2 });
  assert.deepEqual([...assetThumbs(t.db, [id])[0].data], [1, 2, 3, 4]);
  assert.ok(assetsView(t.db, 'LAUNCH').assets.find(a => a.assetId === id).thumbAt);
  const log = t.db.get("SELECT old_json, new_json FROM change_log WHERE target = 'asset_thumbs' ORDER BY log_id DESC LIMIT 1");
  assert.equal(log.new_json, '"있음"');
  const part = t.db.get("SELECT part_id FROM resource_parts WHERE resource_type_id = 'COSTUME' LIMIT 1").part_id;
  apply(t, { kind: 'assetPart', assetIds: [id], partId: part, status: 'DONE', doneAt: '2026-11-04', assignee: '김원화' });
  const del = ctx();
  applyEdit(t.db, t.session, { kind: 'deleteAssets', assetIds: [id] }, del);
  assert.equal(t.db.get("SELECT count(*) AS n FROM progress WHERE resource_type_id = 'COSTUME' AND update_id = 'LAUNCH'").n, 0, '마지막 에셋을 지우면 집계한 완료 수량도 정리');
  undoBatch(t.db, t.session, del.batchId, ctx());
  assert.equal(t.db.get('SELECT status FROM asset_parts WHERE asset_id = ?', [id]).status, 'DONE');
  assert.equal(t.db.get("SELECT completed_qty FROM progress WHERE resource_type_id = 'COSTUME' AND update_id = 'LAUNCH' AND part_id = ?", [part]).completed_qty, 1);
  t.raw.close();
});

test('지우기 보호: 에셋이 있는 업데이트 · 물량 줄 · 리소스는 지울 수 없다', () => {
  const t = open();
  apply(t, { kind: 'createAssets', updateId: 'MINI1', resourceTypeId: t.db.get("SELECT resource_type_id FROM volumes WHERE update_id = 'MINI1' LIMIT 1").resource_type_id, names: ['x'] });
  const rt = t.db.get("SELECT resource_type_id FROM assets LIMIT 1").resource_type_id;
  assert.throws(() => apply(t, { kind: 'deleteUpdate', updateId: 'MINI1' }), /에셋이 1개/);
  assert.throws(() => apply(t, { kind: 'removeResource', updateId: 'MINI1', resourceTypeId: rt }), /에셋/);
  assert.throws(() => apply(t, { kind: 'createAssets', updateId: 'MINI1', resourceTypeId: 'NOPE', names: ['y'] }), /물량에 없는/);
  t.raw.close();
});

test('에셋 엑셀: 받기 → 고치고 새 행 더해 넣기 → 같은 상태 · 배치 자동 생성 · 잘못된 행은 이유와 함께 건너뜀 · 한 묶음 되돌리기', async () => {
  const { assetBook, importAssets } = await import('../core/asset-io.ts');
  const { writeXlsx } = await import('../core/xlsx-write.ts');
  const { readXlsx } = await import('../core/xlsx.ts');
  const t = open();
  apply(t, { kind: 'fillAssets', updateId: 'LAUNCH', resourceTypeId: 'CHAR_NEW' });
  const book = assetBook(t.db, 'LAUNCH');
  const read = await readXlsx(writeXlsx(book.sheets, { freezeRows: book.freezeRows }));
  const rows = read['에셋'];
  const h = rows[0].map(x => String(x).replace(' *', ''));
  const c = name => h.indexOf(name);
  assert.ok(c('원화 상태') > 0 && c('마일스톤') > 0);
  // 첫 에셋: 이름 · 배치 · 모델링 완료, 새 행 하나, 잘못된 행 하나
  const first = rows[2].slice();
  first[c('에셋 이름')] = '용감한 쿠키';
  first[c('배치')] = '1차';
  first[c('모델링 상태')] = '완료';
  first[c('모델링 완료일')] = '2026-11-06';
  first[c('에셋 Jira')] = 'ART-7';
  const fresh = new Array(h.length).fill(null);
  fresh[c('마일스톤')] = '런칭'; fresh[c('리소스 종류')] = '코스튬'; fresh[c('에셋 이름')] = '새 코스튬'; fresh[c('포함 템플릿')] = '최대안'; fresh[c('원화 상태')] = '진행';
  const bad = fresh.slice(); bad[c('에셋 이름')] = '잘못'; bad[c('원화 상태')] = '끝남';
  const edited = { ...read, '에셋': [rows[0], rows[1], first, ...rows.slice(3), fresh, bad] };
  const ctxI = ctx();
  const report = importAssets(t.db, t.session, edited, ctxI, '2026-11-09');
  assert.equal(report.created, 1);
  assert.equal(report.changed, 1);
  assert.equal(report.batches, 1);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /원화 상태 "끝남"/);
  const a = t.db.get("SELECT * FROM assets WHERE name = '용감한 쿠키'");
  assert.equal(a.jira_key, 'ART-7');
  assert.equal(t.db.get('SELECT name FROM batches WHERE batch_id = ?', [a.batch_id]).name, '1차');
  assert.equal(t.db.get("SELECT done_at FROM asset_parts WHERE asset_id = ? AND part_id = 'MODELING'", [a.asset_id]).done_at, '2026-11-06');
  assert.equal(t.db.get("SELECT tier FROM assets WHERE name = '새 코스튬'").tier, 'STRETCH');
  assert.equal(t.db.get("SELECT count(*) AS n FROM assets WHERE name = '잘못'").n, 0, '잘못된 행은 넣지 않는다');
  // 다시 넣으면 바뀐 것이 없다
  const again = importAssets(t.db, t.session, await readXlsx(writeXlsx(assetBook(t.db, 'LAUNCH').sheets)), ctx(), '2026-11-09');
  assert.equal(again.changed + again.created, 0);
  // 넣기 한 묶음을 되돌리면 새 에셋 · 배치가 사라진다
  undoBatch(t.db, t.session, ctxI.batchId, ctx());
  assert.equal(t.db.get("SELECT count(*) AS n FROM assets WHERE name IN ('새 코스튬', '용감한 쿠키')").n, 0);
  assert.equal(t.db.get('SELECT count(*) AS n FROM batches').n, 0);
  t.raw.close();
});

test('에셋 예시: 에셋 상태에서 다시 센 작업 진척 = 정상 예시의 작업 진척(완료 예정이 같다)', () => {
  const a = open('assets');
  const b = open('normal');
  const rows = d => d.all('SELECT update_id, resource_type_id, part_id, completed_qty, as_of FROM progress ORDER BY 1, 2, 3');
  assert.deepEqual(rows(a.db), rows(b.db));
  // 에셋 상태를 다시 세도 그대로(예시 파일이 서로 맞다)
  apply(a, { kind: 'assetPart', assetIds: ['A00001'], partId: 'FX', status: 'TODO' });
  assert.deepEqual(rows(a.db), rows(b.db));
  const comp = t => planView(t.db, t.session, 'TARGET').rows.map(r => `${r.updateId}:${r.result?.completion}`).join(' ');
  assert.equal(comp(a), comp(b));
  const v = assetsView(a.db, 'LAUNCH');
  assert.equal(v.totals.assets, 20);
  assert.equal(v.batches.length, 2);
  assert.equal(v.totals.review, 1);
  a.raw.close(); b.raw.close();
});

test('칸반 단계 옮기기: 앞으로(지나친 파트 완료 · 옮긴 파트 진행) · 뒤로(수정 + 뒤 파트 대기) · 완료 · 대기 · 모든 에셋이 같은 파이프라인 · 한 묶음 되돌리기', () => {
  const t = open('assets');
  const stage = id => assetsView(t.db, 'LAUNCH').assets.find(a => a.assetId === id);
  const st = (id, p) => t.db.get('SELECT status, done_at, retakes FROM asset_parts WHERE asset_id = ? AND part_id = ?', [id, p]) ?? { status: 'TODO' };
  const id = 'A00006'; // 좀비맛 쿠키: 모두 대기
  assert.equal(stage(id).stage, 'TODO');
  apply(t, { kind: 'moveStage', assetIds: [id], stage: 'MODELING' });
  assert.equal(st(id, 'CONCEPT').status, 'DONE');
  assert.ok(st(id, 'CONCEPT').done_at);
  assert.equal(st(id, 'MODELING').status, 'WIP');
  assert.equal(stage(id).stage, 'MODELING');
  assert.equal(stage(id).sub, 'WIP');
  // 뒤로: 원화는 수정(리테이크 1), 모델링은 대기
  const back = ctx();
  applyEdit(t.db, t.session, { kind: 'moveStage', assetIds: [id], stage: 'CONCEPT' }, back);
  assert.equal(st(id, 'CONCEPT').status, 'RETAKE');
  assert.equal(st(id, 'CONCEPT').retakes, 1);
  assert.equal(st(id, 'MODELING').status, 'TODO');
  assert.equal(stage(id).stage, 'CONCEPT');
  undoBatch(t.db, t.session, back.batchId, ctx());
  assert.equal(stage(id).stage, 'MODELING', '되돌리면 한 묶음으로 돌아온다');
  apply(t, { kind: 'moveStage', assetIds: [id], stage: 'DONE' });
  assert.equal(stage(id).stage, 'DONE');
  assert.equal(stage(id).progress, 1);
  apply(t, { kind: 'moveStage', assetIds: [id], stage: 'TODO' });
  assert.equal(stage(id).stage, 'TODO');
  // 모든 에셋이 같은 파이프라인: 코스튬은 FX를 거치지 않아 기본이 "해당 없음"이지만, FX 열로 옮기면 FX가 켜진다
  const costume = stage('A00015');
  assert.deepEqual(Object.keys(costume.parts), ['CONCEPT', 'MODELING', 'ANIMATION', 'FX']);
  assert.deepEqual([costume.parts.FX.status, costume.parts.FX.inPlan, costume.parts.CONCEPT.inPlan], ['OMIT', false, true]);
  assert.equal(costume.stage, 'TODO');
  apply(t, { kind: 'moveStage', assetIds: ['A00007', 'A00015'], stage: 'FX' });
  assert.equal(stage('A00007').stage, 'FX');
  assert.equal(stage('A00015').stage, 'FX');
  assert.equal(st('A00015', 'FX').status, 'WIP');
  assert.equal(t.db.get("SELECT count(*) AS n FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'COSTUME' AND part_id = 'FX'").n, 0, '계획 공수에 없는 파트는 작업 진척에 세지 않는다');
  // 다시 끄기: 해당 없음으로 돌리면 단계는 완료(시작일 기록은 남는다)
  apply(t, { kind: 'assetPart', assetIds: ['A00015'], partId: 'FX', status: 'OMIT' });
  assert.equal(st('A00015', 'FX').status, 'OMIT');
  assert.equal(stage('A00015').stage, 'DONE');
  // 거치는 파트를 해당 없음으로 끄고 다시 대기로 켜기
  apply(t, { kind: 'assetPart', assetIds: ['A00016'], partId: 'ANIMATION', status: 'OMIT' });
  assert.equal(stage('A00016').parts.ANIMATION.status, 'OMIT');
  apply(t, { kind: 'assetPart', assetIds: ['A00016'], partId: 'ANIMATION', status: 'TODO' });
  assert.equal(t.db.get("SELECT count(*) AS n FROM asset_parts WHERE asset_id = 'A00016' AND part_id = 'ANIMATION'").n, 0);
  // 작업 진척: 원화 완료가 늘었다
  assert.ok(t.db.get("SELECT completed_qty FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW' AND part_id = 'CONCEPT'").completed_qty >= 4);
  t.raw.close();
});

test('카드: 열 안 순서 · 마감일 · 설명(여러 줄) · 링크 · 댓글 · 활동 · 에셋 지우기 되돌리면 링크 · 댓글도 돌아온다', async () => {
  const { assetDetail } = await import('../core/assets.ts');
  const t = open('assets');
  apply(t, { kind: 'reorderAssets', assetIds: ['A00003', 'A00001', 'A00002'] });
  const order = assetsView(t.db, 'LAUNCH').assets.filter(a => ['A00001', 'A00002', 'A00003'].includes(a.assetId)).map(a => a.assetId);
  assert.deepEqual(order, ['A00003', 'A00001', 'A00002']);
  apply(t, { kind: 'assetField', assetIds: ['A00001'], field: 'due_date', value: '2027-01-15' });
  assert.throws(() => apply(t, { kind: 'assetField', assetIds: ['A00001'], field: 'due_date', value: '2027-13-01' }), /형식/);
  apply(t, { kind: 'assetField', assetIds: ['A00001'], field: 'note', value: '첫 줄\n둘째 줄\n' });
  assert.equal(t.db.get("SELECT note FROM assets WHERE asset_id = 'A00001'").note, '첫 줄\n둘째 줄');
  apply(t, { kind: 'addLink', assetId: 'A00001', title: '컨셉 문서', url: 'https://wiki.example.com/cookie' });
  assert.throws(() => apply(t, { kind: 'addLink', assetId: 'A00001', title: '', url: 'wiki' }), /http/);
  apply(t, { kind: 'addComment', assetId: 'A00001', body: '  모델링 들어가기 전에 실루엣 확인 부탁  ' });
  assert.throws(() => apply(t, { kind: 'addComment', assetId: 'A00001', body: '   ' }), /댓글 내용/);
  const d = assetDetail(t.db, 'A00001');
  assert.equal(d.links[0].title, '컨셉 문서');
  assert.equal(d.comments[0].body, '모델링 들어가기 전에 실루엣 확인 부탁');
  assert.equal(d.comments[0].author, '검사');
  assert.ok(d.activity.some(a => a.text.startsWith('마감일')), d.activity.map(a => a.text).join(' / '));
  assert.ok(d.activity.some(a => a.text === '댓글을 남김'));
  const v = assetsView(t.db, 'LAUNCH').assets.find(a => a.assetId === 'A00001');
  assert.deepEqual([v.dueDate, v.links, v.comments], ['2027-01-15', 1, 1]);
  const del = ctx();
  applyEdit(t.db, t.session, { kind: 'deleteAssets', assetIds: ['A00001'] }, del);
  assert.equal(t.db.get("SELECT count(*) AS n FROM asset_links WHERE asset_id = 'A00001'").n, 0);
  undoBatch(t.db, t.session, del.batchId, ctx());
  assert.equal(assetDetail(t.db, 'A00001').links.length, 1);
  assert.equal(assetDetail(t.db, 'A00001').comments.length, 1);
  t.raw.close();
});
