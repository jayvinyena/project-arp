// 표기: 날짜 "2027. 5. 31.(월)", 숫자는 천 단위 쉼표, 인·일은 소수 한 자리
const dateFmt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const intFmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const oneFmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 0 });

const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

export const fmtDate = (iso: string | null | undefined): string => (iso ? dateFmt.format(asDate(iso)) : '—');
export const fmtShortDate = (iso: string | null | undefined): string => (iso ? shortFmt.format(asDate(iso)) : '—');
export const fmtInt = (n: number | null | undefined): string => (n == null ? '—' : intFmt.format(n));
export const fmtDays = (n: number | null | undefined): string => (n == null ? '—' : oneFmt.format(n));
export const fmtPct = (r: number): string => `${intFmt.format(Math.round(r * 100))}%`;
export const fmtHeads = (n: number): string => `${oneFmt.format(n)}명`;
