// 리소스별 파이프라인(docs/28) · 공수 옮기기 · 지우기 · 순서 한 번에(docs/27)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession, calculate, validate } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { undoBatch } from '../core/history.ts';
import { pipelinesList, partOrderFor } from '../core/pipelines.ts';
import { migrate } from '../core/migrate.ts';
import { assetsView } from '../core/assets.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-pipelines', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let k = 0;
const open = name => { const path = `${OUT}/${name}-copy${(k += 1)}.arp`; copyFileSync(samples[name], path); const db = nodeDb(openProjectFile(path)); return { db, session: new ProjectSession(db) }; };
let n = 0;
const ctx = () => ({ editor: '검사', batchId: `pl${(n += 1)}` });
const rows = (db, sql, p = []) => db.all(sql, p).map(r => ({ ...r }));
const stagesOf = (db, rt) => calculate(db, { planMode: 'TARGET' }).result.stages.filter(s => s.updateId === 'LAUNCH' && s.resourceTypeId === rt);

test('재현 해결: 배경 원화 · 배경 모델링 파이프라인으로 배경 맵을 옮기면 공수 · 재작업률 · 작업 진척이 따라가고, 한 번에 되돌린다', () => {
  const t = open('normal');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  const bgC = apply({ kind: 'createPart', name: '배경 원화' }).createdId;
  const bgM = apply({ kind: 'createPart', name: '배경 모델링' }).createdId;
  const pid = apply({ kind: 'createPipeline', name: '배경', partIds: [bgC, bgM] }).createdId;
  // 예시 파일은 "기본" 파이프라인(리소스들이 거치는 파트만). 새 파트는 파트 목록에만 생기고 기본에 들어가지 않는다(docs/29)
  const lists = pipelinesList(t.db).map(p => [p.name, p.steps.map(s => s.partId), p.resources]);
  assert.deepEqual(lists, [['기본', ['CONCEPT', 'MODELING', 'ANIMATION', 'FX'], 6], ['배경', [bgC, bgM], 0]]);
  assert.throws(() => apply({ kind: 'effort', resourceTypeId: 'BG_MAP', partId: bgC, profileId: 'BASE', days: 3 }), /파이프라인의 단계가 아닌/);
  // 진척이 있는 칸 비우기는 여전히 바로 하지 않는다(화면에서 옮기기 · 지우기 창)
  assert.throws(() => apply({ kind: 'effort', resourceTypeId: 'BG_MAP', partId: 'CONCEPT', profileId: 'BASE', days: null }), /옮기기/);
  // 새 파이프라인에 없는 파트를 정하지 않으면 거절
  assert.throws(() => apply({ kind: 'resourcePipeline', resourceTypeIds: ['BG_MAP'], pipelineId: pid }), /새 파이프라인에 없습니다/);
  const c = ctx();
  apply({ kind: 'resourcePipeline', resourceTypeIds: ['BG_MAP'], pipelineId: pid, moves: [{ fromPartId: 'CONCEPT', toPartId: bgC }, { fromPartId: 'MODELING', toPartId: bgM }] }, c);
  assert.deepEqual(rows(t.db, "SELECT part_id, profile_id, days FROM efforts WHERE resource_type_id = 'BG_MAP' ORDER BY part_id, profile_id"),
    [{ part_id: bgC, profile_id: 'AI', days: 5 }, { part_id: bgC, profile_id: 'BASE', days: 8 }, { part_id: bgM, profile_id: 'AI', days: 12 }, { part_id: bgM, profile_id: 'BASE', days: 15 }]);
  assert.deepEqual(rows(t.db, "SELECT part_id, rework_rate FROM resource_parts WHERE resource_type_id = 'BG_MAP' ORDER BY part_id").map(r => r.part_id), [bgC, bgM]);
  assert.deepEqual(rows(t.db, "SELECT part_id, completed_qty, as_of FROM progress WHERE resource_type_id = 'BG_MAP'"), [{ part_id: bgC, completed_qty: 1, as_of: '2026-11-04' }]);
  assert.equal(t.db.get("SELECT pipeline_id FROM resource_types WHERE resource_type_id = 'BG_MAP'").pipeline_id, pid);
  // 엔진: 배경 맵은 배경 원화 → 배경 모델링
  assert.deepEqual(stagesOf(t.db, 'BG_MAP').map(s => [s.partId, s.predecessorPartId]), [[bgC, null], [bgM, bgC]]);
  // 파이프라인 밖 파트에는 공수를 넣지 못한다
  assert.throws(() => apply({ kind: 'effort', resourceTypeId: 'BG_MAP', partId: 'FX', profileId: 'BASE', days: 1 }), /파이프라인의 단계가 아닌/);
  // 쓰는 단계는 뺄 수 없다 · 쓰는 파이프라인은 지울 수 없다
  assert.throws(() => apply({ kind: 'pipelineSteps', pipelineId: pid, partIds: [bgC] }), /배경 맵.*뺄 수 없습니다/);
  assert.throws(() => apply({ kind: 'deletePipeline', pipelineId: pid }), /1종/);
  // 한 번에 되돌리기: 원래 원화 · 모델링, 진척도 원화로
  undoBatch(t.db, t.session, c.batchId, ctx());
  assert.deepEqual(rows(t.db, "SELECT part_id FROM resource_parts WHERE resource_type_id = 'BG_MAP' ORDER BY part_id").map(r => r.part_id), ['CONCEPT', 'MODELING']);
  assert.deepEqual(rows(t.db, "SELECT part_id, completed_qty FROM progress WHERE resource_type_id = 'BG_MAP'"), [{ part_id: 'CONCEPT', completed_qty: 1 }]);
  assert.equal(t.db.get("SELECT pipeline_id FROM resource_types WHERE resource_type_id = 'BG_MAP'").pipeline_id, 'L00', '기본 파이프라인으로 돌아온다');
  assert.ok(!validate(t.db).some(f => f.level === 'ERROR'));
});

test('같은 파트를 다른 순서로: 프랍만 모델링 → 원화, 단계 겹침률이 파트 쌍보다 먼저', () => {
  const t = open('normal');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  const before = stagesOf(t.db, 'BG_MAP').map(s => s.partId);
  const pid = apply({ kind: 'createPipeline', name: '역순', partIds: ['MODELING', 'CONCEPT'] }).createdId;
  apply({ kind: 'resourcePipeline', resourceTypeIds: ['PROP'], pipelineId: pid });
  apply({ kind: 'stepOverlap', pipelineId: pid, partId: 'CONCEPT', rate: 0.5 });
  const prop = stagesOf(t.db, 'PROP');
  assert.deepEqual(prop.map(s => [s.partId, s.predecessorPartId]), [['MODELING', null], ['CONCEPT', 'MODELING']]);
  assert.deepEqual([prop[1].overlapRate, prop[1].overlapSource], [0.5, 'STEP']);
  assert.deepEqual(stagesOf(t.db, 'BG_MAP').map(s => s.partId), before, '다른 리소스는 그대로(기본 파이프라인)');
  apply({ kind: 'stepOverlap', pipelineId: pid, partId: 'CONCEPT', rate: null });
  assert.equal(stagesOf(t.db, 'PROP')[1].overlapSource, 'DEFAULT', '비우면 파트 쌍(모델링 > 원화 없음) → 기본');
  assert.deepEqual(partOrderFor(t.db)('PROP').slice(0, 2), ['MODELING', 'CONCEPT']);
});

test('에셋이 있는 리소스: 옮기면 에셋 상태 · 자동 집계도 새 파트로, 지우기는 기록까지, 되돌리기', () => {
  const t = open('assets');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  const np = apply({ kind: 'createPart', name: '컨셉' }).createdId;
  // 새 파트는 파이프라인에 넣어야 옮길 수 있다(docs/29)
  assert.throws(() => apply({ kind: 'moveResourcePart', resourceTypeIds: ['CHAR_NEW'], fromPartId: 'CONCEPT', toPartId: np }), /단계가 아닙니다/);
  const base = pipelinesList(t.db).find(p => p.name === '기본');
  apply({ kind: 'pipelineSteps', pipelineId: base.pipelineId, partIds: [np, ...base.steps.map(s => s.partId)] });
  const doneBefore = Number(t.db.get("SELECT count(*) AS n FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id WHERE a.resource_type_id = 'CHAR_NEW' AND ap.part_id = 'CONCEPT'").n);
  const c = ctx();
  apply({ kind: 'moveResourcePart', resourceTypeIds: ['CHAR_NEW'], fromPartId: 'CONCEPT', toPartId: np }, c);
  assert.equal(Number(t.db.get("SELECT count(*) AS n FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id WHERE a.resource_type_id = 'CHAR_NEW' AND ap.part_id = ?", [np]).n), doneBefore);
  assert.equal(t.db.get("SELECT completed_qty FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW' AND part_id = ?", [np]).completed_qty, 3, '자동 집계(완료 3)');
  assert.equal(t.db.get("SELECT count(*) AS n FROM progress WHERE resource_type_id = 'CHAR_NEW' AND part_id = 'CONCEPT'").n, 0);
  const a = assetsView(t.db, 'LAUNCH').assets.find(x => x.assetId === 'A00001');
  assert.equal(a.parts[np].status, 'DONE');
  undoBatch(t.db, t.session, c.batchId, ctx());
  assert.equal(assetsView(t.db, 'LAUNCH').assets.find(x => x.assetId === 'A00001').parts.CONCEPT.status, 'DONE');
  // 지우기: 공수 · 진척 · 에셋 상태까지
  const d = ctx();
  apply({ kind: 'dropResourcePart', resourceTypeIds: ['COSTUME'], partId: 'ANIMATION' }, d);
  assert.equal(t.db.get("SELECT count(*) AS n FROM resource_parts WHERE resource_type_id = 'COSTUME' AND part_id = 'ANIMATION'").n, 0);
  undoBatch(t.db, t.session, d.batchId, ctx());
  assert.equal(t.db.get("SELECT count(*) AS n FROM resource_parts WHERE resource_type_id = 'COSTUME' AND part_id = 'ANIMATION'").n, 1);
});

test('순서 한 번에: 파트 표 · 배치 · 업데이트 우선순위(이력 한 묶음)', () => {
  const t = open('assets');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  const c = ctx();
  apply({ kind: 'reorderParts', partIds: ['FX', 'CONCEPT', 'MODELING', 'ANIMATION'] }, c);
  assert.deepEqual(rows(t.db, 'SELECT part_id FROM parts ORDER BY sort_order').map(r => r.part_id), ['FX', 'CONCEPT', 'MODELING', 'ANIMATION']);
  assert.equal(new Set(rows(t.db, 'SELECT batch_id FROM change_log WHERE batch_id = ?', [c.batchId]).map(r => r.batch_id)).size, 1);
  assert.throws(() => apply({ kind: 'reorderParts', partIds: ['FX', 'CONCEPT'] }), /순서 목록/);
  undoBatch(t.db, t.session, c.batchId, ctx());
  assert.deepEqual(rows(t.db, 'SELECT part_id FROM parts ORDER BY sort_order').map(r => r.part_id), ['CONCEPT', 'MODELING', 'ANIMATION', 'FX']);
  apply({ kind: 'reorderBatches', batchIds: ['B002', 'B001'] });
  assert.deepEqual(rows(t.db, "SELECT batch_id FROM batches WHERE update_id = 'LAUNCH' ORDER BY sort_order").map(r => r.batch_id), ['B002', 'B001']);
  const live = rows(t.db, "SELECT update_id FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS') ORDER BY priority").map(r => r.update_id);
  apply({ kind: 'reorderPriority', updateIds: [...live].reverse() });
  assert.deepEqual(rows(t.db, "SELECT update_id FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS') ORDER BY priority").map(r => r.update_id), [...live].reverse());
  // 파트 쌍 겹침률
  apply({ kind: 'overlapPair', fromPartId: 'MODELING', toPartId: 'FX', rate: 0.4 });
  assert.equal(t.db.get("SELECT overlap_rate FROM part_overlaps WHERE from_part_id = 'MODELING' AND to_part_id = 'FX'").overlap_rate, 0.4);
  apply({ kind: 'overlapPair', fromPartId: 'MODELING', toPartId: 'FX', rate: null });
  assert.equal(t.db.get("SELECT count(*) AS n FROM part_overlaps WHERE from_part_id = 'MODELING' AND to_part_id = 'FX'").n, 0);
});

test('파일 구조 v11: 파이프라인이 없던 리소스는 "기본"(그 리소스들이 거치는 파트만, 파트 표 순서), 아무도 안 거치는 새 파트는 빠지고 계산은 그대로(docs/29)', () => {
  const t = open('normal');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  const loose = apply({ kind: 'createPart', name: '배경 원화' }).createdId;
  // v10처럼 되돌리기: 파이프라인 없음 · 리소스 파이프라인 비움
  t.db.exec("DELETE FROM pipeline_steps; DELETE FROM pipelines; UPDATE resource_types SET pipeline_id = NULL; PRAGMA user_version = 10;");
  const before = calculate(t.db, { planMode: 'TARGET' }).result.stages.map(s => [s.updateId, s.resourceTypeId, s.partId, s.predecessorPartId, s.overlapRate, s.end]);
  assert.ok(validate(t.db).some(f => f.code === 'E10'), '파이프라인 없는 리소스는 주의');
  const r = migrate(t.db);
  assert.deepEqual([r.from, r.to], [10, 11]);
  const lists = pipelinesList(t.db);
  assert.deepEqual(lists.map(p => [p.pipelineId, p.name, p.steps.map(s => s.partId), p.steps.every(s => s.overlap == null)]), [['L00', '기본', ['CONCEPT', 'MODELING', 'ANIMATION', 'FX'], true]]);
  assert.ok(!lists[0].steps.some(s => s.partId === loose), '아무도 거치지 않는 새 파트는 넣지 않는다');
  assert.equal(Number(t.db.get('SELECT count(*) AS n FROM resource_types WHERE pipeline_id IS NULL').n), 0);
  const after = calculate(t.db, { planMode: 'TARGET' }).result.stages.map(s => [s.updateId, s.resourceTypeId, s.partId, s.predecessorPartId, s.overlapRate, s.end]);
  assert.deepEqual(after, before, '계산 결과 그대로');
  assert.ok(!validate(t.db).some(f => f.code === 'E10'));
  // 새 리소스는 첫 파이프라인 · 고른 파이프라인
  const rid = apply({ kind: 'createResource', name: '탈것', groupName: '오브젝트' }).createdId;
  assert.equal(t.db.get('SELECT pipeline_id FROM resource_types WHERE resource_type_id = ?', [rid]).pipeline_id, 'L00');
  const pid = apply({ kind: 'createPipeline', name: '배경', partIds: [loose] }).createdId;
  const rid2 = apply({ kind: 'createResource', name: '배경 소품', groupName: '배경', pipelineId: pid }).createdId;
  assert.equal(t.db.get('SELECT pipeline_id FROM resource_types WHERE resource_type_id = ?', [rid2]).pipeline_id, pid);
});

test('파이프라인 이름은 20자까지(리소스 표 칸에 다 보이게)', () => {
  const t = open('normal');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  assert.throws(() => apply({ kind: 'createPipeline', name: '가'.repeat(21) }), /20자 이하/);
  const pid = apply({ kind: 'createPipeline', name: '가'.repeat(20) }).createdId;
  assert.throws(() => apply({ kind: 'renamePipeline', pipelineId: pid, name: '나'.repeat(21) }), /20자 이하/);
  apply({ kind: 'renamePipeline', pipelineId: pid, name: '캐릭터 제작' });
  assert.equal(t.db.get('SELECT name FROM pipelines WHERE pipeline_id = ?', [pid]).name, '캐릭터 제작');
});
