// 스테이지 만들기: 업데이트 × 리소스 종류 × 파트. 필요 공수, 앞 스테이지, 겹침률, 배정 순서를 정한다.
import type { ProjectData, PlanMode, Update } from './types.ts';

export class EngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineInputError';
  }
}

export interface Stage {
  index: number;
  updateId: string;
  resourceTypeId: string;
  partId: string;
  partIndex: number;
  requiredDays: number;
  /** 이미 끝낸 수량의 공수(작업 진척). 앞 공정 진행률을 셀 때 전체 = 이미 끝낸 몫 + 남은 일 */
  preDoneDays: number;
  predecessor: Stage | null;
  overlapRate: number | null;
  overlapSource: 'FIRST' | 'PAIR' | 'DEFAULT';
  /** 배정 순서 비교용 */
  order: number[];
  /** 남은 일을 배정하기 시작하는 날: 업데이트 시작일과 작업 진척 기준일 다음 날 중 늦은 날 */
  updateStartDate: string;

  // 계산 중 상태 (영업일 순번, -1 = 계획 기간 전에 이미 끝남)
  done: number;
  doneMorning: number;
  touchDay: number;
  readyDay: number | null;
  startDay: number | null;
  workDoneDay: number | null;
  completionDay: number | null;
  predecessorProgressAtStart: number | null;
}

export const LIVE_STATUSES = new Set(['PLANNED', 'IN_PROGRESS']);
const EPS = 1e-9;

export function liveUpdates(data: ProjectData): Update[] {
  return data.updates.filter(u => LIVE_STATUSES.has(u.status));
}

export function buildStages(data: ProjectData, planMode: PlanMode, legacyProgress = false): Stage[] {
  const s = data.settings;
  const parts = data.parts.filter(p => p.active === 1).sort((a, b) => a.sort_order - b.sort_order);
  const partIndex = new Map(parts.map((p, i) => [p.part_id, i]));
  const partOrder = new Map(parts.map(p => [p.part_id, p.sort_order]));

  const overlap = new Map(data.part_overlaps.map(o => [`${o.from_part_id}>${o.to_part_id}`, o.overlap_rate]));
  const efforts = new Map(data.efforts.map(e => [`${e.resource_type_id}|${e.part_id}|${e.profile_id}`, e.days]));
  const mix = new Map<string, { profile_id: string; share: number }[]>();
  for (const m of data.effort_mix) {
    if (!mix.has(m.part_id)) mix.set(m.part_id, []);
    mix.get(m.part_id)!.push(m);
  }
  const done = new Map(data.progress.map(p => [`${p.update_id}|${p.resource_type_id}|${p.part_id}`, p.completed_qty]));
  // 업데이트마다 작업 진척의 가장 늦은 기준일: 그날까지의 작업은 완료 수량에 들어 있으므로 남은 일은 그 다음 날부터
  const asOf = new Map<string, string>();
  if (!legacyProgress) {
    for (const p of data.progress) {
      if (!p.as_of || !(p.completed_qty > 0)) continue;
      const cur = asOf.get(p.update_id);
      if (!cur || p.as_of > cur) asOf.set(p.update_id, p.as_of);
    }
  }
  const nextDay = (iso: string) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const workFrom = (u: Update): string => {
    const a = asOf.get(u.update_id);
    const after = a ? nextDay(a) : null;
    return after && after > u.start_date! ? after : u.start_date!;
  };
  const rtSort = new Map(data.resource_types.map(r => [r.resource_type_id, r.sort_order]));

  const resourceParts = new Map<string, { part_id: string; rework_rate: number }[]>();
  for (const rp of data.resource_parts) {
    if (!partIndex.has(rp.part_id)) continue;
    if (!resourceParts.has(rp.resource_type_id)) resourceParts.set(rp.resource_type_id, []);
    resourceParts.get(rp.resource_type_id)!.push(rp);
  }
  for (const list of resourceParts.values()) list.sort((a, b) => partOrder.get(a.part_id)! - partOrder.get(b.part_id)!);

  const mixedDays = (rt: string, part: string): number => {
    const base = efforts.get(`${rt}|${part}|BASE`);
    if (base == null) throw new EngineInputError(`기본 공수 없음: ${rt}|${part}`);
    const shares = mix.get(part);
    if (!shares || shares.length === 0) return base;
    return shares.reduce((sum, m) => sum + m.share * (efforts.get(`${rt}|${part}|${m.profile_id}`) ?? base), 0);
  };

  const updates = new Map(liveUpdates(data).map(u => [u.update_id, u]));
  const qtyField = ({ MIN: 'min_qty', TARGET: 'target_qty', STRETCH: 'stretch_qty' } as const)[planMode];

  const stages: Stage[] = [];
  for (const v of data.volumes) {
    const u = updates.get(v.update_id);
    if (!u) continue;
    if (!u.start_date) throw new EngineInputError(`시작일 없음: ${u.update_id}`);
    const qty = v[qtyField];
    if (qty == null) throw new EngineInputError(`물량 빈칸: ${v.update_id}|${v.resource_type_id}`);
    const chain = resourceParts.get(v.resource_type_id);
    if (!chain || chain.length === 0) {
      if (qty > 0) throw new EngineInputError(`거치는 파트 없음: ${v.resource_type_id}`);
      continue;
    }
    let prev: Stage | null = null;
    for (const rp of chain) {
      const completed = done.get(`${v.update_id}|${v.resource_type_id}|${rp.part_id}`) ?? 0;
      const own = Math.max(0, qty - v.outsource_qty);
      const remaining = Math.max(0, own - completed);
      const perUnit = mixedDays(v.resource_type_id, rp.part_id) * v.difficulty
        * Math.max(0, 1 - v.reuse_rate) * (1 + rp.rework_rate) * (1 + s.buffer_rate);
      const requiredDays = remaining * perUnit;
      const preDoneDays = legacyProgress ? 0 : Math.min(own, Math.max(0, completed)) * perUnit;
      let overlapRate: number | null = null;
      let overlapSource: Stage['overlapSource'] = 'FIRST';
      if (prev) {
        const pair = overlap.get(`${prev.partId}>${rp.part_id}`);
        overlapRate = pair ?? s.default_overlap_rate;
        overlapSource = pair == null ? 'DEFAULT' : 'PAIR';
      }
      const stage: Stage = {
        index: stages.length,
        updateId: v.update_id,
        resourceTypeId: v.resource_type_id,
        partId: rp.part_id,
        partIndex: partIndex.get(rp.part_id)!,
        requiredDays: requiredDays < EPS ? 0 : requiredDays,
        preDoneDays,
        predecessor: prev,
        overlapRate,
        overlapSource,
        // 업데이트 우선순위 → 출시일(없으면 뒤) → 업데이트 표시 순서 → 필수 먼저 → 업데이트 안 순위 → 리소스 종류 순서
        order: [
          u.priority,
          u.release_date ? Date.parse(u.release_date) : Number.MAX_SAFE_INTEGER,
          u.sort_order,
          v.required === 1 ? 0 : 1,
          v.priority,
          rtSort.get(v.resource_type_id) ?? 0,
        ],
        updateStartDate: workFrom(u),
        done: 0,
        doneMorning: 0,
        touchDay: -2,
        readyDay: null,
        startDay: null,
        workDoneDay: null,
        completionDay: null,
        predecessorProgressAtStart: null,
      };
      stages.push(stage);
      prev = stage;
    }
  }
  return stages;
}

export function compareStageOrder(a: Stage, b: Stage): number {
  for (let i = 0; i < a.order.length; i += 1) {
    const diff = a.order[i] - b.order[i];
    if (diff !== 0) return diff;
  }
  return a.index - b.index;
}
