// 에셋 관리(docs/20-asset-management.md): 배치 · 에셋 · 파트별 상태 · 썸네일 · Jira 링크.
// 에셋이 있는 업데이트 × 리소스 종류는 작업 진척의 완료 수량을 에셋 상태에서 자동으로 센다(syncProgress).
// 모든 고치기는 변경 이력에 남고 되돌릴 수 있다(썸네일 이미지는 이력에 넣지 않는다).
import type { SqlDb } from './db.ts';
import type { ProjectSession } from './pipeline.ts';
import type { PlanMode } from '../engine/types.ts';
import type { EditContext, EditResult } from './edits.ts';
import { log, nextId, DATE, fail } from './edits.ts';
import { peopleList } from './people.ts';
import { partOrderFor, pipelinesList } from './pipelines.ts';

export type AssetStatus = 'TODO' | 'WIP' | 'REVIEW' | 'RETAKE' | 'DONE' | 'HOLD' | 'OMIT';
export const ASSET_STATUSES: AssetStatus[] = ['TODO', 'WIP', 'REVIEW', 'RETAKE', 'DONE', 'HOLD', 'OMIT'];
export const STATUS_LABEL: Record<AssetStatus, string> = {
  TODO: '대기', WIP: '진행', REVIEW: '검수 요청', RETAKE: '수정', DONE: '완료', HOLD: '보류', OMIT: '해당 없음',
};
/** 완료 수량에 세는 상태(해당 없음 = 그 파트를 거치지 않으니 공수 0으로 끝난 것) */
export const COUNTS_AS_DONE = new Set<AssetStatus>(['DONE', 'OMIT']);
export type Tier = PlanMode;
const TIERS = new Set<string>(['MIN', 'TARGET', 'STRETCH']);
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
/** code = 리소스명(파일 이름 규칙), category = 세부 분류(예: 코스튬 · 상의) */
export type AssetField = 'name' | 'code' | 'category' | 'tier' | 'batch_id' | 'jira_key' | 'note' | 'due_date';
/** 칸반 열(제작 단계): 대기 · 파트 ID · 완료 */
export type Stage = 'TODO' | 'DONE' | string;
export type BatchField = 'name' | 'due_date' | 'note';

export type AssetEdit =
  | { kind: 'createBatch'; updateId: string; name: string; dueDate: string | null }
  | { kind: 'batchField'; batchId: string; field: BatchField; value: string | null }
  | { kind: 'moveBatch'; batchId: string; direction: -1 | 1 }
  | { kind: 'deleteBatch'; batchId: string }
  | { kind: 'createAssets'; updateId: string; resourceTypeId: string; names: string[]; batchId?: string | null; tier?: Tier }
  | { kind: 'assetField'; assetIds: string[]; field: AssetField; value: string | null }
  | { kind: 'deleteAssets'; assetIds: string[] }
  | { kind: 'assetPart'; assetIds: string[]; partId: string; status?: AssetStatus; doneAt?: string | null; assignee?: string | null; jiraKey?: string | null }
  | { kind: 'assetThumb'; assetId: string; data: Uint8Array | null; mime?: string; width?: number; height?: number }
  | { kind: 'jiraBase'; url: string }
  /** 물량만큼 이름 미정 에셋 만들기(템플릿 구간별로 모자란 만큼). 손으로 넣은 완료 수량이 있으면 앞 에셋부터 완료로 옮긴다 */
  | { kind: 'fillAssets'; updateId: string; resourceTypeId: string }
  /** 물량을 등록 에셋 수에 맞추기: 최소안 = 최소안 에셋, 기본안 = 최소안 + 기본안, 최대안 = 전부 */
  | { kind: 'volumeFromAssets'; updateId: string; resourceTypeId: string }
  /** 칸반에서 단계 옮기기(16.2 규칙): 대기 · 파트 · 완료 */
  | { kind: 'moveStage'; assetIds: string[]; stage: Stage }
  /** 보드 열 안 순서: 이 순서대로 다시 매긴다 */
  | { kind: 'reorderAssets'; assetIds: string[] }
  | { kind: 'addLink'; assetId: string; title: string; url: string }
  | { kind: 'removeLink'; linkId: string }
  | { kind: 'addComment'; assetId: string; body: string }
  | { kind: 'removeComment'; commentId: string }
  /** 에셋 속성(이름 – 값). 값이 비면 지운다 */
  | { kind: 'assetAttr'; assetIds: string[]; name: string; value: string | null };

export const ASSET_EDIT_KINDS = new Set<string>([
  'createBatch', 'batchField', 'moveBatch', 'deleteBatch', 'createAssets', 'assetField', 'deleteAssets', 'assetPart', 'assetThumb', 'jiraBase', 'fillAssets', 'volumeFromAssets',
  'moveStage', 'reorderAssets', 'addLink', 'removeLink', 'addComment', 'removeComment', 'assetAttr',
]);

/**
 * 지금 제작 단계(docs/20-asset-management.md 20절). 파이프라인 = 모든 에셋이 같은 파트 순서(사용 중인 파트 전부).
 * 모두 완료 · 해당 없음이면 "완료", 아직 아무 파트도 시작하지 않았으면(대기 · 해당 없음뿐) "대기",
 * 아니면 앞에서부터 아직 끝나지 않은 첫 파트. statusOf(파트) = 그 파트 상태(행이 없으면 기본 상태)
 */
export function stageOf(steps: string[], statusOf: (partId: string) => AssetStatus): Stage {
  const open = steps.find(p => !COUNTS_AS_DONE.has(statusOf(p)));
  if (!open) return 'DONE';
  if (steps.every(p => statusOf(p) === 'TODO' || statusOf(p) === 'OMIT')) return 'TODO';
  return open;
}

/** 에셋 파트의 기본 상태(행이 없을 때): 리소스 종류가 거치는 파트는 대기, 아니면 해당 없음(언제든 대기로 켤 수 있다) */
export const defaultStatus = (passes: boolean): AssetStatus => (passes ? 'TODO' : 'OMIT');

/** 모든 에셋의 파이프라인(사용 중인 파트, 공정 순서)과 리소스 종류별 거치는 파트("리소스|파트") */
export function pipeline(db: SqlDb): { parts: string[]; passes: Set<string> } {
  return {
    parts: db.all('SELECT part_id FROM parts WHERE active = 1 ORDER BY sort_order').map(r => String(r.part_id)),
    passes: new Set(db.all('SELECT resource_type_id, part_id FROM resource_parts').map(r => `${r.resource_type_id}|${r.part_id}`)),
  };
}

/** 이 컴퓨터의 오늘(YYYY-MM-DD) */
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 업데이트 × 리소스 종류에 에셋이 있으면 작업 진척 완료 수량은 에셋에서 센다 */
export function assetDriven(db: SqlDb, updateId: string, resourceTypeId: string): boolean {
  return !!db.get('SELECT 1 AS ok FROM assets WHERE update_id = ? AND resource_type_id = ? LIMIT 1', [updateId, resourceTypeId]);
}

/** 리소스 종류가 거치는(사용 중인) 파트, 공정 순서 */
function stepsOf(db: SqlDb, resourceTypeId: string): string[] {
  return db.all(`SELECT rp.part_id FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id AND p.active = 1
      WHERE rp.resource_type_id = ? ORDER BY p.sort_order`, [resourceTypeId]).map(r => String(r.part_id));
}

/**
 * 에셋 상태 → 작업 진척(완료 수량 · 기준일). 파트마다 완료 · 해당 없음인 에셋 수, 기준일 = 그 파트 완료일 중 가장 늦은 날.
 * 실투입 인·일(spent_days)은 손으로 넣는 값이라 건드리지 않는다. 바뀐 칸은 같은 묶음으로 이력에 남는다(되돌리면 함께 돌아온다).
 */
export function syncProgress(db: SqlDb, ctx: EditContext, updateId: string, resourceTypeId: string): boolean {
  if (!assetDriven(db, updateId, resourceTypeId)) return false;
  let changed = false;
  for (const partId of stepsOf(db, resourceTypeId)) {
    const r = db.get(`SELECT count(*) AS n, max(CASE WHEN ap.status = 'DONE' THEN ap.done_at END) AS d
        FROM assets a JOIN asset_parts ap ON ap.asset_id = a.asset_id AND ap.part_id = ?
        WHERE a.update_id = ? AND a.resource_type_id = ? AND ap.status IN ('DONE', 'OMIT')`, [partId, updateId, resourceTypeId]);
    const n = Number(r?.n ?? 0);
    const asOf = r?.d == null ? null : String(r.d);
    const key = `${updateId}|${resourceTypeId}|${partId}`;
    const params = [updateId, resourceTypeId, partId];
    const before = db.get('SELECT * FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', params);
    if (!before) {
      if (n === 0) continue;
      const row = { update_id: updateId, resource_type_id: resourceTypeId, part_id: partId, completed_qty: n, as_of: asOf, spent_days: null };
      db.run('INSERT INTO progress (update_id, resource_type_id, part_id, completed_qty, as_of, spent_days) VALUES (?, ?, ?, ?, ?, NULL)', [...params, n, asOf]);
      log(db, ctx, 'INSERT', 'progress', key, null, undefined, row);
      changed = true;
    } else if (n === 0 && before.spent_days == null) {
      db.run('DELETE FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', params);
      log(db, ctx, 'DELETE', 'progress', key, null, before, undefined);
      changed = true;
    } else {
      if (Number(before.completed_qty) !== n) {
        db.run('UPDATE progress SET completed_qty = ? WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', [n, ...params]);
        log(db, ctx, 'UPDATE', 'progress', key, 'completed_qty', Number(before.completed_qty), n);
        changed = true;
      }
      const oldAsOf = before.as_of == null ? null : String(before.as_of);
      if (oldAsOf !== asOf) {
        db.run('UPDATE progress SET as_of = ? WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', [asOf, ...params]);
        log(db, ctx, 'UPDATE', 'progress', key, 'as_of', oldAsOf, asOf);
        changed = true;
      }
    }
  }
  return changed;
}

function assetRow(db: SqlDb, assetId: string): Record<string, unknown> {
  return db.get('SELECT * FROM assets WHERE asset_id = ?', [assetId]) ?? fail('없는 에셋입니다.');
}

function cleanText(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

/** 에셋 고치기 하나. 작업 진척이 바뀌면 계산 표를 다시 읽게 알린다 */
export function applyAssetEdit(db: SqlDb, session: ProjectSession, edit: AssetEdit, ctx: EditContext): EditResult {
  const pairs = new Set<string>(); // 작업 진척을 다시 셀 업데이트|리소스
  const touch = (updateId: unknown, rt: unknown) => pairs.add(`${updateId}|${rt}`);
  const finish = (result: EditResult): EditResult => {
    let progress = false;
    for (const p of pairs) {
      const [u, rt] = p.split('|');
      if (syncProgress(db, ctx, u, rt)) progress = true;
    }
    if (progress) session.markDirty('progress');
    return result;
  };

  switch (edit.kind) {
    // ───────── 배치 ─────────
    case 'createBatch': {
      const name = edit.name.trim();
      if (!name) fail('배치 이름을 입력하십시오.');
      if (!db.get('SELECT 1 AS ok FROM updates WHERE update_id = ?', [edit.updateId])) fail('없는 업데이트입니다.');
      if (edit.dueDate != null && !DATE.test(edit.dueDate)) fail('마감일 형식은 YYYY-MM-DD입니다.');
      if (db.get('SELECT 1 AS ok FROM batches WHERE update_id = ? AND name = ?', [edit.updateId, name])) fail('같은 이름의 배치가 있습니다.');
      const id = nextId(db, 'batches', 'batch_id', 'B', 3);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM batches WHERE update_id = ?', [edit.updateId])?.s ?? 0) + 1;
      const row = { batch_id: id, update_id: edit.updateId, name, due_date: edit.dueDate, sort_order: sortOrder, note: null };
      db.run('INSERT INTO batches (batch_id, update_id, name, due_date, sort_order, note) VALUES (?, ?, ?, ?, ?, ?)', Object.values(row));
      log(db, ctx, 'INSERT', 'batches', id, null, undefined, row);
      return { changed: true, createdId: id };
    }
    case 'batchField': {
      const before = db.get('SELECT * FROM batches WHERE batch_id = ?', [edit.batchId]) ?? fail('없는 배치입니다.');
      let value = edit.field === 'due_date' ? edit.value : cleanText(edit.value);
      if (edit.field === 'name') {
        if (!value) fail('배치 이름은 비울 수 없습니다.');
        if (db.get('SELECT 1 AS ok FROM batches WHERE update_id = ? AND name = ? AND batch_id <> ?', [before.update_id, value, edit.batchId])) fail('같은 이름의 배치가 있습니다.');
      }
      if (edit.field === 'due_date') { value = value || null; if (value != null && !DATE.test(value)) fail('마감일 형식은 YYYY-MM-DD입니다.'); }
      const old = before[edit.field] == null ? null : String(before[edit.field]);
      if (old === value) return { changed: false };
      db.run(`UPDATE batches SET ${edit.field} = ? WHERE batch_id = ?`, [value, edit.batchId]);
      log(db, ctx, 'UPDATE', 'batches', edit.batchId, edit.field, old, value);
      return { changed: true };
    }
    case 'moveBatch': {
      const b = db.get('SELECT * FROM batches WHERE batch_id = ?', [edit.batchId]) ?? fail('없는 배치입니다.');
      const list = db.all('SELECT batch_id, sort_order FROM batches WHERE update_id = ? ORDER BY sort_order, batch_id', [b.update_id]);
      const i = list.findIndex(x => x.batch_id === edit.batchId);
      const j = i + edit.direction;
      if (j < 0 || j >= list.length) return { changed: false };
      // 순서를 1부터 다시 매기고 둘을 맞바꾼다
      const order = list.map(x => String(x.batch_id));
      [order[i], order[j]] = [order[j], order[i]];
      order.forEach((id, k) => {
        const old = Number(list.find(x => x.batch_id === id)!.sort_order);
        if (old === k + 1) return;
        db.run('UPDATE batches SET sort_order = ? WHERE batch_id = ?', [k + 1, id]);
        log(db, ctx, 'UPDATE', 'batches', id, 'sort_order', old, k + 1);
      });
      return { changed: true };
    }
    case 'deleteBatch': {
      const old = db.get('SELECT * FROM batches WHERE batch_id = ?', [edit.batchId]);
      if (!old) return { changed: false };
      // 그 배치의 에셋은 미배정으로(지우지 않는다)
      for (const a of db.all('SELECT asset_id FROM assets WHERE batch_id = ?', [edit.batchId])) {
        db.run('UPDATE assets SET batch_id = NULL WHERE asset_id = ?', [a.asset_id]);
        log(db, ctx, 'UPDATE', 'assets', String(a.asset_id), 'batch_id', edit.batchId, null);
      }
      db.run('DELETE FROM batches WHERE batch_id = ?', [edit.batchId]);
      log(db, ctx, 'DELETE', 'batches', edit.batchId, null, old, undefined);
      return { changed: true };
    }

    // ───────── 에셋 ─────────
    case 'createAssets': {
      const names = edit.names.map(n => n.trim()).filter(Boolean);
      if (!names.length) fail('에셋 이름을 입력하십시오.');
      if (!db.get('SELECT 1 AS ok FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId])) {
        fail('그 업데이트의 물량에 없는 리소스입니다. 먼저 물량에 리소스를 추가하십시오.');
      }
      const tier = edit.tier ?? 'TARGET';
      if (!TIERS.has(tier)) fail('포함 템플릿이 올바르지 않습니다.');
      if (edit.batchId && !db.get('SELECT 1 AS ok FROM batches WHERE batch_id = ? AND update_id = ?', [edit.batchId, edit.updateId])) fail('그 업데이트의 배치가 아닙니다.');
      let sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM assets WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId])?.s ?? 0);
      const now = new Date().toISOString();
      let firstId: string | undefined;
      for (const name of names) {
        const id = nextId(db, 'assets', 'asset_id', 'A', 5);
        firstId ??= id;
        sortOrder += 1;
        const row = { asset_id: id, update_id: edit.updateId, batch_id: edit.batchId ?? null, resource_type_id: edit.resourceTypeId, name, code: null, tier, jira_key: null, note: null, sort_order: sortOrder, created_at: now };
        db.run(`INSERT INTO assets (asset_id, update_id, batch_id, resource_type_id, name, code, tier, jira_key, note, sort_order, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, Object.values(row));
        log(db, ctx, 'INSERT', 'assets', id, null, undefined, row);
      }
      touch(edit.updateId, edit.resourceTypeId);
      return finish({ changed: true, createdId: firstId });
    }
    case 'assetField': {
      if (!edit.assetIds.length) return { changed: false };
      let changed = false;
      for (const assetId of edit.assetIds) {
        const a = assetRow(db, assetId);
        let value: string | null = edit.value;
        if (edit.field === 'name') { value = cleanText(value); if (!value) fail('에셋 이름은 비울 수 없습니다.'); }
        else if (edit.field === 'tier') { if (!TIERS.has(value ?? '')) fail('포함 템플릿이 올바르지 않습니다.'); }
        else if (edit.field === 'batch_id') {
          value = value || null;
          if (value && !db.get('SELECT 1 AS ok FROM batches WHERE batch_id = ? AND update_id = ?', [value, a.update_id])) fail('그 에셋의 업데이트에 없는 배치입니다.');
        } else if (edit.field === 'jira_key') {
          value = cleanText(value)?.toUpperCase() ?? null;
          if (value && !JIRA_KEY.test(value)) fail('Jira 키 형식은 ABC-123입니다.');
        } else if (edit.field === 'due_date') {
          value = value || null;
          if (value != null && !DATE.test(value)) fail('마감일 형식은 YYYY-MM-DD입니다.');
        } else if (edit.field === 'note') {
          value = (value ?? '').replace(/\s+$/, '') || null; // 설명은 여러 줄 그대로
        } else value = cleanText(value);
        const old = a[edit.field] == null ? null : String(a[edit.field]);
        if (old === value) continue;
        db.run(`UPDATE assets SET ${edit.field} = ? WHERE asset_id = ?`, [value, assetId]);
        log(db, ctx, 'UPDATE', 'assets', assetId, edit.field, old, value);
        changed = true;
      }
      return { changed };
    }
    case 'deleteAssets': {
      let changed = false;
      for (const assetId of edit.assetIds) {
        const a = db.get('SELECT * FROM assets WHERE asset_id = ?', [assetId]);
        if (!a) continue;
        const parts = db.all('SELECT * FROM asset_parts WHERE asset_id = ?', [assetId]);
        const links = db.all('SELECT * FROM asset_links WHERE asset_id = ?', [assetId]);
        const comments = db.all('SELECT * FROM asset_comments WHERE asset_id = ?', [assetId]);
        const attrs = db.all('SELECT * FROM asset_attrs WHERE asset_id = ?', [assetId]);
        db.run('DELETE FROM asset_attrs WHERE asset_id = ?', [assetId]);
        db.run('DELETE FROM asset_parts WHERE asset_id = ?', [assetId]);
        db.run('DELETE FROM asset_links WHERE asset_id = ?', [assetId]);
        db.run('DELETE FROM asset_comments WHERE asset_id = ?', [assetId]);
        db.run('DELETE FROM asset_thumbs WHERE asset_id = ?', [assetId]);
        db.run('DELETE FROM assets WHERE asset_id = ?', [assetId]);
        // 상태 · 링크 · 댓글도 함께 남긴다(되돌리면 함께 돌아온다). 썸네일은 이력에 넣지 않아 돌아오지 않는다
        log(db, ctx, 'DELETE', 'assets', assetId, null, { ...a, asset_parts: parts, asset_links: links, asset_comments: comments, asset_attrs: attrs }, undefined);
        touch(a.update_id, a.resource_type_id);
        changed = true;
      }
      // 마지막 에셋을 지우면 그 줄은 손으로 넣는 작업 진척으로 돌아간다: 에셋에서 센 완료 수량을 0으로 정리
      for (const p of pairs) {
        const [u, rt] = p.split('|');
        if (!assetDriven(db, u, rt)) clearCounted(db, ctx, u, rt);
      }
      if (changed) session.markDirty('progress');
      return finish({ changed });
    }
    case 'assetPart': {
      if (!edit.assetIds.length) return { changed: false };
      if (edit.status !== undefined && !ASSET_STATUSES.includes(edit.status)) fail('상태가 올바르지 않습니다.');
      if (edit.doneAt != null && !DATE.test(edit.doneAt)) fail('완료일 형식은 YYYY-MM-DD입니다.');
      const jira = edit.jiraKey === undefined ? undefined : (cleanText(edit.jiraKey)?.toUpperCase() ?? null);
      if (jira && !JIRA_KEY.test(jira)) fail('Jira 키 형식은 ABC-123입니다.');
      const today = localToday();
      const pl = pipeline(db);
      if (!pl.parts.includes(edit.partId)) fail('사용하지 않는 파트입니다.');
      let changed = false;
      for (const assetId of edit.assetIds) {
        const a = assetRow(db, assetId);
        // 모든 에셋이 같은 파이프라인: 리소스 종류가 거치지 않는 파트도 해당 없음 ↔ 대기 · 진행 … 으로 바꿀 수 있다
        const base = defaultStatus(pl.passes.has(`${a.resource_type_id}|${edit.partId}`));
        const key = `${assetId}|${edit.partId}`;
        const before = db.get('SELECT * FROM asset_parts WHERE asset_id = ? AND part_id = ?', [assetId, edit.partId]);
        const cur = {
          status: (before?.status as AssetStatus | undefined) ?? base,
          started_at: (before?.started_at as string | null | undefined) ?? null,
          done_at: (before?.done_at as string | null | undefined) ?? null,
          retakes: Number(before?.retakes ?? 0),
          assignee: (before?.assignee as string | null | undefined) ?? null,
          jira_key: (before?.jira_key as string | null | undefined) ?? null,
        };
        const next = { ...cur };
        if (edit.status !== undefined && edit.status !== cur.status) {
          next.status = edit.status;
          if (edit.status === 'WIP' && !cur.started_at) next.started_at = today;
          if (edit.status === 'DONE') next.done_at = edit.doneAt ?? cur.done_at ?? today;
          else next.done_at = null;
          if (edit.status === 'RETAKE') next.retakes = cur.retakes + 1;
        } else if (edit.doneAt !== undefined && cur.status === 'DONE') {
          next.done_at = edit.doneAt ?? today;
        }
        if (edit.assignee !== undefined) next.assignee = cleanText(edit.assignee);
        if (jira !== undefined) next.jira_key = jira;
        const fields = (Object.keys(next) as (keyof typeof next)[]).filter(f => next[f] !== cur[f]);
        if (!fields.length) continue;
        // 기본 상태(거치는 파트는 대기, 아니면 해당 없음 · 다른 값 없음)면 행을 두지 않는다
        const isDefault = next.status === base && !next.started_at && !next.done_at && next.retakes === 0 && !next.assignee && !next.jira_key;
        if (!before) {
          if (isDefault) continue;
          const row = { asset_id: assetId, part_id: edit.partId, ...next };
          db.run(`INSERT INTO asset_parts (asset_id, part_id, status, started_at, done_at, retakes, assignee, jira_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [assetId, edit.partId, next.status, next.started_at, next.done_at, next.retakes, next.assignee, next.jira_key]);
          log(db, ctx, 'INSERT', 'asset_parts', key, null, undefined, row);
        } else if (isDefault) {
          db.run('DELETE FROM asset_parts WHERE asset_id = ? AND part_id = ?', [assetId, edit.partId]);
          log(db, ctx, 'DELETE', 'asset_parts', key, null, before, undefined);
        } else {
          for (const f of fields) {
            db.run(`UPDATE asset_parts SET ${f} = ? WHERE asset_id = ? AND part_id = ?`, [next[f], assetId, edit.partId]);
            log(db, ctx, 'UPDATE', 'asset_parts', key, f, cur[f], next[f]);
          }
        }
        touch(a.update_id, a.resource_type_id);
        changed = true;
      }
      return finish({ changed });
    }
    case 'assetThumb': {
      assetRow(db, edit.assetId);
      const had = !!db.get('SELECT 1 AS ok FROM asset_thumbs WHERE asset_id = ?', [edit.assetId]);
      if (edit.data == null) {
        if (!had) return { changed: false };
        db.run('DELETE FROM asset_thumbs WHERE asset_id = ?', [edit.assetId]);
      } else {
        if (edit.data.byteLength > 512 * 1024) fail('썸네일이 너무 큽니다(512KB 이하).');
        db.run(`INSERT INTO asset_thumbs (asset_id, mime, data, width, height, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (asset_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, width = excluded.width, height = excluded.height, updated_at = excluded.updated_at`,
          [edit.assetId, edit.mime ?? 'image/webp', edit.data, edit.width ?? null, edit.height ?? null, new Date().toISOString()]);
      }
      // 이미지 자체는 이력에 넣지 않는다(파일 크기). 바꾼 사실만 남기고, 되돌리기는 건너뛴다
      log(db, ctx, 'UPDATE', 'asset_thumbs', edit.assetId, 'image', had ? '있음' : null, edit.data == null ? null : '있음');
      return { changed: true };
    }
    case 'jiraBase': {
      let url = edit.url.trim();
      if (url && !/^https?:\/\/\S+$/.test(url)) fail('Jira 주소는 http(s)://로 시작합니다. 예: https://회사.atlassian.net/browse/');
      if (url && !url.endsWith('/')) url += '/';
      const before = db.get("SELECT value FROM meta WHERE key = 'jira_base_url'");
      const old = before?.value == null ? null : String(before.value);
      const value = url || null;
      if (old === value) return { changed: false };
      if (before) {
        db.run("UPDATE meta SET value = ? WHERE key = 'jira_base_url'", [value]);
        log(db, ctx, 'UPDATE', 'meta', 'jira_base_url', 'value', old, value);
      } else {
        db.run("INSERT INTO meta (key, value) VALUES ('jira_base_url', ?)", [value]);
        log(db, ctx, 'INSERT', 'meta', 'jira_base_url', null, undefined, { key: 'jira_base_url', value });
      }
      return { changed: true };
    }
    case 'fillAssets': {
      const v = db.get('SELECT * FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId]) ?? fail('그 업데이트의 물량에 없는 리소스입니다.');
      const wasDriven = assetDriven(db, edit.updateId, edit.resourceTypeId);
      // 손으로 넣은 완료 수량(에셋이 없을 때만 의미가 있다): 만든 에셋의 앞에서부터 완료로 옮긴다
      const manual = wasDriven ? [] : db.all('SELECT part_id, completed_qty, as_of FROM progress WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId]);
      const have = Object.fromEntries(['MIN', 'TARGET', 'STRETCH'].map(t => [t, Number(db.get('SELECT count(*) AS n FROM assets WHERE update_id = ? AND resource_type_id = ? AND tier = ?', [edit.updateId, edit.resourceTypeId, t])?.n ?? 0)]));
      const minQ = Number(v.min_qty ?? 0);
      const tgtQ = Math.max(minQ, Number(v.target_qty ?? 0));
      const strQ = Math.max(tgtQ, Number(v.stretch_qty ?? 0));
      const want: [Tier, number][] = [['MIN', minQ - have.MIN], ['TARGET', tgtQ - minQ - have.TARGET], ['STRETCH', strQ - tgtQ - have.STRETCH]];
      const rtName = String(db.get('SELECT name FROM resource_types WHERE resource_type_id = ?', [edit.resourceTypeId])?.name ?? '');
      let made = Number(db.get('SELECT count(*) AS n FROM assets WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId])?.n ?? 0);
      const created: string[] = [];
      for (const [tier, n] of want) {
        if (n <= 0) continue;
        const names = Array.from({ length: n }, () => `${rtName} 이름 미정 ${(made += 1)}`);
        const before = new Set(db.all('SELECT asset_id FROM assets').map(r => String(r.asset_id)));
        applyAssetEdit(db, session, { kind: 'createAssets', updateId: edit.updateId, resourceTypeId: edit.resourceTypeId, names, tier }, ctx);
        for (const r of db.all('SELECT asset_id FROM assets WHERE update_id = ? AND resource_type_id = ? ORDER BY sort_order', [edit.updateId, edit.resourceTypeId])) {
          if (!before.has(String(r.asset_id))) created.push(String(r.asset_id));
        }
      }
      if (!created.length) return { changed: false };
      for (const m of manual) {
        const k = Math.min(created.length, Number(m.completed_qty));
        if (k > 0) applyAssetEdit(db, session, { kind: 'assetPart', assetIds: created.slice(0, k), partId: String(m.part_id), status: 'DONE', doneAt: m.as_of == null ? null : String(m.as_of) }, ctx);
      }
      touch(edit.updateId, edit.resourceTypeId);
      return finish({ changed: true, createdId: created[0] });
    }
    case 'volumeFromAssets': {
      const v = db.get('SELECT * FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId]) ?? fail('그 업데이트의 물량에 없는 리소스입니다.');
      const c = (t: string) => Number(db.get('SELECT count(*) AS n FROM assets WHERE update_id = ? AND resource_type_id = ? AND tier = ?', [edit.updateId, edit.resourceTypeId, t])?.n ?? 0);
      const min = c('MIN');
      const next = { min_qty: min, target_qty: min + c('TARGET'), stretch_qty: min + c('TARGET') + c('STRETCH') };
      if (next.stretch_qty === 0) fail('등록된 에셋이 없습니다.');
      let changed = false;
      for (const f of ['min_qty', 'target_qty', 'stretch_qty'] as const) {
        const old = v[f] == null ? null : Number(v[f]);
        if (old === next[f]) continue;
        db.run(`UPDATE volumes SET ${f} = ? WHERE update_id = ? AND resource_type_id = ?`, [next[f], edit.updateId, edit.resourceTypeId]);
        log(db, ctx, 'UPDATE', 'volumes', `${edit.updateId}|${edit.resourceTypeId}`, f, old, next[f]);
        changed = true;
      }
      if (changed) session.markDirty('volumes');
      return { changed };
    }

    // ───────── 칸반 · 카드 ─────────
    case 'moveStage': {
      let changed = false;
      for (const assetId of edit.assetIds) {
        const a = assetRow(db, assetId);
        const pl = pipeline(db);
        const steps = partOrderFor(db)(String(a.resource_type_id)); // 그 리소스의 공정 순서(파이프라인)
        const status = new Map(db.all('SELECT part_id, status FROM asset_parts WHERE asset_id = ?', [assetId]).map(r => [String(r.part_id), r.status as AssetStatus]));
        const st = (p: string) => status.get(p) ?? defaultStatus(pl.passes.has(`${a.resource_type_id}|${p}`));
        const from = stageOf(steps, st);
        const to = edit.stage;
        if (to !== 'TODO' && to !== 'DONE' && !steps.includes(to)) fail('사용하지 않는 파트입니다.');
        if (from === to) continue;
        const set = (partId: string, s: AssetStatus) => {
          if (st(partId) === s) return;
          if (applyAssetEdit(db, session, { kind: 'assetPart', assetIds: [assetId], partId, status: s }, ctx).changed) changed = true;
        };
        const rank = (x: Stage) => (x === 'TODO' ? -1 : x === 'DONE' ? steps.length : steps.indexOf(x));
        if (to === 'TODO') { for (const p of steps) if (st(p) !== 'OMIT') set(p, 'TODO'); continue; }
        if (to === 'DONE') { for (const p of steps) if (st(p) !== 'OMIT') set(p, 'DONE'); continue; }
        const ti = steps.indexOf(to);
        if (rank(to) > rank(from)) {
          // 앞으로: 지나친 파트는 완료(해당 없음은 그대로), 옮긴 파트는 진행(이미 검수 요청 · 수정 · 보류면 그대로, 해당 없음이었으면 켜진다)
          steps.slice(0, ti).forEach(p => { if (!COUNTS_AS_DONE.has(st(p))) set(p, 'DONE'); });
          if (st(to) === 'TODO' || COUNTS_AS_DONE.has(st(to))) set(to, 'WIP');
        } else {
          // 뒤로: 옮긴 파트는 수정(리테이크), 그 뒤 파트는 대기(해당 없음은 그대로)
          set(to, 'RETAKE');
          steps.slice(ti + 1).forEach(p => { if (st(p) !== 'OMIT') set(p, 'TODO'); });
        }
      }
      return finish({ changed });
    }
    case 'reorderAssets': {
      let changed = false;
      edit.assetIds.forEach((assetId, i) => {
        const a = assetRow(db, assetId);
        const next = (i + 1) * 10;
        if (Number(a.sort_order) === next) return;
        db.run('UPDATE assets SET sort_order = ? WHERE asset_id = ?', [next, assetId]);
        log(db, ctx, 'UPDATE', 'assets', assetId, 'sort_order', Number(a.sort_order), next);
        changed = true;
      });
      return { changed };
    }
    case 'addLink': {
      assetRow(db, edit.assetId);
      const url = edit.url.trim();
      if (!/^https?:\/\/\S+$/.test(url)) fail('링크는 http(s)://로 시작하는 주소입니다.');
      const title = cleanText(edit.title) ?? url.replace(/^https?:\/\//, '').slice(0, 60);
      const id = nextId(db, 'asset_links', 'link_id', 'L', 5);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM asset_links WHERE asset_id = ?', [edit.assetId])?.s ?? 0) + 1;
      const row = { link_id: id, asset_id: edit.assetId, title, url, sort_order: sortOrder };
      db.run('INSERT INTO asset_links (link_id, asset_id, title, url, sort_order) VALUES (?, ?, ?, ?, ?)', Object.values(row));
      log(db, ctx, 'INSERT', 'asset_links', id, null, undefined, row);
      return { changed: true, createdId: id };
    }
    case 'removeLink': {
      const old = db.get('SELECT * FROM asset_links WHERE link_id = ?', [edit.linkId]);
      if (!old) return { changed: false };
      db.run('DELETE FROM asset_links WHERE link_id = ?', [edit.linkId]);
      log(db, ctx, 'DELETE', 'asset_links', edit.linkId, null, old, undefined);
      return { changed: true };
    }
    case 'addComment': {
      assetRow(db, edit.assetId);
      const body = edit.body.replace(/\s+$/, '').replace(/^\s+/, '');
      if (!body) fail('댓글 내용을 입력하십시오.');
      if (body.length > 4000) fail('댓글은 4천 자 이하입니다.');
      const id = nextId(db, 'asset_comments', 'comment_id', 'C', 6);
      const row = { comment_id: id, asset_id: edit.assetId, at: new Date().toISOString(), author: ctx.editor, body };
      db.run('INSERT INTO asset_comments (comment_id, asset_id, at, author, body) VALUES (?, ?, ?, ?, ?)', Object.values(row));
      log(db, ctx, 'INSERT', 'asset_comments', id, null, undefined, row);
      return { changed: true, createdId: id };
    }
    case 'removeComment': {
      const old = db.get('SELECT * FROM asset_comments WHERE comment_id = ?', [edit.commentId]);
      if (!old) return { changed: false };
      db.run('DELETE FROM asset_comments WHERE comment_id = ?', [edit.commentId]);
      log(db, ctx, 'DELETE', 'asset_comments', edit.commentId, null, old, undefined);
      return { changed: true };
    }
    case 'assetAttr': {
      const name = cleanText(edit.name);
      if (!name) fail('속성 이름을 입력하십시오.');
      if (name.includes('|')) fail('속성 이름에 "|"는 쓸 수 없습니다.');
      if (name.length > 40) fail('속성 이름은 40자 이하입니다.');
      const value = cleanText(edit.value);
      if (value && value.length > 500) fail('속성 값은 500자 이하입니다.');
      let changed = false;
      for (const assetId of edit.assetIds) {
        assetRow(db, assetId);
        const key = `${assetId}|${name}`;
        const before = db.get('SELECT * FROM asset_attrs WHERE asset_id = ? AND name = ?', [assetId, name]);
        if (!before) {
          if (value == null) continue;
          const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM asset_attrs WHERE asset_id = ?', [assetId])?.s ?? 0) + 1;
          const row = { asset_id: assetId, name, value, sort_order: sortOrder };
          db.run('INSERT INTO asset_attrs (asset_id, name, value, sort_order) VALUES (?, ?, ?, ?)', Object.values(row));
          log(db, ctx, 'INSERT', 'asset_attrs', key, null, undefined, row);
        } else if (value == null) {
          db.run('DELETE FROM asset_attrs WHERE asset_id = ? AND name = ?', [assetId, name]);
          log(db, ctx, 'DELETE', 'asset_attrs', key, null, before, undefined);
        } else if (String(before.value) !== value) {
          db.run('UPDATE asset_attrs SET value = ? WHERE asset_id = ? AND name = ?', [value, assetId, name]);
          log(db, ctx, 'UPDATE', 'asset_attrs', key, 'value', String(before.value), value);
        } else continue;
        changed = true;
      }
      return { changed };
    }
  }
}

// ───────── 카드 창: 링크 · 댓글 · 활동 ─────────
export interface AssetDetail {
  links: { linkId: string; title: string; url: string }[];
  comments: { commentId: string; at: string; author: string; body: string }[];
  /** 이 에셋의 변경 이력(최근 순) */
  activity: { at: string; editor: string; text: string }[];
}

const ACT_FIELD: Record<string, string> = {
  name: '이름', code: '리소스명', category: '세부 분류', tier: '포함 템플릿', batch_id: '배치', jira_key: 'Jira', note: '설명', due_date: '마감일', sort_order: '순서',
  status: '상태', done_at: '완료일', started_at: '시작일', retakes: '리테이크', assignee: '담당',
};

export function assetDetail(db: SqlDb, assetId: string): AssetDetail {
  const parts = new Map(db.all('SELECT part_id, name FROM parts').map(r => [String(r.part_id), String(r.name)]));
  const fmt = (field: string | null, v: unknown) => {
    if (v == null) return '없음';
    const x = JSON.parse(String(v));
    if (field === 'status' && typeof x === 'string') return STATUS_LABEL[x as AssetStatus] ?? x;
    return typeof x === 'object' ? '' : String(x);
  };
  const activity = db.all(`SELECT * FROM change_log WHERE (target = 'assets' AND target_key = ?) OR (target IN ('asset_parts', 'asset_attrs') AND target_key LIKE ?)
      OR (target IN ('asset_links', 'asset_comments', 'asset_thumbs') AND (target_key = ? OR new_json LIKE ? OR old_json LIKE ?))
      ORDER BY log_id DESC LIMIT 60`, [assetId, `${assetId}|%`, assetId, `%"asset_id":"${assetId}"%`, `%"asset_id":"${assetId}"%`]).map(r => {
    const target = String(r.target);
    const field = r.field == null ? null : String(r.field);
    const part = target === 'asset_parts' ? parts.get(String(r.target_key).split('|')[1]) ?? '' : '';
    let text: string;
    if (target === 'asset_thumbs') text = '썸네일을 바꿈';
    else if (target === 'asset_attrs') {
      const name = String(r.target_key).slice(assetId.length + 1);
      const val = (j: unknown) => (j == null ? '없음' : (() => { const x = JSON.parse(String(j)); return typeof x === 'object' && x ? String((x as { value?: unknown }).value ?? '') : String(x); })());
      text = `속성 ${name}: ${val(r.old_json)} → ${val(r.new_json)}`;
    }
    else if (target === 'asset_links') text = r.action === 'INSERT' ? '링크를 더함' : '링크를 지움';
    else if (target === 'asset_comments') text = r.action === 'INSERT' ? '댓글을 남김' : '댓글을 지움';
    else if (r.action === 'INSERT') text = target === 'assets' ? '에셋을 만듦' : `${part} 상태를 ${fmt('status', JSON.stringify((JSON.parse(String(r.new_json)) as { status: string }).status))}(으)로`;
    else if (r.action === 'DELETE') text = target === 'assets' ? '에셋을 지움' : `${part} 상태를 대기로`;
    else text = `${part ? `${part} ` : ''}${ACT_FIELD[field ?? ''] ?? field}: ${fmt(field, r.old_json)} → ${fmt(field, r.new_json)}`;
    return { at: String(r.at), editor: String(r.editor), text };
  });
  return {
    links: db.all('SELECT * FROM asset_links WHERE asset_id = ? ORDER BY sort_order, link_id', [assetId]).map(r => ({ linkId: String(r.link_id), title: String(r.title), url: String(r.url) })),
    comments: db.all('SELECT * FROM asset_comments WHERE asset_id = ? ORDER BY at DESC, comment_id DESC', [assetId]).map(r => ({ commentId: String(r.comment_id), at: String(r.at), author: String(r.author), body: String(r.body) })),
    activity,
  };
}

/** 에셋이 없어진 줄: 에셋에서 센 완료 수량을 지운다(실투입 인·일만 남는다) */
function clearCounted(db: SqlDb, ctx: EditContext, updateId: string, resourceTypeId: string) {
  for (const p of db.all('SELECT * FROM progress WHERE update_id = ? AND resource_type_id = ?', [updateId, resourceTypeId])) {
    const key = `${updateId}|${resourceTypeId}|${p.part_id}`;
    const params = [updateId, resourceTypeId, p.part_id];
    if (p.spent_days == null) {
      db.run('DELETE FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', params);
      log(db, ctx, 'DELETE', 'progress', key, null, p, undefined);
    } else if (Number(p.completed_qty) !== 0) {
      db.run('UPDATE progress SET completed_qty = 0 WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', params);
      log(db, ctx, 'UPDATE', 'progress', key, 'completed_qty', Number(p.completed_qty), 0);
    }
  }
}

// ───────── 보기 ─────────

export interface AssetPartState {
  status: AssetStatus; doneAt: string | null; startedAt: string | null; retakes: number; assignee: string | null; jiraKey: string | null;
  /** 리소스 종류가 거치는 파트(계획 공수 · 작업 진척 집계에 들어간다) */
  inPlan: boolean;
}
export interface AssetItem {
  assetId: string; name: string; code: string | null; category: string | null; resourceTypeId: string; batchId: string | null; tier: Tier;
  /** 속성(이름 – 값), 넣은 순서 */
  attrs: { name: string; value: string }[];
  jiraKey: string | null; note: string | null; thumbAt: string | null;
  /** 칸반 열: 대기 · 파트 ID · 완료 */
  stage: Stage;
  /** 지금 단계 파트의 상태(대기 · 완료 단계면 그 상태) */
  sub: AssetStatus;
  dueDate: string | null;
  /** 지금 단계 파트의 담당 */
  assignee: string | null;
  links: number; comments: number; sortOrder: number;
  parts: Record<string, AssetPartState>;
  /** 이 에셋의 공정 순서(리소스 파이프라인 → 나머지 파트) */
  order: string[];
  /** 리소스가 고른 파이프라인(없으면 null = 파트 표 순서) */
  pipelineId: string | null;
  /** 끝난 파트 공수 ÷ 거치는 파트 공수(기본 공수 기준) */
  progress: number;
  retakes: number;
}
export interface AssetResourceRow {
  resourceTypeId: string; name: string; steps: string[];
  volume: { min: number | null; target: number | null; stretch: number | null };
  registered: { MIN: number; TARGET: number; STRETCH: number; total: number };
  done: number;
  /** 에셋 없이 손으로 넣은 완료 수량이 있다(에셋을 만들면 에셋 상태로 다시 센다) */
  manualProgress: boolean;
}
export interface AssetGroup { groupId: string | null; name: string; resources: AssetResourceRow[]; total: number; done: number; progress: number }
export interface AssetsView {
  updates: { updateId: string; name: string; live: boolean }[];
  updateId: string | null;
  parts: { partId: string; name: string }[];
  groups: AssetGroup[];
  batches: { batchId: string; name: string; dueDate: string | null; sortOrder: number; note: string | null; count: number; done: number; progress: number }[];
  assets: AssetItem[];
  jiraBase: string | null;
  /** 담당 칸 제안: 참여 중인 작업자(이름 · 소속팀) */
  people: { name: string; team: string | null }[];
  /** 이름 붙인 파이프라인(보드 열 고르기) */
  pipelines: { pipelineId: string; name: string; steps: string[] }[];
  totals: { assets: number; done: number; progress: number; review: number; retake: number; hold: number };
}

export function assetsView(db: SqlDb, wanted: string | null): AssetsView {
  const updates = db.all(`SELECT update_id, name, status FROM updates
      ORDER BY CASE WHEN status IN ('PLANNED', 'IN_PROGRESS') THEN 0 ELSE 1 END, priority, sort_order`)
    .map(u => ({ updateId: String(u.update_id), name: String(u.name), live: u.status === 'PLANNED' || u.status === 'IN_PROGRESS' }));
  const updateId = updates.find(u => u.updateId === wanted)?.updateId ?? updates[0]?.updateId ?? null;
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(p => ({ partId: String(p.part_id), name: String(p.name) }));
  const jiraBase = db.get("SELECT value FROM meta WHERE key = 'jira_base_url'")?.value;
  const people = peopleList(db).filter(p => p.active).map(p => ({ name: p.name, team: p.team }));
  const pipelines = pipelinesList(db).map(p => ({ pipelineId: p.pipelineId, name: p.name, steps: p.steps.map(x => x.partId) }));
  const empty: AssetsView = { updates, updateId, parts, groups: [], batches: [], assets: [], jiraBase: jiraBase == null ? null : String(jiraBase), people, pipelines, totals: { assets: 0, done: 0, progress: 0, review: 0, retake: 0, hold: 0 } };
  if (!updateId) return empty;

  const partOrder = parts.map(p => p.partId);
  const orderFor = partOrderFor(db);
  const pipeOf = new Map(db.all('SELECT resource_type_id, pipeline_id FROM resource_types').map(r => [String(r.resource_type_id), (r.pipeline_id as string) ?? null]));
  const steps = new Map<string, string[]>();
  for (const r of db.all('SELECT rp.resource_type_id, rp.part_id FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id AND p.active = 1 ORDER BY p.sort_order')) {
    const k = String(r.resource_type_id);
    if (!steps.has(k)) steps.set(k, []);
    steps.get(k)!.push(String(r.part_id));
  }
  const days = new Map(db.all("SELECT resource_type_id, part_id, days FROM efforts WHERE profile_id = 'BASE'").map(r => [`${r.resource_type_id}|${r.part_id}`, Number(r.days)]));
  const partRows = new Map<string, Record<string, AssetPartState>>();
  for (const r of db.all('SELECT ap.* FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id WHERE a.update_id = ?', [updateId])) {
    const k = String(r.asset_id);
    if (!partRows.has(k)) partRows.set(k, {});
    partRows.get(k)![String(r.part_id)] = {
      status: r.status as AssetStatus, doneAt: (r.done_at as string) ?? null, startedAt: (r.started_at as string) ?? null,
      retakes: Number(r.retakes ?? 0), assignee: (r.assignee as string) ?? null, jiraKey: (r.jira_key as string) ?? null, inPlan: false,
    };
  }
  const thumbs = new Map(db.all('SELECT t.asset_id, t.updated_at FROM asset_thumbs t JOIN assets a ON a.asset_id = t.asset_id WHERE a.update_id = ?', [updateId]).map(r => [String(r.asset_id), String(r.updated_at)]));
  const countBy = (table: string) => new Map(db.all(`SELECT x.asset_id, count(*) AS n FROM ${table} x JOIN assets a ON a.asset_id = x.asset_id WHERE a.update_id = ? GROUP BY x.asset_id`, [updateId]).map(r => [String(r.asset_id), Number(r.n)]));
  const attrs = new Map<string, { name: string; value: string }[]>();
  for (const r of db.all('SELECT x.* FROM asset_attrs x JOIN assets a ON a.asset_id = x.asset_id WHERE a.update_id = ? ORDER BY x.asset_id, x.sort_order, x.name', [updateId])) {
    const k = String(r.asset_id);
    if (!attrs.has(k)) attrs.set(k, []);
    attrs.get(k)!.push({ name: String(r.name), value: String(r.value) });
  }
  const linkN = countBy('asset_links');
  const commentN = countBy('asset_comments');
  const passes = new Set(db.all('SELECT resource_type_id, part_id FROM resource_parts').map(r => `${r.resource_type_id}|${r.part_id}`));
  const blank = (inPlan: boolean): AssetPartState => ({ status: defaultStatus(inPlan), doneAt: null, startedAt: null, retakes: 0, assignee: null, jiraKey: null, inPlan });
  const assets: AssetItem[] = db.all(`SELECT a.* FROM assets a JOIN resource_types r ON r.resource_type_id = a.resource_type_id
      LEFT JOIN resource_groups g ON g.group_id = r.group_id LEFT JOIN batches b ON b.batch_id = a.batch_id
      WHERE a.update_id = ? ORDER BY a.sort_order, coalesce(g.sort_order, 999999), r.sort_order, a.asset_id`, [updateId]).map(a => {
    const id = String(a.asset_id);
    const rt = String(a.resource_type_id);
    const pr = partRows.get(id) ?? {};
    const partsState: Record<string, AssetPartState> = {};
    let total = 0; let done = 0; let retakes = 0;
    // 모든 에셋이 모든 파트를 가진다(해당 없음 ↔ 켜기). 순서는 그 리소스의 파이프라인(docs/28). 진행 = 끝낸 파트 공수 ÷ 할 파트 공수
    const ord = orderFor(rt);
    for (const p of ord) {
      const inPlan = passes.has(`${rt}|${p}`);
      const s = pr[p] ? { ...pr[p], inPlan } : blank(inPlan);
      partsState[p] = s;
      retakes += s.retakes;
      if (s.status === 'OMIT') continue;
      const d = days.get(`${rt}|${p}`) ?? 1;
      total += d;
      if (s.status === 'DONE') done += d;
    }
    const stage = stageOf(ord, p => partsState[p].status);
    const doing = ord.filter(p => partsState[p].status !== 'OMIT');
    const cur = stage === 'TODO' ? doing[0] : stage === 'DONE' ? doing[doing.length - 1] : stage;
    return {
      assetId: id, name: String(a.name), code: (a.code as string) ?? null, category: (a.category as string) ?? null, attrs: attrs.get(id) ?? [], resourceTypeId: rt, batchId: (a.batch_id as string) ?? null,
      tier: a.tier as Tier, jiraKey: (a.jira_key as string) ?? null, note: (a.note as string) ?? null, thumbAt: thumbs.get(id) ?? null,
      parts: partsState, order: ord, pipelineId: pipeOf.get(rt) ?? null, progress: total > 0 ? done / total : 1, retakes,
      stage, sub: stage === 'DONE' ? 'DONE' : stage === 'TODO' ? 'TODO' : partsState[stage].status,
      dueDate: (a.due_date as string) ?? null, assignee: cur ? (pr[cur]?.assignee ?? null) : null,
      links: linkN.get(id) ?? 0, comments: commentN.get(id) ?? 0, sortOrder: Number(a.sort_order),
    };
  });
  const isDone = (x: AssetItem) => Object.values(x.parts).length > 0 && Object.values(x.parts).every(s => COUNTS_AS_DONE.has(s.status));

  const manual = new Set(db.all('SELECT DISTINCT resource_type_id FROM progress WHERE update_id = ? AND completed_qty > 0', [updateId]).map(r => String(r.resource_type_id)));
  const groupMap = new Map<string, AssetGroup>();
  for (const v of db.all(`SELECT v.*, r.name, r.group_id, coalesce(g.name, '분류 없음') AS group_name FROM volumes v
      JOIN resource_types r ON r.resource_type_id = v.resource_type_id LEFT JOIN resource_groups g ON g.group_id = r.group_id
      WHERE v.update_id = ? ORDER BY coalesce(g.sort_order, 999999), r.sort_order`, [updateId])) {
    const gid = v.group_id == null ? null : String(v.group_id);
    const gk = gid ?? '_';
    if (!groupMap.has(gk)) groupMap.set(gk, { groupId: gid, name: String(v.group_name), resources: [], total: 0, done: 0, progress: 0 });
    const rt = String(v.resource_type_id);
    const mine = assets.filter(x => x.resourceTypeId === rt);
    const reg = { MIN: 0, TARGET: 0, STRETCH: 0, total: mine.length };
    for (const x of mine) reg[x.tier] += 1;
    groupMap.get(gk)!.resources.push({
      resourceTypeId: rt, name: String(v.name), steps: (steps.get(rt) ?? []).slice().sort((a, b) => orderFor(rt).indexOf(a) - orderFor(rt).indexOf(b)),
      volume: { min: v.min_qty == null ? null : Number(v.min_qty), target: v.target_qty == null ? null : Number(v.target_qty), stretch: v.stretch_qty == null ? null : Number(v.stretch_qty) },
      registered: reg, done: mine.filter(isDone).length, manualProgress: mine.length === 0 && manual.has(rt),
    });
  }
  const groups = [...groupMap.values()].map(g => {
    const mine = assets.filter(x => g.resources.some(r => r.resourceTypeId === x.resourceTypeId));
    return { ...g, total: mine.length, done: mine.filter(isDone).length, progress: mine.length ? mine.reduce((s, x) => s + x.progress, 0) / mine.length : 0 };
  });
  const batches = db.all('SELECT * FROM batches WHERE update_id = ? ORDER BY sort_order, batch_id', [updateId]).map(b => {
    const mine = assets.filter(x => x.batchId === b.batch_id);
    return {
      batchId: String(b.batch_id), name: String(b.name), dueDate: (b.due_date as string) ?? null, sortOrder: Number(b.sort_order), note: (b.note as string) ?? null,
      count: mine.length, done: mine.filter(isDone).length, progress: mine.length ? mine.reduce((s, x) => s + x.progress, 0) / mine.length : 0,
    };
  });
  const any = (st: AssetStatus) => assets.filter(x => Object.values(x.parts).some(s => s.status === st)).length;
  return {
    updates, updateId, parts, groups, batches, assets, jiraBase: jiraBase == null ? null : String(jiraBase), people, pipelines,
    totals: {
      assets: assets.length, done: assets.filter(isDone).length,
      progress: assets.length ? assets.reduce((s, x) => s + x.progress, 0) / assets.length : 0,
      review: any('REVIEW'), retake: any('RETAKE'), hold: any('HOLD'),
    },
  };
}

/** 썸네일 바이트(보이는 카드만 요청한다) */
export function assetThumbs(db: SqlDb, assetIds: string[]): { assetId: string; mime: string; data: Uint8Array; updatedAt: string }[] {
  if (!assetIds.length) return [];
  const out: { assetId: string; mime: string; data: Uint8Array; updatedAt: string }[] = [];
  for (let i = 0; i < assetIds.length; i += 200) {
    const chunk = assetIds.slice(i, i + 200);
    for (const r of db.all(`SELECT asset_id, mime, data, updated_at FROM asset_thumbs WHERE asset_id IN (${chunk.map(() => '?').join(', ')})`, chunk)) {
      out.push({ assetId: String(r.asset_id), mime: String(r.mime), data: r.data as Uint8Array, updatedAt: String(r.updated_at) });
    }
  }
  return out;
}
