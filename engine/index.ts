// ARP 계산 엔진 입구: runPlan(데이터, 옵션) → 결과
// 데이터는 검증 오류가 없는 상태여야 한다(오류가 있으면 앱이 계산 대신 이유를 보여준다).
import type {
  ProjectData, PlanOptions, PlanResult, UpdateResult, PartResult, PartMonthResult, StageResult, LoadLevel, UpdateStatus, BatchResult, BatchStatus, UpdateReason,
} from './types.ts';
import { buildCalendar, workdaysAfter, firstWorkdayOnOrAfter } from './calendar.ts';
import { buildStages, liveUpdates, EngineInputError } from './stages.ts';
import type { Stage } from './stages.ts';
import { schedule } from './schedule.ts';

export { EngineInputError };

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function runPlan(data: ProjectData, options: PlanOptions = {}): PlanResult {
  const started = now();
  const s = data.settings;
  const planMode = options.planMode ?? s.default_plan_mode ?? 'TARGET';
  const cal = buildCalendar(s, data.holidays);
  const parts = data.parts.filter(p => p.active === 1).sort((a, b) => a.sort_order - b.sort_order);
  if (parts.length === 0) throw new EngineInputError('사용 중인 파트가 없음');

  // 파트 × 월 작업 가능량 = 인원 × 영업일 × 가동률 × 생산성 + 외주 + 지원
  const capacityRow = new Map(data.capacity.map(c => [`${c.part_id}|${c.month}`, c]));
  const monthlyCapacity = parts.map(p => cal.months.map((month, mi) => {
    const c = capacityRow.get(`${p.part_id}|${month}`);
    if (!c) throw new EngineInputError(`인력 없음: ${p.part_id}|${month}`);
    return c.headcount * cal.monthWorkdays[mi] * c.utilization * c.productivity + c.outsource_days + c.support_days;
  }));

  const stages = buildStages(data, planMode, options.legacyProgress === true);
  const out = schedule(stages, cal, parts.length, monthlyCapacity);

  const dateOf = (day: number | null): string | null => (day === null || day < 0 ? null : cal.days[day]);
  const launchTypes = new Set(data.update_types.filter(t => t.is_launch === 1).map(t => t.update_type_id));

  // ───────── 업데이트 결과 ─────────
  const byUpdate = new Map<string, Stage[]>();
  for (const st of stages) {
    if (!byUpdate.has(st.updateId)) byUpdate.set(st.updateId, []);
    byUpdate.get(st.updateId)!.push(st);
  }
  const updates: UpdateResult[] = liveUpdates(data)
    .sort((a, b) => a.priority - b.priority || a.sort_order - b.sort_order)
    .map(u => {
      const list = byUpdate.get(u.update_id) ?? [];
      const unfinished = list.filter(st => st.completionDay === null);
      const requiredDays = list.reduce((sum, st) => sum + st.requiredDays, 0);
      const remainingDays = list.reduce((sum, st) => sum + (st.requiredDays - st.done), 0);
      let completionDay: number | null = null;
      let reasonStage: Stage | null = null;
      if (unfinished.length) {
        // 못 끝낸 원인: 준비됐는데 인력이 모자라 일이 남은 스테이지 중 가장 오래 기다린 것(준비일이 가장 이른 것),
        // 같으면 가장 많이 남은 것. 없으면(앞 공정을 기다리는 중) 앞 공정이 끝난 미완료 스테이지.
        const starved = unfinished.filter(st => st.readyDay !== null && st.requiredDays - st.done > 1e-9);
        const pool = starved.length ? starved : unfinished.filter(st => st.predecessors.every(p => p.completionDay !== null));
        const remain = (st: Stage) => st.requiredDays - st.done;
        reasonStage = (pool.length ? pool : unfinished).reduce((a, b) => {
          const ar = a.readyDay ?? Infinity;
          const br = b.readyDay ?? Infinity;
          if (br !== ar) return br < ar ? b : a;
          return remain(b) > remain(a) ? b : a;
        });
      } else if (list.length) {
        reasonStage = list.reduce((a, b) => (b.completionDay! > a.completionDay! ? b : a));
        completionDay = reasonStage.completionDay!;
        // 완료 제약 때문에 앞 공정 완료일에 맞춰진 경우, 실제로 늦게 만든 앞 공정으로 거슬러 간다
        for (;;) {
          const cur: Stage = reasonStage;
          if (cur.workDoneDay === null || cur.workDoneDay >= cur.completionDay!) break;
          const late = cur.predecessors.find(p => p.completionDay === cur.completionDay);
          if (!late) break;
          reasonStage = late;
        }
      }
      const expected = dateOf(completionDay);
      let status: UpdateStatus;
      let lateWorkdays: number | null = null;
      if (unfinished.length) status = 'UNFINISHED';
      else if (!u.release_date) status = 'NO_RELEASE_DATE';
      else if (expected === null || expected <= (u.freeze_date ?? u.release_date)) status = 'ON_TRACK';
      else if (expected <= u.release_date) status = 'TIGHT';
      else {
        status = 'LATE';
        lateWorkdays = workdaysAfter(cal, u.release_date, completionDay!);
      }
      return {
        updateId: u.update_id,
        name: u.name,
        isLaunch: launchTypes.has(u.update_type_id),
        priority: u.priority,
        startDate: u.start_date,
        freezeDate: u.freeze_date,
        releaseDate: u.release_date,
        expectedCompletionDate: expected,
        status,
        lateWorkdays,
        critical: status === 'UNFINISHED' || (lateWorkdays !== null && lateWorkdays > s.late_warn_workdays),
        requiredDays,
        remainingDays,
        reason: reasonStage && reasonStage.startDay !== -1 ? {
          partId: reasonStage.partId,
          resourceTypeId: reasonStage.resourceTypeId,
          waitWorkdays: waitOf(reasonStage),
          workWorkdays: reasonStage.startDay !== null && reasonStage.workDoneDay !== null ? reasonStage.workDoneDay - reasonStage.startDay + 1 : null,
          remainingDays: reasonStage.requiredDays - reasonStage.done,
        } : null,
      };
    });

  // ───────── 파트 · 월 결과 ─────────
  const partMonths: PartMonthResult[] = [];
  const level = (rate: number): LoadLevel =>
    rate >= s.load_critical_rate ? 'CRITICAL' : rate >= s.load_over_rate ? 'OVER' : rate >= s.load_warn_rate ? 'WARN' : 'OK';
  const partResults: PartResult[] = parts.map((p, pi) => {
    let peakMonth: string | null = null;
    let peakRemaining = 0;
    const assignedByMonth = new Array<number>(cal.months.length).fill(0);
    out.dailyAssigned[pi].forEach((v, d) => { assignedByMonth[cal.dayMonth[d]] += v; });
    cal.months.forEach((month, mi) => {
      const capacityDays = monthlyCapacity[pi][mi];
      const assignedDays = assignedByMonth[mi];
      const utilization = capacityDays > 0 ? assignedDays / capacityDays : 0;
      partMonths.push({
        partId: p.part_id, month, workdays: cal.monthWorkdays[mi], capacityDays, assignedDays, utilization,
        remainingDays: out.monthEndRemaining[pi][mi],
      });
      // 가장 밀린 달: 달 끝에 남은 일이 가장 많은 달
      if (out.monthEndRemaining[pi][mi] > peakRemaining + 1e-9) { peakRemaining = out.monthEndRemaining[pi][mi]; peakMonth = month; }
    });
    const requiredDays = stages.filter(st => st.partIndex === pi).reduce((sum, st) => sum + st.requiredDays, 0);
    const capacityDays = monthlyCapacity[pi].reduce((a, b) => a + b, 0);
    const loadRate = capacityDays > 0 ? requiredDays / capacityDays : (requiredDays > 0 ? Infinity : 0);
    return { partId: p.part_id, name: p.name, requiredDays, capacityDays, loadRate, level: level(loadRate), peakMonth };
  });

  // ───────── 스테이지 결과 ─────────
  const stageResults: StageResult[] = stages.map(st => ({
    updateId: st.updateId,
    resourceTypeId: st.resourceTypeId,
    partId: st.partId,
    predecessorPartId: st.predecessors[0]?.partId ?? null,
    predecessorPartIds: st.predecessors.map(p => p.partId),
    batchId: st.batchId,
    overlapRate: st.overlapRate,
    overlapSource: st.overlapSource,
    requiredDays: st.requiredDays,
    remainingDays: st.requiredDays - st.done,
    readyDate: dateOf(st.readyDay),
    startDate: dateOf(st.startDay),
    workDoneDate: dateOf(st.workDoneDay),
    completionDate: dateOf(st.completionDay),
    alreadyDone: st.workDoneDay === -1,
    waitWorkdays: waitOf(st),
    predecessorProgressAtStart: st.predecessorProgressAtStart,
  }));

  // ───────── 배치 결과(docs/33 5.4) ─────────
  const reasonOf = (st: Stage | null): UpdateReason | null => (st && st.startDay !== -1 ? {
    partId: st.partId, resourceTypeId: st.resourceTypeId, waitWorkdays: waitOf(st),
    workWorkdays: st.startDay !== null && st.workDoneDay !== null ? st.workDoneDay - st.startDay + 1 : null,
    remainingDays: st.requiredDays - st.done,
  } : null);
  const byBatch = new Map<string, Stage[]>();
  for (const st of stages) {
    if (!st.batchId) continue;
    if (!byBatch.has(st.batchId)) byBatch.set(st.batchId, []);
    byBatch.get(st.batchId)!.push(st);
  }
  const batchResults: BatchResult[] = (data.batches ?? [])
    .filter(b => byBatch.has(b.batch_id))
    .sort((a, b) => a.sort_order - b.sort_order || (a.batch_id < b.batch_id ? -1 : 1))
    .map(b => {
      const list = byBatch.get(b.batch_id)!;
      const unfinished = list.filter(st => st.completionDay === null);
      const day = unfinished.length ? null : list.reduce((m, st) => Math.max(m, st.completionDay!), -1);
      const expected = dateOf(day);
      let status: BatchStatus;
      let lateWorkdays: number | null = null;
      let slackWorkdays: number | null = null;
      if (unfinished.length) status = 'UNFINISHED';
      else if (!b.due_date) status = 'NO_DUE';
      else if (expected === null || expected <= b.due_date) {
        // 여유 = 마감일(그날이 쉬는 날이면 앞 영업일)까지 남은 영업일
        const i = firstWorkdayOnOrAfter(cal, b.due_date);
        const dueIdx = cal.days[i] === b.due_date ? i : i - 1;
        slackWorkdays = expected === null ? null : Math.max(0, dueIdx - day!);
        status = slackWorkdays !== null && slackWorkdays < s.late_warn_workdays ? 'TIGHT' : 'ON_TRACK';
      } else {
        status = 'LATE';
        lateWorkdays = workdaysAfter(cal, b.due_date, day!);
      }
      const remain = (st: Stage) => st.requiredDays - st.done;
      const reasonStage = unfinished.length
        ? unfinished.reduce((a, c) => ((c.readyDay ?? Infinity) < (a.readyDay ?? Infinity) || remain(c) > remain(a) ? c : a))
        : list.reduce((a, c) => (c.completionDay! > a.completionDay! ? c : a));
      return {
        batchId: b.batch_id, updateId: b.update_id, name: b.name, dueDate: b.due_date, expectedCompletionDate: expected, status, lateWorkdays, slackWorkdays,
        overQty: list.reduce((m, st) => Math.max(m, st.overQty), 0),
        remainingQty: list.reduce((m, st) => Math.max(m, st.remainingQty), 0),
        remainingDays: list.reduce((sum, st) => sum + remain(st), 0),
        reason: reasonOf(reasonStage),
      };
    });

  return {
    planMode,
    batches: batchResults,
    horizon: { start: cal.days[0] ?? '', end: cal.days[cal.days.length - 1] ?? '', workdays: cal.days.length },
    updates,
    parts: partResults,
    partMonths,
    stages: stageResults,
    daily: { dates: cal.days, partIds: parts.map(p => p.part_id), capacity: out.dailyCapacity, assigned: out.dailyAssigned },
    meta: { stageCount: stages.length, elapsedMs: now() - started },
  };
}

function waitOf(st: Stage): number | null {
  if (st.readyDay === null || st.readyDay < 0) return null;
  if (st.startDay === null) return null;
  return st.startDay - st.readyDay;
}
