// 제작 현황판(docs/20-asset-management.md 18절): 마일스톤 하나의 진행률 · 이번 주 완료 · 계획선 대비 · 항목 × 파트 진행 · 단계 분포 · 추이 · 처리할 것 · 배치.
// 진행은 작업 진척(완료 수량)을 기본 공수로 바꿔 센다 → 에셋이 있는 줄(자동 집계)과 없는 줄(손 입력) 모두 같은 기준.
import type { SqlDb } from './db.ts';
import type { PlanMode } from '../engine/types.ts';
import type { AssetStatus, Stage } from './assets.ts';
import { stageOf, pipeline, defaultStatus } from './assets.ts';

export interface DashTodo { assetId: string; name: string; resource: string; part: string | null; since: string | null; who: string | null }
export interface DashboardView {
  updates: { updateId: string; name: string; live: boolean }[];
  updateId: string | null;
  parts: { partId: string; name: string }[];
  planMode: PlanMode;
  window: { start: string | null; target: string | null; targetLabel: string };
  summary: {
    doneDays: number; totalDays: number; rate: number;
    /** 이번 주(월요일부터 오늘) · 지난주에 완료한 파트 작업 수(에셋 기준) */
    weekDone: number; lastWeekDone: number;
    /** 오늘 계획선(시작 0% → 목표일 100%)의 비율 */
    idealRate: number | null;
    /** 계획선 대비 앞섬(+) · 늦음(−), 영업일(주 5일 기준 어림) */
    aheadWorkdays: number | null;
    assets: number;
  };
  matrix: { groupName: string; rows: { resourceTypeId: string; name: string; need: number; cells: ({ done: number; need: number; rate: number } | null)[]; rate: number }[] }[];
  partTotals: { doneDays: number; totalDays: number; rate: number }[];
  stages: { list: { id: Stage; name: string }[]; groups: { name: string; counts: number[]; total: number }[] } | null;
  trend: { points: { date: string; actual: number | null; ideal: number | null }[]; total: number; today: string };
  todo: { review: DashTodo[]; retake: DashTodo[]; hold: DashTodo[]; overdue: DashTodo[]; stale: DashTodo[] };
  batches: { batchId: string; name: string; due: string | null; daysLeft: number | null; count: number; done: number; progress: number }[];
}

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
const mondayOf = (d: string) => { const t = parse(d); const wd = (new Date(t).getUTCDay() + 6) % 7; return iso(t - wd * DAY); };

export function dashboardView(db: SqlDb, wanted: string | null, planMode: PlanMode = 'TARGET', today: string): DashboardView {
  const updates = db.all(`SELECT update_id, name, status FROM updates
      ORDER BY CASE WHEN status IN ('PLANNED', 'IN_PROGRESS') THEN 0 ELSE 1 END, priority, sort_order`)
    .map(u => ({ updateId: String(u.update_id), name: String(u.name), live: u.status === 'PLANNED' || u.status === 'IN_PROGRESS' }));
  const updateId = updates.find(u => u.updateId === wanted)?.updateId ?? updates[0]?.updateId ?? null;
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(p => ({ partId: String(p.part_id), name: String(p.name) }));
  const partName = new Map(parts.map(p => [p.partId, p.name]));
  const empty: DashboardView = {
    updates, updateId, parts, planMode, window: { start: null, target: null, targetLabel: '' },
    summary: { doneDays: 0, totalDays: 0, rate: 0, weekDone: 0, lastWeekDone: 0, idealRate: null, aheadWorkdays: null, assets: 0 },
    matrix: [], partTotals: parts.map(() => ({ doneDays: 0, totalDays: 0, rate: 0 })), stages: null,
    trend: { points: [], total: 0, today }, todo: { review: [], retake: [], hold: [], overdue: [], stale: [] }, batches: [],
  };
  if (!updateId) return empty;
  const u = db.get('SELECT * FROM updates WHERE update_id = ?', [updateId])!;
  const start = (u.start_date as string) ?? null;
  const target = ((u.freeze_date ?? u.release_date) as string) ?? null;
  const targetLabel = u.freeze_date ? '제작 완료 목표' : u.release_date ? '출시' : '';
  const qtyField = planMode === 'MIN' ? 'min_qty' : planMode === 'STRETCH' ? 'stretch_qty' : 'target_qty';

  // ── 항목 × 파트(기본 공수 기준) ──
  const passes = new Set(db.all('SELECT resource_type_id, part_id FROM resource_parts').map(r => `${r.resource_type_id}|${r.part_id}`));
  const base = new Map(db.all("SELECT resource_type_id, part_id, days FROM efforts WHERE profile_id = 'BASE'").map(r => [`${r.resource_type_id}|${r.part_id}`, Number(r.days)]));
  const prog = new Map(db.all('SELECT * FROM progress WHERE update_id = ?', [updateId]).map(r => [`${r.resource_type_id}|${r.part_id}`, r]));
  const partTotals = parts.map(() => ({ doneDays: 0, totalDays: 0, rate: 0 }));
  const groupMap = new Map<string, DashboardView['matrix'][number]>();
  const vols = db.all(`SELECT v.*, r.name, coalesce(g.name, '분류 없음') AS gname FROM volumes v
      JOIN resource_types r ON r.resource_type_id = v.resource_type_id LEFT JOIN resource_groups g ON g.group_id = r.group_id
      WHERE v.update_id = ? ORDER BY coalesce(g.sort_order, 999999), r.sort_order`, [updateId]);
  let doneDays = 0;
  let totalDays = 0;
  for (const v of vols) {
    const rt = String(v.resource_type_id);
    const need = Math.max(0, Number(v[qtyField] ?? 0) - Number(v.outsource_qty ?? 0));
    let rDone = 0; let rTotal = 0;
    const cells = parts.map((p, i) => {
      const key = `${rt}|${p.partId}`;
      if (!passes.has(key)) return null;
      const done = Math.min(need, Number(prog.get(key)?.completed_qty ?? 0));
      const days = base.get(key) ?? 0;
      partTotals[i].doneDays += done * days; partTotals[i].totalDays += need * days;
      rDone += done * days; rTotal += need * days;
      return { done, need, rate: need > 0 ? done / need : 1 };
    });
    doneDays += rDone; totalDays += rTotal;
    const gname = String(v.gname);
    if (!groupMap.has(gname)) groupMap.set(gname, { groupName: gname, rows: [] });
    groupMap.get(gname)!.rows.push({ resourceTypeId: rt, name: String(v.name), need, cells, rate: rTotal > 0 ? rDone / rTotal : 1 });
  }
  for (const t of partTotals) t.rate = t.totalDays > 0 ? t.doneDays / t.totalDays : 0;

  // ── 추이: 완료한 공수의 누적(에셋 줄 = 파트 완료일마다, 손 입력 줄 = 기준일에 한 번에) ──
  const events: { date: string; days: number }[] = [];
  const assetPairs = new Set(db.all('SELECT DISTINCT resource_type_id FROM assets WHERE update_id = ?', [updateId]).map(r => String(r.resource_type_id)));
  for (const r of db.all(`SELECT a.resource_type_id, ap.part_id, ap.status, ap.done_at FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id
      WHERE a.update_id = ? AND ap.status IN ('DONE', 'OMIT')`, [updateId])) {
    const days = base.get(`${r.resource_type_id}|${r.part_id}`) ?? 0;
    events.push({ date: (r.done_at as string) ?? start ?? today, days });
  }
  for (const [key, r] of prog) {
    const rt = key.split('|')[0];
    if (assetPairs.has(rt)) continue;
    const need = Math.max(0, Number(vols.find(v => v.resource_type_id === rt)?.[qtyField] ?? 0) - Number(vols.find(v => v.resource_type_id === rt)?.outsource_qty ?? 0));
    events.push({ date: (r.as_of as string) ?? start ?? today, days: Math.min(need, Number(r.completed_qty)) * (base.get(key) ?? 0) });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));
  const points: DashboardView['trend']['points'] = [];
  if (start) {
    const endT = Math.max(parse(target ?? today), parse(today)) + 7 * DAY;
    const startT = parse(mondayOf(start));
    const targetT = target ? parse(target) : null;
    const s0 = parse(start);
    for (let t = startT; t <= endT; t += 7 * DAY) {
      const d = iso(t + 6 * DAY); // 그 주 일요일까지 누적
      const ideal = targetT && targetT > s0 ? Math.max(0, Math.min(1, (parse(d) - s0) / (targetT - s0))) * totalDays : null;
      const actual = parse(d) - 6 * DAY <= parse(today) ? events.filter(e => e.date <= (d < today ? d : today)).reduce((a, e) => a + e.days, 0) : null;
      points.push({ date: d, actual: actual == null ? null : Math.min(actual, totalDays), ideal });
    }
  }

  // 계획선 대비: 오늘 계획선 비율과 실제 비율의 차 × 계획 기간(영업일 어림)
  let idealRate: number | null = null;
  let aheadWorkdays: number | null = null;
  const rate = totalDays > 0 ? doneDays / totalDays : 0;
  if (start && target && parse(target) > parse(start)) {
    const span = parse(target) - parse(start);
    idealRate = Math.max(0, Math.min(1, (parse(today) - parse(start)) / span));
    aheadWorkdays = Math.round(((rate - idealRate) * span) / DAY * (5 / 7));
  }

  // ── 에셋: 이번 주 완료 · 단계 분포 · 처리할 것 ──
  const mon = mondayOf(today);
  const lastMon = iso(parse(mon) - 7 * DAY);
  const doneDates = db.all(`SELECT ap.done_at FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id WHERE a.update_id = ? AND ap.status = 'DONE' AND ap.done_at IS NOT NULL`, [updateId]).map(r => String(r.done_at));
  const weekDone = doneDates.filter(d => d >= mon && d <= today).length;
  const lastWeekDone = doneDates.filter(d => d >= lastMon && d < mon).length;

  // 모든 에셋이 같은 파이프라인(사용 중인 파트 전부). 행이 없으면 거치는 파트는 대기, 아니면 해당 없음
  const pl = pipeline(db);
  const st0 = (a: Record<string, unknown>, p: string) => ((states.get(String(a.asset_id))?.get(p)?.status as AssetStatus) ?? defaultStatus(pl.passes.has(`${a.resource_type_id}|${p}`)));
  const states = new Map<string, Map<string, Record<string, unknown>>>();
  for (const r of db.all('SELECT ap.* FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id WHERE a.update_id = ?', [updateId])) {
    const k = String(r.asset_id);
    if (!states.has(k)) states.set(k, new Map());
    states.get(k)!.set(String(r.part_id), r);
  }
  const batchDue = new Map(db.all('SELECT batch_id, due_date FROM batches WHERE update_id = ?', [updateId]).map(b => [String(b.batch_id), (b.due_date as string) ?? null]));
  const assets = db.all(`SELECT a.*, r.name AS rname, coalesce(g.name, '분류 없음') AS gname FROM assets a JOIN resource_types r ON r.resource_type_id = a.resource_type_id
      LEFT JOIN resource_groups g ON g.group_id = r.group_id WHERE a.update_id = ? ORDER BY coalesce(g.sort_order, 999999), r.sort_order, a.sort_order`, [updateId]);
  const stageList: { id: Stage; name: string }[] = [{ id: 'TODO', name: '대기' }, ...parts.map(p => ({ id: p.partId, name: p.name })), { id: 'DONE', name: '완료' }];
  const stageGroups = new Map<string, number[]>();
  const todo: DashboardView['todo'] = { review: [], retake: [], hold: [], overdue: [], stale: [] };
  const staleBefore = iso(parse(today) - 14 * DAY);
  for (const a of assets) {
    const id = String(a.asset_id);
    const st = pl.parts;
    const s = states.get(id) ?? new Map();
    const statusOf = (p: string) => st0(a, p);
    const stage = stageOf(st, statusOf);
    const g = String(a.gname);
    if (!stageGroups.has(g)) stageGroups.set(g, stageList.map(() => 0));
    stageGroups.get(g)![stageList.findIndex(x => x.id === stage)] += 1;
    const item = (part: string | null, since: string | null): DashTodo => ({
      assetId: id, name: String(a.name), resource: String(a.rname), part: part ? partName.get(part) ?? part : null, since,
      who: part ? ((s.get(part)?.assignee as string) ?? null) : null,
    });
    for (const p of st) {
      const r = s.get(p);
      const status = statusOf(p);
      if (status === 'REVIEW') todo.review.push(item(p, (r?.started_at as string) ?? null));
      if (status === 'RETAKE') todo.retake.push(item(p, (r?.started_at as string) ?? null));
      if (status === 'HOLD') todo.hold.push(item(p, null));
      if (status === 'WIP' && r?.started_at && String(r.started_at) < staleBefore) todo.stale.push(item(p, String(r.started_at)));
    }
    const due = (a.due_date as string) ?? (a.batch_id ? batchDue.get(String(a.batch_id)) ?? null : null);
    if (due && due < today && stage !== 'DONE') todo.overdue.push(item(stage === 'TODO' || stage === 'DONE' ? null : stage, due));
  }
  todo.overdue.sort((x, y) => String(x.since).localeCompare(String(y.since)));
  todo.stale.sort((x, y) => String(x.since).localeCompare(String(y.since)));

  const batches = db.all('SELECT * FROM batches WHERE update_id = ? ORDER BY sort_order, batch_id', [updateId]).map(b => {
    const mine = assets.filter(a => a.batch_id === b.batch_id);
    const doneN = mine.filter(a => stageOf(pl.parts, p => st0(a, p)) === 'DONE').length;
    const due = (b.due_date as string) ?? null;
    // 진행 = 끝난 파트 수 ÷ 할 파트 수(에셋 전체, 해당 없음은 뺀다)
    let partsAll = 0; let partsDone = 0;
    for (const a of mine) {
      for (const p of pl.parts) {
        const st = st0(a, p);
        if (st === 'OMIT') continue;
        partsAll += 1;
        if (st === 'DONE') partsDone += 1;
      }
    }
    return {
      batchId: String(b.batch_id), name: String(b.name), due, daysLeft: due ? Math.round((parse(due) - parse(today)) / DAY) : null,
      count: mine.length, done: doneN, progress: partsAll ? partsDone / partsAll : 0,
    };
  });

  return {
    updates, updateId, parts, planMode, window: { start, target, targetLabel },
    summary: { doneDays, totalDays, rate, weekDone, lastWeekDone, idealRate, aheadWorkdays, assets: assets.length },
    matrix: [...groupMap.values()], partTotals,
    stages: assets.length ? { list: stageList, groups: [...stageGroups.entries()].map(([name, counts]) => ({ name, counts, total: counts.reduce((x, y) => x + y, 0) })) } : null,
    trend: { points, total: totalDays, today },
    todo, batches,
  };
}
