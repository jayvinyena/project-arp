// 런칭 물량 설계: 화면 요약, 물량·날짜 고치기(변경 이력), 구간 비교, 두 방향 역산.
// Node와 브라우저(Worker)가 같이 쓴다.
import type { SqlDb } from './db.ts';
import type { ProjectData, PlanMode, PlanResult, UpdateResult } from '../engine/types.ts';
import { runPlan } from '../engine/index.ts';
import type { ProjectSession, Finding } from './pipeline.ts';
import { applyEdit } from './edits.ts';
import type { Edit, EditContext } from './edits.ts';

export const PLAN_MODES: PlanMode[] = ['MIN', 'TARGET', 'STRETCH'];
export const QTY_FIELD = { MIN: 'min_qty', TARGET: 'target_qty', STRETCH: 'stretch_qty' } as const;

// ───────── 요약 ─────────

export interface LaunchPartStep { partId: string; name: string; completed: number }
export interface LaunchRow {
  resourceTypeId: string;
  name: string;
  groupId: string | null;
  groupName: string;
  parts: LaunchPartStep[];
  min: number | null;
  target: number | null;
  stretch: number | null;
  outsource: number;
  required: boolean;
}
export interface LaunchInfo {
  updateId: string;
  name: string;
  startDate: string | null;
  freezeDate: string | null;
  releaseDate: string | null;
}
export interface LaunchSnapshot {
  projectName: string;
  dataVersion: number;
  launch: LaunchInfo | null;
  rows: LaunchRow[];
  parts: { partId: string; name: string }[];
  /** 런칭 물량에 아직 없는 리소스 종류 */
  addable: { resourceTypeId: string; name: string; groupName: string }[];
  horizon: { start: string; end: string };
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function findLaunchId(db: SqlDb): string | null {
  const r = db.get(`SELECT u.update_id FROM updates u JOIN update_types t ON t.update_type_id = u.update_type_id
    WHERE t.is_launch = 1 AND u.status IN ('PLANNED', 'IN_PROGRESS') ORDER BY u.priority, u.sort_order LIMIT 1`);
  return r ? String(r.update_id) : null;
}

/** 업데이트 하나의 물량 행(분류·거치는 파트·완료)과 더할 수 있는 리소스. 런칭과 업데이트가 같이 쓴다 */
export function volumeRows(db: SqlDb, updateId: string): { rows: LaunchRow[]; addable: LaunchSnapshot['addable'] } {
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(r => ({ partId: String(r.part_id), name: String(r.name) }));
  const partName = new Map(parts.map(p => [p.partId, p.name]));
  const steps = new Map<string, LaunchPartStep[]>();
  for (const r of db.all(`SELECT rp.resource_type_id, rp.part_id, coalesce(pr.completed_qty, 0) AS completed
      FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id AND p.active = 1
      LEFT JOIN progress pr ON pr.update_id = ? AND pr.resource_type_id = rp.resource_type_id AND pr.part_id = rp.part_id
      ORDER BY p.sort_order`, [updateId])) {
    const key = String(r.resource_type_id);
    if (!steps.has(key)) steps.set(key, []);
    steps.get(key)!.push({ partId: String(r.part_id), name: partName.get(String(r.part_id)) ?? String(r.part_id), completed: Number(r.completed) });
  }
  const rows: LaunchRow[] = db.all(`SELECT v.*, r.name, r.group_id, coalesce(g.name, '분류 없음') AS group_name
      FROM volumes v JOIN resource_types r ON r.resource_type_id = v.resource_type_id
      LEFT JOIN resource_groups g ON g.group_id = r.group_id
      WHERE v.update_id = ? ORDER BY coalesce(g.sort_order, 999999), r.sort_order`, [updateId]).map(r => ({
    resourceTypeId: String(r.resource_type_id),
    name: String(r.name),
    groupId: str(r.group_id),
    groupName: String(r.group_name),
    parts: steps.get(String(r.resource_type_id)) ?? [],
    min: num(r.min_qty),
    target: num(r.target_qty),
    stretch: num(r.stretch_qty),
    outsource: Number(r.outsource_qty),
    required: Number(r.required) === 1,
  }));
  const addable = db.all(`SELECT r.resource_type_id, r.name, coalesce(g.name, '분류 없음') AS group_name
      FROM resource_types r LEFT JOIN resource_groups g ON g.group_id = r.group_id
      WHERE r.active = 1 AND r.resource_type_id NOT IN (SELECT resource_type_id FROM volumes WHERE update_id = ?)
      ORDER BY coalesce(g.sort_order, 999999), r.sort_order`, [updateId])
    .map(r => ({ resourceTypeId: String(r.resource_type_id), name: String(r.name), groupName: String(r.group_name) }));
  return { rows, addable };
}

export function launchSnapshot(db: SqlDb): LaunchSnapshot {
  const meta = Object.fromEntries(db.all('SELECT key, value FROM meta').map(r => [String(r.key), r.value]));
  const settings = db.get('SELECT horizon_start_month, horizon_end_month FROM settings WHERE id = 1') ?? {};
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(r => ({ partId: String(r.part_id), name: String(r.name) }));
  const launchId = findLaunchId(db);
  const base = {
    projectName: String(meta.project_name ?? '이름 없는 프로젝트'),
    dataVersion: Number(meta.data_version ?? 0),
    parts,
    horizon: { start: String(settings.horizon_start_month ?? ''), end: String(settings.horizon_end_month ?? '') },
  };
  if (!launchId) return { ...base, launch: null, rows: [], addable: [] };

  const u = db.get('SELECT * FROM updates WHERE update_id = ?', [launchId]) as Row;
  const { rows, addable } = volumeRows(db, launchId);

  return {
    ...base,
    launch: { updateId: launchId, name: String(u.name), startDate: str(u.start_date), freezeDate: str(u.freeze_date), releaseDate: str(u.release_date) },
    rows,
    addable,
  };
}

// ───────── 고치기 ─────────

export type LaunchEdit =
  | { kind: 'volume'; resourceTypeId: string; field: 'min_qty' | 'target_qty' | 'stretch_qty' | 'outsource_qty'; value: number | null }
  | { kind: 'date'; field: 'start_date' | 'freeze_date' | 'release_date'; value: string | null }
  | { kind: 'addResource'; resourceTypeId: string }
  | { kind: 'removeResource'; resourceTypeId: string };

export type { EditContext };

/** 런칭 물량·날짜 고치기 → 공통 고치기(core/edits.ts). 값이 그대로면 false */
export function applyLaunchEdit(db: SqlDb, session: ProjectSession, edit: LaunchEdit, ctx: EditContext): boolean {
  const launchId = findLaunchId(db);
  if (!launchId) throw new Error('런칭 업데이트가 없어요');
  const e: Edit = edit.kind === 'date'
    ? { kind: 'updateField', updateId: launchId, field: edit.field, value: edit.value }
    : { ...edit, updateId: launchId };
  return applyEdit(db, session, e, ctx).changed;
}

// ───────── 구간 비교 ─────────

export interface LaunchPartLoad {
  partId: string;
  name: string;
  /** 런칭 스테이지의 필요 공수 */
  launchDays: number;
  /** 런칭 기간(시작 달 ~ 제작 완료 목표 달) 작업 가능량 */
  windowCapacity: number;
  /** 런칭 기간에 실제 배정된 양(모든 업데이트) */
  windowAssigned: number;
  /** 런칭 스테이지의 가장 긴 인력 대기(영업일) */
  maxWait: number;
  /** 런칭이 이 파트에서 가장 늦게 끝나는가 */
  critical: boolean;
}

export interface ModeOutcome {
  planMode: PlanMode;
  launch: UpdateResult | null;
  /** 제작 완료 목표일(없으면 출시일) 대비 영업일: 음수 = 여유, 양수 = 늦음 */
  slackWorkdays: number | null;
  launchDays: number;
  parts: LaunchPartLoad[];
  /** 리소스별 필요 공수(런칭) */
  byResource: Record<string, number>;
}

export interface LaunchCompare {
  blocked: boolean;
  findings: Finding[];
  modes: ModeOutcome[];
  ms: number;
}

function deadlineOf(u: { freeze_date?: string | null; release_date?: string | null } | LaunchInfo): string | null {
  const freeze = 'freezeDate' in u ? u.freezeDate : u.freeze_date;
  const release = 'releaseDate' in u ? u.releaseDate : u.release_date;
  return freeze ?? release ?? null;
}

function slack(result: PlanResult, launch: UpdateResult): number | null {
  const deadline = launch.freezeDate ?? launch.releaseDate;
  if (!deadline || !launch.expectedCompletionDate) return null;
  const days = result.daily.dates;
  const di = days.findIndex(d => d > deadline);
  const ci = days.indexOf(launch.expectedCompletionDate);
  const deadlineIndex = di === -1 ? days.length - 1 : di - 1;
  return ci - deadlineIndex;
}

export function summarizeLaunch(result: PlanResult, launchId: string, planMode: PlanMode): ModeOutcome {
  const launch = result.updates.find(u => u.updateId === launchId) ?? null;
  const stages = result.stages.filter(s => s.updateId === launchId);
  const byResource: Record<string, number> = {};
  for (const s of stages) byResource[s.resourceTypeId] = (byResource[s.resourceTypeId] ?? 0) + s.requiredDays;
  const startMonth = (launch?.startDate ?? '').slice(0, 7);
  const endMonth = (launch ? (launch.freezeDate ?? launch.releaseDate ?? '') : '').slice(0, 7);
  const inWindow = (m: string) => (!startMonth || m >= startMonth) && (!endMonth || m <= endMonth);
  const parts: LaunchPartLoad[] = result.parts.map(p => {
    const ps = stages.filter(s => s.partId === p.partId);
    const months = result.partMonths.filter(m => m.partId === p.partId && inWindow(m.month));
    return {
      partId: p.partId,
      name: p.name,
      launchDays: ps.reduce((a, s) => a + s.requiredDays, 0),
      windowCapacity: months.reduce((a, m) => a + m.capacityDays, 0),
      windowAssigned: months.reduce((a, m) => a + m.assignedDays, 0),
      maxWait: ps.reduce((a, s) => Math.max(a, s.waitWorkdays ?? 0), 0),
      critical: launch?.reason?.partId === p.partId && launch.status !== 'ON_TRACK',
    };
  });
  return {
    planMode,
    launch,
    slackWorkdays: launch ? slack(result, launch) : null,
    launchDays: stages.reduce((a, s) => a + s.requiredDays, 0),
    parts,
    byResource,
  };
}

export function compareLaunchModes(db: SqlDb, session: ProjectSession): LaunchCompare {
  const t0 = performance.now();
  const launchId = findLaunchId(db);
  const prepared = session.prepare();
  if (prepared.blocked || !prepared.data || !launchId) {
    return { blocked: prepared.blocked || !launchId, findings: prepared.findings, modes: [], ms: performance.now() - t0 };
  }
  const modes = PLAN_MODES.map(mode => summarizeLaunch(runPlan(prepared.data!, { planMode: mode }), launchId, mode));
  return { blocked: false, findings: prepared.findings, modes, ms: performance.now() - t0 };
}

// ───────── 역산 ─────────

function launchMeetsDeadline(data: ProjectData, launchId: string, planMode: PlanMode): { ok: boolean; launch: UpdateResult | undefined } {
  const launch = runPlan(data, { planMode }).updates.find(u => u.updateId === launchId);
  return { ok: launch?.status === 'ON_TRACK', launch };
}

export interface MaxScaleResult {
  deadline: string | null;
  /** 지금 물량으로 제작 완료 목표일에 맞는가 */
  currentOk: boolean;
  /** 모든 런칭 물량을 같은 비율로 바꿀 때 맞출 수 있는 최대 비율(0.01 단위). null = 0으로 줄여도 안 됨 */
  scale: number | null;
  /** 그 비율일 때 리소스별 수량(내림) */
  suggestion: { resourceTypeId: string; current: number; suggested: number }[];
  runs: number;
}

/** "이 인원과 날짜로 최대 얼마까지": 런칭 물량(선택 구간)을 같은 비율로 키우거나 줄여 맞는 최대 비율을 찾는다 */
export function maxLaunchScale(data: ProjectData, launchId: string, planMode: PlanMode = 'TARGET'): MaxScaleResult {
  const field = QTY_FIELD[planMode];
  const u = data.updates.find(x => x.update_id === launchId);
  const deadline = u ? deadlineOf(u) : null;
  const launchVolumes = data.volumes.filter(v => v.update_id === launchId);
  let runs = 0;
  const withScale = (k: number): ProjectData => ({
    ...data,
    volumes: data.volumes.map(v => (v.update_id === launchId ? { ...v, [field]: (v[field] ?? 0) * k } : v)),
  });
  const ok = (k: number) => { runs += 1; return launchMeetsDeadline(withScale(k), launchId, planMode).ok; };
  if (!deadline) return { deadline, currentOk: false, scale: null, suggestion: [], runs };

  const currentOk = ok(1);
  let lo: number;
  let hi: number;
  if (currentOk) {
    lo = 1; hi = 2;
    while (hi <= 8 && ok(hi)) { lo = hi; hi *= 2; }
    if (hi > 8) hi = lo; // 8배까지 맞으면 거기서 멈춘다
  } else {
    if (!ok(0)) return { deadline, currentOk, scale: null, suggestion: [], runs };
    lo = 0; hi = 1;
  }
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid; else hi = mid;
  }
  const scale = Math.floor(lo * 100) / 100;
  return {
    deadline,
    currentOk,
    scale,
    suggestion: launchVolumes.map(v => ({ resourceTypeId: v.resource_type_id, current: v[field] ?? 0, suggested: Math.floor((v[field] ?? 0) * scale) })),
    runs,
  };
}

export interface HeadcountResult {
  deadline: string | null;
  currentOk: boolean;
  feasible: boolean;
  /** 런칭 기간(시작 달 ~ 제작 완료 목표 달) 동안 더할 인원 */
  additions: { partId: string; heads: number }[];
  months: { from: string; to: string } | null;
  completion: string | null;
  runs: number;
}

/**
 * "이 물량이면 몇 명 더": 런칭 기간(시작 달 ~ 제작 완료 목표 달)에 파트별로 더할 최소 인원(0.5명 단위)을 찾는다.
 *   1) 모든 파트에 같은 인원 x를 더해 맞는 가장 작은 x를 찾는다(두 배씩 늘린 뒤 이분 탐색).
 *   2) 공정 순서대로 파트마다 더한 인원을 맞는 데까지 줄인다(이분 탐색).
 * 실행 횟수가 파트 수에 비례해 일정하고, 한 파트에 인원을 몰아주지 않는다.
 */
export function headcountForLaunch(data: ProjectData, launchId: string, planMode: PlanMode = 'TARGET', step = 0.5, maxHeads = 200): HeadcountResult {
  const u = data.updates.find(x => x.update_id === launchId);
  const deadline = u ? deadlineOf(u) : null;
  if (!u || !deadline || !u.start_date) return { deadline, currentOk: false, feasible: false, additions: [], months: null, completion: null, runs: 0 };
  const from = u.start_date.slice(0, 7) < data.settings.horizon_start_month ? data.settings.horizon_start_month : u.start_date.slice(0, 7);
  const to = deadline.slice(0, 7) > data.settings.horizon_end_month ? data.settings.horizon_end_month : deadline.slice(0, 7);
  const partIds = data.parts.filter(p => p.active === 1).sort((a, b) => a.sort_order - b.sort_order).map(p => p.part_id);
  let runs = 0;
  let last: UpdateResult | undefined;
  const test = (added: Map<string, number>): boolean => {
    runs += 1;
    const d: ProjectData = {
      ...data,
      capacity: data.capacity.map(c => {
        const extra = added.get(c.part_id) ?? 0;
        return extra > 0 && c.month >= from && c.month <= to ? { ...c, headcount: c.headcount + extra } : c;
      }),
    };
    const r = launchMeetsDeadline(d, launchId, planMode);
    if (r.ok) last = r.launch;
    return r.ok;
  };
  const uniform = (x: number) => new Map(partIds.map(p => [p, x]));
  const months = { from, to };

  if (test(new Map())) return { deadline, currentOk: true, feasible: true, additions: [], months, completion: last?.expectedCompletionDate ?? null, runs };

  // 1) 모두에게 같은 인원
  let hi = step;
  while (hi <= maxHeads && !test(uniform(hi))) hi *= 2;
  if (hi > maxHeads) return { deadline, currentOk: false, feasible: false, additions: [], months, completion: null, runs };
  let lo = hi === step ? 0 : hi / 2; // lo는 안 맞음, hi는 맞음
  while (hi - lo > step) {
    const mid = Math.ceil((lo + hi) / 2 / step) * step;
    if (mid >= hi) break;
    if (test(uniform(mid))) hi = mid; else lo = mid;
  }
  const added = uniform(hi);

  // 2) 파트마다 줄이기
  for (const part of partIds) {
    let keep = added.get(part)!; // 맞음
    let cut = -step;             // 0까지 줄일 수 있는지도 본다
    while (keep - cut > step) {
      const mid = Math.max(0, Math.floor((cut + keep) / 2 / step) * step);
      if (mid >= keep) break;
      added.set(part, mid);
      if (test(added)) keep = mid; else cut = mid;
    }
    added.set(part, keep);
  }
  test(added); // 마지막 조합의 완료일
  return {
    deadline,
    currentOk: false,
    feasible: true,
    additions: [...added].filter(([, h]) => h > 0).map(([partId, heads]) => ({ partId, heads })),
    months,
    completion: last?.expectedCompletionDate ?? null,
    runs,
  };
}
