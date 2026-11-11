// 표기(docs/34 T2): 화면의 날짜 · 숫자 · 단위는 모두 이 함수를 쓴다(ISO 글자를 그대로 내보내지 않는다).
//   날짜(문장)  2027. 5. 31.(월)      fmtDate
//   날짜(표)    5월 31일 · 해가 다르면 27년 5월 31일   fmtShortDate
//   달          2027년 5월           fmtMonth · 기간 fmtMonthRange
//   시각        11월 11일 15:20       fmtDateTime
//   영업일 차이  +14영업일 · −1영업일   fmtWorkdays
//   숫자        천 단위 쉼표, 인·일은 소수 한 자리
const dateFmt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const intFmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const oneFmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const oneFixed = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

const asDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);

/** 이 브라우저의 오늘(지역 시간, YYYY-MM-DD). toISOString은 UTC라 한국 0 ~ 9시에 어제가 된다 */
export const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const thisYear = () => Number(localToday().slice(0, 4));

export const fmtDate = (iso: string | null | undefined): string => (iso ? dateFmt.format(asDate(iso)) : '—');
/** 표 날짜: 올해면 "5월 31일", 해가 다르면 "27년 5월 31일" */
export const fmtShortDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const y = Number(iso.slice(0, 4));
  const s = shortFmt.format(asDate(iso));
  return y === thisYear() ? s : `${String(y).slice(2)}년 ${s}`;
};
/** 달: "2027년 5월" */
export const fmtMonth = (ym: string | null | undefined): string => (ym ? `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월` : '—');
/** 달 기간: "2026년 11월 ~ 2027년 5월" */
export const fmtMonthRange = (a: string | null | undefined, b: string | null | undefined): string => `${fmtMonth(a)} ~ ${fmtMonth(b)}`;
/** 시각: "11월 11일 15:20"(해가 다르면 연도) */
export const fmtDateTime = (iso: string | number | null | undefined): string => {
  if (iso == null || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const day = `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.getFullYear() === thisYear() ? day : `${String(d.getFullYear()).slice(2)}년 ${day}`;
};
/** 영업일 차이: +14영업일 · −1영업일 · 0영업일 */
export const fmtWorkdays = (n: number | null | undefined, sign = true): string =>
  n == null ? '—' : `${sign && n > 0 ? '+' : n < 0 ? '−' : ''}${intFmt.format(Math.abs(n))}영업일`;
export const fmtInt = (n: number | null | undefined): string => (n == null ? '—' : intFmt.format(n));
export const fmtDays = (n: number | null | undefined): string => (n == null ? '—' : oneFmt.format(n));
/** 인·일(표에서 소수점 위치를 맞추려고 한 자리 고정) */
export const fmtDaysFixed = (n: number | null | undefined): string => (n == null ? '—' : oneFixed.format(n));
export const fmtPct = (r: number): string => `${intFmt.format(Math.round(r * 100))}%`;
export const fmtHeads = (n: number): string => `${oneFmt.format(n)}명`;
