// 6단계: 실투입 공수 · 공수 보정 제안 · 적용
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { progressView } from '../core/plan.ts';
import { historyView, undoBatch } from '../core/history.ts';
import { calibrationView, calibrationPreview } from '../core/calibration.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-calibration', import.meta.url));
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
  return { raw, db, session, edit };
}
const done = (updateId, resourceTypeId, partId, value) => ({ kind: 'progress', updateId, resourceTypeId, partId, value, asOf: '2026-12-01' });
const spent = (updateId, resourceTypeId, partId, value) => ({ kind: 'progressSpent', updateId, resourceTypeId, partId, value, asOf: '2026-12-01' });

test('실투입 공수: 넣기 · 완료 없이도 남음 · 둘 다 비우면 행 삭제 · 되돌리기', () => {
  const { raw, db, session, edit } = open();
  edit(spent('LAUNCH', 'PROP', 'CONCEPT', 12.5));
  let cell = progressView(db, 'LAUNCH').rows.find(r => r.resourceTypeId === 'PROP').cells[0];
  assert.deepEqual([cell.completed, cell.spent], [null, 12.5]);
  edit(done('LAUNCH', 'PROP', 'CONCEPT', 10));
  edit(spent('LAUNCH', 'PROP', 'CONCEPT', null));
  edit(done('LAUNCH', 'PROP', 'CONCEPT', 0));
  assert.equal(db.get("SELECT count(*) AS n FROM progress WHERE resource_type_id = 'PROP'").n, 0);
  // 지운 실적 되돌리기(이전 행 전체가 돌아온다)
  const del = historyView(db).batches[0];
  undoBatch(db, session, del.batchId, { editor: '검사', batchId: 'U' });
  cell = progressView(db, 'LAUNCH').rows.find(r => r.resourceTypeId === 'PROP').cells[0];
  assert.deepEqual([cell.completed, cell.spent], [10, null]);
  assert.throws(() => edit(spent('LAUNCH', 'PROP', 'CONCEPT', -1)));
  raw.close();
});

test('보정 제안: 실투입 ÷ 기준 = 배율, 근거 충분 여부, 파트 합계', () => {
  const { raw, db, edit } = open();
  // 프랍 원화: 기준 공수 1 × 원화 섞기(기본 0.5·AI 0.6 반반 = 0.8) × 재작업 1.05 = 0.84인·일/개 → 10개 = 8.4. 실투입 12.6 → 1.5배
  edit(done('LAUNCH', 'PROP', 'CONCEPT', 10));
  edit(spent('LAUNCH', 'PROP', 'CONCEPT', 12.6));
  // 배경 맵 모델링: 기준 15 × 1.15 = 17.25/개 → 2개 34.5. 실투입 30 → 0.87배, 근거 부족(2개)
  edit(done('LAUNCH', 'BG_MAP', 'MODELING', 2));
  edit(spent('LAUNCH', 'BG_MAP', 'MODELING', 30));
  const v = calibrationView(db);
  raw.close();
  assert.equal(v.samples, 2);
  const prop = v.rows.find(r => r.resourceTypeId === 'PROP');
  assert.ok(Math.abs(prop.ratio - 1.5) < 1e-9, `${prop.ratio}`);
  assert.equal(prop.suggestedBase, 1.5);
  assert.equal(prop.enough, true);
  const bg = v.rows.find(r => r.resourceTypeId === 'BG_MAP');
  assert.ok(Math.abs(bg.ratio - 30 / 34.5) < 1e-9);
  assert.equal(bg.enough, false);
  assert.equal(v.rows[0].resourceTypeId, 'PROP', '배율 차이가 큰 것이 위');
  assert.ok(Math.abs(v.parts.find(p => p.partId === 'CONCEPT').ratio - 1.5) < 1e-9);
});

test('보정 미리 보기와 적용: 공수가 늘면 완료 예정이 늦어지고, 적용은 모든 공수 판에 배율 · 이력 · 되돌리기', () => {
  const { raw, db, session, edit } = open();
  const pv = calibrationPreview(session.currentData(), [{ resourceTypeId: 'PROP', partId: 'MODELING', ratio: 3 }]);
  const launch = pv.updates.find(u => u.updateId === 'LAUNCH');
  assert.ok(launch.after > launch.before, `${launch.before} → ${launch.after}`);
  edit({ kind: 'effortScale', resourceTypeId: 'PROP', partId: 'CONCEPT', ratio: 1.5 });
  const days = Object.fromEntries(db.all("SELECT profile_id, days FROM efforts WHERE resource_type_id = 'PROP' AND part_id = 'CONCEPT'").map(r => [r.profile_id, r.days]));
  assert.deepEqual(days, { BASE: 1.5, AI: 0.9 });
  const h = historyView(db).batches[0];
  assert.equal(h.summary, '공수 1개당 인·일');
  undoBatch(db, session, h.batchId, { editor: '검사', batchId: 'U' });
  assert.equal(db.get("SELECT days FROM efforts WHERE resource_type_id = 'PROP' AND part_id = 'CONCEPT' AND profile_id = 'BASE'").days, 1);
  raw.close();
});

test('실적 엑셀: 양식(지금 값) → 채워서 넣기(한 묶음) · ID 없이 이름으로 · 맞지 않는 행 보고', async () => {
  const { progressTemplate, importProgress } = await import('../core/progress-io.ts');
  const { writeXlsx } = await import('../core/xlsx-write.ts');
  const { readXlsx } = await import('../core/xlsx.ts');
  const { raw, db, session } = open();
  const tpl = progressTemplate(db)['실적'];
  assert.deepEqual(tpl[0].slice(0, 3), ['업데이트 ID', '업데이트', '리소스 ID']);
  const charConcept = tpl.find(r => r[0] === 'LAUNCH' && r[2] === 'CHAR_NEW' && r[4] === 'CONCEPT');
  assert.equal(charConcept[7], 3, '지금 완료 수량이 채워져 있다');
  // 1) 양식 그대로 채워 넣기
  charConcept[7] = 8; charConcept[8] = 30;
  const propModel = tpl.find(r => r[0] === 'LAUNCH' && r[2] === 'PROP' && r[4] === 'MODELING');
  propModel[7] = 20; propModel[9] = 46356; // 2026-11-30 (엑셀 날짜)
  const back = await readXlsx(writeXlsx({ '실적': tpl }));
  const rep = importProgress(db, session, back, { editor: '검사', batchId: 'IMP1' }, '2026-12-01');
  assert.equal(rep.changedCells, 3);
  assert.deepEqual(rep.skipped, []);
  assert.equal(db.get("SELECT completed_qty, spent_days, as_of FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW' AND part_id = 'CONCEPT'").spent_days, 30);
  assert.equal(db.get("SELECT as_of FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'PROP' AND part_id = 'MODELING'").as_of, '2026-11-30');
  assert.equal(historyView(db).batches.filter(b => b.batchId === 'IMP1').length, 1, '한 묶음');
  // 2) 다른 도구 표: ID 없이 이름, 머리글이 조금 다름, 모르는 이름
  const other = await readXlsx(writeXlsx({ Sheet1: [['Update', 'Resource', 'Part', 'Completed'], ['런칭', '프랍', '원화', 33], ['런칭', '없는 리소스', '원화', 1]] }));
  const rep2 = importProgress(db, session, other, { editor: '검사', batchId: 'IMP2' }, '2026-12-01');
  assert.equal(rep2.changedCells, 1);
  assert.equal(rep2.skipped.length, 1);
  assert.equal(rep2.skipped[0].row, 3);
  await assert.rejects(async () => importProgress(db, session, await readXlsx(writeXlsx({ A: [['x', 'y'], [1, 2]] })), { editor: '검사', batchId: 'X' }, '2026-12-01'), /칸을 찾지 못했어요/);
  raw.close();
});

test('열 때 변화 알림: 지난번 본 뒤 완료 예정 변화 · 새 업데이트 · 다른 사람이 고친 횟수, 바뀐 게 없으면 없음', async () => {
  const { outlookNow, noticeSince } = await import('../core/notice.ts');
  const { raw, db, session, edit } = open();
  const seen = { at: new Date(Date.now() - 1000).toISOString(), updates: outlookNow(db, session) };
  assert.equal(noticeSince(db, seen, outlookNow(db, session), '나'), null);
  // 다른 사람이 런칭 이펙트(FX가 병목)를 늘리고 업데이트를 하나 만든다
  applyEdit(db, session, { kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'VFX', field: 'target_qty', value: 40 }, { editor: '김아트', batchId: 'K1' });
  applyEdit(db, session, { kind: 'createUpdate', name: '시즌 3', typeId: 'SEASON', startDate: '2027-09-01', freezeDate: null, releaseDate: '2027-12-10' }, { editor: '김아트', batchId: 'K2' });
  const n = noticeSince(db, seen, outlookNow(db, session), '나');
  // 계산이 막힌 상태(최저 > 목표)면 비교하지 않는다
  applyEdit(db, session, { kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'min_qty', value: 99 }, { editor: '김아트', batchId: 'K3' });
  assert.equal(outlookNow(db, session), null);
  raw.close();
  assert.ok(n);
  const launch = n.changed.find(c => c.updateId === 'LAUNCH');
  assert.ok(launch && launch.deltaDays > 0, JSON.stringify(n.changed));
  assert.deepEqual(n.added, ['시즌 3']);
  assert.equal(n.editsByOthers, 2);
  assert.deepEqual(n.editors, ['김아트']);
});

test('실적 엑셀: "완료일"은 기준일로, "완료 수량"이 수량으로(전체 점검에서 찾음) · 영어·밑줄 머리글', async () => {
  const { importProgress } = await import('../core/progress-io.ts');
  const { writeXlsx } = await import('../core/xlsx-write.ts');
  const { readXlsx } = await import('../core/xlsx.ts');
  const { raw, db, session } = open();
  const ko = await readXlsx(writeXlsx({ A: [['업데이트', '리소스', '파트', '완료일', '완료 수량'], ['런칭', '신규 캐릭터', '원화', 46000, 5]] }));
  const r1 = importProgress(db, session, ko, { editor: '검사', batchId: 'K' }, '2026-12-01');
  assert.equal(r1.changedCells, 1, JSON.stringify(r1));
  const row = db.get("SELECT completed_qty, as_of FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW' AND part_id = 'CONCEPT'");
  assert.equal(row.completed_qty, 5);
  assert.equal(row.as_of, '2025-12-09');
  const en = await readXlsx(writeXlsx({ A: [['UPDATE_ID', 'RESOURCE_ID', 'PART_ID', 'department', 'COMPLETED_QTY', 'UPDATED_AT'], ['LAUNCH', 'CHAR_NEW', 'CONCEPT', '아트', 6, '2026-12-02']] }));
  importProgress(db, session, en, { editor: '검사', batchId: 'E' }, '2026-12-01');
  assert.equal(db.get("SELECT completed_qty FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW' AND part_id = 'CONCEPT'").completed_qty, 6);
  raw.close();
});
