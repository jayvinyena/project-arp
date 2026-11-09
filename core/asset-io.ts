// 에셋 엑셀: 지금 에셋 · 배치를 표로 받기 → 고치거나 채워서 한 번에 넣기(docs/20-asset-management.md 11절 1번 양식).
// 넣기는 한 묶음이라 변경 이력에서 한 번에 되돌릴 수 있다. 썸네일은 엑셀에 넣지 않는다.
import type { SqlDb } from './db.ts';
import type { ProjectSession } from './pipeline.ts';
import type { Cell as ReadCell, Sheets } from './xlsx.ts';
import { serialToDate } from './xlsx.ts';
import type { StyledCell } from './xlsx-write.ts';
import { applyEdit } from './edits.ts';
import type { AssetStatus, Tier } from './assets.ts';
import { ASSET_STATUSES, STATUS_LABEL } from './assets.ts';
import { readModeNames } from './modes.ts';

type C = string | number | null | StyledCell;
const head = (v: string, req = false): StyledCell => ({ v: req ? `${v} *` : v, s: req ? 'req' : 'opt' });
const note = (v: string): StyledCell => ({ v: `※ ${v}`, s: 'note' });

/** 에셋 · 배치 표(지금 값). 업데이트를 고르면 그 업데이트만 */
export function assetBook(db: SqlDb, updateId: string | null = null): { sheets: Record<string, C[][]>; freezeRows: Record<string, number> } {
  const MODE = readModeNames(db);
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(p => ({ id: String(p.part_id), name: String(p.name) }));
  const where = updateId ? 'WHERE a.update_id = ?' : '';
  const assets = db.all(`SELECT a.*, u.name AS uname, r.name AS rname, coalesce(g.name, '') AS gname, b.name AS bname FROM assets a
      JOIN updates u ON u.update_id = a.update_id JOIN resource_types r ON r.resource_type_id = a.resource_type_id
      LEFT JOIN resource_groups g ON g.group_id = r.group_id LEFT JOIN batches b ON b.batch_id = a.batch_id
      ${where} ORDER BY u.priority, u.sort_order, coalesce(g.sort_order, 999999), r.sort_order, coalesce(b.sort_order, 999999), a.sort_order`, updateId ? [updateId] : []);
  const states = new Map<string, Record<string, unknown>>();
  for (const s of db.all('SELECT * FROM asset_parts')) states.set(`${s.asset_id}|${s.part_id}`, s);
  const passes = new Set(db.all('SELECT resource_type_id, part_id FROM resource_parts').map(r => `${r.resource_type_id}|${r.part_id}`));
  const partHead = parts.flatMap(p => [head(`${p.name} 상태`), head(`${p.name} 완료일`), head(`${p.name} Jira`)]);
  const assetRows: C[][] = [
    [head('에셋 ID'), head('마일스톤', true), head('분류'), head('리소스 종류', true), head('에셋 이름', true), head('코드'), head('배치'), head('포함 템플릿'), head('에셋 Jira'), ...partHead, head('메모')],
    [note('새 에셋은 ID를 비웁니다'), note('업데이트 이름'), note('참고용'), note('리소스 이름'), null, null, note('없으면 새로 만듭니다'), note(`${MODE.MIN} · ${MODE.TARGET} · ${MODE.STRETCH}`), note('ABC-123'),
      ...parts.flatMap((_, i) => (i === 0 ? [note(ASSET_STATUSES.map(s => STATUS_LABEL[s]).join(' · ')), note('YYYY-MM-DD'), null] : [null, null, null])), null],
    ...assets.map(a => {
      const id = String(a.asset_id);
      return [
        id, String(a.uname), String(a.gname), String(a.rname), String(a.name), (a.code as string) ?? null, (a.bname as string) ?? null,
        MODE[a.tier as Tier], (a.jira_key as string) ?? null,
        ...parts.flatMap(p => {
          if (!passes.has(`${a.resource_type_id}|${p.id}`)) return [null, null, null];
          const s = states.get(`${id}|${p.id}`);
          return [STATUS_LABEL[(s?.status as AssetStatus) ?? 'TODO'], (s?.done_at as string) ?? null, (s?.jira_key as string) ?? null];
        }),
        (a.note as string) ?? null,
      ] as C[];
    }),
  ];
  const batches = db.all(`SELECT b.*, u.name AS uname FROM batches b JOIN updates u ON u.update_id = b.update_id ${updateId ? 'WHERE b.update_id = ?' : ''}
      ORDER BY u.priority, b.sort_order`, updateId ? [updateId] : []);
  const batchRows: C[][] = [
    [head('마일스톤', true), head('배치', true), head('마감일'), head('순서'), head('메모')],
    [note('업데이트 이름'), null, note('YYYY-MM-DD'), note('작을수록 먼저'), null],
    ...batches.map(b => [String(b.uname), String(b.name), (b.due_date as string) ?? null, Number(b.sort_order), (b.note as string) ?? null] as C[]),
  ];
  return {
    sheets: {
      '에셋': assetRows,
      '배치': batchRows,
      '안내': [
        [{ v: '에셋 엑셀', s: 'title' }],
        ['"에셋" 시트에서 이름 · 배치 · 포함 템플릿 · 파트별 상태 · 완료일 · Jira 키를 고치거나 새 행을 더한 뒤 "엑셀 넣기"로 넣습니다.'],
        ['에셋 ID가 있으면 그 에셋을 고치고, 비어 있으면 마일스톤 · 리소스 종류 · 에셋 이름으로 찾거나 새로 만듭니다.'],
        [`상태: ${ASSET_STATUSES.map(s => STATUS_LABEL[s]).join(' · ')}. "완료"와 "해당 없음"이 작업 진척의 완료 수량에 들어갑니다.`],
        ['완료일이 비어 있으면 넣는 날의 날짜를 사용합니다. 비워 둔 칸은 변경하지 않습니다(지우기는 앱에서 합니다).'],
        ['배치는 "배치" 시트에 없어도 에셋 행에 이름을 적으면 새로 만듭니다.'],
      ],
    },
    freezeRows: { '에셋': 2, '배치': 2 },
  };
}

export interface AssetImportReport { created: number; changed: number; unchanged: number; batches: number; skipped: { row: number; reason: string }[] }

const norm = (s: unknown) => String(s ?? '').replace(/[\s_\-*]+/g, '').toLowerCase();
const text = (v: ReadCell): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim());
const date = (v: ReadCell): string | null | 'bad' => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? serialToDate(v) : 'bad';
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(String(v).trim());
  if (!m) return 'bad';
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : 'bad';
};

/** 에셋 엑셀 넣기. 한 묶음(ctx.batchId). 맞지 않는 행은 건너뛰고 이유를 남긴다 */
export function importAssets(db: SqlDb, session: ProjectSession, sheets: Sheets, ctx: { editor: string; batchId: string }, today: string): AssetImportReport {
  const MODE = readModeNames(db);
  const report: AssetImportReport = { created: 0, changed: 0, unchanged: 0, batches: 0, skipped: [] };
  const sheet = (name: string) => sheets[Object.keys(sheets).find(n => n.trim() === name) ?? ''] ?? null;
  const assetsT = sheet('에셋') ?? sheet('assets');
  if (!assetsT || assetsT.length < 2) throw new Error('"에셋" 시트가 없거나 비었습니다. "엑셀 받기"로 받은 파일에 채우십시오.');
  const updates = db.all('SELECT update_id, name FROM updates');
  const findUpdate = (v: ReadCell) => updates.find(u => norm(u.update_id) === norm(v)) ?? updates.find(u => norm(u.name) === norm(v));
  const resources = db.all('SELECT resource_type_id, name FROM resource_types');
  const findResource = (v: ReadCell) => resources.find(r => norm(r.resource_type_id) === norm(v)) ?? resources.find(r => norm(r.name) === norm(v));
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1').map(p => ({ id: String(p.part_id), name: String(p.name) }));
  const statusOf = (v: ReadCell): AssetStatus | null | 'bad' => {
    const t = text(v);
    if (t == null) return null;
    const hit = ASSET_STATUSES.find(s => norm(s) === norm(t) || norm(STATUS_LABEL[s]) === norm(t) || (s === 'REVIEW' && norm(t) === '검수'));
    return hit ?? 'bad';
  };
  const tierOf = (v: ReadCell): Tier | null | 'bad' => {
    const t = text(v);
    if (t == null) return null;
    const hit = (['MIN', 'TARGET', 'STRETCH'] as Tier[]).find(m => norm(m) === norm(t) || norm(MODE[m]) === norm(t));
    return hit ?? 'bad';
  };
  const run = (edit: Parameters<typeof applyEdit>[2]) => applyEdit(db, session, edit, ctx);
  const batchId = (updateId: string, name: string, due: string | null = null): string => {
    const hit = db.get('SELECT batch_id FROM batches WHERE update_id = ? AND name = ?', [updateId, name]);
    if (hit) return String(hit.batch_id);
    report.batches += 1;
    return run({ kind: 'createBatch', updateId, name, dueDate: due }).createdId!;
  };

  db.exec('SAVEPOINT import_assets');
  try {
    // 배치 시트(있으면): 마감일 · 순서 · 메모
    const batchT = sheet('배치');
    if (batchT && batchT.length > 1) {
      const h = batchT[0].map(norm);
      const ci = (re: RegExp) => h.findIndex(x => re.test(x));
      const cu = ci(/^(마일스톤|업데이트|milestone|update)/); const cb = ci(/^(배치|batch)/); const cd = ci(/^(마감일|due)/); const cn = ci(/^(메모|note)/);
      batchT.slice(1).forEach((r, i) => {
        if (!r.some(v => v != null && v !== '') || String(r[0] ?? '').startsWith('※')) return;
        const u = findUpdate(r[cu]);
        const name = text(r[cb]);
        if (!u || !name) { report.skipped.push({ row: i + 2, reason: '배치 시트: 마일스톤이나 배치 이름을 찾지 못했습니다' }); return; }
        const due = cd >= 0 ? date(r[cd]) : null;
        if (due === 'bad') { report.skipped.push({ row: i + 2, reason: '배치 시트: 마감일 형식이 올바르지 않습니다' }); return; }
        const id = batchId(String(u.update_id), name, due);
        if (due) run({ kind: 'batchField', batchId: id, field: 'due_date', value: due });
        if (cn >= 0 && text(r[cn])) run({ kind: 'batchField', batchId: id, field: 'note', value: text(r[cn]) });
      });
    }

    const h = assetsT[0].map(norm);
    const ci = (re: RegExp) => h.findIndex(x => re.test(x));
    const col = {
      id: ci(/^(에셋id|assetid)$/), u: ci(/^(마일스톤|업데이트|milestone|update)$/), rt: ci(/^(리소스종류|리소스|resourcetype|resource)$/),
      name: ci(/^(에셋이름|에셋|이름|assetname|name)$/), code: ci(/^(코드|code)$/), batch: ci(/^(배치|batch)$/), tier: ci(/^(포함템플릿|템플릿|tier)$/),
      jira: ci(/^(에셋jira|jira|jirakey)$/), note: ci(/^(메모|note)$/),
    };
    if (col.u < 0 || col.rt < 0 || col.name < 0) throw new Error('"마일스톤", "리소스 종류", "에셋 이름" 칸을 찾지 못했습니다.');
    const partCols = parts.map(p => ({
      ...p,
      status: h.findIndex(x => x === norm(`${p.name}상태`) || x === norm(p.name)),
      done: h.findIndex(x => x === norm(`${p.name}완료일`)),
      jira: h.findIndex(x => x === norm(`${p.name}jira`)),
    }));

    assetsT.slice(1).forEach((r, i) => {
      const rowNo = i + 2;
      if (!r.some(v => v != null && v !== '') || String(r[0] ?? '').startsWith('※') || String(r[col.u] ?? '').startsWith('※')) return;
      const before = Number(db.get('SELECT count(*) AS n FROM change_log WHERE batch_id = ?', [ctx.batchId])?.n ?? 0);
      try {
        db.exec('SAVEPOINT asset_row');
        const u = findUpdate(r[col.u]);
        if (!u) throw new Error(`마일스톤 "${r[col.u] ?? ''}"을 찾지 못했습니다`);
        const rt = findResource(r[col.rt]);
        if (!rt) throw new Error(`리소스 종류 "${r[col.rt] ?? ''}"을 찾지 못했습니다`);
        const name = text(r[col.name]);
        if (!name) throw new Error('에셋 이름이 비었습니다');
        const tier = col.tier >= 0 ? tierOf(r[col.tier]) : null;
        if (tier === 'bad') throw new Error(`포함 템플릿 "${r[col.tier]}"을 알 수 없습니다`);
        const updateId = String(u.update_id);
        const rtId = String(rt.resource_type_id);
        // 찾기: 에셋 ID → (마일스톤 · 리소스 · 이름)
        let asset = col.id >= 0 && text(r[col.id]) ? db.get('SELECT * FROM assets WHERE asset_id = ?', [text(r[col.id])]) : undefined;
        if (asset && (asset.update_id !== updateId)) throw new Error('에셋 ID의 마일스톤이 다릅니다(마일스톤은 앱에서 바꾸지 않습니다)');
        asset ??= db.get('SELECT * FROM assets WHERE update_id = ? AND resource_type_id = ? AND name = ?', [updateId, rtId, name]);
        const bName = col.batch >= 0 ? text(r[col.batch]) : null;
        const bId = bName ? batchId(updateId, bName) : null;
        let id: string;
        if (!asset) {
          id = run({ kind: 'createAssets', updateId, resourceTypeId: rtId, names: [name], batchId: bId, tier: tier ?? 'TARGET' }).createdId!;
        } else {
          id = String(asset.asset_id);
          if (asset.resource_type_id !== rtId) throw new Error('에셋 ID의 리소스 종류가 다릅니다');
          run({ kind: 'assetField', assetIds: [id], field: 'name', value: name });
          if (bName) run({ kind: 'assetField', assetIds: [id], field: 'batch_id', value: bId });
          if (tier) run({ kind: 'assetField', assetIds: [id], field: 'tier', value: tier });
        }
        for (const [f, c] of [['code', col.code], ['jira_key', col.jira], ['note', col.note]] as const) {
          if (c >= 0 && text(r[c]) != null) run({ kind: 'assetField', assetIds: [id], field: f, value: text(r[c]) });
        }
        const steps = new Set(db.all('SELECT part_id FROM resource_parts WHERE resource_type_id = ?', [rtId]).map(x => String(x.part_id)));
        for (const p of partCols) {
          if (!steps.has(p.id)) continue;
          const st = p.status >= 0 ? statusOf(r[p.status]) : null;
          if (st === 'bad') throw new Error(`${p.name} 상태 "${r[p.status]}"을 알 수 없습니다`);
          const d = p.done >= 0 ? date(r[p.done]) : null;
          if (d === 'bad') throw new Error(`${p.name} 완료일 형식이 올바르지 않습니다`);
          const jira = p.jira >= 0 ? text(r[p.jira]) : null;
          if (st == null && d == null && jira == null) continue;
          run({ kind: 'assetPart', assetIds: [id], partId: p.id, ...(st ? { status: st } : {}), ...(st === 'DONE' || d ? { doneAt: d ?? today } : {}), ...(jira ? { jiraKey: jira } : {}) });
        }
        db.exec('RELEASE asset_row');
        const after = Number(db.get('SELECT count(*) AS n FROM change_log WHERE batch_id = ?', [ctx.batchId])?.n ?? 0);
        if (!asset) report.created += 1;
        else if (after > before) report.changed += 1;
        else report.unchanged += 1;
      } catch (error) {
        db.exec('ROLLBACK TO asset_row');
        db.exec('RELEASE asset_row');
        report.skipped.push({ row: rowNo, reason: (error as Error).message });
      }
    });
    db.exec('RELEASE import_assets');
  } catch (error) {
    db.exec('ROLLBACK TO import_assets');
    db.exec('RELEASE import_assets');
    throw error;
  }
  return report;
}
