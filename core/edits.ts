// 모든 고치기: 업데이트·물량·유형·템플릿·인력·계획 기간. 값 검사 → 쓰기 → 변경 이력 → 바뀐 표 알리기.
// 값의 업무 규칙(최저 ≤ 목표 등)은 검증 규칙이 맡고, 여기서는 형식(정수, 날짜 모양, 범위가 정해진 값)만 막는다.
import type { SqlDb } from './db.ts';
import type { ProjectSession, EngineTable } from './pipeline.ts';

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
  | { kind: 'horizon'; startMonth: string; endMonth: string };

export interface EditContext { editor: string; batchId: string; reason?: string }
export interface EditResult { changed: boolean; createdId?: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 달력에 있는 날짜만(2027-02-30 같은 날은 거절) */
const DATE = { test: (d: string) => DATE_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUSES = new Set(['PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED']);

function fail(message: string): never { throw new Error(message); }

function log(db: SqlDb, ctx: EditContext, action: string, target: string, key: string, field: string | null, oldValue: unknown, newValue: unknown) {
  db.run(`INSERT INTO change_log (batch_id, at, editor, action, target, target_key, field, old_json, new_json, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    ctx.batchId, new Date().toISOString(), ctx.editor, action, target, key, field,
    oldValue === undefined ? null : JSON.stringify(oldValue), newValue === undefined ? null : JSON.stringify(newValue), ctx.reason ?? null,
  ]);
}

function nextId(db: SqlDb, table: string, column: string, prefix: string, width: number): string {
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

  switch (edit.kind) {
    // ───────── 업데이트 ─────────
    case 'createUpdate': {
      if (!edit.name.trim()) fail('업데이트 이름을 넣어 주세요.');
      if (!db.get('SELECT 1 AS ok FROM update_types WHERE update_type_id = ? AND is_launch = 0', [edit.typeId])) fail('업데이트 유형을 골라 주세요.');
      for (const d of [edit.startDate, edit.freezeDate, edit.releaseDate]) if (d != null && !DATE.test(d)) fail('날짜 형식은 YYYY-MM-DD예요.');
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
      if (!before) fail('없는 업데이트예요.');
      let value = edit.value;
      if (edit.field === 'name') { value = (value ?? '').trim(); if (!value) fail('이름은 비울 수 없어요.'); }
      if (edit.field.endsWith('_date') && value != null && !DATE.test(value)) fail('날짜 형식은 YYYY-MM-DD예요.');
      if (edit.field === 'status' && !STATUSES.has(value ?? '')) fail('상태가 올바르지 않아요.');
      if (edit.field === 'update_type_id' && !db.get('SELECT 1 AS ok FROM update_types WHERE update_type_id = ?', [value])) fail('없는 유형이에요.');
      if (edit.field === 'start_date' && value == null) fail('시작일은 비울 수 없어요.');
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
      const volumes = db.all('SELECT * FROM volumes WHERE update_id = ?', [edit.updateId]);
      const progress = db.all('SELECT * FROM progress WHERE update_id = ?', [edit.updateId]);
      db.run('DELETE FROM updates WHERE update_id = ?', [edit.updateId]); // 물량·실적은 함께 지워진다 → 되돌릴 수 있게 함께 남긴다
      log(db, ctx, 'DELETE', 'updates', edit.updateId, null, { ...old, volumes, progress }, undefined);
      dirty('updates', 'volumes', 'progress');
      return { changed: true };
    }

    // ───────── 물량 ─────────
    case 'volume': {
      if (!qtyOk(edit.value)) fail('수량은 0 이상의 정수예요.');
      if (edit.field === 'outsource_qty' && edit.value == null) fail('외주 수량은 비울 수 없어요.');
      const before = db.get(`SELECT ${edit.field} AS v FROM volumes WHERE update_id = ? AND resource_type_id = ?`, [edit.updateId, edit.resourceTypeId]);
      if (!before) fail('그 업데이트 물량에 없는 리소스예요.');
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
      if (!name) fail('유형 이름을 넣어 주세요.');
      if (db.get('SELECT 1 AS ok FROM update_types WHERE name = ?', [name])) fail(`"${name}" 유형이 이미 있어요.`);
      const id = nextId(db, 'update_types', 'update_type_id', 'T', 2);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM update_types')?.s ?? 0) + 1;
      db.run('INSERT INTO update_types (update_type_id, name, is_launch, sort_order, active) VALUES (?, ?, 0, ?, 1)', [id, name, sortOrder]);
      log(db, ctx, 'INSERT', 'update_types', id, null, undefined, { name });
      dirty('update_types');
      return { changed: true, createdId: id };
    }
    case 'renameType': {
      const name = edit.name.trim();
      if (!name) fail('유형 이름은 비울 수 없어요.');
      const before = db.get('SELECT name FROM update_types WHERE update_type_id = ?', [edit.typeId]);
      if (!before) fail('없는 유형이에요.');
      if (before.name === name) return { changed: false };
      if (db.get('SELECT 1 AS ok FROM update_types WHERE name = ? AND update_type_id <> ?', [name, edit.typeId])) fail(`"${name}" 유형이 이미 있어요.`);
      db.run('UPDATE update_types SET name = ? WHERE update_type_id = ?', [name, edit.typeId]);
      log(db, ctx, 'UPDATE', 'update_types', edit.typeId, 'name', before.name, name);
      dirty('update_types');
      return { changed: true };
    }
    case 'deleteType': {
      const t = db.get('SELECT * FROM update_types WHERE update_type_id = ?', [edit.typeId]);
      if (!t) return { changed: false };
      if (Number(t.is_launch) === 1) fail('런칭 유형은 지울 수 없어요.');
      const used = Number(db.get('SELECT count(*) AS n FROM updates WHERE update_type_id = ?', [edit.typeId])?.n ?? 0);
      if (used > 0) fail(`이 유형을 쓰는 업데이트가 ${used}개 있어요. 업데이트의 유형을 바꾼 뒤 지워 주세요.`);
      const template = db.all('SELECT * FROM type_templates WHERE update_type_id = ?', [edit.typeId]);
      db.run('DELETE FROM update_types WHERE update_type_id = ?', [edit.typeId]);
      log(db, ctx, 'DELETE', 'update_types', edit.typeId, null, { ...t, template }, undefined);
      dirty('update_types');
      return { changed: true };
    }
    case 'template': {
      if (!qtyOk(edit.value)) fail('수량은 0 이상의 정수예요.');
      const before = db.get(`SELECT ${edit.field} AS v FROM type_templates WHERE update_type_id = ? AND resource_type_id = ?`, [edit.typeId, edit.resourceTypeId]);
      if (!before) fail('템플릿에 없는 리소스예요.');
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
      if (edit.asOf != null && !DATE.test(edit.asOf)) fail('기준일 형식은 YYYY-MM-DD예요.');
      if (!db.get('SELECT 1 AS ok FROM volumes WHERE update_id = ? AND resource_type_id = ?', [edit.updateId, edit.resourceTypeId])) fail('그 업데이트 물량에 없는 리소스예요.');
      const steps = db.all('SELECT rp.part_id FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id AND p.active = 1 WHERE rp.resource_type_id = ? ORDER BY p.sort_order', [edit.resourceTypeId]).map(r => String(r.part_id));
      // 칸 하나 = (완료 수량, 실투입 인·일). 둘 다 없으면(완료 0·실투입 빈칸) 행을 지운다
      const targets: { partId: string; field: 'completed_qty' | 'spent_days'; value: number | null }[] = [];
      if (edit.kind === 'progress') {
        if (!(edit.value == null || (Number.isInteger(edit.value) && edit.value >= 0))) fail('완료 수량은 0 이상의 정수예요.');
        if (!steps.includes(edit.partId)) fail('이 리소스가 거치지 않는 파트예요.');
        targets.push({ partId: edit.partId, field: 'completed_qty', value: edit.value });
      } else if (edit.kind === 'progressSpent') {
        if (!(edit.value == null || (Number.isFinite(edit.value) && edit.value >= 0))) fail('실투입 공수는 0 이상의 숫자(인·일)예요.');
        if (!steps.includes(edit.partId)) fail('이 리소스가 거치지 않는 파트예요.');
        targets.push({ partId: edit.partId, field: 'spent_days', value: edit.value === 0 ? null : edit.value });
      } else {
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
      if (!(edit.ratio > 0 && edit.ratio < 20)) fail('보정 배율이 올바르지 않아요.');
      const rows = db.all('SELECT profile_id, days FROM efforts WHERE resource_type_id = ? AND part_id = ?', [edit.resourceTypeId, edit.partId]);
      if (!rows.length) fail('그 리소스·파트의 공수가 없어요.');
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
      if (!Number.isFinite(v) || v < 0) fail('0 이상의 숫자를 넣어 주세요.');
      if (edit.field === 'utilization' && v > 1) fail('가동률은 100% 이하예요.');
      if (edit.field === 'productivity' && v <= 0) fail('생산성은 0보다 커야 해요.');
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
      if (!MONTH.test(edit.startMonth) || !MONTH.test(edit.endMonth)) fail('달 형식은 YYYY-MM이에요.');
      if (edit.endMonth < edit.startMonth) fail('끝 달이 시작 달보다 앞이에요.');
      const months = monthsBetween(edit.startMonth, edit.endMonth);
      if (months.length > 60) fail(`계획 기간이 ${months.length}개월이에요. 60개월 이하로 줄여 주세요.`);
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
  }
}
