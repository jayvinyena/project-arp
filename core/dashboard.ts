// 제작 현황판(docs/20-asset-management.md 18절): 마일스톤 하나의 진행률 · 이번 주 완료 · 계획선 대비 · 항목 × 파트 진행 · 단계 분포 · 추이 · 처리할 것 · 배치.
// 진행은 작업 진척(완료 수량)을 기본 공수로 바꿔 센다 → 에셋이 있는 줄(자동 집계)과 없는 줄(손 입력) 모두 같은 기준.
import type { SqlDb } from './db.ts';
import type { PlanMode } from '../engine/types.ts';
import type { AssetStatus, Stage } from './assets.ts';
import { stageOf, pipeline, defaultStatus } from './assets.ts';
import { partOrderFor, pipelinesList } from './pipelines.ts';
import { nameKey } from './people-paste.ts';

/** 담당별 현황(docs/32 7): 이 업데이트 에셋의 파트 작업을 담당 이름마다 상태별로 센다 */
export interface DashPersonRow {
  /** 담당 이름(명단 표기가 있으면 명단 표기). null = 담당 없음 */
  name: string | null; team: string | null; inRoster: boolean;
  todo: number; wip: number; review: number; retake: number; hold: number; done: number;
  /** 마감 지남: 마감(에셋 · 배치)이 지났는데 끝나지 않은 에셋에서 지금 단계 파트를 맡음 */
  overdue: number;
}
/** 파트 인원 비교: 명단(참여 중, 소속팀 = 파트) vs 인력 표(그 달 인원) */
export interface DashHeadcount { month: string | null; parts: { partId: string; name: string; roster: number; capacity: number | null }[] }
/** 파이프라인별 단계 분포(docs/32 8): 열 = 대기 · 묶음(병렬은 한 칸) · 완료 */
/** 단계 칸 하나의 속(docs/37): 그 단계에 있는 에셋의 세부 상태 · 14일+ 머문 수 · 이번 주 들어옴(그 파트 시작) · 나감(그 파트 완료) */
export interface StageCell { wait: number; wip: number; review: number; retake: number; hold: number; stale: number; weekIn: number; weekOut: number }
const emptyCell = (): StageCell => ({ wait: 0, wip: 0, review: 0, retake: 0, hold: 0, stale: 0, weekIn: 0, weekOut: 0 });
export interface DashPipelineStages { pipelineId: string | null; name: string; list: { id: string; name: string }[]; counts: number[]; total: number; cells: StageCell[]; colParts?: string[][] }

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
  stages: { list: { id: Stage; name: string }[]; cells: StageCell[]; groups: { name: string; counts: number[]; total: number; included: number; planned: number | null }[] } | null;
  trend: { points: { date: string; actual: number | null; ideal: number | null }[]; total: number; today: string };
  todo: { review: DashTodo[]; retake: DashTodo[]; hold: DashTodo[]; overdue: DashTodo[]; stale: DashTodo[] };
  batches: { batchId: string; name: string; due: string | null; daysLeft: number | null; count: number; done: number; progress: number }[];
  /** 담당별 현황 · 파트 인원 비교(docs/32 7) */
  people: { rows: DashPersonRow[]; headcount: DashHeadcount };
  /** 파이프라인별 단계 분포(docs/32 8). 에셋이 없으면 빈 목록 */
  pipelineStages: DashPipelineStages[];
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
    people: { rows: [], headcount: { month: null, parts: [] } }, pipelineStages: [],
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
  const orderFor = partOrderFor(db); // 리소스별 공정 순서(docs/28)
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
  const stageCells = stageList.map(emptyCell);
  // 항목별 등록(이 물량 템플릿에 드는 에셋) · 계획 물량
  const modeRank = planMode === 'MIN' ? 0 : planMode === 'STRETCH' ? 2 : 1;
  const tierRank = (t: unknown) => (t === 'MIN' ? 0 : t === 'STRETCH' ? 2 : 1);
  const groupIncluded = new Map<string, number>();
  const groupPlanned = new Map<string, number>();
  for (const v of vols) { const g = String(v.gname); groupPlanned.set(g, (groupPlanned.get(g) ?? 0) + Number(v[qtyField] ?? 0)); }
  const todo: DashboardView['todo'] = { review: [], retake: [], hold: [], overdue: [], stale: [] };
  const staleBefore = iso(parse(today) - 14 * DAY);
  // 담당별(명단 이름과 공백 · 대소문자 무시로 맞춤)
  const roster = db.all('SELECT name, team, active FROM people ORDER BY sort_order, person_id');
  const rosterBy = new Map(roster.map(r => [nameKey(String(r.name)), r]));
  const personRows = new Map<string, DashPersonRow>();
  const personOf = (raw: string | null): DashPersonRow => {
    const k = raw ? nameKey(raw) : '';
    if (!personRows.has(k)) {
      const r = k ? rosterBy.get(k) : undefined;
      personRows.set(k, { name: k ? String(r?.name ?? raw!.trim()) : null, team: r ? ((r.team as string) ?? null) : null, inRoster: !!r, todo: 0, wip: 0, review: 0, retake: 0, hold: 0, done: 0, overdue: 0 });
    }
    return personRows.get(k)!;
  };
  // 파이프라인별 단계 분포: 리소스 파이프라인마다 묶음 열
  const pipeOfRt = new Map(db.all('SELECT resource_type_id, pipeline_id FROM resource_types').map(r => [String(r.resource_type_id), (r.pipeline_id as string) ?? null]));
  const pipeInfo = new Map(pipelinesList(db).map(p => [p.pipelineId, p]));
  const pipeStages = new Map<string, DashPipelineStages & { groups: string[][] }>();
  for (const a of assets) {
    const id = String(a.asset_id);
    const st = orderFor(String(a.resource_type_id));
    const s = states.get(id) ?? new Map();
    const statusOf = (p: string) => st0(a, p);
    const stage = stageOf(st, statusOf);
    const g = String(a.gname);
    if (!stageGroups.has(g)) stageGroups.set(g, stageList.map(() => 0));
    const si = stageList.findIndex(x => x.id === stage);
    stageGroups.get(g)![si] += 1;
    if (tierRank(a.tier) <= modeRank) groupIncluded.set(g, (groupIncluded.get(g) ?? 0) + 1);
    // 단계 칸 속: 세부 상태 · 머문 수(그 단계 파트 기준)
    const sub = stage === 'TODO' || stage === 'DONE' ? null : statusOf(stage);
    const stale = sub === 'WIP' && !!s.get(stage)?.started_at && String(s.get(stage)!.started_at) < staleBefore;
    const bump = (c: StageCell) => {
      if (sub === 'WIP') c.wip += 1; else if (sub === 'REVIEW') c.review += 1; else if (sub === 'RETAKE') c.retake += 1; else if (sub === 'HOLD') c.hold += 1; else if (sub) c.wait += 1;
      if (stale) c.stale += 1;
    };
    bump(stageCells[si]);
    // 이번 주 들어옴(파트 시작) · 나감(파트 완료). 완료 칸은 마지막 파트를 이번 주에 끝낸 에셋
    const lastDone = st.map(p => (statusOf(p) === 'DONE' ? String(s.get(p)?.done_at ?? '') : '')).reduce((m, d) => (d > m ? d : m), '');
    const weekOf = (d: unknown) => !!d && String(d) >= mon && String(d) <= today;
    for (const p of st) {
      const pi = stageList.findIndex(x => x.id === p); if (pi < 0) continue;
      if (weekOf(s.get(p)?.started_at)) stageCells[pi].weekIn += 1;
      if (statusOf(p) === 'DONE' && weekOf(s.get(p)?.done_at)) stageCells[pi].weekOut += 1;
    }
    if (stage === 'DONE' && weekOf(lastDone)) stageCells[stageCells.length - 1].weekIn += 1;
    {
      // 파이프라인별: 이 에셋 리소스의 묶음(병렬은 한 칸). 파이프라인이 같으면 열도 같다
      const pid = pipeOfRt.get(String(a.resource_type_id)) ?? null;
      const info = pid ? pipeInfo.get(pid) : undefined;
      const key = info ? info.pipelineId : '';
      if (!pipeStages.has(key)) {
        // 열 = 그 파이프라인의 묶음(병렬은 한 칸). 파이프라인이 없으면 파트 표 순서로 파트마다
        const groups = info ? info.groups : parts.map(x => [x.partId]);
        const list = [{ id: 'TODO', name: '대기' }, ...groups.map(gp => ({ id: gp[0], name: gp.map(x => partName.get(x) ?? x).join(' ∥ ') })), { id: 'DONE', name: '완료' }];
        pipeStages.set(key, { pipelineId: key || null, name: info ? info.name : '파이프라인 고르지 않음', list, counts: list.map(() => 0), total: 0, groups, cells: list.map(emptyCell) });
      }
      const ps = pipeStages.get(key)!;
      let col = stage === 'TODO' ? 0 : stage === 'DONE' ? ps.list.length - 1 : ps.list.findIndex(x => ps.groups.find(gp => gp.includes(stage))?.[0] === x.id);
      if (col < 0) {
        // 파이프라인 밖 파트에 머문 에셋(옛 기록): 완료 앞에 그 파트 열을 덧붙여 빠짐없이 센다
        const at = ps.list.length - 1;
        ps.list.splice(at, 0, { id: stage, name: `${partName.get(stage) ?? stage}(파이프라인 밖)` });
        ps.counts.splice(at, 0, 0);
        ps.cells.splice(at, 0, emptyCell());
        ps.groups.push([stage]);
        col = at;
      }
      ps.counts[col] += 1; ps.total += 1;
      bump(ps.cells[col]);
      // 들어옴 · 나감: 파트 → 그 파트가 든 열
      const colOfPart = (p: string) => ps.list.findIndex(x => ps.groups.find(gp => gp.includes(p))?.[0] === x.id);
      for (const p of st) {
        const pc = colOfPart(p); if (pc < 0) continue;
        if (weekOf(s.get(p)?.started_at)) ps.cells[pc].weekIn += 1;
        if (statusOf(p) === 'DONE' && weekOf(s.get(p)?.done_at)) ps.cells[pc].weekOut += 1;
      }
      if (stage === 'DONE' && weekOf(lastDone)) ps.cells[ps.list.length - 1].weekIn += 1;
    }
    for (const p of st) {
      const status = statusOf(p);
      if (status === 'OMIT') continue;
      const who = (s.get(p)?.assignee as string) ?? null;
      const row = personOf(who);
      if (status === 'TODO') row.todo += 1;
      else if (status === 'WIP') row.wip += 1;
      else if (status === 'REVIEW') row.review += 1;
      else if (status === 'RETAKE') row.retake += 1;
      else if (status === 'HOLD') row.hold += 1;
      else if (status === 'DONE') row.done += 1;
    }
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
    if (due && due < today && stage !== 'DONE') {
      todo.overdue.push(item(stage === 'TODO' || stage === 'DONE' ? null : stage, due));
      if (stage !== 'TODO') personOf((s.get(stage)?.assignee as string) ?? null).overdue += 1;
    }
  }
  todo.overdue.sort((x, y) => String(x.since).localeCompare(String(y.since)));
  todo.stale.sort((x, y) => String(x.since).localeCompare(String(y.since)));

  const batches = db.all('SELECT * FROM batches WHERE update_id = ? ORDER BY sort_order, batch_id', [updateId]).map(b => {
    const mine = assets.filter(a => a.batch_id === b.batch_id);
    const doneN = mine.filter(a => stageOf(orderFor(String(a.resource_type_id)), p => st0(a, p)) === 'DONE').length;
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

  // 담당별: 명단 순(파트 공정 순 소속팀 → 나머지) → 명단에 없는 이름(가나다) → 담당 없음. 아무 일도 없는 담당 없음 줄은 뺀다
  const teamRank = new Map(parts.map((p, i) => [p.name, i]));
  const people = [...personRows.values()].filter(r => r.name !== null || r.todo + r.wip + r.review + r.retake + r.hold + r.done > 0);
  people.sort((x, y) => (x.name === null ? 1 : 0) - (y.name === null ? 1 : 0) || (x.inRoster ? 0 : 1) - (y.inRoster ? 0 : 1)
    || (teamRank.get(x.team ?? '') ?? 99) - (teamRank.get(y.team ?? '') ?? 99) || String(x.name).localeCompare(String(y.name), 'ko'));
  // 파트 인원 비교: 이번 달(계획 기간 안이면) 인력 표 인원 vs 명단(참여 중, 소속팀 = 파트 이름)
  const month = today.slice(0, 7);
  const capRows = new Map(db.all('SELECT part_id, headcount FROM capacity WHERE month = ?', [month]).map(r => [String(r.part_id), Number(r.headcount)]));
  const headcount: DashHeadcount = {
    month: capRows.size ? month : null,
    parts: parts.map(p => ({ partId: p.partId, name: p.name, roster: roster.filter(r => Number(r.active) === 1 && r.team === p.name).length, capacity: capRows.get(p.partId) ?? null })),
  };
  const pipelineStages = assets.length ? [...pipeStages.values()].map(({ groups, ...rest }) => ({ ...rest, colParts: rest.list.map(x => (x.id === 'TODO' || x.id === 'DONE' ? [x.id] : groups.find(g => g[0] === x.id) ?? [x.id])) }))
    .sort((x, y) => (x.pipelineId ? 0 : 1) - (y.pipelineId ? 0 : 1) || y.total - x.total) : [];

  return {
    people: { rows: people, headcount }, pipelineStages,
    updates, updateId, parts, planMode, window: { start, target, targetLabel },
    summary: { doneDays, totalDays, rate, weekDone, lastWeekDone, idealRate, aheadWorkdays, assets: assets.length },
    matrix: [...groupMap.values()], partTotals,
    stages: assets.length ? { list: stageList, cells: stageCells, groups: [...stageGroups.entries()].map(([name, counts]) => ({ name, counts, total: counts.reduce((x, y) => x + y, 0), included: groupIncluded.get(name) ?? 0, planned: groupPlanned.has(name) ? groupPlanned.get(name)! : null })) } : null,
    trend: { points, total: totalDays, today },
    todo, batches,
  };
}
