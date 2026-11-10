// 리소스별 파이프라인(docs/28-resource-pipelines.md) · 공수를 다른 파트로 옮기기 · 지우기 · 순서 한 번에 바꾸기(docs/27).
// 모든 고치기는 변경 이력에 남고, 한 동작은 한 묶음이라 한 번에 되돌린다.
import type { SqlDb } from './db.ts';
import type { ProjectSession } from './pipeline.ts';
import type { EditContext, EditResult } from './edits.ts';
import { log, nextId, fail } from './edits.ts';
import { syncProgress, assetDriven } from './assets.ts';
import { PIPELINE_NAME_MAX } from './limits.ts';

export type PipelineEdit =
  | { kind: 'createPipeline'; name: string; partIds?: string[] }
  | { kind: 'renamePipeline'; pipelineId: string; name: string }
  | { kind: 'deletePipeline'; pipelineId: string }
  /** 단계 전체(순서대로). 더하기 · 빼기 · 끌어서 순서 바꾸기 모두 이것 하나로 */
  | { kind: 'pipelineSteps'; pipelineId: string; partIds: string[] }
  /** 단계 겹침률(앞 단계와). null = 파트 쌍 → 기본 */
  | { kind: 'stepOverlap'; pipelineId: string; partId: string; rate: number | null }
  /** 리소스 파이프라인 고르기(null = 파트 표 순서). 새 파이프라인에 없는 파트의 공수는 moves대로 옮기거나 지운다 */
  | { kind: 'resourcePipeline'; resourceTypeIds: string[]; pipelineId: string | null; moves?: { fromPartId: string; toPartId: string | null }[] }
  /** 공수 · 재작업률 · 작업 진척 · 에셋 상태를 다른 파트로 */
  | { kind: 'moveResourcePart'; resourceTypeIds: string[]; fromPartId: string; toPartId: string }
  /** 그 파트를 거치지 않게: 공수 · 작업 진척 · 에셋 상태까지 지운다 */
  | { kind: 'dropResourcePart'; resourceTypeIds: string[]; partId: string }
  /** 파트 표 순서(표시 · 파이프라인을 고르지 않은 리소스의 공정 순서) */
  | { kind: 'reorderParts'; partIds: string[] }
  | { kind: 'reorderBatches'; batchIds: string[] }
  | { kind: 'reorderPriority'; updateIds: string[] }
  /** 파트 쌍 겹침률(파이프라인을 고르지 않은 리소스 · 단계 겹침률이 빈 곳). null = 기본 */
  | { kind: 'overlapPair'; fromPartId: string; toPartId: string; rate: number | null };

export const PIPELINE_EDIT_KINDS = new Set<string>([
  'createPipeline', 'renamePipeline', 'deletePipeline', 'pipelineSteps', 'stepOverlap', 'resourcePipeline',
  'moveResourcePart', 'dropResourcePart', 'reorderParts', 'reorderBatches', 'reorderPriority', 'overlapPair',
]);

export interface PipelineInfo { pipelineId: string; name: string; steps: { partId: string; overlap: number | null }[]; resources: number }

export function pipelinesList(db: SqlDb): PipelineInfo[] {
  const steps = db.all('SELECT * FROM pipeline_steps ORDER BY pipeline_id, seq');
  const used = new Map(db.all('SELECT pipeline_id, count(*) AS n FROM resource_types WHERE pipeline_id IS NOT NULL GROUP BY pipeline_id').map(r => [String(r.pipeline_id), Number(r.n)]));
  return db.all('SELECT * FROM pipelines ORDER BY sort_order, pipeline_id').map(p => ({
    pipelineId: String(p.pipeline_id), name: String(p.name), resources: used.get(String(p.pipeline_id)) ?? 0,
    steps: steps.filter(s => s.pipeline_id === p.pipeline_id).map(s => ({ partId: String(s.part_id), overlap: s.overlap_rate == null ? null : Number(s.overlap_rate) })),
  }));
}

/**
 * 리소스마다 공정 순서(엔진과 같은 규칙): 고른 파이프라인이 있으면 그 단계 순서 + 단계에 없는 파트는 뒤에(파트 표 순서),
 * 없으면 파트 표 순서. 사용 중인 파트만.
 */
export function partOrderFor(db: SqlDb): (resourceTypeId: string) => string[] {
  const parts = db.all('SELECT part_id FROM parts WHERE active = 1 ORDER BY sort_order').map(r => String(r.part_id));
  const pipe = new Map(db.all('SELECT resource_type_id, pipeline_id FROM resource_types').map(r => [String(r.resource_type_id), (r.pipeline_id as string) ?? null]));
  const seq = new Map(db.all('SELECT pipeline_id, part_id, seq FROM pipeline_steps').map(r => [`${r.pipeline_id}|${r.part_id}`, Number(r.seq)]));
  const cache = new Map<string, string[]>();
  return (rt: string) => {
    const p = pipe.get(rt) ?? null;
    const key = p ?? '';
    if (cache.has(key)) return cache.get(key)!;
    const order = !p ? parts : parts.map((id, i) => ({ id, pos: seq.get(`${p}|${id}`) ?? 1e6 + i })).sort((a, b) => a.pos - b.pos).map(x => x.id);
    cache.set(key, order);
    return order;
  };
}

/** 리소스의 파이프라인 단계(고른 파이프라인이 없으면 null = 모든 파트 허용) */
export function allowedParts(db: SqlDb, resourceTypeId: string): Set<string> | null {
  const rt = db.get('SELECT pipeline_id FROM resource_types WHERE resource_type_id = ?', [resourceTypeId]);
  if (!rt?.pipeline_id || !db.get('SELECT 1 AS ok FROM pipelines WHERE pipeline_id = ?', [rt.pipeline_id])) return null;
  return new Set(db.all('SELECT part_id FROM pipeline_steps WHERE pipeline_id = ?', [rt.pipeline_id]).map(r => String(r.part_id)));
}

const name = (db: SqlDb, table: 'parts' | 'resource_types', id: string) =>
  String(db.get(`SELECT name FROM ${table} WHERE ${table === 'parts' ? 'part_id' : 'resource_type_id'} = ?`, [id])?.name ?? id);

/** 공수를 다른 파트로: 공수(기본 · AI) · 재작업률 · 작업 진척 · 에셋 상태. 받는 쪽에 이미 있으면 공수는 받는 쪽 값을 두고, 진척은 더한다 */
function moveOne(db: SqlDb, session: ProjectSession, ctx: EditContext, rt: string, from: string, to: string): { skippedAssets: number } {
  const src = db.get('SELECT * FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [rt, from]);
  if (!src) fail(`${name(db, 'resource_types', rt)}은(는) ${name(db, 'parts', from)}을(를) 거치지 않습니다.`);
  const allowed = allowedParts(db, rt);
  if (allowed && !allowed.has(to)) fail(`${name(db, 'parts', to)}은(는) ${name(db, 'resource_types', rt)} 파이프라인의 단계가 아닙니다.`);
  if (from === to) return { skippedAssets: 0 };
  // 1. 받는 파트를 거치게(재작업률은 옮겨 온 값)
  if (!db.get('SELECT 1 AS ok FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [rt, to])) {
    const row = { resource_type_id: rt, part_id: to, rework_rate: Number(src!.rework_rate) };
    db.run('INSERT INTO resource_parts (resource_type_id, part_id, rework_rate) VALUES (?, ?, ?)', [rt, to, row.rework_rate]);
    log(db, ctx, 'INSERT', 'resource_parts', `${rt}|${to}`, null, undefined, row);
  }
  // 2. 공수(받는 쪽에 없는 프로필만)
  for (const e of db.all('SELECT * FROM efforts WHERE resource_type_id = ? AND part_id = ?', [rt, from])) {
    if (!db.get('SELECT 1 AS ok FROM efforts WHERE resource_type_id = ? AND part_id = ? AND profile_id = ?', [rt, to, e.profile_id])) {
      const row = { resource_type_id: rt, part_id: to, profile_id: e.profile_id, days: e.days };
      db.run('INSERT INTO efforts (resource_type_id, part_id, profile_id, days) VALUES (?, ?, ?, ?)', [rt, to, e.profile_id, e.days]);
      log(db, ctx, 'INSERT', 'efforts', `${rt}|${to}|${e.profile_id}`, null, undefined, row);
    }
    db.run('DELETE FROM efforts WHERE resource_type_id = ? AND part_id = ? AND profile_id = ?', [rt, from, e.profile_id]);
    log(db, ctx, 'DELETE', 'efforts', `${rt}|${from}|${e.profile_id}`, null, e, undefined);
  }
  // 3. 에셋 상태(받는 파트에 이미 상태가 있는 에셋은 건너뛴다)
  let skippedAssets = 0;
  const pairs = new Set<string>();
  for (const ap of db.all('SELECT ap.* , a.update_id FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id WHERE a.resource_type_id = ? AND ap.part_id = ?', [rt, from])) {
    pairs.add(String(ap.update_id));
    const { update_id: _u, ...row } = ap;
    if (db.get('SELECT 1 AS ok FROM asset_parts WHERE asset_id = ? AND part_id = ?', [ap.asset_id, to])) { skippedAssets += 1; continue; }
    const next: Record<string, unknown> = { ...row, part_id: to };
    db.run('INSERT INTO asset_parts (asset_id, part_id, status, started_at, done_at, retakes, assignee, jira_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [next.asset_id, to, next.status, next.started_at, next.done_at, next.retakes, next.assignee, next.jira_key]);
    log(db, ctx, 'INSERT', 'asset_parts', `${ap.asset_id}|${to}`, null, undefined, next);
    db.run('DELETE FROM asset_parts WHERE asset_id = ? AND part_id = ?', [ap.asset_id, from]);
    log(db, ctx, 'DELETE', 'asset_parts', `${ap.asset_id}|${from}`, null, row, undefined);
  }
  // 4. 작업 진척(받는 쪽에 있으면 완료 · 실투입을 더하고 기준일은 늦은 날)
  for (const p of db.all('SELECT * FROM progress WHERE resource_type_id = ? AND part_id = ?', [rt, from])) {
    const tgt = db.get('SELECT * FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', [p.update_id, rt, to]);
    const tkey = `${p.update_id}|${rt}|${to}`;
    if (!tgt) {
      const row = { ...p, part_id: to };
      db.run('INSERT INTO progress (update_id, resource_type_id, part_id, completed_qty, as_of, spent_days) VALUES (?, ?, ?, ?, ?, ?)', [p.update_id, rt, to, p.completed_qty, p.as_of, p.spent_days]);
      log(db, ctx, 'INSERT', 'progress', tkey, null, undefined, row);
    } else {
      const set = (field: string, value: unknown) => {
        if (tgt[field] === value) return;
        db.run(`UPDATE progress SET ${field} = ? WHERE update_id = ? AND resource_type_id = ? AND part_id = ?`, [value, p.update_id, rt, to]);
        log(db, ctx, 'UPDATE', 'progress', tkey, field, tgt[field] ?? null, value);
      };
      set('completed_qty', Number(tgt.completed_qty) + Number(p.completed_qty));
      if (p.spent_days != null) set('spent_days', Number(tgt.spent_days ?? 0) + Number(p.spent_days));
      const later = [tgt.as_of, p.as_of].filter(Boolean).sort().pop() ?? null;
      set('as_of', later);
    }
    db.run('DELETE FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', [p.update_id, rt, from]);
    log(db, ctx, 'DELETE', 'progress', `${p.update_id}|${rt}|${from}`, null, p, undefined);
    pairs.add(String(p.update_id));
  }
  // 5. 보내는 파트를 거치지 않게
  db.run('DELETE FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [rt, from]);
  log(db, ctx, 'DELETE', 'resource_parts', `${rt}|${from}`, null, src, undefined);
  for (const u of pairs) if (assetDriven(db, u, rt)) syncProgress(db, ctx, u, rt);
  session.markDirty('resource_parts', 'efforts', 'progress');
  return { skippedAssets };
}

/** 그 파트를 거치지 않게: 공수 · 작업 진척 · 에셋 상태 · 거치는 파트를 지운다 */
function dropOne(db: SqlDb, session: ProjectSession, ctx: EditContext, rt: string, part: string): void {
  const src = db.get('SELECT * FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [rt, part]);
  if (!src) return;
  for (const e of db.all('SELECT * FROM efforts WHERE resource_type_id = ? AND part_id = ?', [rt, part])) {
    db.run('DELETE FROM efforts WHERE resource_type_id = ? AND part_id = ? AND profile_id = ?', [rt, part, e.profile_id]);
    log(db, ctx, 'DELETE', 'efforts', `${rt}|${part}|${e.profile_id}`, null, e, undefined);
  }
  for (const ap of db.all('SELECT ap.* FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id WHERE a.resource_type_id = ? AND ap.part_id = ?', [rt, part])) {
    db.run('DELETE FROM asset_parts WHERE asset_id = ? AND part_id = ?', [ap.asset_id, part]);
    log(db, ctx, 'DELETE', 'asset_parts', `${ap.asset_id}|${part}`, null, ap, undefined);
  }
  for (const p of db.all('SELECT * FROM progress WHERE resource_type_id = ? AND part_id = ?', [rt, part])) {
    db.run('DELETE FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', [p.update_id, rt, part]);
    log(db, ctx, 'DELETE', 'progress', `${p.update_id}|${rt}|${part}`, null, p, undefined);
  }
  db.run('DELETE FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [rt, part]);
  log(db, ctx, 'DELETE', 'resource_parts', `${rt}|${part}`, null, src, undefined);
  session.markDirty('resource_parts', 'efforts', 'progress');
}

/** 순서 다시 매기기: ids 순서대로 1..n(바뀐 행만 이력) */
function renumber(db: SqlDb, ctx: EditContext, table: string, idCol: string, orderCol: string, ids: string[], all: string[]): boolean {
  if (new Set(ids).size !== ids.length || ids.length !== all.length || ids.some(id => !all.includes(id))) fail('순서 목록이 맞지 않습니다. 화면을 새로 고치십시오.');
  let changed = false;
  ids.forEach((id, i) => {
    const old = Number(db.get(`SELECT ${orderCol} AS o FROM ${table} WHERE ${idCol} = ?`, [id])?.o);
    if (old === i + 1) return;
    db.run(`UPDATE ${table} SET ${orderCol} = ? WHERE ${idCol} = ?`, [i + 1, id]);
    log(db, ctx, 'UPDATE', table, id, orderCol, old, i + 1);
    changed = true;
  });
  return changed;
}

export function applyPipelineEdit(db: SqlDb, session: ProjectSession, edit: PipelineEdit, ctx: EditContext): EditResult {
  const dirty = (...t: Parameters<ProjectSession['markDirty']>) => session.markDirty(...t);
  switch (edit.kind) {
    case 'createPipeline': {
      const nm = edit.name.trim();
      if (!nm) fail('파이프라인 이름을 입력하십시오.');
      if (nm.length > PIPELINE_NAME_MAX) fail(`파이프라인 이름은 ${PIPELINE_NAME_MAX}자 이하입니다.`);
      if (db.get('SELECT 1 AS ok FROM pipelines WHERE name = ?', [nm])) fail('같은 이름의 파이프라인이 있습니다.');
      const id = nextId(db, 'pipelines', 'pipeline_id', 'L', 2);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM pipelines')?.s ?? 0) + 1;
      const row = { pipeline_id: id, name: nm, sort_order: sortOrder };
      db.run('INSERT INTO pipelines (pipeline_id, name, sort_order) VALUES (?, ?, ?)', [id, nm, sortOrder]);
      log(db, ctx, 'INSERT', 'pipelines', id, null, undefined, row);
      if (edit.partIds?.length) applyPipelineEdit(db, session, { kind: 'pipelineSteps', pipelineId: id, partIds: edit.partIds }, ctx);
      return { changed: true, createdId: id };
    }
    case 'renamePipeline': {
      const old = db.get('SELECT * FROM pipelines WHERE pipeline_id = ?', [edit.pipelineId]) ?? fail('없는 파이프라인입니다.');
      const nm = edit.name.trim();
      if (!nm) fail('파이프라인 이름은 비울 수 없습니다.');
      if (nm.length > PIPELINE_NAME_MAX) fail(`파이프라인 이름은 ${PIPELINE_NAME_MAX}자 이하입니다.`);
      if (old.name === nm) return { changed: false };
      if (db.get('SELECT 1 AS ok FROM pipelines WHERE name = ? AND pipeline_id <> ?', [nm, edit.pipelineId])) fail('같은 이름의 파이프라인이 있습니다.');
      db.run('UPDATE pipelines SET name = ? WHERE pipeline_id = ?', [nm, edit.pipelineId]);
      log(db, ctx, 'UPDATE', 'pipelines', edit.pipelineId, 'name', old.name, nm);
      return { changed: true };
    }
    case 'deletePipeline': {
      const old = db.get('SELECT * FROM pipelines WHERE pipeline_id = ?', [edit.pipelineId]);
      if (!old) return { changed: false };
      const n = Number(db.get('SELECT count(*) AS n FROM resource_types WHERE pipeline_id = ?', [edit.pipelineId])?.n ?? 0);
      if (n) fail(`이 파이프라인을 쓰는 리소스가 ${n}종 있습니다. 리소스의 파이프라인을 먼저 바꾸십시오.`);
      const steps = db.all('SELECT * FROM pipeline_steps WHERE pipeline_id = ?', [edit.pipelineId]);
      db.run('DELETE FROM pipelines WHERE pipeline_id = ?', [edit.pipelineId]);
      log(db, ctx, 'DELETE', 'pipelines', edit.pipelineId, null, { ...old, pipeline_steps: steps }, undefined);
      dirty('pipeline_steps');
      return { changed: true };
    }
    case 'pipelineSteps': {
      if (!db.get('SELECT 1 AS ok FROM pipelines WHERE pipeline_id = ?', [edit.pipelineId])) fail('없는 파이프라인입니다.');
      const ids = edit.partIds;
      if (new Set(ids).size !== ids.length) fail('같은 파트를 두 번 넣을 수 없습니다.');
      for (const p of ids) if (!db.get('SELECT 1 AS ok FROM parts WHERE part_id = ?', [p])) fail('없는 파트입니다.');
      const before = db.all('SELECT * FROM pipeline_steps WHERE pipeline_id = ? ORDER BY seq', [edit.pipelineId]);
      // 빠지는 단계를 거치는 리소스가 있으면 먼저 옮기게
      for (const s of before.filter(b => !ids.includes(String(b.part_id)))) {
        const users = db.all('SELECT r.name FROM resource_types r JOIN resource_parts rp ON rp.resource_type_id = r.resource_type_id AND rp.part_id = ? WHERE r.pipeline_id = ?', [s.part_id, edit.pipelineId]).map(r => String(r.name));
        if (users.length) fail(`${users.join(', ')}이(가) ${name(db, 'parts', String(s.part_id))}에 공수가 있어 이 단계를 뺄 수 없습니다. 리소스 · 공수 표에서 그 칸을 다른 파트로 옮기거나 비우십시오.`);
      }
      let changed = false;
      for (const s of before) {
        if (ids.includes(String(s.part_id))) continue;
        db.run('DELETE FROM pipeline_steps WHERE pipeline_id = ? AND part_id = ?', [edit.pipelineId, s.part_id]);
        log(db, ctx, 'DELETE', 'pipeline_steps', `${edit.pipelineId}|${s.part_id}`, null, s, undefined);
        changed = true;
      }
      ids.forEach((p, i) => {
        const cur = before.find(b => b.part_id === p);
        if (!cur) {
          const row = { pipeline_id: edit.pipelineId, part_id: p, seq: i + 1, overlap_rate: null };
          db.run('INSERT INTO pipeline_steps (pipeline_id, part_id, seq, overlap_rate) VALUES (?, ?, ?, NULL)', [edit.pipelineId, p, i + 1]);
          log(db, ctx, 'INSERT', 'pipeline_steps', `${edit.pipelineId}|${p}`, null, undefined, row);
          changed = true;
        } else if (Number(cur.seq) !== i + 1) {
          db.run('UPDATE pipeline_steps SET seq = ? WHERE pipeline_id = ? AND part_id = ?', [i + 1, edit.pipelineId, p]);
          log(db, ctx, 'UPDATE', 'pipeline_steps', `${edit.pipelineId}|${p}`, 'seq', Number(cur.seq), i + 1);
          changed = true;
        }
      });
      if (changed) dirty('pipeline_steps');
      return { changed };
    }
    case 'stepOverlap': {
      const cur = db.get('SELECT * FROM pipeline_steps WHERE pipeline_id = ? AND part_id = ?', [edit.pipelineId, edit.partId]) ?? fail('파이프라인 단계가 아닙니다.');
      if (edit.rate != null && !(edit.rate >= 0 && edit.rate <= 1)) fail('겹침률은 0 ~ 100%입니다.');
      const old = cur.overlap_rate == null ? null : Number(cur.overlap_rate);
      if (old === edit.rate) return { changed: false };
      db.run('UPDATE pipeline_steps SET overlap_rate = ? WHERE pipeline_id = ? AND part_id = ?', [edit.rate, edit.pipelineId, edit.partId]);
      log(db, ctx, 'UPDATE', 'pipeline_steps', `${edit.pipelineId}|${edit.partId}`, 'overlap_rate', old, edit.rate);
      dirty('pipeline_steps');
      return { changed: true };
    }
    case 'resourcePipeline': {
      const pid = edit.pipelineId;
      if (pid && !db.get('SELECT 1 AS ok FROM pipelines WHERE pipeline_id = ?', [pid])) fail('없는 파이프라인입니다.');
      const steps = pid ? new Set(db.all('SELECT part_id FROM pipeline_steps WHERE pipeline_id = ?', [pid]).map(r => String(r.part_id))) : null;
      if (steps && steps.size === 0) fail('단계가 없는 파이프라인입니다. 먼저 단계를 더하십시오.');
      let changed = false;
      for (const rt of edit.resourceTypeIds) {
        const r = db.get('SELECT * FROM resource_types WHERE resource_type_id = ?', [rt]) ?? fail('없는 리소스입니다.');
        if (steps) {
          // 새 파이프라인에 없는 파트의 공수: moves대로 옮기거나 지운다. 정하지 않은 것이 있으면 거절
          const outside = db.all('SELECT part_id FROM resource_parts WHERE resource_type_id = ?', [rt]).map(x => String(x.part_id)).filter(p => !steps.has(p));
          for (const from of outside) {
            const m = edit.moves?.find(x => x.fromPartId === from);
            if (!m) fail(`${r.name}: ${name(db, 'parts', from)}은(는) 새 파이프라인에 없습니다. 옮길 파트를 고르거나 지우기를 고르십시오.`);
            if (m!.toPartId) {
              if (!steps.has(m!.toPartId)) fail(`${name(db, 'parts', m!.toPartId)}은(는) 새 파이프라인의 단계가 아닙니다.`);
              // 옮기기 전에 파이프라인을 먼저 바꿔야 받는 파트 검사가 맞다
            }
          }
        }
        const old = (r.pipeline_id as string) ?? null;
        if (old !== pid) {
          db.run('UPDATE resource_types SET pipeline_id = ? WHERE resource_type_id = ?', [pid, rt]);
          log(db, ctx, 'UPDATE', 'resource_types', rt, 'pipeline_id', old, pid);
          dirty('resource_types');
          changed = true;
        }
        if (steps) {
          for (const from of db.all('SELECT part_id FROM resource_parts WHERE resource_type_id = ?', [rt]).map(x => String(x.part_id)).filter(p => !steps.has(p))) {
            const m = edit.moves!.find(x => x.fromPartId === from)!;
            if (m.toPartId) moveOne(db, session, ctx, rt, from, m.toPartId); else dropOne(db, session, ctx, rt, from);
            changed = true;
          }
        }
      }
      return { changed };
    }
    case 'moveResourcePart': {
      let skipped = 0;
      for (const rt of edit.resourceTypeIds) skipped += moveOne(db, session, ctx, rt, edit.fromPartId, edit.toPartId).skippedAssets;
      return { changed: true, ...(skipped ? { note: `받는 파트에 이미 상태가 있는 에셋 ${skipped}개는 옮기지 않았습니다` } : {}) } as EditResult;
    }
    case 'dropResourcePart': {
      for (const rt of edit.resourceTypeIds) dropOne(db, session, ctx, rt, edit.partId);
      return { changed: true };
    }
    case 'reorderParts': {
      const all = db.all('SELECT part_id FROM parts').map(r => String(r.part_id));
      const changed = renumber(db, ctx, 'parts', 'part_id', 'sort_order', edit.partIds, all);
      if (changed) dirty('parts');
      return { changed };
    }
    case 'reorderBatches': {
      const first = db.get('SELECT update_id FROM batches WHERE batch_id = ?', [edit.batchIds[0] ?? '']) ?? fail('없는 배치입니다.');
      const all = db.all('SELECT batch_id FROM batches WHERE update_id = ?', [first.update_id]).map(r => String(r.batch_id));
      return { changed: renumber(db, ctx, 'batches', 'batch_id', 'sort_order', edit.batchIds, all) };
    }
    case 'reorderPriority': {
      const all = db.all("SELECT update_id FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS')").map(r => String(r.update_id));
      const changed = renumber(db, ctx, 'updates', 'update_id', 'priority', edit.updateIds, all);
      if (changed) dirty('updates');
      return { changed };
    }
    case 'overlapPair': {
      if (edit.rate != null && !(edit.rate >= 0 && edit.rate <= 1)) fail('겹침률은 0 ~ 100%입니다.');
      const key = `${edit.fromPartId}|${edit.toPartId}`;
      const cur = db.get('SELECT * FROM part_overlaps WHERE from_part_id = ? AND to_part_id = ?', [edit.fromPartId, edit.toPartId]);
      if (edit.rate == null) {
        if (!cur) return { changed: false };
        db.run('DELETE FROM part_overlaps WHERE from_part_id = ? AND to_part_id = ?', [edit.fromPartId, edit.toPartId]);
        log(db, ctx, 'DELETE', 'part_overlaps', key, null, cur, undefined);
      } else if (!cur) {
        const row = { from_part_id: edit.fromPartId, to_part_id: edit.toPartId, overlap_rate: edit.rate };
        db.run('INSERT INTO part_overlaps (from_part_id, to_part_id, overlap_rate) VALUES (?, ?, ?)', [edit.fromPartId, edit.toPartId, edit.rate]);
        log(db, ctx, 'INSERT', 'part_overlaps', key, null, undefined, row);
      } else {
        if (Number(cur.overlap_rate) === edit.rate) return { changed: false };
        db.run('UPDATE part_overlaps SET overlap_rate = ? WHERE from_part_id = ? AND to_part_id = ?', [edit.rate, edit.fromPartId, edit.toPartId]);
        log(db, ctx, 'UPDATE', 'part_overlaps', key, 'overlap_rate', Number(cur.overlap_rate), edit.rate);
      }
      dirty('part_overlaps');
      return { changed: true };
    }
  }
}
