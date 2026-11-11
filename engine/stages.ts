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
  /** 앞 공정: 앞 묶음에서 이 리소스가 거치는 단계 모두(docs/30). 한 줄 파이프라인이면 하나 */
  predecessors: Stage[];
  /** 앞 공정마다 겹침률(predecessors와 같은 순서) */
  overlaps: number[];
  /** 배치 스테이지면 그 배치(docs/33), 배치 밖 일은 null · 물량 밖 에셋 수 · 남은 에셋 수 */
  batchId: string | null;
  overQty: number;
  remainingQty: number;
  /** 결과 표시용: 첫 앞 공정의 겹침률과 출처 */
  overlapRate: number | null;
  overlapSource: 'FIRST' | 'STEP' | 'PAIR' | 'DEFAULT';
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
  // 리소스별 파이프라인(docs/28): 고른 파이프라인이 있으면 그 단계 순서, 단계에 없는 파트는 뒤에(파트 표 순서). 없으면 파트 표 순서 그대로
  // 단계 묶음(docs/30): seq 순서로 보며 with_prev = 1이면 앞 단계와 같은 묶음 번호
  const steps = new Map<string, { seq: number; overlap: number | null; group: number }>();
  const byPipe = new Map<string, typeof data.pipeline_steps>();
  for (const st of data.pipeline_steps ?? []) {
    if (!byPipe.has(st.pipeline_id)) byPipe.set(st.pipeline_id, []);
    byPipe.get(st.pipeline_id)!.push(st);
  }
  for (const list of byPipe.values()) {
    let group = 0;
    list!.sort((a, b) => a.seq - b.seq).forEach((st, i) => {
      if (i === 0 || !st.with_prev) group += 1;
      steps.set(`${st.pipeline_id}|${st.part_id}`, { seq: st.seq, overlap: st.overlap_rate, group });
    });
  }
  const pipelineOf = new Map(data.resource_types.map(r => [r.resource_type_id, r.pipeline_id ?? null]));
  const stepOf = (rt: string, part: string) => { const p = pipelineOf.get(rt); return p ? steps.get(`${p}|${part}`) : undefined; };
  for (const [rt, list] of resourceParts) {
    if (!pipelineOf.get(rt)) continue;
    const pos = (part: string) => stepOf(rt, part)?.seq ?? 1e6 + partOrder.get(part)!;
    list.sort((a, b) => pos(a.part_id) - pos(b.part_id));
  }

  const mixedDays = (rt: string, part: string): number => {
    const base = efforts.get(`${rt}|${part}|BASE`);
    if (base == null) throw new EngineInputError(`기본 공수 없음: ${rt}|${part}`);
    const shares = mix.get(part);
    if (!shares || shares.length === 0) return base;
    return shares.reduce((sum, m) => sum + m.share * (efforts.get(`${rt}|${part}|${m.profile_id}`) ?? base), 0);
  };

  const updates = new Map(liveUpdates(data).map(u => [u.update_id, u]));
  const qtyField = ({ MIN: 'min_qty', TARGET: 'target_qty', STRETCH: 'stretch_qty' } as const)[planMode];

  // 배치(docs/33): 업데이트 × 리소스마다 배치 순서대로 [배치, 파트별 남은 · 끝낸 에셋 수]. 계획 템플릿에 들어가는 에셋만
  const tiers = new Set(planMode === 'MIN' ? ['MIN'] : planMode === 'TARGET' ? ['MIN', 'TARGET'] : ['MIN', 'TARGET', 'STRETCH']);
  const batchRank = new Map((data.batches ?? []).slice().sort((a, b) => a.sort_order - b.sort_order || (a.batch_id < b.batch_id ? -1 : 1)).map((b, i) => [b.batch_id, i]));
  const batchWork = new Map<string, Map<string, Map<string, { rem: number; done: number }>>>();
  for (const w of data.batch_work ?? []) {
    if (!tiers.has(w.tier) || !batchRank.has(w.batch_id)) continue;
    const k = `${w.update_id}|${w.resource_type_id}`;
    if (!batchWork.has(k)) batchWork.set(k, new Map());
    const byBatch = batchWork.get(k)!;
    if (!byBatch.has(w.batch_id)) byBatch.set(w.batch_id, new Map());
    const cur = byBatch.get(w.batch_id)!.get(w.part_id) ?? { rem: 0, done: 0 };
    byBatch.get(w.batch_id)!.set(w.part_id, { rem: cur.rem + w.remaining_qty, done: cur.done + w.done_qty });
  }
  /** 배치 밖 일의 순서: 그 업데이트의 배치들 뒤(docs/33 정할 것 2). 배치가 없으면 모두 같은 값이라 지금 순서 그대로 */
  const NO_BATCH = 1e6;

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
    // 묶음: 파이프라인 단계는 묶음 번호, 그 밖(파이프라인 밖 파트 · 파이프라인 없음)은 파트마다 따로
    const groupOf = (part: string) => { const st = stepOf(v.resource_type_id, part); return st ? st.group : 1e6 + partOrder.get(part)!; };
    // 파트마다 남은 수량 · 이미 끝낸 수량(지금과 같은 물량 기준)
    const own = Math.max(0, qty - v.outsource_qty);
    const left = new Map<string, number>();
    const doneLeft = new Map<string, number>();
    for (const rp of chain) {
      const completed = done.get(`${v.update_id}|${v.resource_type_id}|${rp.part_id}`) ?? 0;
      left.set(rp.part_id, Math.max(0, own - completed));
      doneLeft.set(rp.part_id, Math.min(own, Math.max(0, completed)));
    }
    // 조각: 배치마다(배치 순서) 그 배치의 남은 에셋만큼 담고, 남은 몫은 배치 밖 조각으로(docs/33 5.2)
    type Slice = { batchId: string | null; rank: number; rem: Map<string, number>; pre: Map<string, number>; over: Map<string, number> };
    const slices: Slice[] = [];
    const byBatch = batchWork.get(`${v.update_id}|${v.resource_type_id}`);
    if (byBatch) {
      for (const [batchId, parts] of [...byBatch].sort((a, b) => batchRank.get(a[0])! - batchRank.get(b[0])!)) {
        const sl: Slice = { batchId, rank: batchRank.get(batchId)!, rem: new Map(), pre: new Map(), over: new Map() };
        for (const rp of chain) {
          const w = parts.get(rp.part_id) ?? { rem: 0, done: 0 };
          const take = Math.min(w.rem, left.get(rp.part_id)!);
          left.set(rp.part_id, left.get(rp.part_id)! - take);
          const pre = Math.min(w.done, doneLeft.get(rp.part_id)!);
          doneLeft.set(rp.part_id, doneLeft.get(rp.part_id)! - pre);
          sl.rem.set(rp.part_id, take); sl.pre.set(rp.part_id, pre); sl.over.set(rp.part_id, w.rem - take);
        }
        slices.push(sl);
      }
      if (chain.some(rp => left.get(rp.part_id)! > 0)) slices.push({ batchId: null, rank: NO_BATCH, rem: left, pre: doneLeft, over: new Map() });
    } else {
      slices.push({ batchId: null, rank: NO_BATCH, rem: left, pre: doneLeft, over: new Map() });
    }
    for (const sl of slices) {
    let prevGroup: Stage[] = [];
    let curGroup: Stage[] = [];
    let curKey: number | null = null;
    for (const rp of chain) {
      const g = groupOf(rp.part_id);
      if (g !== curKey) { if (curGroup.length) prevGroup = curGroup; curGroup = []; curKey = g; }
      const remaining = sl.rem.get(rp.part_id)!;
      const perUnit = mixedDays(v.resource_type_id, rp.part_id) * v.difficulty
        * Math.max(0, 1 - v.reuse_rate) * (1 + rp.rework_rate) * (1 + s.buffer_rate);
      const requiredDays = remaining * perUnit;
      const preDoneDays = legacyProgress ? 0 : sl.pre.get(rp.part_id)! * perUnit;
      // 겹침률(앞 공정마다): 파이프라인 단계에 적은 값 → 파트 쌍 → 기본
      const step = stepOf(v.resource_type_id, rp.part_id)?.overlap;
      const links = prevGroup.map(p => {
        if (step != null) return { rate: step, source: 'STEP' as const };
        const pair = overlap.get(`${p.partId}>${rp.part_id}`);
        return { rate: pair ?? s.default_overlap_rate, source: pair == null ? 'DEFAULT' as const : 'PAIR' as const };
      });
      const overlapRate: number | null = links[0]?.rate ?? null;
      const overlapSource: Stage['overlapSource'] = links[0]?.source ?? 'FIRST';
      const stage: Stage = {
        index: stages.length,
        updateId: v.update_id,
        resourceTypeId: v.resource_type_id,
        partId: rp.part_id,
        partIndex: partIndex.get(rp.part_id)!,
        requiredDays: requiredDays < EPS ? 0 : requiredDays,
        preDoneDays,
        predecessors: prevGroup,
        overlaps: links.map(l => l.rate),
        batchId: sl.batchId,
        overQty: sl.over.get(rp.part_id) ?? 0,
        remainingQty: remaining,
        overlapRate,
        overlapSource,
        // 업데이트 우선순위 → 출시일(없으면 뒤) → 업데이트 표시 순서 → 배치 순서(배치 밖은 뒤, docs/33) → 필수 먼저 → 업데이트 안 순위 → 리소스 종류 순서
        order: [
          u.priority,
          u.release_date ? Date.parse(u.release_date) : Number.MAX_SAFE_INTEGER,
          u.sort_order,
          sl.rank,
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
      curGroup.push(stage);
    }
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
