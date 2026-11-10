// 모든 고치기: 업데이트·물량·유형·템플릿·인력·계획 기간. 값 검사 → 쓰기 → 변경 이력 → 바뀐 표 알리기.
// 값의 업무 규칙(최저 ≤ 목표 등)은 검증 규칙이 맡고, 여기서는 형식(정수, 날짜 모양, 범위가 정해진 값)만 막는다.
import type { SqlDb } from './db.ts';
import type { ProjectSession, EngineTable } from './pipeline.ts';
import type { PlanMode } from '../engine/types.ts';
import { PLAN_MODES, DEFAULT_MODE_NAMES, modeMetaKey, readModeNames } from './modes.ts';
import type { AssetEdit } from './assets.ts';
import { applyAssetEdit, ASSET_EDIT_KINDS, assetDriven } from './assets.ts';
import type { PeopleEdit } from './people.ts';
import { applyPeopleEdit, PEOPLE_EDIT_KINDS } from './people.ts';
import type { NewsEdit } from './news.ts';
import { applyNewsEdit, NEWS_EDIT_KINDS } from './news.ts';

export type QtyField = 'min_qty' | 'target_qty' | 'stretch_qty' | 'outsource_qty';
export type UpdateField = 'name' | 'update_type_id' | 'start_date' | 'freeze_date' | 'release_date' | 'status';
export type CapacityField = 'headcount' | 'utilization' | 'productivity' | 'outsource_days' | 'support_days';

export type Edit =
  // 업데이트
  | { kind: 'createUpdate'; name: string; typeId: string; startDate: string; freezeDate: string | null; releaseDate: string | null }
  | { kind: 'updateField'; updateId: string; field: UpdateField; value: string | null }
  | { kind: 'movePriority'; updateId: string; direction: -1 | 1 }
  | { kind: 'deleteUpdate'; updateId: string }
  // 물량
  | { kind: 'volume'; updateId: string; resourceTypeId: string; field: QtyField; value: number | null }
  | { kind: 'addResource'; updateId: string; resourceTypeId: string }
  | { kind: 'removeResource'; updateId: string; resourceTypeId: string }
  // 유형 · 템플릿
  | { kind: 'createType'; name: string }
  | { kind: 'renameType'; typeId: string; name: string }
  | { kind: 'deleteType'; typeId: string }
  | { kind: 'template'; typeId: string; resourceTypeId: string; field: 'min_qty' | 'target_qty' | 'stretch_qty'; value: number | null }
  | { kind: 'addTemplateResource'; typeId: string; resourceTypeId: string }
  | { kind: 'removeTemplateResource'; typeId: string; resourceTypeId: string }
  // 실적
  | { kind: 'progress'; updateId: string; resourceTypeId: string; partId: string; value: number | null; asOf: string | null }
  | { kind: 'progressSpent'; updateId: string; resourceTypeId: string; partId: string; value: number | null; asOf: string | null }
  | { kind: 'completeRow'; updateId: string; resourceTypeId: string; asOf: string | null }
  // 공수 보정: 그 리소스·파트의 모든 공수 판에 배율을 곱한다
  | { kind: 'effortScale'; resourceTypeId: string; partId: string; ratio: number }
  // 인력 · 계획 기간
  | { kind: 'capacity'; partId: string; month: string; field: CapacityField; value: number }
  | { kind: 'fillCapacity'; partId: string; fromMonth: string; toMonth: string; field: CapacityField; value: number }
  | { kind: 'horizon'; startMonth: string; endMonth: string }
  // 물량 템플릿(최소안·기본안·최대안): 이름 · 다른 템플릿에서 수량 복사
  | { kind: 'modeName'; mode: PlanMode; name: string }
  | { kind: 'copyQty'; updateId: string; from: 'min_qty' | 'target_qty' | 'stretch_qty'; to: 'min_qty' | 'target_qty' | 'stretch_qty' }
  // 프로젝트 기본 정보
  | { kind: 'projectName'; name: string }
  | { kind: 'setting'; field: 'buffer_rate' | 'work_weekdays'; value: number | string }
  | { kind: 'addHoliday'; date: string; name: string; holidayKind: 'PUBLIC' | 'COMPANY' }
  | { kind: 'removeHoliday'; date: string }
  // 파트
  | { kind: 'createPart'; name: string }
  | { kind: 'renamePart'; partId: string; name: string }
  | { kind: 'movePart'; partId: string; direction: -1 | 1 }
  | { kind: 'partActive'; partId: string; active: boolean }
  | { kind: 'deletePart'; partId: string }
  // 리소스 · 공수
  | { kind: 'createResource'; name: string; groupName: string }
  | { kind: 'renameResource'; resourceTypeId: string; name: string }
  | { kind: 'resourceGroup'; resourceTypeId: string; groupName: string }
  | { kind: 'renameGroup'; groupId: string; name: string }
  | { kind: 'resourceActive'; resourceTypeId: string; active: boolean }
  | { kind: 'deleteResource'; resourceTypeId: string }
  | { kind: 'effort'; resourceTypeId: string; partId: string; profileId: 'BASE' | 'AI'; days: number | null }
  | { kind: 'rework'; resourceTypeId: string; partId: string; rate: number }
  // AI 활용 비율(파트별): 공수 = 기본 × (1 − 비율) + AI 사용 시 × 비율
  | { kind: 'aiShare'; partId: string; share: number }
  // 에셋 관리(core/assets.ts)
  | AssetEdit
  | PeopleEdit
  | NewsEdit;

export interface EditContext { editor: string; batchId: string; reason?: string }
export interface EditResult { changed: boolean; createdId?: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 달력에 있는 날짜만(2027-02-30 같은 날은 거절) */
// 13월 · 32일처럼 Date가 만들 수 없는 값도 거절(toISOString이 예외를 내지 않게 먼저 본다)
export const DATE = { test: (d: string) => DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUSES = new Set(['PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED']);

export function fail(message: string): never { throw new Error(message); }

export function log(db: SqlDb, ctx: EditContext, action: string, target: string, key: string, field: string | null, oldValue: unknown, newValue: unknown) {
  db.run(`INSERT INTO change_log (batch_id, at, editor, action, target, target_key, field, old_json, new_json, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    ctx.batchId, new Date().toISOString(), ctx.editor, action, target, key, field,
    oldValue === undefined ? null : JSON.stringify(oldValue), newValue === undefined ? null : JSON.stringify(newValue), ctx.reason ?? null,
  ]);
}

export function nextId(db: SqlDb, table: string, column: string, prefix: string, width: number): string {
  // 지운 ID도 다시 쓰지 않는다(지우기를 되돌릴 수 있게, 이력·시나리오가 다른 행을 가리키지 않게): 변경 이력에 남은 ID까지 본다
  const rows = [
    ...db.all(`SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE ?`, [`${prefix}%`]),
    ...db.all("SELECT target_key AS id FROM change_log WHERE target = ? AND target_key LIKE ? AND instr(target_key, '|') = 0", [table, `${prefix}%`]),
  ];
  const max = rows.reduce((m, r) => Math.max(m, Number(String(r.id).slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const qtyOk = (v: number | null) => v == null || (Number.isInteger(v) && v >= 0);

/** 고치기 하나. 값이 그대로면 changed = false */
export function applyEdit(db: SqlDb, session: ProjectSession, edit: Edit, ctx: EditContext): EditResult {
  const dirty = (...t: EngineTable[]) => session.markDirty(...t);
  if (ASSET_EDIT_KINDS.has(edit.kind)) return applyAssetEdit(db, session, edit as AssetEdit, ctx);
  if (PEOPLE_EDIT_KINDS.has(edit.kind)) return applyPeopleEdit(db, edit as PeopleEdit, ctx);
  if (NEWS_EDIT_KINDS.has(edit.kind)) return applyNewsEdit(db, edit as NewsEdit, ctx);

  switch (edit.kind) {
    // ───────── 업데이트 ─────────
    case 'createUpdate': {
      if (!edit.name.trim()) fail('업데이트 이름을 입력하십시오.');
      if (!db.get('SELECT 1 AS ok FROM update_types WHERE update_type_id = ? AND is_launch = 0', [edit.typeId])) fail('업데이트 유형을 선택하십시오.');
      for (const d of [edit.startDate, edit.freezeDate, edit.releaseDate]) if (d != null && !DATE.test(d)) fail('날짜 형식은 YYYY-MM-DD입니다.');
      const id = nextId(db, 'updates', 'update_id', 'U', 3);
      const priority = Number(db.get("SELECT coalesce(max(priority), 0) AS p FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS')")?.p ?? 0) + 1;
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM updates')?.s ?? 0) + 1;
      const row = { update_id: id, name: edit.name.trim(), update_type_id: edit.typeId, start_date: edit.startDate, freeze_date: edit.freezeDate, release_date: edit.releaseDate, priority, status: 'PLANNED', sort_order: sortOrder };
      db.run(`INSERT INTO updates (update_id, name, update_type_id, start_date, freeze_date, release_date, priority, status, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, Object.values(row));
      log(db, ctx, 'INSERT', 'updates', id, null, undefined, row);
      // 유형 템플릿의 물량을 그대로 복사한다
      const template = db.all('SELECT * FROM type_templates t JOIN resource_types r ON r.resource_type_id = t.resource_type_id WHERE t.update_type_id = ? AND r.active = 1', [edit.typeId]);
      for (const t of template) {
        db.run('INSERT INTO volumes (update_id, resource_type_id, min_qty, target_qty, stretch_qty) VALUES (?, ?, ?, ?, ?)', [id, t.resource_type_id, t.min_qty, t.target_qty, t.stretch_qty]);
        log(db, ctx, 'INSERT', 'volumes', `${id}|${t.resource_type_id}`, null, undefined, { min_qty: t.min_qty, target_qty: t.target_qty, stretch_qty: t.stretch_qty });
      }
      dirty('updates', 'volumes');
      return { changed: true, createdId: id };
    }
    case 'updateField': {
      const before = db.get(`SELECT ${edit.field} AS v FROM updates WHERE update_id = ?`, [edit.updateId]);
      if (!before) fail('없는 업데이트입니다.');
      let value = edit.value;
      if (edit.field === 'name') { value = (value ?? '').trim(); if (!value) fail('이름은 비울 수 없습니다.'); }
      if (edit.field.endsWith('_date') && value != null && !DATE.test(value)) fail('날짜 형식은 YYYY-MM-DD입니다.');
      if (edit.field === 'status' && !STATUSES.has(value ?? '')) fail('상태가 올바르지 않습니다.');
      if (edit.field === 'update_type_id' && !db.get('SELECT 1 AS ok FROM update_types WHERE update_type_id = ?', [value])) fail('없는 유형입니다.');
      if (edit.field === 'start_date' && value == null) fail('시작일은 비울 수 없습니다.');
      if (before.v === value) return { changed: false };
      db.run(`UPDATE updates SET ${edit.field} = ? WHERE update_id = ?`, [value, edit.updateId]);
      log(db, ctx, 'UPDATE', 'updates', edit.updateId, edit.field, before.v, value);
      dirty('updates');
      return { changed: true };
    }
    case 'movePriority': {
      // 계산 대상 업데이트를 지금 순서대로 1..n으로 다시 매기고 이웃과 바꾼다
      const list = db.all("SELECT update_id, priority FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS') ORDER BY priority, sort_order");
      const i = list.findIndex(r => r.update_id === edit.updateId);
      const j = i + edit.direction;
      if (i < 0 || j < 0 || j >= list.length) return { changed: false };
      const order = list.map(r => String(r.update_id));
      [order[i], order[j]] = [order[j], order[i]];
      order.forEach((id, k) => {
        const old = list.find(r => r.update_id === id)!.priority;
        if (old !== k + 1) {
          db.run('UPDATE updates SET priority = ? WHERE update_id = ?', [k + 1, id]);
          log(db, ctx, 'UPDATE', 'updates', id, 'priority', old, k + 1);
        }
      });
      dirty('updates');
      return { changed: true };
    }
    case 'deleteUpdate': {
      const old = db.get('SELECT * FROM updates WHERE update_id = ?', [edit.updateId]);
      if (!old) return { changed: false };
      const nAssets = Number(db.get('SELECT count(*) AS n FROM assets WHERE update_id = ?', [edit.updateId])?.n ?? 0);
      if (nAssets) fail(`이 업데이트에 에셋이 ${nAssets}개 있습니다. 에셋 화면에서 먼저 지우십시오.`);
      const volumes = db.all('SELECT * FROM volumes WHERE update_id = ?', [edit.updateId]);
      const progress = db.all('SELECT * FROM progress WHERE update_id = ?', [edit.updateId]);
      db.run('DELETE FROM updates WHERE update_id = ?', [edit.updateId]); // 물량·실적은 함께 지워진다 → 되돌릴 수 있게 함께 남긴다
      log(db, ctx, 'DELETE', 'updates', edit.updateId, null, { ...old, volumes, progress }, undefined);
      dirty('updates', 'volumes', 'progress');
      return { changed: true };
    }

    // ───────── 물량 ─────────
    case 'volume': {
      if (!qtyOk(edit.value)) fail('수량은 0 이상의 정수입니다.');
      if (edit.field === 'outsource_qty' && edit.value == null) fail('외주 수량은 비울 수 없습니다.');
      const before = db.get(`SELECT ${edit.field} AS v FROM volumes WHERE update_id = ? AND resource_type_id = ?`, [edit.updateId, edit.resourceTypeId]);
      if (!before) fail('그 업데이트 물량에 없는 리소스입니다.');
      if (before.v === edit.value) return { changed: false };
      db.run(`UPDATE volumes SET ${edit.field} = ? WHERE update_id = ? AND resource_type_id = ?`, [edit.value, edit.updateId, edit.resourceTypeId]);
      log(db, ctx, 'UPDATE', 'volumes', `${edit.updateId}|${edit.resourceTypeId}`, edit.field, before.v, edit.value);
      dirty('volumes');
      return { changed: true };
    }
    case 'addResource': {
      if (db.get('SELECT 1 AS ok FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId])) return { changed: false };
      db.run('INSERT INTO volumes (update_id, resource_type_id, min_qty, target_qty, stretch_qty) VALUES (?, ?, 0, 0, 0)', [edit.updateId, edit.resourceTypeId]);
      log(db, ctx, 'INSERT', 'volumes', `${edit.updateId}|${edit.resourceTypeId}`, null, undefined, { min_qty: 0, target_qty: 0, stretch_qty: 0 });
      dirty('volumes');
      return { changed: true };
    }
    case 'removeResource': {
      const old = db.get('SELECT * FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId]);
      if (!old) return { changed: false };
      if (assetDriven(db, edit.updateId, edit.resourceTypeId)) fail('이 리소스에 등록된 에셋이 있습니다. 에셋 화면에서 먼저 지우십시오.');
      // 그 리소스의 실적도 함께 지운다(남기면 물량 없는 실적). 되돌리면 함께 돌아온다
      for (const p of db.all('SELECT * FROM progress WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId])) {
        db.run('DELETE FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', [p.update_id, p.resource_type_id, p.part_id]);
        log(db, ctx, 'DELETE', 'progress', `${p.update_id}|${p.resource_type_id}|${p.part_id}`, null, p, undefined);
      }
      db.run('DELETE FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId]);
      log(db, ctx, 'DELETE', 'volumes', `${edit.updateId}|${edit.resourceTypeId}`, null, old, undefined);
      dirty('volumes', 'progress');
      return { changed: true };
    }

    // ───────── 유형 · 템플릿 ─────────
    case 'createType': {
      const name = edit.name.trim();
      if (!name) fail('유형 이름을 입력하십시오.');
      if (db.get('SELECT 1 AS ok FROM update_types WHERE name = ?', [name])) fail(`"${name}" 유형이 이미 있습니다.`);
      const id = nextId(db, 'update_types', 'update_type_id', 'T', 2);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM update_types')?.s ?? 0) + 1;
      db.run('INSERT INTO update_types (update_type_id, name, is_launch, sort_order, active) VALUES (?, ?, 0, ?, 1)', [id, name, sortOrder]);
      log(db, ctx, 'INSERT', 'update_types', id, null, undefined, { name });
      dirty('update_types');
      return { changed: true, createdId: id };
    }
    case 'renameType': {
      const name = edit.name.trim();
      if (!name) fail('유형 이름은 비울 수 없습니다.');
      const before = db.get('SELECT name FROM update_types WHERE update_type_id = ?', [edit.typeId]);
      if (!before) fail('없는 유형입니다.');
      if (before.name === name) return { changed: false };
      if (db.get('SELECT 1 AS ok FROM update_types WHERE name = ? AND update_type_id <> ?', [name, edit.typeId])) fail(`"${name}" 유형이 이미 있습니다.`);
      db.run('UPDATE update_types SET name = ? WHERE update_type_id = ?', [name, edit.typeId]);
      log(db, ctx, 'UPDATE', 'update_types', edit.typeId, 'name', before.name, name);
      dirty('update_types');
      return { changed: true };
    }
    case 'deleteType': {
      const t = db.get('SELECT * FROM update_types WHERE update_type_id = ?', [edit.typeId]);
      if (!t) return { changed: false };
      if (Number(t.is_launch) === 1) fail('런칭 유형은 삭제할 수 없습니다.');
      const used = Number(db.get('SELECT count(*) AS n FROM updates WHERE update_type_id = ?', [edit.typeId])?.n ?? 0);
      if (used > 0) fail(`이 유형을 사용하는 업데이트가 ${used}개 있습니다. 업데이트의 유형을 변경한 뒤 삭제하십시오.`);
      const template = db.all('SELECT * FROM type_templates WHERE update_type_id = ?', [edit.typeId]);
      db.run('DELETE FROM update_types WHERE update_type_id = ?', [edit.typeId]);
      log(db, ctx, 'DELETE', 'update_types', edit.typeId, null, { ...t, template }, undefined);
      dirty('update_types');
      return { changed: true };
    }
    case 'template': {
      if (!qtyOk(edit.value)) fail('수량은 0 이상의 정수입니다.');
      const before = db.get(`SELECT ${edit.field} AS v FROM type_templates WHERE update_type_id = ? AND resource_type_id = ?`, [edit.typeId, edit.resourceTypeId]);
      if (!before) fail('템플릿에 없는 리소스입니다.');
      if (before.v === edit.value) return { changed: false };
      db.run(`UPDATE type_templates SET ${edit.field} = ? WHERE update_type_id = ? AND resource_type_id = ?`, [edit.value, edit.typeId, edit.resourceTypeId]);
      log(db, ctx, 'UPDATE', 'type_templates', `${edit.typeId}|${edit.resourceTypeId}`, edit.field, before.v, edit.value);
      return { changed: true }; // 템플릿은 계산에 쓰지 않는다
    }
    case 'addTemplateResource': {
      if (db.get('SELECT 1 AS ok FROM type_templates WHERE update_type_id = ? AND resource_type_id = ?', [edit.typeId, edit.resourceTypeId])) return { changed: false };
      db.run('INSERT INTO type_templates (update_type_id, resource_type_id, min_qty, target_qty, stretch_qty) VALUES (?, ?, 0, 0, 0)', [edit.typeId, edit.resourceTypeId]);
      log(db, ctx, 'INSERT', 'type_templates', `${edit.typeId}|${edit.resourceTypeId}`, null, undefined, { min_qty: 0, target_qty: 0, stretch_qty: 0 });
      return { changed: true };
    }
    case 'removeTemplateResource': {
      const old = db.get('SELECT * FROM type_templates WHERE update_type_id = ? AND resource_type_id = ?', [edit.typeId, edit.resourceTypeId]);
      if (!old) return { changed: false };
      db.run('DELETE FROM type_templates WHERE update_type_id = ? AND resource_type_id = ?', [edit.typeId, edit.resourceTypeId]);
      log(db, ctx, 'DELETE', 'type_templates', `${edit.typeId}|${edit.resourceTypeId}`, null, old, undefined);
      return { changed: true };
    }

    // ───────── 실적 ─────────
    case 'progress':
    case 'progressSpent':
    case 'completeRow': {
      if (edit.asOf != null && !DATE.test(edit.asOf)) fail('기준일 형식은 YYYY-MM-DD입니다.');
      if (!db.get('SELECT 1 AS ok FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId])) fail('그 업데이트 물량에 없는 리소스입니다.');
      const steps = db.all('SELECT rp.part_id FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id AND p.active = 1 WHERE rp.resource_type_id = ? ORDER BY p.sort_order', [edit.resourceTypeId]).map(r => String(r.part_id));
      // 칸 하나 = (완료 수량, 실투입 인·일). 둘 다 없으면(완료 0·실투입 빈칸) 행을 지운다
      const targets: { partId: string; field: 'completed_qty' | 'spent_days'; value: number | null }[] = [];
      if (edit.kind === 'progress') {
        if (!(edit.value == null || (Number.isInteger(edit.value) && edit.value >= 0))) fail('완료 수량은 0 이상의 정수입니다.');
        if (!steps.includes(edit.partId)) fail('이 리소스가 거치지 않는 파트입니다.');
        if (assetDriven(db, edit.updateId, edit.resourceTypeId)) fail('이 리소스의 완료 수량은 에셋 상태에서 집계합니다. 에셋 화면에서 상태를 변경하십시오.');
        targets.push({ partId: edit.partId, field: 'completed_qty', value: edit.value });
      } else if (edit.kind === 'progressSpent') {
        if (!(edit.value == null || (Number.isFinite(edit.value) && edit.value >= 0))) fail('실투입 공수는 0 이상의 숫자(인·일)입니다.');
        if (!steps.includes(edit.partId)) fail('이 리소스가 거치지 않는 파트입니다.');
        targets.push({ partId: edit.partId, field: 'spent_days', value: edit.value === 0 ? null : edit.value });
      } else {
        if (assetDriven(db, edit.updateId, edit.resourceTypeId)) fail('이 리소스의 완료 수량은 에셋 상태에서 집계합니다. 에셋 화면에서 상태를 변경하십시오.');
        // 다 끝남: 거치는 모든 파트를 (목표 − 외주)만큼 완료로
        const v = db.get('SELECT target_qty, outsource_qty FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId])!;
        const n = Math.max(0, Number(v.target_qty ?? 0) - Number(v.outsource_qty ?? 0));
        for (const partId of steps) targets.push({ partId, field: 'completed_qty', value: n });
      }
      let changed = false;
      for (const t of targets) {
        const key = `${edit.updateId}|${edit.resourceTypeId}|${t.partId}`;
        const keyParams = [edit.updateId, edit.resourceTypeId, t.partId];
        const before = db.get('SELECT * FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', keyParams);
        const completed = t.field === 'completed_qty' ? (t.value ?? 0) : Number(before?.completed_qty ?? 0);
        const spent = t.field === 'spent_days' ? t.value : (before?.spent_days == null ? null : Number(before.spent_days));
        const empty = completed === 0 && spent == null;
        if (!before) {
          if (empty) continue;
          const row = { update_id: edit.updateId, resource_type_id: edit.resourceTypeId, part_id: t.partId, completed_qty: completed, as_of: edit.asOf, spent_days: spent };
          db.run('INSERT INTO progress (update_id, resource_type_id, part_id, completed_qty, as_of, spent_days) VALUES (?, ?, ?, ?, ?, ?)', [...keyParams, completed, edit.asOf, spent]);
          log(db, ctx, 'INSERT', 'progress', key, null, undefined, row);
        } else if (empty) {
          db.run('DELETE FROM progress WHERE update_id = ? AND resource_type_id = ? AND part_id = ?', keyParams);
          log(db, ctx, 'DELETE', 'progress', key, null, before, undefined);
        } else {
          const old = before[t.field] == null ? null : Number(before[t.field]);
          const next = t.field === 'completed_qty' ? completed : spent;
          if (old === next) continue;
          db.run(`UPDATE progress SET ${t.field} = ?, as_of = coalesce(?, as_of) WHERE update_id = ? AND resource_type_id = ? AND part_id = ?`, [next, edit.asOf, ...keyParams]);
          // 기준일도 바뀌면 남긴다(되돌리면 기준일도 돌아오게)
          if (edit.asOf != null && before.as_of !== edit.asOf) log(db, ctx, 'UPDATE', 'progress', key, 'as_of', before.as_of ?? null, edit.asOf);
          log(db, ctx, 'UPDATE', 'progress', key, t.field, old, next);
        }
        changed = true;
      }
      if (changed) dirty('progress');
      return { changed };
    }

    // ───────── 공수 보정 ─────────
    case 'effortScale': {
      if (!(edit.ratio > 0 && edit.ratio < 20)) fail('보정 배율이 올바르지 않습니다.');
      const rows = db.all('SELECT profile_id, days FROM efforts WHERE resource_type_id = ? AND part_id = ?', [edit.resourceTypeId, edit.partId]);
      if (!rows.length) fail('그 리소스·파트의 공수가 없습니다.');
      let changed = false;
      for (const r of rows) {
        const next = Math.round(Number(r.days) * edit.ratio * 100) / 100;
        if (next === Number(r.days)) continue;
        db.run('UPDATE efforts SET days = ? WHERE resource_type_id = ? AND part_id = ? AND profile_id = ?', [next, edit.resourceTypeId, edit.partId, r.profile_id]);
        log(db, ctx, 'UPDATE', 'efforts', `${edit.resourceTypeId}|${edit.partId}|${r.profile_id}`, 'days', Number(r.days), next);
        changed = true;
      }
      if (changed) dirty('efforts');
      return { changed };
    }

    // ───────── 인력 · 계획 기간 ─────────
    case 'capacity':
    case 'fillCapacity': {
      const v = edit.value;
      if (!Number.isFinite(v) || v < 0) fail('0 이상의 숫자를 입력하십시오.');
      if (edit.field === 'utilization' && v > 1) fail('가동률은 100% 이하입니다.');
      if (edit.field === 'productivity' && v <= 0) fail('생산성은 0보다 커야 합니다.');
      const months = edit.kind === 'capacity' ? [edit.month] : monthsBetween(edit.fromMonth, edit.toMonth);
      let changed = false;
      for (const month of months) {
        const before = db.get(`SELECT ${edit.field} AS v FROM capacity WHERE part_id = ? AND month = ?`, [edit.partId, month]);
        if (!before) continue;
        if (before.v === v) continue;
        db.run(`UPDATE capacity SET ${edit.field} = ? WHERE part_id = ? AND month = ?`, [v, edit.partId, month]);
        log(db, ctx, 'UPDATE', 'capacity', `${edit.partId}|${month}`, edit.field, before.v, v);
        changed = true;
      }
      if (changed) dirty('capacity');
      return { changed };
    }
    case 'horizon': {
      if (!MONTH.test(edit.startMonth) || !MONTH.test(edit.endMonth)) fail('달 형식은 YYYY-MM입니다.');
      if (edit.endMonth < edit.startMonth) fail('끝 달이 시작 달보다 앞입니다.');
      const months = monthsBetween(edit.startMonth, edit.endMonth);
      if (months.length > 60) fail(`계획 기간이 ${months.length}개월입니다. 60개월 이하로 줄이십시오.`);
      const s = db.get('SELECT horizon_start_month AS a, horizon_end_month AS b FROM settings WHERE id = 1')!;
      if (s.a === edit.startMonth && s.b === edit.endMonth) return { changed: false };
      db.run('UPDATE settings SET horizon_start_month = ?, horizon_end_month = ? WHERE id = 1', [edit.startMonth, edit.endMonth]);
      log(db, ctx, 'UPDATE', 'settings', 'settings', 'horizon', { start: s.a, end: s.b }, { start: edit.startMonth, end: edit.endMonth });
      // 새로 들어온 달의 인력: 가장 가까운 앞 달(없으면 뒤 달) 값을 복사한다. 기간 밖 행은 지우지 않는다(줄였다 다시 늘릴 때 그대로)
      const parts = db.all('SELECT part_id FROM parts WHERE active = 1');
      for (const p of parts) {
        const existing = db.all('SELECT * FROM capacity WHERE part_id = ? ORDER BY month', [p.part_id]);
        const have = new Set(existing.map(r => String(r.month)));
        for (const month of months) {
          if (have.has(month)) continue;
          const prev = [...existing].reverse().find(r => String(r.month) < month) ?? existing.find(r => String(r.month) > month);
          const row = prev
            ? { headcount: prev.headcount, utilization: prev.utilization, productivity: prev.productivity, outsource_days: 0, support_days: 0 }
            : { headcount: 0, utilization: 0.8, productivity: 1, outsource_days: 0, support_days: 0 };
          db.run('INSERT INTO capacity (part_id, month, headcount, utilization, productivity, outsource_days, support_days) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [p.part_id, month, row.headcount, row.utilization, row.productivity, row.outsource_days, row.support_days]);
          log(db, ctx, 'INSERT', 'capacity', `${p.part_id}|${month}`, null, undefined, row);
        }
      }
      dirty('settings', 'capacity');
      return { changed: true };
    }

    // ───────── 물량 템플릿 ─────────
    case 'modeName': {
      if (!PLAN_MODES.includes(edit.mode)) fail('없는 템플릿입니다.');
      const name = edit.name.trim();
      if (!name || name.length > 20) fail('템플릿 이름은 1~20자로 입력하십시오.');
      const names = readModeNames(db);
      if (PLAN_MODES.some(m => m !== edit.mode && names[m] === name)) fail('다른 템플릿과 같은 이름입니다.');
      if (names[edit.mode] === name) return { changed: false };
      const key = modeMetaKey(edit.mode);
      const before = db.get('SELECT value FROM meta WHERE key = ?', [key]);
      db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, name]);
      log(db, ctx, before ? 'UPDATE' : 'INSERT', 'meta', key, before ? 'value' : null, before ? (before.value ?? DEFAULT_MODE_NAMES[edit.mode]) : undefined, before ? name : { key, value: name });
      return { changed: true };
    }
    case 'copyQty': {
      if (edit.from === edit.to) return { changed: false };
      const rows = db.all(`SELECT resource_type_id AS rt, ${edit.from} AS a, ${edit.to} AS b FROM volumes WHERE update_id = ?`, [edit.updateId]);
      let changed = false;
      for (const r of rows) {
        if (r.a === r.b) continue;
        db.run(`UPDATE volumes SET ${edit.to} = ? WHERE update_id = ? AND resource_type_id = ?`, [r.a, edit.updateId, r.rt]);
        log(db, ctx, 'UPDATE', 'volumes', `${edit.updateId}|${r.rt}`, edit.to, r.b, r.a);
        changed = true;
      }
      if (changed) dirty('volumes');
      return { changed };
    }

    // ───────── 프로젝트 기본 정보 ─────────
    case 'projectName': {
      const name = edit.name.trim();
      if (!name) fail('프로젝트 이름을 입력하십시오.');
      const before = db.get("SELECT value FROM meta WHERE key = 'project_name'");
      if (before?.value === name) return { changed: false };
      db.run("INSERT INTO meta (key, value) VALUES ('project_name', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [name]);
      log(db, ctx, 'UPDATE', 'meta', 'project_name', 'value', before?.value ?? null, name);
      return { changed: true };
    }
    case 'setting': {
      if (edit.field === 'buffer_rate' && !(typeof edit.value === 'number' && edit.value >= 0 && edit.value < 1)) fail('여유율은 0~99%입니다.');
      if (edit.field === 'work_weekdays' && !(typeof edit.value === 'string' && /^[01]{7}$/.test(edit.value) && edit.value.includes('1'))) fail('근무 요일을 하루 이상 선택하십시오.');
      const before = db.get(`SELECT ${edit.field} AS v FROM settings WHERE id = 1`)!;
      if (before.v === edit.value) return { changed: false };
      db.run(`UPDATE settings SET ${edit.field} = ? WHERE id = 1`, [edit.value]);
      log(db, ctx, 'UPDATE', 'settings', 'settings', edit.field, before.v, edit.value);
      dirty('settings');
      return { changed: true };
    }
    case 'addHoliday': {
      if (!DATE.test(edit.date)) fail('날짜를 확인하십시오.');
      if (!edit.name.trim()) fail('휴일 이름을 입력하십시오.');
      if (db.get('SELECT 1 AS ok FROM holidays WHERE date = ?', [edit.date])) fail('그 날짜는 이미 휴일입니다.');
      const row = { date: edit.date, name: edit.name.trim(), kind: edit.holidayKind };
      db.run('INSERT INTO holidays (date, name, kind) VALUES (?, ?, ?)', [row.date, row.name, row.kind]);
      log(db, ctx, 'INSERT', 'holidays', edit.date, null, undefined, row);
      dirty('holidays');
      return { changed: true };
    }
    case 'removeHoliday': {
      const old = db.get('SELECT * FROM holidays WHERE date = ?', [edit.date]);
      if (!old) return { changed: false };
      db.run('DELETE FROM holidays WHERE date = ?', [edit.date]);
      log(db, ctx, 'DELETE', 'holidays', edit.date, null, old, undefined);
      dirty('holidays');
      return { changed: true };
    }

    // ───────── 파트 ─────────
    case 'createPart': {
      const name = edit.name.trim();
      if (!name) fail('파트 이름을 입력하십시오.');
      if (db.get('SELECT 1 AS ok FROM parts WHERE name = ?', [name])) fail('같은 이름의 파트가 있습니다.');
      const id = nextId(db, 'parts', 'part_id', 'P', 2);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM parts')?.s ?? 0) + 1;
      const row = { part_id: id, name, sort_order: sortOrder, active: 1 };
      db.run('INSERT INTO parts (part_id, name, sort_order, active) VALUES (?, ?, ?, ?)', [id, name, sortOrder, 1]);
      log(db, ctx, 'INSERT', 'parts', id, null, undefined, row);
      // 계획 기간의 모든 달에 인력 행(인원 0, 가동률 80%)
      const s = db.get('SELECT horizon_start_month AS a, horizon_end_month AS b FROM settings WHERE id = 1')!;
      for (const month of monthsBetween(String(s.a), String(s.b))) {
        const cap = { headcount: 0, utilization: 0.8, productivity: 1, outsource_days: 0, support_days: 0 };
        db.run('INSERT INTO capacity (part_id, month, headcount, utilization, productivity, outsource_days, support_days) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, month, cap.headcount, cap.utilization, cap.productivity, cap.outsource_days, cap.support_days]);
        log(db, ctx, 'INSERT', 'capacity', `${id}|${month}`, null, undefined, cap);
      }
      dirty('parts', 'capacity');
      return { changed: true, createdId: id };
    }
    case 'renamePart': {
      const name = edit.name.trim();
      if (!name) fail('파트 이름을 입력하십시오.');
      const old = db.get('SELECT name FROM parts WHERE part_id = ?', [edit.partId]);
      if (!old) fail('없는 파트입니다.');
      if (old!.name === name) return { changed: false };
      if (db.get('SELECT 1 AS ok FROM parts WHERE name = ? AND part_id <> ?', [name, edit.partId])) fail('같은 이름의 파트가 있습니다.');
      if (db.get('SELECT 1 AS ok FROM teams WHERE name = ?', [name])) fail('같은 이름의 지원 팀이 있습니다(인력 › 작업자 › 팀).');
      db.run('UPDATE parts SET name = ? WHERE part_id = ?', [name, edit.partId]);
      log(db, ctx, 'UPDATE', 'parts', edit.partId, 'name', old!.name, name);
      // 작업자 소속팀은 파트 이름으로 적혀 있다: 함께 바꾼다
      for (const p of db.all('SELECT person_id FROM people WHERE team = ?', [old!.name])) {
        db.run('UPDATE people SET team = ? WHERE person_id = ?', [name, p.person_id]);
        log(db, ctx, 'UPDATE', 'people', String(p.person_id), 'team', old!.name, name);
      }
      dirty('parts');
      return { changed: true };
    }
    case 'movePart': {
      // 순서 = 공정 순서(앞 파트 → 뒤 파트). 이웃과 sort_order를 맞바꾼다
      const list = db.all('SELECT part_id, sort_order FROM parts ORDER BY sort_order, part_id');
      const i = list.findIndex(p => p.part_id === edit.partId);
      const j = i + edit.direction;
      if (i < 0 || j < 0 || j >= list.length) return { changed: false };
      const a = list[i]; const b = list[j];
      const [sa, sb] = a.sort_order === b.sort_order ? [Number(b.sort_order) + (edit.direction > 0 ? 1 : -1), Number(a.sort_order)] : [b.sort_order, a.sort_order];
      db.run('UPDATE parts SET sort_order = ? WHERE part_id = ?', [sa, a.part_id]);
      db.run('UPDATE parts SET sort_order = ? WHERE part_id = ?', [sb, b.part_id]);
      log(db, ctx, 'UPDATE', 'parts', String(a.part_id), 'sort_order', a.sort_order, sa);
      log(db, ctx, 'UPDATE', 'parts', String(b.part_id), 'sort_order', b.sort_order, sb);
      dirty('parts');
      return { changed: true };
    }
    case 'partActive': {
      const old = db.get('SELECT active FROM parts WHERE part_id = ?', [edit.partId]);
      if (!old) fail('없는 파트입니다.');
      const v = edit.active ? 1 : 0;
      if (Number(old!.active) === v) return { changed: false };
      // 사용 중인 리소스가 거치는 파트를 끄면 공정이 끊겨 계산이 막힌다 → 먼저 공수에서 빼게 한다
      const used = Number(db.get('SELECT count(*) AS n FROM resource_parts rp JOIN resource_types r ON r.resource_type_id = rp.resource_type_id WHERE rp.part_id = ? AND r.active = 1', [edit.partId])?.n ?? 0);
      if (!v && used) fail(`이 파트를 거치는 리소스가 ${used}종 있습니다. 리소스 공수에서 이 파트를 제외한 뒤 사용 안 함으로 두십시오.`);
      db.run('UPDATE parts SET active = ? WHERE part_id = ?', [v, edit.partId]);
      log(db, ctx, 'UPDATE', 'parts', edit.partId, 'active', old!.active, v);
      dirty('parts');
      return { changed: true };
    }
    case 'deletePart': {
      const old = db.get('SELECT * FROM parts WHERE part_id = ?', [edit.partId]);
      if (!old) return { changed: false };
      const used = Number(db.get('SELECT count(*) AS n FROM resource_parts WHERE part_id = ?', [edit.partId])?.n ?? 0);
      if (used) fail(`이 파트를 거치는 리소스가 ${used}종 있습니다. 리소스의 공수에서 이 파트를 제외한 뒤 삭제하거나, "사용 안 함"으로 두십시오.`);
      if (db.get('SELECT 1 AS ok FROM progress WHERE part_id = ?', [edit.partId])) fail('이 파트에 작업 진척 기록이 있습니다. "사용 안 함"으로 두십시오.');
      // 함께 지워지는 인력·겹침률·AI 비율을 남겨 되돌릴 수 있게
      const capacity = db.all('SELECT * FROM capacity WHERE part_id = ?', [edit.partId]);
      const overlaps = db.all('SELECT * FROM part_overlaps WHERE from_part_id = ? OR to_part_id = ?', [edit.partId, edit.partId]);
      const mix = db.all('SELECT * FROM effort_mix WHERE part_id = ?', [edit.partId]);
      // 그 파트 소속 작업자는 소속팀 없음으로(되돌리면 돌아온다)
      for (const p of db.all('SELECT person_id FROM people WHERE team = ?', [old.name])) {
        db.run('UPDATE people SET team = NULL WHERE person_id = ?', [p.person_id]);
        log(db, ctx, 'UPDATE', 'people', String(p.person_id), 'team', old.name, null);
      }
      db.run('DELETE FROM parts WHERE part_id = ?', [edit.partId]);
      log(db, ctx, 'DELETE', 'parts', edit.partId, null, { ...old, capacity, part_overlaps: overlaps, effort_mix: mix }, undefined);
      dirty('parts', 'capacity', 'part_overlaps', 'effort_mix');
      return { changed: true };
    }

    // ───────── 리소스 · 공수 ─────────
    case 'createResource': {
      const name = edit.name.trim();
      if (!name) fail('리소스 이름을 입력하십시오.');
      if (db.get('SELECT 1 AS ok FROM resource_types WHERE name = ?', [name])) fail('같은 이름의 리소스가 있습니다.');
      const groupId = groupFor(db, ctx, edit.groupName);
      const id = nextId(db, 'resource_types', 'resource_type_id', 'R', 3);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM resource_types')?.s ?? 0) + 1;
      const row = { resource_type_id: id, group_id: groupId, name, sort_order: sortOrder, active: 1 };
      db.run('INSERT INTO resource_types (resource_type_id, group_id, name, sort_order, active) VALUES (?, ?, ?, ?, ?)', [id, groupId, name, sortOrder, 1]);
      log(db, ctx, 'INSERT', 'resource_types', id, null, undefined, row);
      dirty('resource_types');
      return { changed: true, createdId: id };
    }
    case 'renameResource': {
      const name = edit.name.trim();
      if (!name) fail('리소스 이름을 입력하십시오.');
      const old = db.get('SELECT name FROM resource_types WHERE resource_type_id = ?', [edit.resourceTypeId]);
      if (!old) fail('없는 리소스입니다.');
      if (old!.name === name) return { changed: false };
      if (db.get('SELECT 1 AS ok FROM resource_types WHERE name = ? AND resource_type_id <> ?', [name, edit.resourceTypeId])) fail('같은 이름의 리소스가 있습니다.');
      db.run('UPDATE resource_types SET name = ? WHERE resource_type_id = ?', [name, edit.resourceTypeId]);
      log(db, ctx, 'UPDATE', 'resource_types', edit.resourceTypeId, 'name', old!.name, name);
      dirty('resource_types');
      return { changed: true };
    }
    case 'resourceGroup': {
      const old = db.get('SELECT group_id FROM resource_types WHERE resource_type_id = ?', [edit.resourceTypeId]);
      if (!old) fail('없는 리소스입니다.');
      const groupId = groupFor(db, ctx, edit.groupName);
      if (old!.group_id === groupId) return { changed: false };
      db.run('UPDATE resource_types SET group_id = ? WHERE resource_type_id = ?', [groupId, edit.resourceTypeId]);
      log(db, ctx, 'UPDATE', 'resource_types', edit.resourceTypeId, 'group_id', old!.group_id, groupId);
      dirty('resource_types');
      return { changed: true };
    }
    case 'renameGroup': {
      const name = edit.name.trim();
      if (!name) fail('분류 이름을 입력하십시오.');
      const old = db.get('SELECT name FROM resource_groups WHERE group_id = ?', [edit.groupId]);
      if (!old) fail('없는 분류입니다.');
      if (old!.name === name) return { changed: false };
      if (db.get('SELECT 1 AS ok FROM resource_groups WHERE name = ? AND group_id <> ?', [name, edit.groupId])) fail('같은 이름의 분류가 있습니다.');
      db.run('UPDATE resource_groups SET name = ? WHERE group_id = ?', [name, edit.groupId]);
      log(db, ctx, 'UPDATE', 'resource_groups', edit.groupId, 'name', old!.name, name);
      return { changed: true };
    }
    case 'resourceActive': {
      const old = db.get('SELECT active FROM resource_types WHERE resource_type_id = ?', [edit.resourceTypeId]);
      if (!old) fail('없는 리소스입니다.');
      const v = edit.active ? 1 : 0;
      if (Number(old!.active) === v) return { changed: false };
      db.run('UPDATE resource_types SET active = ? WHERE resource_type_id = ?', [v, edit.resourceTypeId]);
      log(db, ctx, 'UPDATE', 'resource_types', edit.resourceTypeId, 'active', old!.active, v);
      dirty('resource_types');
      return { changed: true };
    }
    case 'deleteResource': {
      const old = db.get('SELECT * FROM resource_types WHERE resource_type_id = ?', [edit.resourceTypeId]);
      if (!old) return { changed: false };
      const used = ['volumes', 'type_templates', 'progress', 'assets'].filter(t => db.get(`SELECT 1 AS ok FROM ${t} WHERE resource_type_id = ? LIMIT 1`, [edit.resourceTypeId]));
      if (used.length) fail('물량·유형 템플릿·작업 진척에 쓰이는 리소스입니다. 그곳에서 제외한 뒤 삭제하거나 "사용 안 함"으로 두십시오.');
      const resourceParts = db.all('SELECT * FROM resource_parts WHERE resource_type_id = ?', [edit.resourceTypeId]);
      const efforts = db.all('SELECT * FROM efforts WHERE resource_type_id = ?', [edit.resourceTypeId]);
      db.run('DELETE FROM resource_types WHERE resource_type_id = ?', [edit.resourceTypeId]);
      log(db, ctx, 'DELETE', 'resource_types', edit.resourceTypeId, null, { ...old, resource_parts: resourceParts, efforts }, undefined);
      dirty('resource_types', 'resource_parts', 'efforts');
      return { changed: true };
    }
    case 'effort': {
      // 기본 공수를 비우면 그 파트를 거치지 않는다(거치는 파트·공수를 지운다). 0은 "거치지만 할 일 없음"
      if (edit.days != null && !(Number.isFinite(edit.days) && edit.days >= 0 && edit.days < 10000)) fail('공수는 0 이상의 숫자입니다.');
      if (!db.get('SELECT 1 AS ok FROM resource_types WHERE resource_type_id = ?', [edit.resourceTypeId])) fail('없는 리소스입니다.');
      if (!db.get('SELECT 1 AS ok FROM parts WHERE part_id = ?', [edit.partId])) fail('없는 파트입니다.');
      const key = `${edit.resourceTypeId}|${edit.partId}`;
      const rp = db.get('SELECT * FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [edit.resourceTypeId, edit.partId]);
      const cur = db.get('SELECT days FROM efforts WHERE resource_type_id = ? AND part_id = ? AND profile_id = ?', [edit.resourceTypeId, edit.partId, edit.profileId]);
      if (edit.profileId === 'BASE' && edit.days == null) {
        if (!rp) return { changed: false };
        if (db.get('SELECT 1 AS ok FROM progress WHERE resource_type_id = ? AND part_id = ? LIMIT 1', [edit.resourceTypeId, edit.partId])) fail('이 파트에 작업 진척 기록이 있어 제외할 수 없습니다. 공수를 0으로 두십시오.');
        const efforts = db.all('SELECT * FROM efforts WHERE resource_type_id = ? AND part_id = ?', [edit.resourceTypeId, edit.partId]);
        db.run('DELETE FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [edit.resourceTypeId, edit.partId]);
        log(db, ctx, 'DELETE', 'resource_parts', key, null, { ...rp, efforts }, undefined);
        dirty('resource_parts', 'efforts');
        return { changed: true };
      }
      if (edit.profileId === 'AI' && edit.days == null) {
        if (!cur) return { changed: false };
        db.run("DELETE FROM efforts WHERE resource_type_id = ? AND part_id = ? AND profile_id = 'AI'", [edit.resourceTypeId, edit.partId]);
        log(db, ctx, 'DELETE', 'efforts', `${key}|AI`, null, { resource_type_id: edit.resourceTypeId, part_id: edit.partId, profile_id: 'AI', days: cur.days }, undefined);
        dirty('efforts');
        return { changed: true };
      }
      if (!rp) {
        if (edit.profileId === 'AI') fail('기본 공수를 먼저 입력하십시오.');
        const row = { resource_type_id: edit.resourceTypeId, part_id: edit.partId, rework_rate: 0 };
        db.run('INSERT INTO resource_parts (resource_type_id, part_id, rework_rate) VALUES (?, ?, 0)', [edit.resourceTypeId, edit.partId]);
        log(db, ctx, 'INSERT', 'resource_parts', key, null, undefined, row);
      }
      if (edit.profileId === 'AI' && !db.get("SELECT 1 AS ok FROM effort_profiles WHERE profile_id = 'AI'")) {
        const prof = { profile_id: 'AI', name: 'AI 사용 시', sort_order: 2 };
        db.run("INSERT INTO effort_profiles (profile_id, name, sort_order) VALUES ('AI', 'AI 사용 시', 2)");
        log(db, ctx, 'INSERT', 'effort_profiles', 'AI', null, undefined, prof);
      }
      if (cur && Number(cur.days) === edit.days) return { changed: !rp };
      if (cur) {
        db.run('UPDATE efforts SET days = ? WHERE resource_type_id = ? AND part_id = ? AND profile_id = ?', [edit.days, edit.resourceTypeId, edit.partId, edit.profileId]);
        log(db, ctx, 'UPDATE', 'efforts', `${key}|${edit.profileId}`, 'days', Number(cur.days), edit.days);
      } else {
        const row = { resource_type_id: edit.resourceTypeId, part_id: edit.partId, profile_id: edit.profileId, days: edit.days };
        db.run('INSERT INTO efforts (resource_type_id, part_id, profile_id, days) VALUES (?, ?, ?, ?)', [edit.resourceTypeId, edit.partId, edit.profileId, edit.days]);
        log(db, ctx, 'INSERT', 'efforts', `${key}|${edit.profileId}`, null, undefined, row);
      }
      dirty('resource_parts', 'efforts');
      return { changed: true };
    }
    case 'aiShare': {
      if (!(Number.isFinite(edit.share) && edit.share >= 0 && edit.share <= 1)) fail('AI 활용 비율은 0~100%입니다.');
      if (!db.get('SELECT 1 AS ok FROM parts WHERE part_id = ?', [edit.partId])) fail('없는 파트입니다.');
      const share = Math.round(edit.share * 1000) / 1000;
      const rows = db.all('SELECT * FROM effort_mix WHERE part_id = ?', [edit.partId]);
      const cur = Number(rows.find(r => r.profile_id === 'AI')?.share ?? 0);
      if (rows.every(r => r.profile_id === 'BASE' || r.profile_id === 'AI') && Math.abs(cur - share) < 1e-9 && (share === 0 || rows.length === 2)) return { changed: false };
      if (share > 0 && !db.get("SELECT 1 AS ok FROM effort_profiles WHERE profile_id = 'AI'")) {
        db.run("INSERT INTO effort_profiles (profile_id, name, sort_order) VALUES ('AI', 'AI 사용 시', 2)");
        log(db, ctx, 'INSERT', 'effort_profiles', 'AI', null, undefined, { profile_id: 'AI', name: 'AI 사용 시', sort_order: 2 });
      }
      // 지금 섞는 비율을 지우고(0이면 비율 없음 = 기본 공수만) 새로 넣는다
      for (const r of rows) {
        db.run('DELETE FROM effort_mix WHERE part_id = ? AND profile_id = ?', [edit.partId, r.profile_id]);
        log(db, ctx, 'DELETE', 'effort_mix', `${edit.partId}|${r.profile_id}`, null, r, undefined);
      }
      if (share > 0) {
        for (const [profile, v] of [['BASE', Math.round((1 - share) * 1000) / 1000], ['AI', share]] as const) {
          const row = { part_id: edit.partId, profile_id: profile, share: v };
          db.run('INSERT INTO effort_mix (part_id, profile_id, share) VALUES (?, ?, ?)', [edit.partId, profile, v]);
          log(db, ctx, 'INSERT', 'effort_mix', `${edit.partId}|${profile}`, null, undefined, row);
        }
      }
      dirty('effort_mix');
      return { changed: true };
    }
    case 'rework': {
      if (!(Number.isFinite(edit.rate) && edit.rate >= 0 && edit.rate <= 1)) fail('재작업률은 0~100%입니다.');
      const old = db.get('SELECT rework_rate FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [edit.resourceTypeId, edit.partId]);
      if (!old) fail('이 리소스가 거치지 않는 파트입니다.');
      if (Number(old!.rework_rate) === edit.rate) return { changed: false };
      db.run('UPDATE resource_parts SET rework_rate = ? WHERE resource_type_id = ? AND part_id = ?', [edit.rate, edit.resourceTypeId, edit.partId]);
      log(db, ctx, 'UPDATE', 'resource_parts', `${edit.resourceTypeId}|${edit.partId}`, 'rework_rate', Number(old!.rework_rate), edit.rate);
      dirty('resource_parts');
      return { changed: true };
    }
  }
  return fail(`알 수 없는 고치기입니다: ${(edit as { kind: string }).kind}`);
}

/** 분류 이름 → 분류 ID(없으면 만든다). 빈 이름이면 분류 없음 */
function groupFor(db: SqlDb, ctx: EditContext, groupName: string): string | null {
  const name = groupName.trim();
  if (!name) return null;
  const found = db.get('SELECT group_id FROM resource_groups WHERE name = ?', [name]);
  if (found) return String(found.group_id);
  const id = nextId(db, 'resource_groups', 'group_id', 'G', 2);
  const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM resource_groups')?.s ?? 0) + 1;
  const row = { group_id: id, name, sort_order: sortOrder };
  db.run('INSERT INTO resource_groups (group_id, name, sort_order) VALUES (?, ?, ?)', [id, name, sortOrder]);
  log(db, ctx, 'INSERT', 'resource_groups', id, null, undefined, row);
  return id;
}
