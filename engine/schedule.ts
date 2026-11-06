// 영업일 하루씩 일정 배정 (docs/04-engine-rules.md)
//
// 하루의 순서
//   1. 오늘 시작하는 업데이트의 스테이지를 들인다. 앞 공정이 없거나 이미 끝났으면 바로 "준비됨".
//   2. 어제 진행된 스테이지의 다음 스테이지가 오늘 아침 조건(앞 공정 진행률 ≥ 1 − 겹침률)을 채우면 "준비됨".
//      (준비 여부는 앞 공정이 진행될 때만 바뀌므로, 진행된 스테이지의 다음 스테이지만 확인한다)
//   3. 파트마다 준비된 스테이지를 배정 순서대로 하루 작업 가능량만큼 채운다.
import type { Calendar } from './calendar.ts';
import { firstWorkdayOnOrAfter } from './calendar.ts';
import type { Stage } from './stages.ts';
import { compareStageOrder } from './stages.ts';

const EPS = 1e-9;

export interface ScheduleOutput {
  /** [파트][영업일] 하루 작업 가능량 */
  dailyCapacity: number[][];
  /** [파트][영업일] 배정량 */
  dailyAssigned: number[][];
  /** [파트][월] 그 달 끝에 남은 일(시작한 업데이트 기준) */
  monthEndRemaining: number[][];
}

/** 앞 스테이지의 그날 아침 진행률 (0–1). 이미 끝낸 수량(작업 진척)도 진행에 들어간다: (이미 끝낸 몫 + 오늘 아침까지 한 일) ÷ 전체 */
function morningProgress(p: Stage, day: number): number {
  if (p.requiredDays <= 0) return 1;
  const done = p.touchDay === day ? p.doneMorning : p.done;
  return (p.preDoneDays + done) / (p.preDoneDays + p.requiredDays);
}

/** 아침 판정: 앞 공정이 어제까지 시작했고, 진행률이 1 − 겹침률 이상 */
function isReady(s: Stage, day: number): boolean {
  const p = s.predecessor;
  if (!p) return true;
  if (p.startDay === null || p.startDay >= day) return false;
  return morningProgress(p, day) >= 1 - (s.overlapRate ?? 0) - EPS;
}

function insertSorted(queue: Stage[], s: Stage): void {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareStageOrder(queue[mid], s) < 0) lo = mid + 1; else hi = mid;
  }
  queue.splice(lo, 0, s);
}

export function schedule(stages: Stage[], cal: Calendar, partCount: number, monthlyCapacity: number[][]): ScheduleOutput {
  const dayCount = cal.days.length;
  const dailyCapacity = Array.from({ length: partCount }, (_, pi) =>
    cal.days.map((_, d) => {
      const mi = cal.dayMonth[d];
      return cal.monthWorkdays[mi] > 0 ? monthlyCapacity[pi][mi] / cal.monthWorkdays[mi] : 0;
    }));
  const dailyAssigned = Array.from({ length: partCount }, () => new Array<number>(dayCount).fill(0));
  const monthEndRemaining = Array.from({ length: partCount }, () => new Array<number>(cal.months.length).fill(0));

  // 다음 스테이지 연결
  const successor = new Map<Stage, Stage>();
  for (const s of stages) if (s.predecessor) successor.set(s.predecessor, s);

  // 필요 공수 0(이미 끝났거나 외주)인 스테이지는 계획 기간 전에 끝난 것으로 둔다.
  // 나머지는 업데이트 시작일에 들어온다.
  const activation = new Map<number, Stage[]>();
  for (const s of stages) {
    if (s.requiredDays <= 0) {
      s.readyDay = -1; s.startDay = -1; s.workDoneDay = -1;
      continue;
    }
    const startIndex = firstWorkdayOnOrAfter(cal, s.updateStartDate);
    if (startIndex >= dayCount) continue; // 계획 기간 뒤 시작: 끝나지 않음
    if (!activation.has(startIndex)) activation.set(startIndex, []);
    activation.get(startIndex)!.push(s);
  }

  const ready: Stage[][] = Array.from({ length: partCount }, () => []);
  const remainingByPart = new Array<number>(partCount).fill(0);
  let toCheck: Stage[] = [];

  const markReady = (s: Stage, day: number): void => {
    s.readyDay = day;
    insertSorted(ready[s.partIndex], s);
  };

  for (let day = 0; day < dayCount; day += 1) {
    // 1. 들이기
    const arriving = activation.get(day);
    if (arriving) {
      for (const s of arriving) {
        remainingByPart[s.partIndex] += s.requiredDays;
        if (isReady(s, day)) markReady(s, day);
      }
    }
    // 2. 어제 진행된 스테이지의 다음 스테이지 확인
    if (toCheck.length) {
      for (const s of toCheck) if (s.readyDay === null && s.workDoneDay === null && isReady(s, day)) markReady(s, day);
      toCheck = [];
    }
    // 3. 배정: 파트는 공정 순서대로. 뒤 파트의 오늘 판정은 이미 1·2에서 끝났다.
    const touchedToday: Stage[] = [];
    for (let pi = 0; pi < partCount; pi += 1) {
      const queue = ready[pi];
      let available = dailyCapacity[pi][day];
      let finished = 0;
      for (let i = 0; i < queue.length && available > EPS; i += 1) {
        const s = queue[i];
        const give = Math.min(available, s.requiredDays - s.done);
        if (s.touchDay !== day) { s.doneMorning = s.done; s.touchDay = day; }
        if (s.startDay === null) {
          s.startDay = day;
          s.predecessorProgressAtStart = s.predecessor ? morningProgress(s.predecessor, day) : null;
        }
        s.done += give;
        available -= give;
        dailyAssigned[pi][day] += give;
        remainingByPart[pi] -= give;
        touchedToday.push(s);
        if (s.done >= s.requiredDays - EPS) {
          s.done = s.requiredDays;
          s.workDoneDay = day;
          finished += 1;
        }
      }
      if (finished) ready[pi] = queue.filter(s => s.workDoneDay === null);
    }
    for (const s of touchedToday) {
      const next = successor.get(s);
      if (next && next.readyDay === null) toCheck.push(next);
    }

    if (cal.isMonthEnd[day]) {
      const mi = cal.dayMonth[day];
      for (let pi = 0; pi < partCount; pi += 1) monthEndRemaining[pi][mi] = Math.max(0, remainingByPart[pi]);
    }
  }

  // 완료 제약: 다음 스테이지는 앞 스테이지보다 먼저 끝나지 않는다 (stages는 리소스마다 공정 순서로 들어 있다)
  for (const s of stages) {
    if (s.workDoneDay === null) { s.completionDay = null; continue; }
    const p = s.predecessor;
    if (!p) { s.completionDay = s.workDoneDay; continue; }
    s.completionDay = p.completionDay === null ? null : Math.max(s.workDoneDay, p.completionDay);
  }

  return { dailyCapacity, dailyAssigned, monthEndRemaining };
}
