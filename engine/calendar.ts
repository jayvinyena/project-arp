// 근무 달력: 계획 기간의 영업일 목록. 계산은 영업일 순번(0, 1, 2 …)으로 하고 결과에서 날짜로 바꾼다.
import type { Settings, Holiday } from './types.ts';

export interface Calendar {
  /** 영업일 날짜(YYYY-MM-DD), 오름차순 */
  days: string[];
  /** 영업일 순번 → 월 순번 */
  dayMonth: number[];
  /** 계획 기간의 월(YYYY-MM) */
  months: string[];
  /** 월별 영업일 수 */
  monthWorkdays: number[];
  /** 그 달 마지막 영업일인가 */
  isMonthEnd: boolean[];
}

export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function buildCalendar(settings: Settings, holidays: Holiday[]): Calendar {
  const holidaySet = new Set(holidays.map(h => h.date));
  const months = monthsBetween(settings.horizon_start_month, settings.horizon_end_month);
  const days: string[] = [];
  const dayMonth: number[] = [];
  const monthWorkdays: number[] = [];
  months.forEach((month, mi) => {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let count = 0;
    for (let d = 1; d <= last; d += 1) {
      const weekdayIndex = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 월=0 … 일=6
      if (settings.work_weekdays[weekdayIndex] !== '1') continue;
      const iso = `${month}-${String(d).padStart(2, '0')}`;
      if (holidaySet.has(iso)) continue;
      days.push(iso);
      dayMonth.push(mi);
      count += 1;
    }
    monthWorkdays.push(count);
  });
  const isMonthEnd = days.map((_, i) => i === days.length - 1 || dayMonth[i + 1] !== dayMonth[i]);
  return { days, dayMonth, months, monthWorkdays, isMonthEnd };
}

/** 이 날짜 당일 또는 그 뒤 첫 영업일의 순번. 계획 기간 뒤면 days.length */
export function firstWorkdayOnOrAfter(cal: Calendar, date: string): number {
  let lo = 0;
  let hi = cal.days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cal.days[mid] < date) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** date 다음 날부터 dayIndex까지 영업일 수 (date < days[dayIndex]일 때 늦은 영업일 수) */
export function workdaysAfter(cal: Calendar, date: string, dayIndex: number): number {
  const firstAfter = firstWorkdayOnOrAfter(cal, nextDate(date));
  return Math.max(0, dayIndex - firstAfter + 1);
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}
