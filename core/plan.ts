// 3단계 요약: 업데이트 계획(모든 업데이트 · 같은 인력 · 전망 범위), 유형 템플릿, 인력, 업데이트 상세.
import type { SqlDb } from './db.ts';
import type { Person, TeamOption } from './people.ts';
import { peopleList, teamOptions, assigneeCandidates } from './people.ts';
import type { AssigneeCandidate } from './people.ts';
import { partGroupsFor, pipelinesList } from './pipelines.ts';
import type { PipelineInfo } from './pipelines.ts';
import type { PlanMode, PlanResult, UpdateStatus, BatchStatus } from '../engine/types.ts';
import { runPlan } from '../engine/index.ts';
import type { ProjectSession, Finding } from './pipeline.ts';
import { volumeRows } from './launch.ts';
import type { LaunchRow } from './launch.ts';

const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

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

// ───────── 업데이트 계획 ─────────

export interface PlanRow {
  updateId: string;
  name: string;
  typeId: string;
  typeName: string;
  isLaunch: boolean;
  startDate: string | null;
  freezeDate: string | null;
  releaseDate: string | null;
  priority: number;
  status: string;
  live: boolean;
  totals: { min: number; target: number; stretch: number };
  resourceCount: number;
  result: {
    completion: string | null;
    status: UpdateStatus;
    lateWorkdays: number | null;
    critical: boolean;
    requiredDays: number;
    reason: { partName: string; resourceName: string; waitWorkdays: number | null; remainingDays: number } | null;
  } | null;
  /** 최저안·확장안 완료 예정일: 전망 범위 */
  range: { min: string | null; stretch: string | null; minUnfinished: boolean; stretchUnfinished: boolean } | null;
  /** 배치별 완료 예정(배치 순서, docs/33). 배치가 없거나 계산이 막혔으면 빈 목록 */
  batches: BatchRow[];
}

/** 배치 완료 예정 한 줄(화면 · 보고용 엑셀 · 현황판이 함께 쓴다) */
export interface BatchRow {
  batchId: string; updateId: string; name: string; dueDate: string | null;
  completion: string | null; status: BatchStatus; lateWorkdays: number | null; slackWorkdays: number | null; overQty: number;
  reason: { partName: string; resourceName: string; waitWorkdays: number | null; remainingDays: number } | null;
}
export function batchRows(db: SqlDb, result: PlanResult): BatchRow[] {
  const rtName = new Map(db.all('SELECT resource_type_id, name FROM resource_types').map(r => [String(r.resource_type_id), String(r.name)]));
  const partName = new Map(db.all('SELECT part_id, name FROM parts').map(r => [String(r.part_id), String(r.name)]));
  return result.batches.map(b => ({
    batchId: b.batchId, updateId: b.updateId, name: b.name, dueDate: b.dueDate,
    completion: b.expectedCompletionDate, status: b.status, lateWorkdays: b.lateWorkdays, slackWorkdays: b.slackWorkdays, overQty: b.overQty,
    reason: b.reason ? {
      partName: partName.get(b.reason.partId) ?? b.reason.partId, resourceName: rtName.get(b.reason.resourceTypeId) ?? b.reason.resourceTypeId,
      waitWorkdays: b.reason.waitWorkdays, remainingDays: b.reason.remainingDays,
    } : null,
  }));
}
/** 배치 완료 예정만(에셋 화면): 계산 한 번(설정의 기본 물량 구간). 계산이 막혔으면 빈 목록 */
export function batchForecast(db: SqlDb, session: ProjectSession, planMode?: PlanMode): BatchRow[] {
  const p = session.prepare();
  if (p.blocked || !p.data) return [];
  return batchRows(db, runPlan(p.data, planMode ? { planMode } : {}));
}

export interface PartLoadRow {
  partId: string;
  name: string;
  months: { month: string; capacity: number; assigned: number; utilization: number; remaining: number }[];
}

export interface PlanView {
  blocked: boolean;
  findings: Finding[];
  planMode: PlanMode;
  horizon: { start: string; end: string; months: string[] };
  rows: PlanRow[];
  parts: PartLoadRow[];
  types: { typeId: string; name: string; isLaunch: boolean; templateCount: number }[];
  ms: number;
}

export function planView(db: SqlDb, session: ProjectSession, planMode: PlanMode = 'TARGET'): PlanView {
  const t0 = performance.now();
  const s = db.get('SELECT horizon_start_month AS a, horizon_end_month AS b FROM settings WHERE id = 1') ?? {};
  const horizon = { start: String(s.a ?? ''), end: String(s.b ?? ''), months: s.a && s.b ? monthsBetween(String(s.a), String(s.b)) : [] };
  const types = db.all(`SELECT t.update_type_id, t.name, t.is_launch, (SELECT count(*) FROM type_templates x WHERE x.update_type_id = t.update_type_id) AS n
      FROM update_types t WHERE t.active = 1 ORDER BY t.sort_order`)
    .map(r => ({ typeId: String(r.update_type_id), name: String(r.name), isLaunch: Number(r.is_launch) === 1, templateCount: Number(r.n) }));
  const rtName = new Map(db.all('SELECT resource_type_id, name FROM resource_types').map(r => [String(r.resource_type_id), String(r.name)]));
  const partName = new Map(db.all('SELECT part_id, name FROM parts').map(r => [String(r.part_id), String(r.name)]));

  const base = db.all(`SELECT u.*, t.name AS type_name, t.is_launch,
        coalesce(sum(v.min_qty), 0) AS min_sum, coalesce(sum(v.target_qty), 0) AS target_sum, coalesce(sum(v.stretch_qty), 0) AS stretch_sum,
        count(v.resource_type_id) AS res_count
      FROM updates u JOIN update_types t ON t.update_type_id = u.update_type_id
      LEFT JOIN volumes v ON v.update_id = u.update_id
      GROUP BY u.update_id
      ORDER BY CASE WHEN u.status IN ('PLANNED', 'IN_PROGRESS') THEN 0 ELSE 1 END, u.priority, u.sort_order`);

  const prepared = session.prepare();
  let results: Record<PlanMode, PlanResult> | null = null;
  if (!prepared.blocked && prepared.data) {
    results = {
      MIN: runPlan(prepared.data, { planMode: 'MIN' }),
      TARGET: runPlan(prepared.data, { planMode: 'TARGET' }),
      STRETCH: runPlan(prepared.data, { planMode: 'STRETCH' }),
    };
  }

  const allBatches = results ? batchRows(db, results[planMode]) : [];
  const rows: PlanRow[] = base.map(r => {
    const id = String(r.update_id);
    const live = r.status === 'PLANNED' || r.status === 'IN_PROGRESS';
    const main = results?.[planMode].updates.find(u => u.updateId === id) ?? null;
    const lo = results?.MIN.updates.find(u => u.updateId === id) ?? null;
    const hi = results?.STRETCH.updates.find(u => u.updateId === id) ?? null;
    return {
      updateId: id,
      name: String(r.name),
      typeId: String(r.update_type_id),
      typeName: String(r.type_name),
      isLaunch: Number(r.is_launch) === 1,
      startDate: str(r.start_date),
      freezeDate: str(r.freeze_date),
      releaseDate: str(r.release_date),
      priority: Number(r.priority),
      status: String(r.status),
      live,
      totals: { min: Number(r.min_sum), target: Number(r.target_sum), stretch: Number(r.stretch_sum) },
      resourceCount: Number(r.res_count),
      result: main ? {
        completion: main.expectedCompletionDate,
        status: main.status,
        lateWorkdays: main.lateWorkdays,
        critical: main.critical,
        requiredDays: main.requiredDays,
        reason: main.reason ? {
          partName: partName.get(main.reason.partId) ?? main.reason.partId,
          resourceName: rtName.get(main.reason.resourceTypeId) ?? main.reason.resourceTypeId,
          waitWorkdays: main.reason.waitWorkdays,
          remainingDays: main.reason.remainingDays,
        } : null,
      } : null,
      range: lo && hi ? {
        min: lo.expectedCompletionDate, stretch: hi.expectedCompletionDate,
        minUnfinished: lo.status === 'UNFINISHED', stretchUnfinished: hi.status === 'UNFINISHED',
      } : null,
      batches: allBatches.filter(b => b.updateId === id),
    };
  });

  const parts: PartLoadRow[] = results
    ? results[planMode].parts.map(p => ({
      partId: p.partId,
      name: p.name,
      months: results![planMode].partMonths.filter(m => m.partId === p.partId).map(m => ({
        month: m.month, capacity: m.capacityDays, assigned: m.assignedDays, utilization: m.utilization, remaining: m.remainingDays,
      })),
    }))
    : [];

  return { blocked: prepared.blocked, findings: prepared.findings, planMode, horizon, rows, parts, types, ms: performance.now() - t0 };
}

// ───────── 업데이트 상세 ─────────

export interface UpdateDetail {
  updateId: string;
  name: string;
  typeId: string;
  isLaunch: boolean;
  startDate: string | null;
  freezeDate: string | null;
  releaseDate: string | null;
  priority: number;
  status: string;
  rows: LaunchRow[];
  addable: { resourceTypeId: string; name: string; groupName: string }[];
}

export function updateDetail(db: SqlDb, updateId: string): UpdateDetail | null {
  const u = db.get(`SELECT u.*, t.is_launch FROM updates u JOIN update_types t ON t.update_type_id = u.update_type_id WHERE u.update_id = ?`, [updateId]);
  if (!u) return null;
  const { rows, addable } = volumeRows(db, updateId);
  return {
    updateId,
    name: String(u.name),
    typeId: String(u.update_type_id),
    isLaunch: Number(u.is_launch) === 1,
    startDate: str(u.start_date),
    freezeDate: str(u.freeze_date),
    releaseDate: str(u.release_date),
    priority: Number(u.priority),
    status: String(u.status),
    rows,
    addable,
  };
}

/** 업데이트 하나의 리소스별 필요 공수(선택 구간). 상세 화면 표의 오른쪽 칸 */
export function updateDays(db: SqlDb, session: ProjectSession, updateId: string, planMode: PlanMode): { blocked: boolean; byResource: Record<string, number>; total: number } {
  const prepared = session.prepare();
  if (prepared.blocked || !prepared.data) return { blocked: true, byResource: {}, total: 0 };
  const result = runPlan(prepared.data, { planMode });
  const byResource: Record<string, number> = {};
  let total = 0;
  for (const st of result.stages) {
    if (st.updateId !== updateId) continue;
    byResource[st.resourceTypeId] = (byResource[st.resourceTypeId] ?? 0) + st.requiredDays;
    total += st.requiredDays;
  }
  void db;
  return { blocked: false, byResource, total };
}

// ───────── 유형 템플릿 ─────────

export interface TemplateRow { resourceTypeId: string; name: string; groupName: string; min: number | null; target: number | null; stretch: number | null }
export interface TypeView {
  typeId: string;
  name: string;
  isLaunch: boolean;
  usedBy: number;
  rows: TemplateRow[];
  addable: { resourceTypeId: string; name: string; groupName: string }[];
}

export function typesView(db: SqlDb): TypeView[] {
  const types = db.all(`SELECT t.*, (SELECT count(*) FROM updates u WHERE u.update_type_id = t.update_type_id) AS used
      FROM update_types t WHERE t.active = 1 ORDER BY t.sort_order`);
  return types.map(t => {
    const id = String(t.update_type_id);
    const rows = db.all(`SELECT x.*, r.name, coalesce(g.name, '분류 없음') AS group_name FROM type_templates x
        JOIN resource_types r ON r.resource_type_id = x.resource_type_id LEFT JOIN resource_groups g ON g.group_id = r.group_id
        WHERE x.update_type_id = ? ORDER BY coalesce(g.sort_order, 999999), r.sort_order`, [id])
      .map(r => ({ resourceTypeId: String(r.resource_type_id), name: String(r.name), groupName: String(r.group_name), min: num(r.min_qty), target: num(r.target_qty), stretch: num(r.stretch_qty) }));
    const addable = db.all(`SELECT r.resource_type_id, r.name, coalesce(g.name, '분류 없음') AS group_name
        FROM resource_types r LEFT JOIN resource_groups g ON g.group_id = r.group_id
        WHERE r.active = 1 AND r.resource_type_id NOT IN (SELECT resource_type_id FROM type_templates WHERE update_type_id = ?)
        ORDER BY coalesce(g.sort_order, 999999), r.sort_order`, [id])
      .map(r => ({ resourceTypeId: String(r.resource_type_id), name: String(r.name), groupName: String(r.group_name) }));
    return { typeId: id, name: String(t.name), isLaunch: Number(t.is_launch) === 1, usedBy: Number(t.used), rows, addable };
  });
}

// ───────── 인력 ─────────

export interface CapacityCell { headcount: number; utilization: number; productivity: number; outsource_days: number; support_days: number }
export interface CapacityView {
  horizon: { start: string; end: string };
  /** 작업자 명단(계산에는 쓰지 않음) */
  people: Person[];
  /** 명단에 없는 에셋 담당(담당에서 찾기, docs/31) */
  candidates: AssigneeCandidate[];
  /** 소속팀 목록: 파트 + 지원 팀 */
  teams: TeamOption[];
  months: string[];
  parts: { partId: string; name: string; cells: (CapacityCell | null)[] }[];
}

export function capacityView(db: SqlDb): CapacityView {
  const s = db.get('SELECT horizon_start_month AS a, horizon_end_month AS b FROM settings WHERE id = 1') ?? {};
  const months = s.a && s.b ? monthsBetween(String(s.a), String(s.b)) : [];
  const rows = new Map(db.all('SELECT * FROM capacity').map(r => [`${r.part_id}|${r.month}`, r]));
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(p => ({
    partId: String(p.part_id),
    name: String(p.name),
    cells: months.map(m => {
      const r = rows.get(`${p.part_id}|${m}`);
      return r ? {
        headcount: Number(r.headcount), utilization: Number(r.utilization), productivity: Number(r.productivity),
        outsource_days: Number(r.outsource_days), support_days: Number(r.support_days),
      } : null;
    }),
  }));
  return { people: peopleList(db), candidates: assigneeCandidates(db), teams: teamOptions(db), horizon: { start: String(s.a ?? ''), end: String(s.b ?? '') }, months, parts };
}

// ───────── 실적 ─────────

export interface ProgressCell { partId: string; passes: boolean; completed: number | null; spent: number | null; asOf: string | null; flag: string | null }
export interface ProgressRow {
  resourceTypeId: string;
  name: string;
  groupName: string;
  target: number;
  stretch: number;
  outsource: number;
  cells: ProgressCell[];
  /** 마지막 공정 완료 ÷ (목표 − 외주) */
  doneRate: number;
  /** 에셋이 등록된 줄: 완료 수량은 에셋 상태에서 집계(손 입력 잠금) */
  fromAssets: boolean;
}
export interface ProgressView {
  updates: { updateId: string; name: string; live: boolean; status: string }[];
  updateId: string | null;
  parts: { partId: string; name: string }[];
  rows: ProgressRow[];
  /** 기본 공수로 바꾼 진행: 완료한 인·일 ÷ 목표 인·일 */
  summary: { doneDays: number; totalDays: number; byPart: { partId: string; name: string; doneDays: number; totalDays: number }[] };
  latestAsOf: string | null;
}

export function progressView(db: SqlDb, wanted: string | null): ProgressView {
  const updates = db.all(`SELECT update_id, name, status FROM updates
      ORDER BY CASE WHEN status IN ('PLANNED', 'IN_PROGRESS') THEN 0 ELSE 1 END, priority, sort_order`)
    .map(u => ({ updateId: String(u.update_id), name: String(u.name), live: u.status === 'PLANNED' || u.status === 'IN_PROGRESS', status: String(u.status) }));
  const updateId = updates.find(u => u.updateId === wanted)?.updateId ?? updates[0]?.updateId ?? null;
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(p => ({ partId: String(p.part_id), name: String(p.name) }));
  const empty = { updates, updateId, parts, rows: [], summary: { doneDays: 0, totalDays: 0, byPart: parts.map(p => ({ ...p, doneDays: 0, totalDays: 0 })) }, latestAsOf: null };
  if (!updateId) return empty;

  const passes = new Set(db.all('SELECT resource_type_id, part_id FROM resource_parts').map(r => `${r.resource_type_id}|${r.part_id}`));
  const groupsFor = partGroupsFor(db);
  const base = new Map(db.all("SELECT resource_type_id, part_id, days FROM efforts WHERE profile_id = 'BASE'").map(r => [`${r.resource_type_id}|${r.part_id}`, Number(r.days)]));
  const done = new Map(db.all('SELECT * FROM progress WHERE update_id = ?', [updateId]).map(r => [`${r.resource_type_id}|${r.part_id}`, r]));
  // 실적 관련 주의(A02 확장 초과, A04 앞 공정보다 많이 끝남)를 칸에 붙인다
  const flags = new Map<string, string>();
  const vol = new Map(db.all('SELECT resource_type_id, stretch_qty FROM volumes WHERE update_id = ?', [updateId]).map(r => [String(r.resource_type_id), Number(r.stretch_qty ?? 0)]));
  const withAssets = new Set(db.all('SELECT DISTINCT resource_type_id FROM assets WHERE update_id = ?', [updateId]).map(r => String(r.resource_type_id)));
  const byPart = new Map(parts.map(p => [p.partId, { ...p, doneDays: 0, totalDays: 0 }]));
  const rows: ProgressRow[] = db.all(`SELECT v.*, r.name, coalesce(g.name, '분류 없음') AS group_name FROM volumes v
      JOIN resource_types r ON r.resource_type_id = v.resource_type_id LEFT JOIN resource_groups g ON g.group_id = r.group_id
      WHERE v.update_id = ? ORDER BY coalesce(g.sort_order, 999999), r.sort_order`, [updateId]).map(v => {
    const rt = String(v.resource_type_id);
    const target = Number(v.target_qty ?? 0);
    const outsource = Number(v.outsource_qty ?? 0);
    const need = Math.max(0, target - outsource);
    let last = 0;
    // 앞 공정 = 이 리소스 공정 묶음(파이프라인)에서 바로 앞 묶음의 거치는 파트 모두(병렬 묶음이면 여럿, docs/30)
    const chain = groupsFor(rt).map(g => g.filter(pid => passes.has(`${rt}|${pid}`))).filter(g => g.length);
    const prevOf = new Map(chain.flatMap((g, i) => g.map(pid => [pid, i > 0 ? chain[i - 1] : null] as const)));
    const doneOf = (pid: string) => Number(done.get(`${rt}|${pid}`)?.completed_qty ?? 0);
    if (chain.length) last = Math.min(...chain[chain.length - 1].map(doneOf));
    const cells = parts.map(p => {
      const key = `${rt}|${p.partId}`;
      const on = passes.has(key);
      const row = done.get(key);
      const completed = row ? Number(row.completed_qty) : null;
      let flag: string | null = null;
      if (on) {
        const c = completed ?? 0;
        const before = prevOf.get(p.partId) ?? null;
        if (c > (vol.get(rt) ?? 0)) flag = '세 번째 템플릿 물량보다 많습니다';
        else if (before !== null && c > Math.min(...before.map(doneOf))) flag = '앞 공정보다 많이 끝났습니다';
        const days = base.get(key) ?? 0;
        const bp = byPart.get(p.partId)!;
        bp.totalDays += need * days;
        bp.doneDays += Math.min(c, need) * days;
      }
      if (flag) flags.set(key, flag);
      return { partId: p.partId, passes: on, completed: completed === 0 ? null : completed, spent: row?.spent_days == null ? null : Number(row.spent_days), asOf: row?.as_of == null ? null : String(row.as_of), flag };
    });
    return { resourceTypeId: rt, name: String(v.name), groupName: String(v.group_name), target, stretch: Number(v.stretch_qty ?? 0), outsource, cells, doneRate: need > 0 ? Math.min(1, last / need) : (last > 0 ? 1 : 0), fromAssets: withAssets.has(rt) };
  });
  const list = [...byPart.values()];
  const latest = db.get('SELECT max(as_of) AS d FROM progress WHERE update_id = ?', [updateId])?.d;
  return {
    updates, updateId, parts, rows,
    summary: { doneDays: list.reduce((a, p) => a + p.doneDays, 0), totalDays: list.reduce((a, p) => a + p.totalDays, 0), byPart: list },
    latestAsOf: latest == null ? null : String(latest),
  };
}

// ───────── 프로젝트 · 파트 · 리소스(만든 뒤 고치기) ─────────

export interface SetupView {
  project: { name: string; bufferRate: number; workWeekdays: string; holidays: { date: string; name: string; kind: string }[]; jiraBase: string | null };
  horizon: { start: string; end: string };
  parts: { partId: string; name: string; active: boolean; usedBy: number; hasProgress: boolean; headcount: number | null; utilization: number | null; aiShare: number }[];
  groups: { groupId: string; name: string }[];
  resources: {
    resourceTypeId: string; name: string; groupId: string | null; groupName: string; active: boolean; used: boolean;
    /** 고른 파이프라인(없으면 null = 파트 표 순서) */
    pipelineId: string | null;
    /** records = 그 칸의 작업 진척(완료 수량 합) · 에셋 상태 수: 비울 때 옮기기 · 지우기 창을 띄운다 */
    efforts: Record<string, { base: number | null; ai: number | null; rework: number; done: number; assets: number }>;
  }[];
  hasAI: boolean;
  /** 이름 붙인 파이프라인(단계 순서 · 단계 겹침률 · 쓰는 리소스 수) */
  pipelines: PipelineInfo[];
  /** 파트 쌍 겹침률(파이프라인을 고르지 않은 리소스 · 단계 겹침률이 빈 곳), 기본 겹침률 */
  overlaps: { from: string; to: string; rate: number }[];
  defaultOverlap: number;
}

/** 새 프로젝트 마법사에서 입력한 것(기본 정보·파트·리소스·공수)을 만든 뒤에 고치는 화면용 */
export function setupView(db: SqlDb): SetupView {
  const meta = Object.fromEntries(db.all('SELECT key, value FROM meta').map(r => [String(r.key), r.value]));
  const s = db.get('SELECT * FROM settings WHERE id = 1')!;
  const start = String(s.horizon_start_month); const end = String(s.horizon_end_month);
  // 파트의 "기본" 인원·가동률 = 계획 기간 안에서 가장 많이 쓰인 값(달마다 다르면 그중 가장 흔한 값)
  const common = (partId: string, col: string): number | null => {
    const r = db.get(`SELECT ${col} AS v, count(*) AS n FROM capacity WHERE part_id = ? AND month BETWEEN ? AND ? GROUP BY ${col} ORDER BY n DESC, ${col} DESC LIMIT 1`, [partId, start, end]);
    return r ? Number(r.v) : null;
  };
  const parts = db.all('SELECT * FROM parts ORDER BY sort_order, part_id').map(p => ({
    partId: String(p.part_id), name: String(p.name), active: Number(p.active) === 1,
    usedBy: Number(db.get('SELECT count(*) AS n FROM resource_parts WHERE part_id = ?', [p.part_id])?.n ?? 0),
    hasProgress: !!db.get('SELECT 1 AS ok FROM progress WHERE part_id = ? LIMIT 1', [p.part_id]),
    headcount: common(String(p.part_id), 'headcount'), utilization: common(String(p.part_id), 'utilization'),
    aiShare: Number(db.get("SELECT share FROM effort_mix WHERE part_id = ? AND profile_id = 'AI'", [p.part_id])?.share ?? 0),
  }));
  const groups = db.all('SELECT group_id, name FROM resource_groups ORDER BY sort_order, group_id').map(g => ({ groupId: String(g.group_id), name: String(g.name) }));
  const groupName = new Map(groups.map(g => [g.groupId, g.name]));
  const rps = db.all('SELECT * FROM resource_parts');
  const effs = db.all('SELECT * FROM efforts');
  const doneBy = new Map(db.all('SELECT resource_type_id, part_id, sum(completed_qty) AS n FROM progress GROUP BY resource_type_id, part_id').map(r => [`${r.resource_type_id}|${r.part_id}`, Number(r.n)]));
  const assetBy = new Map(db.all('SELECT a.resource_type_id, ap.part_id, count(*) AS n FROM asset_parts ap JOIN assets a ON a.asset_id = ap.asset_id GROUP BY a.resource_type_id, ap.part_id').map(r => [`${r.resource_type_id}|${r.part_id}`, Number(r.n)]));
  const resources = db.all(`SELECT r.* FROM resource_types r LEFT JOIN resource_groups g ON g.group_id = r.group_id
      ORDER BY coalesce(g.sort_order, 1e9), r.sort_order, r.resource_type_id`).map(r => {
    const id = String(r.resource_type_id);
    const efforts: SetupView['resources'][number]['efforts'] = {};
    for (const rp of rps.filter(x => x.resource_type_id === id)) {
      const of = (prof: string) => { const e = effs.find(x => x.resource_type_id === id && x.part_id === rp.part_id && x.profile_id === prof); return e ? Number(e.days) : null; };
      const k = `${id}|${rp.part_id}`;
      efforts[String(rp.part_id)] = { base: of('BASE'), ai: of('AI'), rework: Number(rp.rework_rate), done: doneBy.get(k) ?? 0, assets: assetBy.get(k) ?? 0 };
    }
    const used = ['volumes', 'type_templates', 'progress', 'assets'].some(t => db.get(`SELECT 1 AS ok FROM ${t} WHERE resource_type_id = ? LIMIT 1`, [id]));
    return { resourceTypeId: id, name: String(r.name), groupId: r.group_id == null ? null : String(r.group_id), groupName: r.group_id == null ? '' : groupName.get(String(r.group_id)) ?? '', active: Number(r.active) === 1, used, pipelineId: (r.pipeline_id as string) ?? null, efforts };
  });
  return {
    project: {
      name: String(meta.project_name ?? ''), bufferRate: Number(s.buffer_rate), workWeekdays: String(s.work_weekdays),
      holidays: db.all('SELECT * FROM holidays ORDER BY date').map(h => ({ date: String(h.date), name: String(h.name), kind: String(h.kind) })),
      jiraBase: meta.jira_base_url ? String(meta.jira_base_url) : null,
    },
    horizon: { start, end },
    parts, groups, resources,
    hasAI: !!db.get("SELECT 1 AS ok FROM effort_profiles WHERE profile_id = 'AI'"),
    pipelines: pipelinesList(db),
    overlaps: db.all('SELECT * FROM part_overlaps').map(o => ({ from: String(o.from_part_id), to: String(o.to_part_id), rate: Number(o.overlap_rate) })),
    defaultOverlap: Number(s.default_overlap_rate ?? 0),
  };
}
