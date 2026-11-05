// 7단계: 마감 일정 맞춤 제안.
// 모든 계산 대상 업데이트가 마감(제작 완료 목표일 또는 출시일)을 지키도록, 허용한 수단을 한 걸음씩 더해 본다.
//   - 가장 급한(우선순위가 높은) 늦은 업데이트부터
//   - 수단마다 한 걸음을 계산해 보고, "줄어든 늦음 ÷ 비용"이 가장 큰 걸음을 고른다
//   - 다 맞거나, 더 줄일 걸음이 없거나, 계산 횟수 상한에 닿으면 멈춘다
// 결과는 걸음 목록(설명)과 시나리오 동작(그대로 시뮬레이션에 넣을 수 있음)으로 돌려준다.
import type { ProjectData, PlanMode, PlanResult, UpdateResult } from '../engine/types.ts';
import { runPlan } from '../engine/index.ts';
import type { SqlDb } from './db.ts';
import { applyScenarioOp } from './scenarios.ts';
import type { ScenarioAction } from './scenarios.ts';

export interface AdvisorOptions {
  planMode?: PlanMode;
  /** 맞출 날: 제작 완료 목표일(없으면 출시일) 또는 출시일 */
  deadline?: 'freeze' | 'release';
  levers?: { headcount?: boolean; outsource?: boolean; volume?: boolean; priority?: boolean };
  /** 파트마다 어느 달이든 더할 수 있는 인원 상한(명) */
  maxHeadsPerPart?: number;
  /** 파트·달마다 더할 수 있는 외주 상한(인·일) */
  maxOutsourceDays?: number;
  /** 엔진 계산 횟수 상한 */
  maxRuns?: number;
  /** 계산 시간 상한(ms) */
  maxMs?: number;
}

export interface Outcome { updateId: string; name: string; deadline: string | null; completion: string | null; status: string; late: number; unfinished: boolean }
export interface AdvisorStep {
  kind: 'headcount' | 'outsource' | 'volumeToMin' | 'priority';
  label: string;
  /** 같은 걸음을 몇 번 묶었나(인원·외주는 합친 양) */
  amount: number;
  /** 이 걸음이 도운 업데이트 */
  forUpdate: string;
  /** 점수로 본 효과(내부 비교용) */
  gain: number;
  /** 당긴 영업일(기간 안에 끝나던 업데이트들의 합) */
  days: number;
  /** "기간 안에 못 끝남"에서 벗어난 업데이트 수 */
  rescued: number;
  cost: number;
}
export interface AdvisorResult {
  alreadyOk: boolean;
  feasible: boolean;
  before: Outcome[];
  after: Outcome[];
  steps: AdvisorStep[];
  totals: { extraHeadMonths: number; outsourceDays: number; cutUnits: number; reprioritized: number };
  actions: ScenarioAction[];
  runs: number;
  ms: number;
  /** 계산 상한에 닿아 멈췄나 */
  limited: boolean;
  /** 더 줄일 수 없어 남은 늦은 업데이트와 이유 */
  stuck: { name: string; why: string }[];
}

const STEP_HEADS = 0.5;
const STEP_OUTSOURCE = 10;
const UNFINISHED_PENALTY = 1000;

const LIVE = (s: string) => s === 'PLANNED' || s === 'IN_PROGRESS';
const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function monthsBetween(a: string, b: string): string[] {
  const out: string[] = [];
  let [y, m] = a.split('-').map(Number);
  const [ey, em] = b.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

interface State {
  heads: Map<string, number>;   // part|month → 더한 인원
  outs: Map<string, number>;    // part|month → 더한 외주 인·일
  mins: Map<string, 'optional' | 'all'>;
  order: string[];              // 계산 대상 업데이트 우선순위 순서
}
const clone = (s: State): State => ({ heads: new Map(s.heads), outs: new Map(s.outs), mins: new Map(s.mins), order: [...s.order] });

/** 상태를 원본 데이터에 얹는다(시나리오 동작과 똑같이 바꾼다) */
function build(data: ProjectData, s: State, initial: string[]): ProjectData {
  // 순서가 처음과 같으면 우선순위 숫자를 건드리지 않는다(동률 처리까지 원본 그대로)
  const moved = s.order.some((id, i) => initial[i] !== id);
  const rank = new Map(moved ? s.order.map((id, i) => [id, i + 1]) : []);
  return {
    ...data,
    capacity: data.capacity.map(c => {
      const k = `${c.part_id}|${c.month}`;
      const h = s.heads.get(k) ?? 0;
      const o = s.outs.get(k) ?? 0;
      return h || o ? { ...c, headcount: Math.max(0, c.headcount + h), outsource_days: Math.max(0, c.outsource_days + o) } : c;
    }),
    volumes: data.volumes.map(v => {
      const mode = s.mins.get(v.update_id);
      if (!mode || v.min_qty == null || (mode === 'optional' && v.required === 1)) return v;
      return { ...v, target_qty: v.min_qty, stretch_qty: v.min_qty };
    }),
    updates: data.updates.map(u => (rank.has(u.update_id) ? { ...u, priority: rank.get(u.update_id)! } : u)),
  };
}

function outcomes(r: PlanResult, deadline: 'freeze' | 'release'): Outcome[] {
  const days = r.daily.dates;
  const lastIndexOnOrBefore = (d: string) => {
    let lo = 0; let hi = days.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (days[mid] <= d) lo = mid + 1; else hi = mid; }
    return lo - 1;
  };
  return r.updates.map((u: UpdateResult) => {
    const dl = deadline === 'freeze' ? (u.freezeDate ?? u.releaseDate) : u.releaseDate;
    const unfinished = u.status === 'UNFINISHED';
    let late = 0;
    if (unfinished) late = UNFINISHED_PENALTY + u.remainingDays / 10;
    else if (dl && u.expectedCompletionDate && u.expectedCompletionDate > dl) late = Math.max(0, days.indexOf(u.expectedCompletionDate) - lastIndexOnOrBefore(dl));
    return { updateId: u.updateId, name: u.name, deadline: dl, completion: u.expectedCompletionDate, status: u.status, late, unfinished };
  });
}

export function adviseDeadlines(data: ProjectData, options: AdvisorOptions = {}): AdvisorResult {
  const t0 = now();
  const planMode = options.planMode ?? 'TARGET';
  const deadline = options.deadline ?? 'freeze';
  const levers = { headcount: true, outsource: false, volume: true, priority: true, ...options.levers };
  const maxHeads = options.maxHeadsPerPart ?? 5;
  const maxOut = options.maxOutsourceDays ?? 40;
  const maxRuns = options.maxRuns ?? 400;
  const maxMs = options.maxMs ?? 4000;
  const s = data.settings;
  const parts = new Map(data.parts.map(p => [p.part_id, p.name]));
  const updates = new Map(data.updates.map(u => [u.update_id, u]));
  const live = data.updates.filter(u => LIVE(u.status)).sort((a, b) => a.priority - b.priority || (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999') || a.sort_order - b.sort_order);

  const initial = live.map(u => u.update_id);
  let runs = 0;
  let limited = false;
  const out = () => { if (runs >= maxRuns || now() - t0 > maxMs) limited = true; return limited; };
  const evaluate = (st: State) => {
    runs += 1;
    const r = runPlan(build(data, st, initial), { planMode });
    const oc = outcomes(r, deadline);
    return { r, oc, score: oc.reduce((a, o) => a + o.late, 0) };
  };

  let state: State = { heads: new Map(), outs: new Map(), mins: new Map(), order: [...initial] };
  let cur = evaluate(state);
  const before = cur.oc;
  const steps: AdvisorStep[] = [];
  const stuck = new Map<string, string>();

  const windowOf = (updateId: string): string[] => {
    const u = updates.get(updateId)!;
    const dl = deadline === 'freeze' ? (u.freeze_date ?? u.release_date) : u.release_date;
    if (!u.start_date) return [];
    const from = u.start_date.slice(0, 7) < s.horizon_start_month ? s.horizon_start_month : u.start_date.slice(0, 7);
    const toRaw = (dl ?? `${s.horizon_end_month}-28`).slice(0, 7);
    const to = toRaw > s.horizon_end_month ? s.horizon_end_month : toRaw;
    return to >= from ? monthsBetween(from, to) : [];
  };
  // 지금 물량 구간의 수량(엔진과 같은 칸). 최저안이면 줄일 것이 없다
  const planQty = (v: ProjectData['volumes'][number]) => (planMode === 'MIN' ? v.min_qty : planMode === 'STRETCH' ? v.stretch_qty : v.target_qty);
  const hasMinRoom = (updateId: string, onlyOptional: boolean) => data.volumes.some(v => {
    const q = planQty(v);
    return v.update_id === updateId && v.min_qty != null && q != null && v.min_qty < q && (!onlyOptional || v.required === 0);
  });

  while (!out()) {
    const late = cur.oc.filter(o => o.late > 0 && !stuck.has(o.updateId))
      .sort((a, b) => state.order.indexOf(a.updateId) - state.order.indexOf(b.updateId));
    if (!late.length) break;
    const target = late[0];
    const reason = cur.r.updates.find(u => u.updateId === target.updateId)?.reason?.partId ?? null;
    const months = windowOf(target.updateId);
    const name = target.name;
    // 후보 만들기. mult는 인원·외주 한 걸음 크기 배수(작은 걸음이 효과 없을 때 키운다). 물량·우선순위는 mult 1에서만
    const gen = (mult: number) => {
    const hs = STEP_HEADS * mult;
    const os = STEP_OUTSOURCE * mult;
    const cands: { st: State; step: Omit<AdvisorStep, 'gain' | 'days' | 'rescued'> }[] = [];

    // 인원·외주 후보 파트: 원인 파트 + 이 업데이트에서 마감을 넘겨 끝나는(못 끝낸) 공정의 파트
    const tdl = target.deadline;
    const lateParts = [...new Set([
      ...(reason ? [reason] : []),
      ...cur.r.stages.filter(g => g.updateId === target.updateId && !g.alreadyDone && (g.completionDate == null || (tdl != null && g.completionDate > tdl))).map(g => g.partId),
    ])];
    for (const part of months.length ? lateParts : []) {
      if (levers.headcount) {
        const peak = Math.max(...months.map(m => state.heads.get(`${part}|${m}`) ?? 0));
        if (peak + hs <= maxHeads + 1e-9) {
          const st = clone(state);
          for (const m of months) st.heads.set(`${part}|${m}`, (st.heads.get(`${part}|${m}`) ?? 0) + hs);
          cands.push({ st, step: { kind: 'headcount', label: `${parts.get(part)}|${months[0]}~${months[months.length - 1]}`, amount: hs, forUpdate: name, cost: hs * months.length } });
        }
      }
      if (levers.outsource) {
        const peak = Math.max(...months.map(m => state.outs.get(`${part}|${m}`) ?? 0));
        if (peak + os <= maxOut + 1e-9) {
          const st = clone(state);
          for (const m of months) st.outs.set(`${part}|${m}`, (st.outs.get(`${part}|${m}`) ?? 0) + os);
          cands.push({ st, step: { kind: 'outsource', label: `${parts.get(part)}|${months[0]}~${months[months.length - 1]}`, amount: os, forUpdate: name, cost: (os / 20) * months.length } });
        }
      }
    }
    if (levers.volume && mult === 1) {
      const mode = state.mins.get(target.updateId);
      const cutCost = (st: State) => {
        const a = cur.r.updates.find(u => u.updateId === target.updateId)?.requiredDays ?? 0;
        runs += 1;
        const b = runPlan(build(data, st, initial), { planMode }).updates.find(u => u.updateId === target.updateId)?.requiredDays ?? 0;
        return Math.max(0, a - b) / 20 * 1.5; // 물량을 줄이는 것은 인원보다 비싸게 본다
      };
      // 선택 리소스만 · 모든 리소스 두 후보를 함께 본다(선택 리소스가 늦음의 원인이 아니면 "모든"만 효과가 있다)
      if (!mode && hasMinRoom(target.updateId, true)) {
        const st = clone(state); st.mins.set(target.updateId, 'optional');
        cands.push({ st, step: { kind: 'volumeToMin', label: `${name} 선택 리소스를 최저 물량으로`, amount: 1, forUpdate: name, cost: cutCost(st) } });
      }
      if (mode !== 'all' && hasMinRoom(target.updateId, false)) {
        const st = clone(state); st.mins.set(target.updateId, 'all');
        cands.push({ st, step: { kind: 'volumeToMin', label: `${name} 모든 리소스를 최저 물량으로`, amount: 1, forUpdate: name, cost: cutCost(st) } });
      }
    }
    if (levers.priority && mult === 1) {
      const i = state.order.indexOf(target.updateId);
      if (i > 0) {
        const st = clone(state);
        [st.order[i - 1], st.order[i]] = [st.order[i], st.order[i - 1]];
        cands.push({ st, step: { kind: 'priority', label: `${name} → ${updates.get(state.order[i - 1])?.name}보다 먼저`, amount: 1, forUpdate: name, cost: 0.3 } });
      }
    }

    return cands;
    };
    let best: { st: State; step: AdvisorStep; next: ReturnType<typeof evaluate>; value: number } | null = null;
    let tried = 0;
    for (const mult of [1, 2, 4]) {
      const cands = gen(mult);
      tried += cands.length;
      for (const c of cands) {
        if (out()) break;
        const next = evaluate(c.st);
        const gain = cur.score - next.score;
        if (gain <= 1e-9) continue;
        // 어떤 업데이트도 지금보다 늦어지면 안 된다(다른 업데이트를 희생해 맞추지 않는다)
        const prev = new Map(cur.oc.map(o => [o.updateId, o.late]));
        if (next.oc.some(o => o.late > (prev.get(o.updateId) ?? 0) + 1e-9)) continue;
        const value = gain / (c.step.cost + 0.5);
        if (!best || value > best.value) {
          const before = new Map(cur.oc.map(o => [o.updateId, o]));
          let days = 0; let rescued = 0;
          for (const o of next.oc) {
            const b = before.get(o.updateId);
            if (!b) continue;
            if (b.unfinished && !o.unfinished) rescued += 1;
            else if (!b.unfinished && !o.unfinished) days += b.late - o.late;
          }
          best = { st: c.st, step: { ...c.step, gain, days, rescued }, next, value };
        }
      }
      if (best || out()) break;
    }
    if (!best && out()) break;
    if (!best) {
      stuck.set(target.updateId, !tried
        ? '허용한 수단을 다 썼어요(상한에 닿았거나 더 줄일 물량이 없어요)'
        : '남은 수단으로는 더 당겨지지 않아요(상한을 올리거나 다른 수단을 켜 보세요)');
      continue;
    }
    state = best.st;
    cur = best.next;
    // 같은 업데이트를 위해 같은 파트·같은 기간에 더한 인원(외주)은 앞서 나온 걸음에 합친다(다른 걸음과 번갈아 나와도)
    const last = (best.step.kind === 'headcount' || best.step.kind === 'outsource')
      ? steps.find(x => x.kind === best!.step.kind && x.label === best!.step.label && x.forUpdate === best!.step.forUpdate) : undefined;
    if (last) {
      last.amount += best.step.amount; last.gain += best.step.gain; last.cost += best.step.cost;
      last.days += best.step.days; last.rescued += best.step.rescued;
    } else steps.push(best.step);
  }
  for (const st of steps) {
    if (st.kind !== 'headcount' && st.kind !== 'outsource') continue;
    const [part, range] = st.label.split('|');
    const r = range.split('~');
    const when = r[0] === r[1] ? r[0] : range;
    st.label = st.kind === 'headcount' ? `${part} 인원 +${fmt(st.amount)}명 (${when})` : `${part} 외주 +${fmt(st.amount)}인·일/월 (${when})`;
  }

  // 같은 파트의 인원·외주는 달마다 합쳐 이어진 구간으로 묶는다
  const segments = (map: Map<string, number>) => {
    const byPart = new Map<string, Map<string, number>>();
    for (const [k, v] of map) {
      if (!v) continue;
      const [part, month] = k.split('|');
      if (!byPart.has(part)) byPart.set(part, new Map());
      byPart.get(part)!.set(month, v);
    }
    const out: { partId: string; from: string; to: string; value: number }[] = [];
    for (const [part, months] of byPart) {
      const all = monthsBetween(s.horizon_start_month, s.horizon_end_month);
      let seg: { from: string; to: string; value: number } | null = null;
      for (const m of all) {
        const v = months.get(m) ?? 0;
        if (seg && v === seg.value && v) { seg.to = m; continue; }
        if (seg) out.push({ partId: part, ...seg });
        seg = v ? { from: m, to: m, value: v } : null;
      }
      if (seg) out.push({ partId: part, ...seg });
    }
    return out;
  };
  const actions: ScenarioAction[] = [];
  for (const g of segments(state.heads)) actions.push({ kind: 'headcount', partId: g.partId, fromMonth: g.from, toMonth: g.to, delta: g.value });
  for (const g of segments(state.outs)) actions.push({ kind: 'outsource', partId: g.partId, fromMonth: g.from, toMonth: g.to, days: g.value });
  for (const [updateId, mode] of state.mins) actions.push({ kind: 'volumeToMin', updateId, onlyOptional: mode === 'optional' });
  const moved = state.order.some((id, i) => initial[i] !== id);
  let reprioritized = 0;
  if (moved) {
    state.order.forEach((id, i) => {
      if (updates.get(id)!.priority !== i + 1) actions.push({ kind: 'priority', updateId: id, priority: i + 1 });
      if (initial[i] !== id) reprioritized += 1;
    });
  }

  const cutUnits = [...state.mins].reduce((a, [updateId, mode]) => a + data.volumes
    .filter(v => v.update_id === updateId && v.min_qty != null && planQty(v) != null && (mode === 'all' || v.required === 0))
    .reduce((x, v) => x + Math.max(0, (planQty(v) ?? 0) - (v.min_qty ?? 0)), 0), 0);
  const after = cur.oc;
  return {
    alreadyOk: before.every(o => o.late === 0),
    feasible: after.every(o => o.late === 0),
    before,
    after,
    steps,
    totals: {
      extraHeadMonths: [...state.heads.values()].reduce((a, b) => a + b, 0),
      outsourceDays: [...state.outs.values()].reduce((a, b) => a + b, 0),
      cutUnits,
      reprioritized,
    },
    actions,
    runs,
    ms: now() - t0,
    stuck: after.filter(o => o.late > 0).map(o => ({ name: o.name, why: stuck.get(o.updateId) ?? '계산 상한(횟수·시간)에 닿아 여기서 멈췄어요' })),
    limited,
  };
}

/** 제안을 시나리오로 만든다(동작마다 한 묶음). 시뮬레이션에서 비교·원본 반영을 그대로 쓴다 */
export function adviceToScenario(db: SqlDb, name: string, actions: ScenarioAction[]): string {
  if (!actions.length) throw new Error('시나리오로 만들 제안이 없어요.');
  db.exec('SAVEPOINT advice');
  try {
    const id = applyScenarioOp(db, { kind: 'create', name }).createdId!;
    for (const action of actions) applyScenarioOp(db, { kind: 'addAction', scenarioId: id, action });
    db.exec('RELEASE advice');
    return id;
  } catch (e) {
    db.exec('ROLLBACK TO advice');
    db.exec('RELEASE advice');
    throw e;
  }
}
