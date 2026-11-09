// 팀 제작 리스트(구글 시트를 .xlsx로 받은 것) 형식 그대로 가져오기 — docs/20-asset-management.md 19절.
// 1) scanSheetBook: 시트마다 머리글 행을 찾아 칸의 뜻(마일스톤 · 분류 · 이름 · 리소스명 · 파트 상태 …)을 알아보고,
//    가져오기 창에서 고를 것(마일스톤 → 업데이트, 시트 · 분류 → 리소스 종류, 모르는 상태 말)을 모은다.
// 2) importSheetBook: 고른 대응대로 에셋을 만들거나 고친다. 한 묶음이라 변경 이력에서 한 번에 되돌린다.
import type { SqlDb } from './db.ts';
import type { ProjectSession } from './pipeline.ts';
import type { Cell, Sheets, SheetLinks } from './xlsx.ts';
import { applyEdit } from './edits.ts';
import type { AssetStatus } from './assets.ts';
import { DATE } from './edits.ts';

const norm = (s: unknown) => String(s ?? '').replace(/[\s_\-*·.:()/[\]]+/g, '').toLowerCase();
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const text = (v: Cell | undefined): string | null => {
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? '예' : null;
  const t = clean(v);
  return t ? t : null;
};

/** 파트 머리글의 다른 이름(파트 이름과 같은 묶음이면 그 파트) */
const PART_ALIASES = [
  ['원화', '컨셉', '컨셉아트', 'concept', 'conceptart', '일러스트'],
  ['모델링', '모델', 'model', 'modeling', '3d'],
  ['애니', '애니메이션', 'animation', 'anim', '모션'],
  ['fx', '이펙트', 'vfx', 'effect', 'effects'],
];
const COL = {
  milestone: /^(마일스톤|milestone|업데이트|목표마일스톤)$/,
  major: /^(대분류)$/,
  minor: /^(분류|소분류|중분류|종류)$/,
  name: /^(이름|에셋이름|에셋명|캐릭터명|캐릭터이름|쿠키이름|쿠키명|명칭|name)$/,
  code: /^(리소스명|리소스이름|파일명|resourcename|코드)$/,
  spec: /^(기획서|기획|기획문서|spec)$/,
  epic: /^(관련에픽|에픽|에픽링크|에픽키|jira|지라|jira링크|epic)$/,
  note: /^(비고|메모|note|설명)$/,
  ignore: /^(#|no|번호|순번|썸네일|이미지|thumbnail|image)$/,
};
/** 상태 말 → 상태. null = 바꾸지 않음(빈칸 · 체크 안 함) */
const WORDS: [RegExp, AssetStatus][] = [
  [/^(완료|완성|done|complete|completed|o|ㅇ|v|✓|✔|예)$/, 'DONE'],
  [/^(없음|해당없음|x|-|–|—|n\/a|na|불필요|미사용|제외)$/, 'OMIT'],
  [/^(진행|진행중|작업|작업중|제작중|wip|inprogress)$/, 'WIP'],
  [/^(검수|검수요청|검수중|컨펌|컨펌요청|컨펌대기|리뷰|review)$/, 'REVIEW'],
  [/^(수정|수정중|리테이크|retake)$/, 'RETAKE'],
  [/^(보류|홀드|hold)$/, 'HOLD'],
  [/^(대기|예정|미착수|미진행|todo)$/, 'TODO'],
];
export function statusWord(v: Cell | undefined): AssetStatus | null | 'unknown' {
  if (v == null || v === false) return null;
  if (v === true) return 'DONE';
  const t = String(v).replace(/\s+/g, '').toLowerCase();
  if (!t) return null;
  return WORDS.find(([re]) => re.test(t))?.[1] ?? 'unknown';
}
const JIRA_IN = /\b([A-Z][A-Z0-9_]+-\d+)\b/;

interface Layout {
  sheet: string; header: number;
  milestone: number; major: number; minor: number; name: number; code: number; spec: number; note: number;
  epic: number[];
  parts: { col: number; partId: string }[];
  /** "원화 담당" 같은 파트별 담당 칸 */
  assign: { col: number; partId: string }[];
  attrs: { col: number; name: string }[];
}

function layoutOf(sheet: string, rows: Cell[][], parts: { id: string; name: string }[]): Layout | string {
  const partOf = (h: string) => {
    const n = norm(h);
    if (!n) return null;
    return parts.find(p => norm(p.name) === n || PART_ALIASES.some(g => g.includes(norm(p.name)) && g.includes(n)))?.id ?? null;
  };
  for (let r0 = 0; r0 < Math.min(rows.length, 15); r0 += 1) {
    const top = (rows[r0] ?? []).map(c => clean(c));
    if (!top.some(x => COL.name.test(norm(x)))) continue;
    // 머리글이 두 줄이면(위: "파트 상태" 같은 묶음, 아래: 원화 · 모델링 …) 아래 줄 이름을 쓴다
    const below = (rows[r0 + 1] ?? []).map(c => clean(c));
    const twoRows = !top.some(x => partOf(x)) && below.some(x => partOf(x));
    const r = twoRows ? r0 + 1 : r0;
    const h = twoRows ? Array.from({ length: Math.max(top.length, below.length) }, (_, i) => below[i] || top[i] || '') : top;
    const nameCol = h.findIndex(x => COL.name.test(norm(x)));
    const found = h.map((x, i) => ({ i, p: partOf(x) })).filter(x => x.p);
    const seen = new Set<string>();
    const partCols = found.filter(x => (seen.has(x.p!) ? false : (seen.add(x.p!), true))).map(x => ({ col: x.i, partId: x.p! }));
    if (!partCols.length) return '파트 상태 칸(원화 · 모델링 · 애니 · FX)이 없습니다';
    const find = (re: RegExp) => h.findIndex(x => re.test(norm(x)));
    const L: Layout = {
      sheet, header: r, name: nameCol, milestone: find(COL.milestone), major: find(COL.major), minor: find(COL.minor),
      code: find(COL.code), spec: find(COL.spec), note: find(COL.note),
      epic: h.map((x, i) => (COL.epic.test(norm(x)) ? i : -1)).filter(i => i >= 0),
      parts: partCols, attrs: [],
      assign: h.map((x, i) => {
        const m = /^(.+?)(담당자|담당|작업자)$/.exec(norm(x));
        const p = m ? partOf(m[1]) : null;
        return p ? { col: i, partId: p } : null;
      }).filter((x): x is { col: number; partId: string } => !!x),
    };
    const used = new Set([L.name, L.milestone, L.major, L.minor, L.code, L.spec, L.note, ...L.epic, ...found.map(x => x.i), ...L.assign.map(x => x.col)]);
    const names = new Set<string>();
    h.forEach((x, i) => {
      if (used.has(i) || !x || COL.ignore.test(norm(x))) return;
      const n = x.replace(/\|/g, '/').slice(0, 40);
      if (names.has(n)) return;
      names.add(n);
      L.attrs.push({ col: i, name: n });
    });
    return L;
  }
  return '"이름" 머리글을 찾지 못했습니다';
}

export interface SheetScan {
  sheets: { name: string; included: boolean; reason: string | null; rows: number; parts: string[]; columns: string[]; attrs: string[] }[];
  /** (시트 · 대분류 · 분류) → 리소스 종류. key = JSON [시트, 대분류, 분류] */
  keys: {
    key: string; sheet: string; label: string; count: number; guess: string | null;
    /** 새 리소스 종류로 만들 때 제안(분류 = 시트 이름, 이름 = 대분류 · 분류) · 거치는 파트(그 시트의 파트 칸) */
    suggest: { group: string; name: string }; parts: string[];
  }[];
  milestones: { value: string; count: number; guess: string | null }[];
  /** 알아보지 못한 파트 상태 말 */
  unknownWords: { word: string; count: number }[];
  /** (마일스톤 값 · 키)별 행 수: 고른 대응으로 몇 행이 들어갈지 미리 센다 */
  pairs: { ms: string; key: string; count: number }[];
  updates: { updateId: string; name: string }[];
  resources: { resourceTypeId: string; name: string; group: string }[];
  /** 지금 물량에 있는 "업데이트|리소스" */
  volumes: string[];
  rows: number;
}
/** resources 값: 리소스 종류 ID · ''(건너뛰기) · NEW_RESOURCE(create의 분류 · 이름으로 새로 만들기) */
export const NEW_RESOURCE = '+new';
export interface SheetPlan {
  milestones: Record<string, string>;
  resources: Record<string, string>;
  /** 새로 만들 리소스 종류(키 → 분류 · 이름). 이름이 같으면 하나로, 이미 있으면 그 종류를 쓴다 */
  create?: Record<string, { group: string; name: string }>;
  words: Record<string, AssetStatus | ''>;
  /** 시트에서 "완료"인 파트의 완료일 */
  doneDate: string;
  /** 물량에 없는 리소스는 물량에 더하고 에셋 수에 맞춘다 */
  addVolumes: boolean;
}
export interface SheetImportReport {
  created: number; changed: number; unchanged: number; volumesAdded: number; jiraBaseSet: boolean;
  /** 새로 만든 리소스 종류(공수 0 — 데이터 점검 E08에서 채운다) */
  resourcesCreated: string[];
  skipped: { sheet: string; row: number; reason: string }[];
}

const NO_MS = '(비어 있음)';
const rowsOf = (rows: Cell[][], L: Layout) => rows.slice(L.header + 1)
  .map((r, i) => ({ r: r ?? [], no: L.header + i + 2 }))
  .filter(x => text(x.r[L.name]) != null);
const keyOf = (L: Layout, r: Cell[]) => JSON.stringify([L.sheet, L.major >= 0 ? text(r[L.major]) ?? '' : '', L.minor >= 0 ? text(r[L.minor]) ?? '' : '']);
const msOf = (L: Layout, r: Cell[]) => (L.milestone >= 0 ? text(r[L.milestone]) : null) ?? NO_MS;

function partsOf(db: SqlDb) {
  return db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(p => ({ id: String(p.part_id), name: String(p.name) }));
}

/** 이름이 비슷한 리소스 종류(분류 → 대분류 → 시트 이름 순으로 가장 구체적인 것) */
function guessResource(resources: SheetScan['resources'], sheet: string, major: string, minor: string): string | null {
  const tries = [major && minor ? `${major}${minor}` : '', minor, major, sheet, ...sheet.split(/[_/·]+/).reverse()].map(norm).filter(t => t.length >= 2);
  for (const t of tries) {
    const hit = resources.find(r => norm(r.name) === t) ?? resources.find(r => norm(`${r.group}${r.name}`) === t);
    if (hit) return hit.resourceTypeId;
  }
  for (const t of tries) {
    const hit = resources.find(r => norm(r.name).length >= 2 && (norm(r.name).includes(t) || t.includes(norm(r.name))));
    if (hit) return hit.resourceTypeId;
  }
  return null;
}
function guessUpdate(updates: SheetScan['updates'], value: string): string | null {
  if (value === NO_MS) return null;
  const v = norm(value);
  const exact = updates.find(u => norm(u.name) === v || norm(u.updateId) === v);
  if (exact) return exact.updateId;
  const tokens = (s: string) => s.toLowerCase().split(/[^0-9a-z가-힣]+/).filter(Boolean);
  return updates.find(u => tokens(u.name).includes(v) || tokens(u.updateId).includes(v))?.updateId ?? null;
}

/** 이 파일이 ARP 에셋 양식(에셋 엑셀 받기로 받은 것)인가 */
export function isArpAssetBook(sheets: Sheets): boolean {
  const t = sheets[Object.keys(sheets).find(n => n.trim() === '에셋') ?? ''];
  return !!t && (t[0] ?? []).some(c => /^(에셋id|리소스종류)$/.test(norm(c)));
}

export function scanSheetBook(db: SqlDb, sheets: Sheets): SheetScan {
  const parts = partsOf(db);
  const partName = new Map(parts.map(p => [p.id, p.name]));
  const updates = db.all(`SELECT update_id, name FROM updates ORDER BY CASE WHEN status IN ('PLANNED', 'IN_PROGRESS') THEN 0 ELSE 1 END, priority, sort_order`)
    .map(u => ({ updateId: String(u.update_id), name: String(u.name) }));
  const resources = db.all(`SELECT r.resource_type_id, r.name, coalesce(g.name, '') AS g FROM resource_types r LEFT JOIN resource_groups g ON g.group_id = r.group_id
      WHERE r.active = 1 ORDER BY coalesce(g.sort_order, 999999), r.sort_order`).map(r => ({ resourceTypeId: String(r.resource_type_id), name: String(r.name), group: String(r.g) }));
  const out: SheetScan = { sheets: [], keys: [], milestones: [], unknownWords: [], pairs: [], updates, resources, rows: 0,
    volumes: db.all('SELECT update_id, resource_type_id FROM volumes').map(v => `${v.update_id}|${v.resource_type_id}`) };
  const pairs = new Map<string, number>();
  const keys = new Map<string, SheetScan['keys'][number]>();
  const ms = new Map<string, number>();
  const words = new Map<string, number>();
  for (const [name, rows] of Object.entries(sheets)) {
    const L = layoutOf(name, rows, parts);
    if (typeof L === 'string') { out.sheets.push({ name, included: false, reason: L, rows: 0, parts: [], columns: [], attrs: [] }); continue; }
    const list = rowsOf(rows, L);
    const columns = [
      L.milestone >= 0 ? '마일스톤' : '', L.major >= 0 ? '대분류' : '', L.minor >= 0 ? '분류' : '', '이름', L.code >= 0 ? '리소스명' : '',
      L.spec >= 0 ? '기획서' : '', L.epic.length ? '에픽(Jira)' : '', L.note >= 0 ? '비고' : '',
    ].filter(Boolean);
    out.sheets.push({ name, included: list.length > 0, reason: list.length ? null : '이름이 적힌 행이 없습니다', rows: list.length, parts: L.parts.map(p => partName.get(p.partId) ?? p.partId), columns: [...columns, ...L.assign.map(a => `${partName.get(a.partId)} 담당`)], attrs: L.attrs.map(a => a.name) });
    for (const { r } of list) {
      out.rows += 1;
      const k = keyOf(L, r);
      if (!keys.has(k)) {
        const [, major, minor] = JSON.parse(k) as string[];
        const label = [major, minor].filter(Boolean).join(' · ');
        keys.set(k, { key: k, sheet: name, label: label || '(분류 없음)', count: 0, guess: guessResource(resources, name, major, minor), suggest: { group: name, name: label || name }, parts: L.parts.map(p => p.partId) });
      }
      keys.get(k)!.count += 1;
      const m = msOf(L, r);
      ms.set(m, (ms.get(m) ?? 0) + 1);
      const pk = JSON.stringify([m, k]);
      pairs.set(pk, (pairs.get(pk) ?? 0) + 1);
      for (const p of L.parts) {
        if (statusWord(r[p.col]) === 'unknown') { const w = clean(r[p.col]); words.set(w, (words.get(w) ?? 0) + 1); }
      }
    }
  }
  out.keys = [...keys.values()];
  // 제안 이름이 다른 줄 · 기존 종류와 겹치면 앞에 시트 이름을 붙인다
  const taken = new Set(resources.map(r => norm(r.name)));
  const count = new Map<string, number>();
  for (const k of out.keys) count.set(norm(k.suggest.name), (count.get(norm(k.suggest.name)) ?? 0) + 1);
  for (const k of out.keys) {
    const n = norm(k.suggest.name);
    if ((taken.has(n) && !k.guess) || (count.get(n) ?? 0) > 1) {
      if (k.suggest.name !== k.sheet) k.suggest = { ...k.suggest, name: `${k.sheet} ${k.suggest.name}` };
    }
  }
  out.pairs = [...pairs.entries()].map(([pk, count]) => { const [m, key] = JSON.parse(pk) as string[]; return { ms: m, key, count }; });
  out.milestones = [...ms.entries()].map(([value, count]) => ({ value, count, guess: guessUpdate(updates, value) }))
    .sort((a, b) => (a.value === NO_MS ? 1 : b.value === NO_MS ? -1 : a.value.localeCompare(b.value, 'ko', { numeric: true })));
  out.unknownWords = [...words.entries()].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count);
  return out;
}

export function importSheetBook(db: SqlDb, session: ProjectSession, sheets: Sheets, links: SheetLinks, plan: SheetPlan,
  ctx: { editor: string; batchId: string }): SheetImportReport {
  if (!DATE.test(plan.doneDate)) throw new Error('완료일 형식은 YYYY-MM-DD입니다.');
  const report: SheetImportReport = { created: 0, changed: 0, unchanged: 0, volumesAdded: 0, jiraBaseSet: false, resourcesCreated: [], skipped: [] };
  const parts = partsOf(db);
  const run = (edit: Parameters<typeof applyEdit>[2]) => applyEdit(db, session, edit, ctx);
  const added = new Set<string>(); // 물량에 새로 더한 업데이트|리소스
  const logCount = () => Number(db.get('SELECT count(*) AS n FROM change_log WHERE batch_id = ?', [ctx.batchId])?.n ?? 0);
  let jiraBase = db.get("SELECT value FROM meta WHERE key = 'jira_base_url'")?.value as string | null | undefined;

  db.exec('SAVEPOINT import_sheet');
  try {
    // 새 리소스 종류: 분류 = 시트 이름, 거치는 파트 = 그 시트의 파트 칸(공수 0 = 거치지만 공수 미정)
    const resources = { ...plan.resources };
    const sheetParts = new Map<string, string[]>();
    for (const [name, rows] of Object.entries(sheets)) {
      const L = layoutOf(name, rows, parts);
      if (typeof L !== 'string') sheetParts.set(name, L.parts.map(p => p.partId));
    }
    for (const [key, target] of Object.entries(plan.resources)) {
      if (target !== NEW_RESOURCE) continue;
      const want = plan.create?.[key];
      const rtName = clean(want?.name);
      if (!rtName) throw new Error('새 리소스 종류의 이름이 비었습니다.');
      let id = db.get('SELECT resource_type_id FROM resource_types WHERE name = ?', [rtName])?.resource_type_id as string | undefined;
      if (!id) {
        id = run({ kind: 'createResource', name: rtName, groupName: clean(want?.group) }).createdId!;
        report.resourcesCreated.push(rtName);
      }
      const [sheet] = JSON.parse(key) as string[];
      for (const partId of sheetParts.get(sheet) ?? []) {
        if (!db.get('SELECT 1 AS ok FROM resource_parts WHERE resource_type_id = ? AND part_id = ?', [id, partId])) {
          run({ kind: 'effort', resourceTypeId: id, partId, profileId: 'BASE', days: 0 });
        }
      }
      resources[key] = id;
    }
    plan = { ...plan, resources };
    for (const [name, rows] of Object.entries(sheets)) {
      const L = layoutOf(name, rows, parts);
      if (typeof L === 'string') continue;
      const linkAt = (r: number, c: number) => links[name]?.[`${r},${c}`] ?? null;
      for (const { r, no } of rowsOf(rows, L)) {
        const before = logCount();
        try {
          db.exec('SAVEPOINT sheet_row');
          const updateId = plan.milestones[msOf(L, r)];
          if (!updateId) throw new Error('마일스톤을 고르지 않음');
          const rtId = plan.resources[keyOf(L, r)];
          if (!rtId) throw new Error('리소스 종류를 고르지 않음');
          if (!db.get('SELECT 1 AS ok FROM volumes WHERE update_id = ? AND resource_type_id = ?', [updateId, rtId])) {
            if (!plan.addVolumes) throw new Error('물량에 없는 리소스');
            run({ kind: 'addResource', updateId, resourceTypeId: rtId });
            added.add(`${updateId}|${rtId}`);
          }
          const assetName = text(r[L.name])!;
          const code = L.code >= 0 ? text(r[L.code]) : null;
          let asset = code ? db.get('SELECT * FROM assets WHERE update_id = ? AND resource_type_id = ? AND code = ?', [updateId, rtId, code]) : undefined;
          asset ??= db.get('SELECT * FROM assets WHERE update_id = ? AND resource_type_id = ? AND name = ?', [updateId, rtId, assetName]);
          const id = asset ? String(asset.asset_id) : run({ kind: 'createAssets', updateId, resourceTypeId: rtId, names: [assetName], tier: 'TARGET' }).createdId!;
          if (asset) run({ kind: 'assetField', assetIds: [id], field: 'name', value: assetName });
          const [, major, minor] = JSON.parse(keyOf(L, r)) as string[];
          const category = [major, minor].filter(Boolean).join(' · ') || null;
          if (code) run({ kind: 'assetField', assetIds: [id], field: 'code', value: code });
          if (category) run({ kind: 'assetField', assetIds: [id], field: 'category', value: category });
          if (L.note >= 0 && text(r[L.note])) run({ kind: 'assetField', assetIds: [id], field: 'note', value: text(r[L.note]) });
          // Jira: 에픽 칸의 글자나 링크에서 ABC-123
          for (const c of L.epic) {
            const raw = [text(r[c]) ?? '', linkAt(no - 1, c) ?? ''].join(' ');
            const key = JIRA_IN.exec(raw.toUpperCase())?.[1];
            if (!key) continue;
            run({ kind: 'assetField', assetIds: [id], field: 'jira_key', value: key });
            const url = /(https?:\/\/\S+?\/browse\/)[A-Z][A-Z0-9_]+-\d+/i.exec(raw)?.[1];
            if (url && !jiraBase) { run({ kind: 'jiraBase', url }); jiraBase = url; report.jiraBaseSet = true; }
            break;
          }
          // 기획서 링크
          if (L.spec >= 0) {
            const t = text(r[L.spec]);
            const url = linkAt(no - 1, L.spec) ?? (t && /^https?:\/\/\S+$/.test(t) ? t : null);
            if (url && !db.get('SELECT 1 AS ok FROM asset_links WHERE asset_id = ? AND url = ?', [id, url])) run({ kind: 'addLink', assetId: id, title: '기획서', url });
          }
          for (const a of L.attrs) {
            const v = text(r[a.col]);
            if (v != null) run({ kind: 'assetAttr', assetIds: [id], name: a.name, value: v.slice(0, 500) });
          }
          // 모든 에셋이 같은 파이프라인: 리소스 종류가 거치지 않는 파트도 시트 값대로(빈칸이면 기본 = 해당 없음)
          const passes = new Set(db.all('SELECT part_id FROM resource_parts WHERE resource_type_id = ?', [rtId]).map(x => String(x.part_id)));
          for (const p of L.assign) {
            const who = text(r[p.col]);
            if (who) run({ kind: 'assetPart', assetIds: [id], partId: p.partId, assignee: who });
          }
          for (const p of L.parts) {
            const w = statusWord(r[p.col]);
            const st = w === 'unknown' ? (plan.words[clean(r[p.col])] || null) : w;
            if (!st) continue;
            const cur = db.get('SELECT status FROM asset_parts WHERE asset_id = ? AND part_id = ?', [id, p.partId])?.status ?? (passes.has(p.partId) ? 'TODO' : 'OMIT');
            if (cur === st) continue;
            run({ kind: 'assetPart', assetIds: [id], partId: p.partId, status: st, ...(st === 'DONE' ? { doneAt: plan.doneDate } : {}) });
          }
          db.exec('RELEASE sheet_row');
          if (!asset) report.created += 1;
          else if (logCount() > before) report.changed += 1;
          else report.unchanged += 1;
        } catch (error) {
          db.exec('ROLLBACK TO sheet_row');
          db.exec('RELEASE sheet_row');
          report.skipped.push({ sheet: name, row: no, reason: (error as Error).message });
        }
      }
    }
    // 새로 더한 물량은 등록 에셋 수로
    for (const k of added) {
      const [u, rt] = k.split('|');
      if (!db.get('SELECT 1 AS ok FROM volumes WHERE update_id = ? AND resource_type_id = ?', [u, rt])) continue;
      if (!db.get('SELECT 1 AS ok FROM assets WHERE update_id = ? AND resource_type_id = ? LIMIT 1', [u, rt])) continue;
      run({ kind: 'volumeFromAssets', updateId: u, resourceTypeId: rt });
      report.volumesAdded += 1;
    }
    db.exec('RELEASE import_sheet');
  } catch (error) {
    db.exec('ROLLBACK TO import_sheet');
    db.exec('RELEASE import_sheet');
    throw error;
  }
  return report;
}
