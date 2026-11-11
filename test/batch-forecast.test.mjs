// 배치별 완료 예측(docs/33): 에셋 표 → 배치 작업량 → 엔진. 세션 캐시가 에셋 · 배치 고치기와 되돌리기를 따라가는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession, calculate, readProjectData } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { undoBatch } from '../core/history.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-batch-forecast', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let k = 0;
const open = name => { const path = `${OUT}/${name}-copy${(k += 1)}.arp`; copyFileSync(samples[name], path); const db = nodeDb(openProjectFile(path)); return { db, session: new ProjectSession(db) }; };
let n = 0;
const ctx = () => ({ editor: '검사', batchId: `bf${(n += 1)}` });

test('배치 작업량: 배치에 든 에셋을 파트마다 남음 · 끝냄으로 센다(상태 행이 없으면 대기 = 남음)', () => {
  const t = open('assets');
  const data = readProjectData(t.db);
  assert.deepEqual(data.batches.map(b => [b.batch_id, b.name]), [['B001', '1차 납품'], ['B002', '2차 납품']]);
  const sum = (b, key) => data.batch_work.filter(w => w.batch_id === b).reduce((s, w) => s + w[key], 0);
  const assets = b => Number(t.db.get('SELECT count(*) AS n FROM assets a JOIN resource_parts rp ON rp.resource_type_id = a.resource_type_id WHERE a.batch_id = ?', [b]).n);
  for (const b of ['B001', 'B002']) assert.equal(sum(b, 'remaining_qty') + sum(b, 'done_qty'), assets(b), `${b}: 에셋 × 거치는 파트`);
  assert.deepEqual(readProjectData(open('normal').db).batch_work, [], '에셋이 없는 파일은 비어 있다');
});

test('세션: 배치 예측이 나오고, 에셋을 다른 배치로 옮기면 · 배치 순서를 바꾸면 · 되돌리면 바로 다시 계산된다', () => {
  const t = open('assets');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  const batches = () => t.session.calculate({ planMode: 'TARGET' }).result.batches;
  const b0 = batches();
  assert.deepEqual(b0.map(b => b.batchId), ['B001', 'B002']);
  assert.ok(b0.every(b => ['ON_TRACK', 'TIGHT', 'LATE', 'UNFINISHED', 'NO_DUE'].includes(b.status)));
  // 배치 결과는 세션 계산과 한 번 계산(calculate)이 같다
  assert.deepEqual(calculate(t.db, { planMode: 'TARGET' }).result.batches, b0);
  // 2차 에셋을 모두 1차로 옮기면 2차 배치 결과가 사라지고 1차가 늦어지거나 같다
  const two = t.db.all("SELECT asset_id FROM assets WHERE batch_id = 'B002'").map(r => String(r.asset_id));
  const c1 = ctx();
  apply({ kind: 'assetField', assetIds: two, field: 'batch_id', value: 'B001' }, c1);
  const b1 = batches();
  assert.deepEqual(b1.map(b => b.batchId), ['B001']);
  assert.ok(b1[0].expectedCompletionDate >= b0[0].expectedCompletionDate);
  undoBatch(t.db, t.session, c1.batchId, ctx());
  assert.deepEqual(batches(), b0, '되돌리면 처음과 같다');
  // 배치 순서를 바꾸면(2차 먼저) 2차가 더 빨리 끝난다
  apply({ kind: 'reorderBatches', batchIds: ['B002', 'B001'] });
  const b2 = batches();
  const at = (list, id) => list.find(b => b.batchId === id).expectedCompletionDate;
  assert.ok(at(b2, 'B002') <= at(b0, 'B002'), `${at(b2, 'B002')} <= ${at(b0, 'B002')}`);
  assert.deepEqual(b2.map(b => b.batchId), ['B002', 'B001'], '결과도 배치 순서대로');
});
