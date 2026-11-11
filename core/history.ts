// 변경 이력 보기와 되돌리기. 묶음(batch_id) = 사람이 한 번 수정한 것(물량 한 칸, 업데이트 만들기, 시나리오 반영 …).
// 되돌리기도 고치기다: 이력의 이전 값을 다시 쓰고, 그 자체가 새 묶음으로 이력에 남는다(이유 = "되돌리기: 묶음").
import type { SqlDb } from './db.ts';
import type { ProjectSession, EngineTable } from './pipeline.ts';
import { validate, tableColumns } from './pipeline.ts';
import { readModeNames } from './modes.ts';
import { tableKeys, tableLabels, childTables } from './tables.ts';

// 표마다 키 칸 · 이름 · 딸린 행은 core/tables.ts 한 곳에서 읽는다
const KEYS: Record<string, string[]> = tableKeys();
const ENGINE = new Set(['settings', 'part_overlaps', 'pipeline_steps', 'resource_parts', 'efforts', 'effort_mix', 'update_types', 'updates', 'volumes', 'progress', 'capacity', 'parts', 'resource_types', 'holidays']);
/** 지울 때 함께 남긴 딸린 행(키 → 표). 되돌리면 이 순서(외래 키 순서)로 다시 넣는다 */
const CHILD_TABLES: [string, string][] = childTables();

const TARGET_NAME: Record<string, string> = tableLabels();
const FIELD_NAME: Record<string, string> = {
  min_qty: '최소안', target_qty: '기본안', stretch_qty: '최대안', outsource_qty: '외주', name: '이름', start_date: '시작', freeze_date: '제작 완료 목표',
  release_date: '출시', priority: '우선순위', days: '1개당 인·일', spent_days: '실투입', status: '상태', update_type_id: '유형', headcount: '인원', utilization: '가동률',
  productivity: '생산성', outsource_days: '외주', support_days: '지원', completed_qty: '완료', horizon: '계획 기간', share: '비율', overlap_rate: '겹침률',
  sort_order: '순서', active: '사용', group_id: '분류', rework_rate: '재작업률', buffer_rate: '여유율', work_weekdays: '근무 요일', value: '값',
  tier: '포함 템플릿', batch_id: '배치', jira_key: 'Jira', code: '에셋 코드', category: '세부 분류', team: '소속팀', email: '이메일', important: '중요', pipeline_id: '파이프라인', seq: '단계 순서', note: '메모', due_date: '마감일', done_at: '완료일', started_at: '시작일',
  assignee: '담당', retakes: '리테이크', as_of: '기준일', image: '이미지', url: '주소', title: '제목', body: '내용',
};

/** targetName · fieldName · where · oldText · nextText = 사람이 읽는 이름과 값(표 이름 · 칸 이름 · 리소스 · 파트 · 달 이름, 비율은 %, docs/34 A-05) */
export interface HistoryEntry { logId: number; action: string; target: string; key: string; field: string | null; old: unknown; next: unknown;
  targetName: string; fieldName: string; where: string; oldText: string; nextText: string }

/** 비율(0 ~ 1)로 적힌 칸: %로 보인다 */
const RATIO_FIELDS = new Set(['utilization', 'share', 'overlap_rate', 'rework_rate', 'buffer_rate', 'reuse_rate', 'default_overlap_rate', 'load_warn_rate', 'load_over_rate', 'load_critical_rate']);
const showValue = (field: string | null, v: unknown): string => {
  if (v === undefined) return '—';
  if (v === null) return '빈칸';
  if (typeof v === 'number' && field && RATIO_FIELDS.has(field)) return `${Math.round(v * 1000) / 10}%`;
  if (typeof v === 'object') {
    // 행 전체(더함 · 지움): 이름이 있으면 이름, 없으면 칸 몇 개만
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    return Object.entries(o).filter(([k, x]) => x != null && typeof x !== 'object' && !k.endsWith('_id')).slice(0, 3)
      .map(([k, x]) => `${FIELD_NAME[k] ?? k} ${typeof x === 'number' && RATIO_FIELDS.has(k) ? `${Math.round(x * 1000) / 10}%` : x}`).join(' · ') || '행';
  }
  if (v === 1 && field === 'active') return '사용';
  if (v === 0 && field === 'active') return '사용 안 함';
  return String(v);
};
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
  const MODE = readModeNames(db);
  const QTY_NAME: Record<string, string> = { min_qty: MODE.MIN, target_qty: MODE.TARGET, stretch_qty: MODE.STRETCH };
  const total = Number(db.get('SELECT count(DISTINCT batch_id) AS n FROM change_log')?.n ?? 0);
  const ids = db.all('SELECT batch_id, min(log_id) AS first FROM change_log GROUP BY batch_id ORDER BY first DESC LIMIT ?', [limit]).map(r => String(r.batch_id));
  const undoneSet = new Set(db.all("SELECT DISTINCT reason FROM change_log WHERE reason LIKE '되돌리기: %'").map(r => String(r.reason).slice('되돌리기: '.length)));
  // 키 조각 → 이름(리소스 · 파트 · 업데이트 · 배치 · 에셋 · 파이프라인 · 작업자 · 분류 · 유형)
  const names = new Map<string, string>();
  for (const [t, idc] of [['resource_types', 'resource_type_id'], ['parts', 'part_id'], ['updates', 'update_id'], ['batches', 'batch_id'], ['assets', 'asset_id'],
    ['pipelines', 'pipeline_id'], ['people', 'person_id'], ['resource_groups', 'group_id'], ['update_types', 'update_type_id'], ['teams', 'team_id']] as const) {
    try { for (const r of db.all(`SELECT ${idc} AS id, name FROM ${t}`)) names.set(String(r.id), String(r.name)); } catch { /* 옛 파일에 없는 표 */ }
  }
  const batches = ids.map(id => {
    const rows = db.all('SELECT * FROM change_log WHERE batch_id = ? ORDER BY log_id', [id]);
    const entries: HistoryEntry[] = rows.map(r => {
      const field = r.field == null ? null : String(r.field);
      const old = parse(r.old_json); const next = parse(r.new_json);
      return {
        logId: Number(r.log_id), action: String(r.action), target: String(r.target), key: String(r.target_key), field, old, next,
        targetName: TARGET_NAME[String(r.target)] ?? String(r.target),
        fieldName: field ? QTY_NAME[field] ?? FIELD_NAME[field] ?? field : '—',
        where: String(r.target_key).split('|').map(x => names.get(x) ?? (/^\d{4}-\d{2}$/.test(x) ? `${x.slice(0, 4)}년 ${Number(x.slice(5))}월` : x)).join(' · '),
        oldText: showValue(field, old), nextText: showValue(field, next),
      };
    });
    const kinds = [...new Set(entries.map(e => (e.action === 'UPDATE'
      ? `${TARGET_NAME[e.target] ?? e.target} ${QTY_NAME[e.field ?? ''] ?? FIELD_NAME[e.field ?? ''] ?? e.field ?? ''}`.trim()
      : `${TARGET_NAME[e.target] ?? e.target} ${e.action === 'INSERT' ? '더함' : '지움'}`)))];
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
  if (!cols) throw new Error(`되돌릴 수 없는 대상입니다: ${target}`);
  const parts = key.split('|');
  return { sql: cols.map(c => `${c} = ?`).join(' AND '), params: parts };
}

/** 이 묶음 뒤에 같은 칸을 고친 묶음들(되돌리면 그 값도 덮어쓴다) */
export function laterConflicts(db: SqlDb, batchId: string): string[] {
  const first = Number(db.get('SELECT min(log_id) AS f FROM change_log WHERE batch_id = ?', [batchId])?.f ?? 0);
  // 같은 칸을 고친 뒤 묶음. 만들기·지우기는 같은 행의 어느 칸이든, 그 행에 딸린 행(키가 "그 키|…": 물량·실적·템플릿·인력)까지 충돌로 본다
  return db.all(`SELECT DISTINCT later.batch_id AS b FROM change_log mine JOIN change_log later
      ON (later.target = mine.target AND later.target_key = mine.target_key
          AND (coalesce(later.field, '') = coalesce(mine.field, '') OR mine.action <> 'UPDATE' OR later.action <> 'UPDATE'))
      OR (mine.action <> 'UPDATE' AND substr(later.target_key, 1, length(mine.target_key) + 1) = mine.target_key || '|')
      WHERE mine.batch_id = ? AND later.log_id > ? AND later.batch_id <> ?`, [batchId, first, batchId]).map(r => String(r.b));
}

/** 묶음 하나를 되돌린다. 뒤에 같은 칸을 고친 묶음이 있으면 force 없이는 거절. 되돌린 뒤 검증 오류가 생기면 전부 취소 */
export function undoBatch(db: SqlDb, session: ProjectSession, batchId: string, ctx: { editor: string; batchId: string }, force = false): { reverted: number } {
  const rows = db.all('SELECT * FROM change_log WHERE batch_id = ? ORDER BY log_id DESC', [batchId]);
  if (!rows.length) throw new Error('없는 변경 묶음입니다.');
  if (db.get("SELECT 1 AS ok FROM change_log WHERE reason = ?", [`되돌리기: ${batchId}`])) throw new Error('이미 되돌린 변경입니다.');
  const conflicts = laterConflicts(db, batchId);
  if (conflicts.length && !force) throw new Error(`이 뒤에 같은 칸을 ${conflicts.length}번 더 수정했습니다. 되돌리면 그 값도 덮어씁니다. 그래도 되돌리려면 "그래도 되돌리기"를 누르십시오.`);
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
  // 되돌리기 전부터 있던 오류는 되돌리기를 막지 않는다(되돌려서 새로 생긴 오류만 본다)
  const errKey = (f: { code: string; key: string }) => `${f.code}|${f.key}`;
  const errorsBefore = new Set(validate(db).filter(f => f.level === 'ERROR').map(errKey));
  db.exec('SAVEPOINT undo_batch');
  try {
    for (const r of rows) {
      const target = String(r.target);
      const key = String(r.target_key);
      const field = r.field == null ? null : String(r.field);
      const oldV = parse(r.old_json);
      const newV = parse(r.new_json);
      // 썸네일 이미지는 이력에 넣지 않아 되돌릴 수 없다(바꾼 사실만 남는다)
      if (target === 'asset_thumbs') continue;
      touched.add(target);
      if (r.action === 'UPDATE') {
        if (target === 'settings' && field === 'horizon') {
          const o = oldV as { start: string; end: string };
          db.run('UPDATE settings SET horizon_start_month = ?, horizon_end_month = ? WHERE id = 1', [o.start, o.end]);
          log('UPDATE', target, key, field, newV, oldV);
          continue;
        }
        const w = where(target, key);
        // 칸 이름은 파일에서 읽은 값이라 실제 칸인지 확인한다(조작된 파일로 다른 SQL이 돌지 않게)
        if (!field || !tableColumns(db, target).has(field)) throw new Error(`되돌릴 수 없는 칸입니다: ${target}.${field}`);
        db.run(`UPDATE ${target} SET ${field} = ? WHERE ${w.sql}`, [oldV ?? null, ...w.params]);
        log('UPDATE', target, key, field, newV, oldV);
      } else if (r.action === 'INSERT') {
        const w = where(target, key);
        const now = db.get(`SELECT * FROM ${target} WHERE ${w.sql}`, w.params);
        if (now) {
          // 함께 지워지는 딸린 행도 남긴다(이 되돌리기를 다시 되돌리면 함께 돌아오게)
          const snapshot: Record<string, unknown> = { ...now };
          if (target === 'updates') {
            snapshot.volumes = db.all('SELECT * FROM volumes WHERE update_id = ?', [key]);
            snapshot.progress = db.all('SELECT * FROM progress WHERE update_id = ?', [key]);
            touched.add('volumes'); touched.add('progress');
          } else if (target === 'update_types') {
            snapshot.template = db.all('SELECT * FROM type_templates WHERE update_type_id = ?', [key]);
          } else if (target === 'assets') {
            snapshot.asset_parts = db.all('SELECT * FROM asset_parts WHERE asset_id = ?', [key]);
            snapshot.asset_links = db.all('SELECT * FROM asset_links WHERE asset_id = ?', [key]);
            snapshot.asset_comments = db.all('SELECT * FROM asset_comments WHERE asset_id = ?', [key]);
            snapshot.asset_attrs = db.all('SELECT * FROM asset_attrs WHERE asset_id = ?', [key]);
            db.run('DELETE FROM asset_attrs WHERE asset_id = ?', [key]);
            db.run('DELETE FROM asset_parts WHERE asset_id = ?', [key]);
            db.run('DELETE FROM asset_links WHERE asset_id = ?', [key]);
            db.run('DELETE FROM asset_comments WHERE asset_id = ?', [key]);
            db.run('DELETE FROM asset_thumbs WHERE asset_id = ?', [key]);
          }
          db.run(`DELETE FROM ${target} WHERE ${w.sql}`, w.params);
          log('DELETE', target, key, field, snapshot, undefined);
        }
      } else {
        // 지운 행을 다시 넣는다. 업데이트는 함께 지워진 물량, 유형은 템플릿도
        const row = { ...(oldV as Record<string, unknown>) };
        const children: [string, Record<string, unknown>[]][] = [];
        for (const [k, table] of CHILD_TABLES) {
          if (Array.isArray(row[k])) children.push([table, row[k] as Record<string, unknown>[]]);
          delete row[k];
        }
        if (db.get(`SELECT 1 AS ok FROM ${target} WHERE ${where(target, key).sql}`, where(target, key).params)) {
          throw new Error(`같은 ID(${key})가 이미 있어 되돌릴 수 없습니다.`);
        }
        insertRow(target, row);
        for (const [table, rows2] of children) {
          for (const c of rows2) insertRow(table, c);
          if (rows2.length) touched.add(table);
        }
        log('INSERT', target, key, null, undefined, oldV);
      }
    }
    const errors = validate(db).filter(f => f.level === 'ERROR' && !errorsBefore.has(errKey(f)));
    if (errors.length) {
      throw new Error(`되돌리면 계산할 수 없는 상태가 되어 취소했습니다: ${errors.slice(0, 3).map(e => `${e.title}(${e.key})`).join(', ')}`);
    }
    db.exec('RELEASE undo_batch');
  } catch (error) {
    try { db.exec('ROLLBACK TO undo_batch'); db.exec('RELEASE undo_batch'); } catch { /* 이미 끝남 */ }
    throw error;
  }
  session.markDirty(...([...touched].filter(t => ENGINE.has(t)) as EngineTable[]));
  if (touched.has('settings')) session.markDirty('settings', 'capacity');
  // 배치 예측 입력(docs/33): 에셋 · 에셋 상태 · 배치 · 거치는 파트가 돌아오면 다시 모은다
  if (['assets', 'asset_parts', 'batches', 'resource_parts'].some(t => touched.has(t))) session.markDirty('batches', 'batch_work');
  return { reverted: rows.length };
}
