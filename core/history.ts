// 변경 이력 보기와 되돌리기. 묶음(batch_id) = 사람이 한 번 고친 것(물량 한 칸, 업데이트 만들기, 시나리오 반영 …).
// 되돌리기도 고치기다: 이력의 이전 값을 다시 쓰고, 그 자체가 새 묶음으로 이력에 남는다(이유 = "되돌리기: 묶음").
import type { SqlDb } from './db.ts';
import type { ProjectSession, EngineTable } from './pipeline.ts';
import { validate, tableColumns } from './pipeline.ts';

const KEYS: Record<string, string[]> = {
  part_overlaps: ['from_part_id', 'to_part_id'],
  resource_parts: ['resource_type_id', 'part_id'],
  efforts: ['resource_type_id', 'part_id', 'profile_id'],
  effort_mix: ['part_id', 'profile_id'],
  updates: ['update_id'],
  volumes: ['update_id', 'resource_type_id'],
  capacity: ['part_id', 'month'],
  progress: ['update_id', 'resource_type_id', 'part_id'],
  update_types: ['update_type_id'],
  type_templates: ['update_type_id', 'resource_type_id'],
};
const ENGINE = new Set(['settings', 'part_overlaps', 'resource_parts', 'efforts', 'effort_mix', 'update_types', 'updates', 'volumes', 'progress', 'capacity']);

const TARGET_NAME: Record<string, string> = {
  volumes: '물량', updates: '업데이트', capacity: '인력', progress: '실적', update_types: '유형', type_templates: '템플릿',
  settings: '설정', part_overlaps: '겹침률', effort_mix: 'AI 비율', efforts: '공수', resource_parts: '거치는 파트',
};
const FIELD_NAME: Record<string, string> = {
  min_qty: '최저', target_qty: '목표', stretch_qty: '확장', outsource_qty: '외주', name: '이름', start_date: '시작', freeze_date: '제작 완료 목표',
  release_date: '출시', priority: '우선순위', status: '상태', update_type_id: '유형', headcount: '인원', utilization: '가동률',
  productivity: '생산성', outsource_days: '외주', support_days: '지원', completed_qty: '완료', horizon: '계획 기간', share: '비율', overlap_rate: '겹침률',
};

export interface HistoryEntry { logId: number; action: string; target: string; key: string; field: string | null; old: unknown; next: unknown }
export interface HistoryBatch {
  batchId: string;
  at: string;
  editor: string;
  reason: string | null;
  /** 사람이 읽는 요약. 예: "물량 목표 · 업데이트 만들기 외 2" */
  summary: string;
  count: number;
  entries: HistoryEntry[];
  /** 이 묶음을 되돌린 묶음이 있나 */
  undone: boolean;
  /** 되돌리기 묶음인가 */
  isUndo: boolean;
}

const parse = (v: unknown) => (v == null ? undefined : JSON.parse(String(v)));

export function historyView(db: SqlDb, limit = 200): { batches: HistoryBatch[]; total: number } {
  const total = Number(db.get('SELECT count(DISTINCT batch_id) AS n FROM change_log')?.n ?? 0);
  const ids = db.all('SELECT batch_id, min(log_id) AS first FROM change_log GROUP BY batch_id ORDER BY first DESC LIMIT ?', [limit]).map(r => String(r.batch_id));
  const undoneSet = new Set(db.all("SELECT DISTINCT reason FROM change_log WHERE reason LIKE '되돌리기: %'").map(r => String(r.reason).slice('되돌리기: '.length)));
  const batches = ids.map(id => {
    const rows = db.all('SELECT * FROM change_log WHERE batch_id = ? ORDER BY log_id', [id]);
    const entries: HistoryEntry[] = rows.map(r => ({
      logId: Number(r.log_id), action: String(r.action), target: String(r.target), key: String(r.target_key),
      field: r.field == null ? null : String(r.field), old: parse(r.old_json), next: parse(r.new_json),
    }));
    const kinds = [...new Set(entries.map(e => (e.action === 'UPDATE'
      ? `${TARGET_NAME[e.target] ?? e.target} ${FIELD_NAME[e.field ?? ''] ?? e.field ?? ''}`.trim()
      : `${TARGET_NAME[e.target] ?? e.target} ${e.action === 'INSERT' ? '추가' : '삭제'}`)))];
    const reason = rows[0]?.reason == null ? null : String(rows[0].reason);
    return {
      batchId: id,
      at: String(rows[0]?.at ?? ''),
      editor: String(rows[0]?.editor ?? ''),
      reason,
      summary: kinds.length > 2 ? `${kinds.slice(0, 2).join(' · ')} 외 ${kinds.length - 2}` : kinds.join(' · '),
      count: entries.length,
      entries,
      undone: undoneSet.has(id),
      isUndo: !!reason && reason.startsWith('되돌리기: '),
    };
  });
  return { batches, total };
}

function where(target: string, key: string): { sql: string; params: unknown[] } {
  if (target === 'settings') return { sql: 'id = 1', params: [] };
  const cols = KEYS[target];
  if (!cols) throw new Error(`되돌릴 수 없는 대상이에요: ${target}`);
  const parts = key.split('|');
  return { sql: cols.map(c => `${c} = ?`).join(' AND '), params: parts };
}

/** 이 묶음 뒤에 같은 칸을 고친 묶음들(되돌리면 그 값도 덮어쓴다) */
export function laterConflicts(db: SqlDb, batchId: string): string[] {
  const first = Number(db.get('SELECT min(log_id) AS f FROM change_log WHERE batch_id = ?', [batchId])?.f ?? 0);
  return db.all(`SELECT DISTINCT later.batch_id AS b FROM change_log mine JOIN change_log later
      ON later.target = mine.target AND later.target_key = mine.target_key AND coalesce(later.field, '') = coalesce(mine.field, '')
      WHERE mine.batch_id = ? AND later.log_id > ? AND later.batch_id <> ?`, [batchId, first, batchId]).map(r => String(r.b));
}

/** 묶음 하나를 되돌린다. 뒤에 같은 칸을 고친 묶음이 있으면 force 없이는 거절. 되돌린 뒤 검증 오류가 생기면 전부 취소 */
export function undoBatch(db: SqlDb, session: ProjectSession, batchId: string, ctx: { editor: string; batchId: string }, force = false): { reverted: number } {
  const rows = db.all('SELECT * FROM change_log WHERE batch_id = ? ORDER BY log_id DESC', [batchId]);
  if (!rows.length) throw new Error('없는 변경 묶음이에요.');
  if (db.get("SELECT 1 AS ok FROM change_log WHERE reason = ?", [`되돌리기: ${batchId}`])) throw new Error('이미 되돌린 변경이에요.');
  const conflicts = laterConflicts(db, batchId);
  if (conflicts.length && !force) throw new Error(`이 뒤에 같은 칸을 ${conflicts.length}번 더 고쳤어요. 되돌리면 그 값도 덮어써요. 그래도 되돌리려면 "그래도 되돌리기"를 눌러 주세요.`);
  const reason = `되돌리기: ${batchId}`;
  const log = (action: string, target: string, key: string, field: string | null, oldV: unknown, newV: unknown) =>
    db.run(`INSERT INTO change_log (batch_id, at, editor, action, target, target_key, field, old_json, new_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.batchId, new Date().toISOString(), ctx.editor, action, target, key, field, oldV === undefined ? null : JSON.stringify(oldV), newV === undefined ? null : JSON.stringify(newV), reason]);
  const insertRow = (target: string, row: Record<string, unknown>) => {
    const columns = tableColumns(db, target);
    const cols = Object.keys(row).filter(c => columns.has(c));
    db.run(`INSERT INTO ${target} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c]));
  };
  const touched = new Set<string>();
  db.exec('SAVEPOINT undo_batch');
  try {
    for (const r of rows) {
      const target = String(r.target);
      const key = String(r.target_key);
      const field = r.field == null ? null : String(r.field);
      const oldV = parse(r.old_json);
      const newV = parse(r.new_json);
      touched.add(target);
      if (r.action === 'UPDATE') {
        if (target === 'settings' && field === 'horizon') {
          const o = oldV as { start: string; end: string };
          db.run('UPDATE settings SET horizon_start_month = ?, horizon_end_month = ? WHERE id = 1', [o.start, o.end]);
          log('UPDATE', target, key, field, newV, oldV);
          continue;
        }
        const w = where(target, key);
        db.run(`UPDATE ${target} SET ${field} = ? WHERE ${w.sql}`, [oldV ?? null, ...w.params]);
        log('UPDATE', target, key, field, newV, oldV);
      } else if (r.action === 'INSERT') {
        const w = where(target, key);
        const now = db.get(`SELECT * FROM ${target} WHERE ${w.sql}`, w.params);
        if (now) {
          db.run(`DELETE FROM ${target} WHERE ${w.sql}`, w.params);
          log('DELETE', target, key, field, now, undefined);
        }
      } else {
        // 지운 행을 다시 넣는다. 업데이트는 함께 지워진 물량, 유형은 템플릿도
        const row = { ...(oldV as Record<string, unknown>) };
        const volumes = Array.isArray(row.volumes) ? row.volumes as Record<string, unknown>[] : [];
        const template = Array.isArray(row.template) ? row.template as Record<string, unknown>[] : [];
        delete row.volumes;
        delete row.template;
        insertRow(target, row);
        for (const v of volumes) insertRow('volumes', v);
        for (const t of template) insertRow('type_templates', t);
        if (volumes.length) touched.add('volumes');
        log('INSERT', target, key, null, undefined, oldV);
      }
    }
    const errors = validate(db).filter(f => f.level === 'ERROR');
    if (errors.length) {
      throw new Error(`되돌리면 계산할 수 없는 상태가 돼서 취소했어요: ${errors.slice(0, 3).map(e => `${e.title}(${e.key})`).join(', ')}`);
    }
    db.exec('RELEASE undo_batch');
  } catch (error) {
    try { db.exec('ROLLBACK TO undo_batch'); db.exec('RELEASE undo_batch'); } catch { /* 이미 끝남 */ }
    throw error;
  }
  session.markDirty(...([...touched].filter(t => ENGINE.has(t)) as EngineTable[]));
  if (touched.has('settings')) session.markDirty('settings', 'capacity');
  return { reverted: rows.length };
}
