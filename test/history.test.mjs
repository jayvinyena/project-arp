// 5단계: 변경 이력 보기 · 되돌리기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { historyView, undoBatch } from '../core/history.ts';
import { planView, updateDetail, capacityView } from '../core/plan.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-history', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let n = 0;
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

test('이력: 묶음마다 요약·편집자·항목, 최신이 위', () => {
  const { raw, db, edit } = open();
  edit({ kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'target_qty', value: 70 });
  edit({ kind: 'createUpdate', name: '시즌 3', typeId: 'SEASON', startDate: '2027-09-01', freezeDate: null, releaseDate: '2027-12-10' });
  const h = historyView(db);
  raw.close();
  assert.equal(h.total, 2);
  assert.equal(h.batches[0].batchId, 'B2');
  assert.equal(h.batches[0].summary, '업데이트 추가 · 물량 추가');
  assert.equal(h.batches[0].count, 7);
  assert.equal(h.batches[1].summary, '물량 기본안');
  assert.deepEqual([h.batches[1].entries[0].old, h.batches[1].entries[0].next], [60, 70]);
});

test('되돌리기: 값 고치기 · 업데이트 만들기 · 업데이트 지우기(물량까지) · 계획 기간 늘리기', () => {
  const { raw, db, session, edit, undo } = open();
  const before = planView(db, session).rows.map(r => [r.updateId, r.result.completion]);
  edit({ kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'target_qty', value: 70 });
  undo('B1');
  assert.equal(db.get("SELECT target_qty FROM volumes WHERE update_id = 'LAUNCH' AND resource_type_id = 'PROP'").target_qty, 60);

  edit({ kind: 'createUpdate', name: '시즌 3', typeId: 'SEASON', startDate: '2027-09-01', freezeDate: null, releaseDate: '2027-12-10' });
  undo('B3');
  assert.equal(updateDetail(db, 'U001'), null);
  assert.equal(db.get("SELECT count(*) AS n FROM volumes WHERE update_id = 'U001'").n, 0);

  edit({ kind: 'deleteUpdate', updateId: 'S2' });
  assert.equal(updateDetail(db, 'S2'), null);
  undo('B5');
  assert.equal(updateDetail(db, 'S2').rows.length, 6);

  edit({ kind: 'horizon', startMonth: '2026-11', endMonth: '2028-03' });
  assert.equal(capacityView(db).months.length, 17);
  undo('B7');
  assert.equal(capacityView(db).months.length, 14);
  assert.equal(db.get("SELECT count(*) AS n FROM capacity WHERE month > '2027-12'").n, 0);

  assert.deepEqual(planView(db, session).rows.map(r => [r.updateId, r.result.completion]), before);
  const h = historyView(db);
  assert.ok(h.batches.find(x => x.batchId === 'B1').undone);
  assert.ok(h.batches.find(x => x.batchId === 'U2').isUndo);
  raw.close();
});

test('되돌리기: 두 번은 거절, 뒤에 같은 칸을 고쳤으면 확인을 요구', () => {
  const { raw, db, edit, undo } = open();
  edit({ kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'target_qty', value: 70 });
  edit({ kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'target_qty', value: 75 });
  assert.throws(() => undo('B1'), /같은 칸/);
  undo('B1', true);
  assert.equal(db.get("SELECT target_qty FROM volumes WHERE update_id = 'LAUNCH' AND resource_type_id = 'PROP'").target_qty, 60);
  assert.throws(() => undo('B1', true), /이미/);
  raw.close();
});

test('되돌리기: 되돌린 결과가 계산할 수 없는 상태면 취소한다', () => {
  const { raw, db, edit, undo } = open();
  // 최저를 비웠다가(오류) 다시 채운 상태에서, "다시 채운" 묶음만 되돌리면 빈칸이 돼 오류 → 거절
  edit({ kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'min_qty', value: null });
  edit({ kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'min_qty', value: 40 });
  assert.throws(() => undo('B2'), /계산할 수 없는/);
  assert.equal(db.get("SELECT min_qty FROM volumes WHERE update_id = 'LAUNCH' AND resource_type_id = 'PROP'").min_qty, 40);
  raw.close();
});

test('엑셀 내보내기: 시트 9개, 업데이트 전망·파트 부하가 계산 결과와 같고 다시 읽힌다', async () => {
  const { exportSheets } = await import('../core/export.ts');
  const { writeXlsx } = await import('../core/xlsx-write.ts');
  const { readXlsx } = await import('../core/xlsx.ts');
  const { raw, db, session } = open();
  const sheets = exportSheets(db, session, 'TARGET');
  const plan = planView(db, session);
  raw.close();
  assert.deepEqual(Object.keys(sheets), ['요약', '업데이트 전망', '파트 부하', '물량', '인력', '공수', '작업 진척', '데이터 점검', '변경 이력']);
  const back = await readXlsx(writeXlsx(sheets)); // 저장 방식(브라우저와 같은 경로)
  const outlook = back['업데이트 전망'];
  assert.equal(outlook.length, 1 + plan.rows.length);
  assert.equal(outlook[1][1], '런칭');
  assert.equal(outlook[1][9], plan.rows[0].result.completion);
  assert.equal(back['파트 부하'].length, 1 + 4 * 4);
  assert.equal(back['물량'].length, 1 + 21);
});

// ───────── 전체 점검(2026-11-05)에서 찾아 고친 것 ─────────
import { laterConflicts } from '../core/history.ts';

test('업데이트 지우기 → 되돌리기: 물량과 함께 진행 실적(실투입 포함)도 돌아온다', () => {
  const { raw, db, edit, undo } = open();
  edit({ kind: 'progressSpent', updateId: 'LAUNCH', resourceTypeId: 'CHAR_NEW', partId: 'CONCEPT', value: 7, asOf: '2026-11-04' });
  const before = db.all("SELECT * FROM progress WHERE update_id = 'LAUNCH' ORDER BY resource_type_id, part_id");
  edit({ kind: 'deleteUpdate', updateId: 'LAUNCH' });
  assert.equal(db.get("SELECT count(*) AS n FROM progress WHERE update_id = 'LAUNCH'").n, 0);
  undo('B2');
  assert.deepEqual(db.all("SELECT * FROM progress WHERE update_id = 'LAUNCH' ORDER BY resource_type_id, part_id"), before);
  raw.close();
});

test('지운 ID는 다시 쓰지 않는다 → 지우기를 되돌릴 수 있다', () => {
  const { raw, db, edit, undo } = open();
  edit({ kind: 'createUpdate', name: '하나', typeId: 'MINI', startDate: '2027-03-01', freezeDate: null, releaseDate: '2027-05-14' });
  const first = db.get("SELECT update_id FROM updates WHERE name = '하나'").update_id;
  edit({ kind: 'deleteUpdate', updateId: first });
  edit({ kind: 'createUpdate', name: '둘', typeId: 'MINI', startDate: '2027-03-01', freezeDate: null, releaseDate: '2027-05-14' });
  const second = db.get("SELECT update_id FROM updates WHERE name = '둘'").update_id;
  assert.notEqual(second, first);
  undo('B2', true);
  assert.equal(db.get('SELECT name FROM updates WHERE update_id = ?', [first]).name, '하나');
  raw.close();
});

test('만들기를 되돌릴 때 뒤에 그 업데이트·물량을 고쳤으면 확인을 요구하고, 되돌린 것을 다시 되돌리면 물량·실적이 돌아온다', () => {
  const { raw, db, edit, undo } = open();
  edit({ kind: 'createUpdate', name: '새 미니', typeId: 'MINI', startDate: '2027-03-01', freezeDate: null, releaseDate: '2027-05-14' });
  const id = db.get("SELECT update_id FROM updates WHERE name = '새 미니'").update_id;
  edit({ kind: 'volume', updateId: id, resourceTypeId: 'ICON', field: 'stretch_qty', value: 99 });
  const iconPart = db.get("SELECT part_id FROM resource_parts WHERE resource_type_id = 'ICON' LIMIT 1").part_id;
  edit({ kind: 'progress', updateId: id, resourceTypeId: 'ICON', partId: iconPart, value: 2, asOf: '2026-11-05' });
  assert.deepEqual(laterConflicts(db, 'B1').sort(), ['B2', 'B3']);
  assert.throws(() => undo('B1'), /그래도 되돌리기/);
  const vols = db.all('SELECT * FROM volumes WHERE update_id = ? ORDER BY resource_type_id', [id]);
  undo('B1', true);
  assert.equal(db.get('SELECT count(*) AS n FROM updates WHERE update_id = ?', [id]).n, 0);
  const undoBatchId = db.get("SELECT batch_id FROM change_log WHERE reason = '되돌리기: B1' LIMIT 1").batch_id;
  undo(undoBatchId, true);
  assert.deepEqual(db.all('SELECT * FROM volumes WHERE update_id = ? ORDER BY resource_type_id', [id]), vols);
  assert.equal(db.get('SELECT completed_qty FROM progress WHERE update_id = ?', [id]).completed_qty, 2);
  raw.close();
});

test('이미 있던 오류는 관계없는 되돌리기를 막지 않는다 · 기준일도 되돌린다 · 리소스 빼기는 그 실적도 함께', () => {
  const { raw, db, edit, undo } = open();
  db.run("UPDATE volumes SET min_qty = target_qty + 1 WHERE update_id = 'S1' AND resource_type_id = 'COSTUME'"); // 최저 > 목표 오류(이미 있음)
  edit({ kind: 'capacity', partId: 'FX', month: '2027-01', field: 'headcount', value: 9 });
  assert.doesNotThrow(() => undo('B1'));
  edit({ kind: 'progress', updateId: 'LAUNCH', resourceTypeId: 'CHAR_NEW', partId: 'CONCEPT', value: 4, asOf: '2026-12-01' });
  undo('B3');
  assert.deepEqual({ ...db.get("SELECT completed_qty, as_of FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW' AND part_id = 'CONCEPT'") }, { completed_qty: 3, as_of: '2026-11-04' });
  edit({ kind: 'removeResource', updateId: 'LAUNCH', resourceTypeId: 'CHAR_NEW' });
  assert.equal(db.get("SELECT count(*) AS n FROM progress WHERE resource_type_id = 'CHAR_NEW'").n, 0);
  undo('B5');
  assert.equal(db.get("SELECT count(*) AS n FROM progress WHERE resource_type_id = 'CHAR_NEW'").n, 2);
  raw.close();
});

test('조작된 변경 이력의 칸 이름은 실행하지 않는다', () => {
  const { raw, db, undo } = open();
  db.run("INSERT INTO change_log (batch_id, at, editor, action, target, target_key, field, old_json, new_json) VALUES ('EVIL', '2026-11-05T00:00:00Z', 'x', 'UPDATE', 'updates', 'S1', 'name = 1; DROP TABLE parts; --', '1', '2')");
  assert.throws(() => undo('EVIL'), /되돌릴 수 없는 칸/);
  assert.ok(db.get('SELECT count(*) AS n FROM parts').n > 0);
  raw.close();
});
