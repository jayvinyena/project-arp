// 실적 엑셀: 양식 받기(지금 값이 채워진 표) → 채워서 한 번에 넣기. 다른 도구에서 뽑은 표도 머리글·이름으로 맞춘다.
// 넣기는 한 묶음이라 변경 이력에서 한 번에 되돌릴 수 있다.
import type { SqlDb } from './db.ts';
import type { ProjectSession } from './pipeline.ts';
import type { Cell as ReadCell, Sheets } from './xlsx.ts';
import { serialToDate } from './xlsx.ts';
import type { Cell } from './xlsx-write.ts';
import { applyEdit } from './edits.ts';

const HEAD = ['업데이트 ID', '업데이트', '리소스 ID', '리소스', '파트 ID', '파트', '목표', '완료 수량', '실투입 인·일', '기준일'];

/** 양식: 계산 대상 업데이트 × 물량 × 거치는 파트, 지금 값이 채워져 있다 */
export function progressTemplate(db: SqlDb): Record<string, Cell[][]> {
  const rows = db.all(`SELECT u.update_id, u.name AS uname, v.resource_type_id, r.name AS rname, rp.part_id, p.name AS pname, v.target_qty,
        a.completed_qty, a.spent_days, a.as_of
      FROM volumes v JOIN updates u ON u.update_id = v.update_id AND u.status IN ('PLANNED', 'IN_PROGRESS')
      JOIN resource_types r ON r.resource_type_id = v.resource_type_id
      JOIN resource_parts rp ON rp.resource_type_id = v.resource_type_id
      JOIN parts p ON p.part_id = rp.part_id AND p.active = 1
      LEFT JOIN progress a ON a.update_id = v.update_id AND a.resource_type_id = v.resource_type_id AND a.part_id = rp.part_id
      ORDER BY u.priority, u.sort_order, r.sort_order, p.sort_order`);
  return {
    '작업 진척': [HEAD, ...rows.map(x => [x.update_id, x.uname, x.resource_type_id, x.rname, x.part_id, x.pname, x.target_qty, x.completed_qty, x.spent_days, x.as_of] as Cell[])],
    '안내': [
      ['안내'],
      ['"완료 수량"과 "실투입 인·일" 칸만 수정하십시오. 비워 둔 칸은 변경하지 않습니다.'],
      ['0을 입력하면 그 값을 삭제합니다(완료 0 = 아직 없음).'],
      ['ID 칸이 있으면 ID로, 없으면 이름으로 맞춥니다. 다른 도구에서 뽑은 표도 머리글이 비슷하면 입력할 수 있습니다.'],
      ['기준일이 비면 넣는 날의 날짜를 사용합니다.'],
    ],
  };
}

export interface ProgressImportReport {
  rows: number;
  changedCells: number;
  unchanged: number;
  skipped: { row: number; reason: string }[];
}

type Col = 'uid' | 'uname' | 'rid' | 'rname' | 'pid' | 'pname' | 'done' | 'spent' | 'asof';

function columns(head: ReadCell[]): Partial<Record<Col, number>> {
  const out: Partial<Record<Col, number>> = {};
  // 칸 이름 전체로 맞춘다(부분 일치는 "완료일" → 완료 수량, "department" → 파트처럼 잘못 고른다). 공백·_·- 는 무시
  head.forEach((h, i) => {
    const t = String(h ?? '').replace(/[\s_\-]+/g, '').toLowerCase();
    if (!t) return;
    const id = /id$/.test(t);
    if (/^(기준일|기준일자|완료일|완료일자|날짜|일자|asof|date|updatedat)$/.test(t)) out.asof ??= i;
    else if (/^(업데이트|update)(id|명|이름|name)?$/.test(t)) out[id ? 'uid' : 'uname'] ??= i;
    else if (/^(리소스|resource)(종류|type)?(id|명|이름|name)?$/.test(t)) out[id ? 'rid' : 'rname'] ??= i;
    else if (/^(파트|part)(id|명|이름|name)?$/.test(t)) out[id ? 'pid' : 'pname'] ??= i;
    else if (/^(실투입|투입|spent)/.test(t)) out.spent ??= i;
    else if (/^(완료|completed|done)(수량|개수|qty|quantity)?$/.test(t)) out.done ??= i;
  });
  return out;
}

const num = (v: ReadCell): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const date = (v: ReadCell): string | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? serialToDate(v) : null;
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(String(v).trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null; // 달력에 없는 날은 버린다
};

/** 엑셀 작업 진척을 넣는다. 한 묶음(ctx.batchId). 맞지 않는 행은 건너뛰고 이유를 남긴다 */
export function importProgress(db: SqlDb, session: ProjectSession, sheets: Sheets, ctx: { editor: string; batchId: string }, today: string): ProgressImportReport {
  const name = Object.keys(sheets).find(n => n.trim() === '작업 진척' || n.trim() === '실적') ?? Object.keys(sheets)[0];
  const table = name ? sheets[name] : [];
  if (!table || table.length < 2) throw new Error('작업 진척 표가 비었습니다. "양식 받기"로 받은 파일에 채우십시오.');
  const col = columns(table[0]);
  if ((col.uid == null && col.uname == null) || (col.rid == null && col.rname == null) || (col.pid == null && col.pname == null)) {
    throw new Error('업데이트·리소스·파트 칸을 찾지 못했습니다. 머리글에 "업데이트", "리소스", "파트"가 있어야 합니다.');
  }
  if (col.done == null && col.spent == null) throw new Error('"완료 수량"이나 "실투입 인·일" 칸이 없습니다.');
  const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
  const byId = (table2: string, idc: string, namec: string) => {
    const all = db.all(`SELECT ${idc} AS id, ${namec} AS name FROM ${table2}`);
    const ids = new Map(all.map(r => [norm(r.id), String(r.id)]));
    const names = new Map<string, string[]>();
    for (const r of all) { const k = norm(r.name); names.set(k, [...(names.get(k) ?? []), String(r.id)]); }
    return (idv: ReadCell, namev: ReadCell): string | { error: string } => {
      if (idv != null && idv !== '' && ids.has(norm(idv))) return ids.get(norm(idv))!;
      const hit = names.get(norm(namev));
      if (hit?.length === 1) return hit[0];
      if (hit && hit.length > 1) return { error: `이름 "${namev}"이 여러 개라 ID가 필요합니다` };
      return { error: `"${idv ?? namev ?? ''}"을 찾지 못했습니다` };
    };
  };
  const findUpdate = byId('updates', 'update_id', 'name');
  const findResource = byId('resource_types', 'resource_type_id', 'name');
  const findPart = byId('parts', 'part_id', 'name');
  const report: ProgressImportReport = { rows: 0, changedCells: 0, unchanged: 0, skipped: [] };
  const at = (r: ReadCell[], c?: number) => (c == null ? null : r[c] ?? null);
  db.exec('SAVEPOINT import_progress');
  try {
    table.slice(1).forEach((r, i) => {
      const rowNo = i + 2;
      if (!r.some(v => v != null && v !== '')) return;
      const u = findUpdate(at(r, col.uid), at(r, col.uname));
      const rt = findResource(at(r, col.rid), at(r, col.rname));
      const p = findPart(at(r, col.pid), at(r, col.pname));
      const bad = [u, rt, p].find(x => typeof x !== 'string') as { error: string } | undefined;
      if (bad) { report.skipped.push({ row: rowNo, reason: bad.error }); return; }
      const done = num(at(r, col.done));
      const spent = num(at(r, col.spent));
      if (Number.isNaN(done) || Number.isNaN(spent)) { report.skipped.push({ row: rowNo, reason: '숫자가 아닌 값' }); return; }
      if (done == null && spent == null) return;
      const asOf = date(at(r, col.asof)) ?? today;
      report.rows += 1;
      try {
        if (done != null) {
          const res = applyEdit(db, session, { kind: 'progress', updateId: u as string, resourceTypeId: rt as string, partId: p as string, value: Math.round(done), asOf }, ctx);
          if (res.changed) report.changedCells += 1; else report.unchanged += 1;
        }
        if (spent != null) {
          const res = applyEdit(db, session, { kind: 'progressSpent', updateId: u as string, resourceTypeId: rt as string, partId: p as string, value: spent, asOf }, ctx);
          if (res.changed) report.changedCells += 1; else report.unchanged += 1;
        }
      } catch (error) {
        report.rows -= 1;
        report.skipped.push({ row: rowNo, reason: (error as Error).message });
      }
    });
    db.exec('RELEASE import_progress');
  } catch (error) {
    db.exec('ROLLBACK TO import_progress');
    db.exec('RELEASE import_progress');
    throw error;
  }
  return report;
}
