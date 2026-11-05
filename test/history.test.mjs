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
  assert.equal(h.batches[1].summary, '물량 목표');
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
  assert.deepEqual(Object.keys(sheets), ['요약', '업데이트 전망', '파트 부하', '물량', '인력', '공수', '실적', '데이터 점검', '변경 이력']);
  const back = await readXlsx(writeXlsx(sheets)); // 저장 방식(브라우저와 같은 경로)
  const outlook = back['업데이트 전망'];
  assert.equal(outlook.length, 1 + plan.rows.length);
  assert.equal(outlook[1][1], '런칭');
  assert.equal(outlook[1][9], plan.rows[0].result.completion);
  assert.equal(back['파트 부하'].length, 1 + 4 * 4);
  assert.equal(back['물량'].length, 1 + 21);
});
