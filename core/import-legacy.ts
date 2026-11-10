// 옛 도구(구글 시트) → 새 프로젝트 파일. 시트 이름과 머리글은 옛 도구 그대로(00_Config, 01_Part_Master …).
// 바꾼 값·건너뛴 행·가져오지 않은 시트를 보고서로 남긴다. 값 규칙 위반은 그대로 들여와 데이터 점검에서 보이게 한다.
import type { SqlDb } from './db.ts';
import type { Cell, Sheets } from './xlsx.ts';
import { serialToDate } from './xlsx.ts';
import { migrate, ensureDefaultPipeline } from './migrate.ts';
import { fixedKoreanHolidays } from './new-project.ts';
import { normalizeSheets, isTemplateBook, missingSheetNames } from './import-spec.ts';

export interface ImportOptions {
  projectName?: string;
  /** 날짜가 고정된 공휴일을 넣는다(기본 켬). 옛 도구는 휴일을 따로 빼지 않았다 */
  fixedHolidays?: boolean;
  /** 옛 월 근무일 수(BUSINESS_DAYS)로 작업 가능량을 맞춘다: 생산성에 (옛 근무일 ÷ 새 근무일)을 곱한다. 대조용(기본 끔) */
  keepLegacyWorkdays?: boolean;
  /**
   * 옛 도구 계산 방식 흉내(대조용, 기본 끔). keepLegacyWorkdays를 포함한다.
   *  - 상태(출시 완료·취소)는 보지 않고 사용(ACTIVE)이면 계산한다
   *  - 계산 기간: 사용 중 업데이트의 가장 이른 시작 달 ~ max(인력 마지막 달, 가장 늦은 출시 달, 시작 + ALLOCATION_FORECAST_HORIZON_MONTHS)
   *  - 인력 행이 없는 달은 그 파트의 마지막 인력 행을 되풀이한다(옛 CAPACITY_EXTENSION_MODE = REPEAT_LAST)
   */
  legacyCompat?: boolean;
  appVersion?: string;
  now?: string;
}

export interface ImportReport {
  counts: Record<string, number>;
  /** 자동으로 바꾸거나 채운 것 */
  adjustments: string[];
  /** 건너뛴 행 */
  skipped: string[];
  /** 가져오지 않은 시트 */
  ignoredSheets: string[];
  /** 꼭 필요한데 없는 시트 */
  missingSheets: string[];
  horizon: { start: string; end: string } | null;
}

type Row = Record<string, Cell>;
type Rows = Record<string, Record<string, unknown>[]>;

const REQUIRED = ['01_Part_Master', '02_Resource_Master', '03_Effort_Standard', '10_Update_Master', '11_Update_Volume', '12_Capacity_Monthly'];
const KNOWN = ['00_Config', ...REQUIRED, '05_Update_Type', '06_Update_Volume_Template', '13_Progress_Actual', 'HOLIDAYS'];
const NOT_IMPORTED: Record<string, string> = {
  '04_Pipeline_Template': '공정 순서는 파트 순서 + 겹침률로 변경되었습니다(인계 방식·묶음·대기일은 쓰지 않습니다)',
  '20_Scenario_Master': '옛 시나리오는 가져오지 않습니다. 시뮬레이션에서 다시 만드십시오',
  '21_Scenario_Override': '옛 시나리오는 가져오지 않습니다',
  '90_Change_History': '옛 변경 이력은 가져오지 않습니다(새 파일의 이력은 가져온 뒤부터)',
};

function table(sheets: Sheets, name: string): Row[] {
  const rows = sheets[name];
  if (!rows || rows.length === 0) return [];
  const head = rows[0].map(h => (h == null ? '' : String(h).trim()));
  return rows.slice(1)
    .filter(r => r.some(v => v !== null && v !== ''))
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? null])));
}
const s = (v: Cell): string => (v == null ? '' : String(v).trim());
const n = (v: Cell): number | null => {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : null;
};
/** 옛 도구(06_Utils.js arpToBoolean_)와 같은 규칙: 체크(참) 또는 TRUE·Y·YES·1만 참. 빈칸·그 밖의 글자는 거짓 */
/** 사용 여부 칸: 시트에 그 칸이 아예 없으면 사용으로 본다(예: 06 템플릿 탭에 ACTIVE 칸이 없는 시트). 칸이 있으면 옛 규칙(bool) */
const on = (r: Row, col: string): boolean => (col in r ? bool(r[col]) : true);
/** 정수 칸(순서·수량): 소수는 반올림 */
const int = (v: Cell): number | null => { const x = n(v); return x == null ? null : Math.round(x); };
/** 같은 키가 두 번 나오면 뒤의 행을 건너뛴다(앞의 것을 쓴다) */
function uniqueBy<T>(rows: T[], key: (r: T) => string, onDup: (k: string) => void): T[] {
  const seen = new Set<string>();
  return rows.filter(r => { const k = key(r); if (seen.has(k)) { onDup(k); return false; } seen.add(k); return true; });
}
const bool = (v: Cell): boolean => {
  if (typeof v === 'boolean') return v;
  return ['TRUE', 'Y', 'YES', '1'].includes(String(v ?? '').trim().toUpperCase());
};
/** 날짜 칸: 엑셀 일련번호, 'YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY/MM/DD', 날짜+시각 */
function date(v: Cell): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? serialToDate(v) : null;
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(String(v).trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null; // 2027-02-30 · 13월 같은 날은 빈칸으로
}
function month(v: Cell): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return serialToDate(v).slice(0, 7);
  const m = /^(\d{4})[-./](\d{1,2})/.exec(String(v).trim());
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
}
const lastDay = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
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
function weekdays(ym: string, holidays: Set<string>): number {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let c = 0;
  for (let d = 1; d <= days; d += 1) {
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (holidays.has(`${ym}-${String(d).padStart(2, '0')}`)) continue;
    c += 1;
  }
  return c;
}
const LEVEL: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, MID: 2, LOW: 3 };
const level = (v: Cell): number => {
  const x = n(v);
  if (x != null) return x;
  return LEVEL[s(v).toUpperCase()] ?? 2;
};
const STATUS: Record<string, string> = {
  PLANNED: 'PLANNED', PLAN: 'PLANNED', READY: 'PLANNED', IN_PROGRESS: 'IN_PROGRESS', ACTIVE: 'IN_PROGRESS', PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE', COMPLETED: 'DONE', COMPLETE: 'DONE', RELEASED: 'DONE', CANCELLED: 'CANCELLED', CANCELED: 'CANCELLED', DROPPED: 'CANCELLED',
  // 한국어 상태(실제 운영 시트에서 씀)
  '계획': 'PLANNED', '예정': 'PLANNED', '대기': 'PLANNED', '준비': 'PLANNED',
  '진행': 'IN_PROGRESS', '진행중': 'IN_PROGRESS', '진행 중': 'IN_PROGRESS', '제작중': 'IN_PROGRESS', '제작 중': 'IN_PROGRESS',
  '완료': 'DONE', '출시': 'DONE', '출시 완료': 'DONE', '출시완료': 'DONE',
  '취소': 'CANCELLED', '중단': 'CANCELLED', '무산': 'CANCELLED',
};

/** 옛 시트 → 새 표 행 + 보고서 */
export function legacyToRows(input: Sheets, options: ImportOptions = {}): { rows: Rows; report: ImportReport } {
  // 한글 양식(시트·머리글 한글, ※ 설명 줄)은 옛 구조로 바꿔 읽는다. 옛 도구 시트는 그대로
  const fromTemplate = isTemplateBook(input);
  const sheets = normalizeSheets(input);
  const report: ImportReport = { counts: {}, adjustments: [], skipped: [], ignoredSheets: [], missingSheets: [], horizon: null };
  const adjust = (m: string) => report.adjustments.push(m);
  const skip = (m: string) => report.skipped.push(m);
  for (const name of Object.keys(sheets)) {
    if (KNOWN.includes(name)) continue;
    report.ignoredSheets.push(NOT_IMPORTED[name] ? `${name}: ${NOT_IMPORTED[name]}` : `${name}: 옛 도구의 화면·보조 시트라 가져오지 않습니다`);
  }
  report.missingSheets = REQUIRED.filter(n2 => !sheets[n2]);
  if (report.missingSheets.length) {
    const names = missingSheetNames(report.missingSheets);
    throw Object.assign(new Error(`가져오기 양식의 필수 시트가 없습니다: ${names.map((k, i) => `${k}(${report.missingSheets[i]})`).join(', ')}. "엑셀로 가져오기" 창에서 양식을 받아 채우십시오`), { report });
  }

  // ───────── 설정 ─────────
  const config = new Map(table(sheets, '00_Config').map(r => [s(r.CONFIG_KEY), r.CONFIG_VALUE]));
  const cfgNum = (k: string, d: number) => n(config.get(k) ?? null) ?? d;

  // ───────── 파트 ─────────
  const partRows = uniqueBy(table(sheets, '01_Part_Master').filter(r => s(r.PART_ID)), r => s(r.PART_ID), k => skip(`파트 ${k}: 같은 ID가 두 번 있어 뒤의 행을 건너뜀`));
  const parts = partRows.map((r, i) => {
    const active = on(r, 'ACTIVE') && on(r, 'IS_CAPACITY_TARGET');
    if (on(r, 'ACTIVE') && !on(r, 'IS_CAPACITY_TARGET')) adjust(`파트 ${s(r.PART_NAME) || s(r.PART_ID)}: 작업 가능량 대상이 아니라 "사용 안 함"으로 가져왔습니다`);
    return { part_id: s(r.PART_ID), name: s(r.PART_NAME) || s(r.PART_ID), sort_order: int(r.SORT_ORDER) ?? i + 1, active: active ? 1 : 0 };
  });
  const partIds = new Set(parts.map(p => p.part_id));

  // ───────── 리소스: GROUP = 분류, 나머지 = 리소스 종류(가장 가까운 GROUP 조상이 분류) ─────────
  const resRows = uniqueBy(table(sheets, '02_Resource_Master').filter(r => s(r.RESOURCE_ID)), r => s(r.RESOURCE_ID), k => skip(`리소스 ${k}: 같은 ID가 두 번 있어 뒤의 행을 건너뜀`));
  const byId = new Map(resRows.map(r => [s(r.RESOURCE_ID), r]));
  const isGroup = (r: Row) => s(r.RESOURCE_LEVEL).toUpperCase() === 'GROUP';
  const groupOf = (r: Row): string | null => {
    let p = s(r.PARENT_RESOURCE_ID);
    for (let hop = 0; p && hop < 10; hop += 1) {
      const pr = byId.get(p);
      if (!pr) return null;
      if (isGroup(pr)) return p;
      p = s(pr.PARENT_RESOURCE_ID);
    }
    return null;
  };
  const groups = resRows.filter(isGroup).map((r, i) => ({ group_id: s(r.RESOURCE_ID), name: s(r.RESOURCE_NAME) || s(r.RESOURCE_ID), sort_order: int(r.SORT_ORDER) ?? i + 1 }));
  const resourceTypes = resRows.filter(r => !isGroup(r)).map((r, i) => ({
    resource_type_id: s(r.RESOURCE_ID), group_id: groupOf(r), name: s(r.RESOURCE_NAME) || s(r.RESOURCE_ID),
    sort_order: int(r.SORT_ORDER) ?? i + 1, active: on(r, 'ACTIVE') ? 1 : 0,
  }));
  const rtIds = new Set(resourceTypes.map(r => r.resource_type_id));
  const nested = resRows.filter(r => !isGroup(r) && s(r.PARENT_RESOURCE_ID) && byId.get(s(r.PARENT_RESOURCE_ID)) && !isGroup(byId.get(s(r.PARENT_RESOURCE_ID))!)).length;
  if (nested) adjust(`리소스 ${nested}종은 부모가 GROUP이 아니어서 가장 가까운 GROUP을 분류로 사용했습니다`);

  // ───────── 공수 ─────────
  const resourceParts: Record<string, unknown>[] = [];
  const efforts: Record<string, unknown>[] = [];
  let aiCount = 0;
  let noBase = 0;
  const effortSeen = new Set<string>();
  for (const r of table(sheets, '03_Effort_Standard')) {
    const rt = s(r.RESOURCE_ID);
    const part = s(r.PART_ID);
    if (effortSeen.has(`${rt}|${part}`)) { skip(`공수 ${rt}|${part}: 같은 행이 두 번 있어 뒤의 것을 건너뜀`); continue; }
    effortSeen.add(`${rt}|${part}`);
    if (!rtIds.has(rt)) { skip(`공수 ${rt}|${part}: 리소스 마스터에 없는 리소스`); continue; }
    if (!partIds.has(part)) { skip(`공수 ${rt}|${part}: 파트 마스터에 없는 파트`); continue; }
    const base = n(r.BASE_DAYS);
    const ai = n(r.AI_ASSISTED_DAYS);
    if (base == null && ai == null) { skip(`공수 ${rt}|${part}: 기본·AI 공수가 모두 비어 거치지 않는 파트로 보았습니다`); continue; }
    resourceParts.push({ resource_type_id: rt, part_id: part, rework_rate: n(r.DEFAULT_REWORK_RATE) ?? 0 });
    if (base != null) efforts.push({ resource_type_id: rt, part_id: part, profile_id: 'BASE', days: base });
    else noBase += 1;
    if (ai != null && ai > 0) { efforts.push({ resource_type_id: rt, part_id: part, profile_id: 'AI', days: ai }); aiCount += 1; }
  }
  if (noBase) adjust(`기본 공수가 빈 리소스·파트 ${noBase}개: 데이터 점검(E03)에서 채우십시오`);
  // 파트별 AI 활용 비율(양식의 설정 "AI 활용:파트ID")
  const aiShares = new Map<string, number>();
  for (const [k, v] of config) {
    const m = /^AI_SHARE:(.+)$/.exec(k);
    const x = n(v);
    if (m && partIds.has(m[1]) && x != null && x > 0) aiShares.set(m[1], Math.min(1, x));
  }
  const profiles = [{ profile_id: 'BASE', name: '기본', sort_order: 1 }, ...(aiCount || aiShares.size ? [{ profile_id: 'AI', name: 'AI 사용 시', sort_order: 2 }] : [])];
  const effortMix: Record<string, unknown>[] = [];
  const profileCfg = s(config.get('EFFORT_PROFILE') ?? null).toUpperCase();
  if (aiCount && (profileCfg === 'AI' || profileCfg === 'AI_ASSISTED')) {
    for (const p of parts) effortMix.push({ part_id: p.part_id, profile_id: 'AI', share: 1 });
    adjust('옛 설정 EFFORT_PROFILE = AI → 모든 파트를 AI 공수 100%로 섞었습니다');
  } else {
    for (const [part, share] of aiShares) {
      if (share < 1) effortMix.push({ part_id: part, profile_id: 'BASE', share: 1 - share });
      effortMix.push({ part_id: part, profile_id: 'AI', share });
    }
  }

  // ───────── 겹침률 ─────────
  // 옛 엔진은 설정에 기본 겹침률이 없으면 코드에 박힌 20%를 썼다(11_StageScheduleEngine.js builtinDefaultOverlapRate).
  // 새 구조는 숨은 기본값이 없으므로 그 값을 설정에 적는다
  const LEGACY_BUILTIN_OVERLAP = 0.2;
  const defaultOverlap = n(config.get('STAGE_OVERLAP_RATE_DEFAULT') ?? null);
  if (defaultOverlap == null && !fromTemplate) adjust(`기본 겹침률 설정이 없어 옛 도구가 쓰던 값 ${LEGACY_BUILTIN_OVERLAP * 100}%를 입력했습니다`);
  const overlaps: Record<string, unknown>[] = [];
  for (const [k, v] of config) {
    const m = /^STAGE_OVERLAP_RATE:(.+)>(.+)$/.exec(k);
    if (m && partIds.has(m[1]) && partIds.has(m[2]) && n(v) != null) overlaps.push({ from_part_id: m[1], to_part_id: m[2], overlap_rate: n(v) });
  }

  // ───────── 인력 · 계획 기간 ─────────
  const compat = !!options.legacyCompat;
  const keepWorkdays = compat || !!options.keepLegacyWorkdays;
  const capRows = table(sheets, '12_Capacity_Monthly');
  const capMonths = capRows.map(r => month(r.YEAR_MONTH)).filter((x): x is string => !!x).sort();
  if (!capMonths.length) throw Object.assign(new Error('12_Capacity_Monthly에 달이 없습니다.'), { report });
  const capStart = capMonths[0];
  const capEnd = capMonths[capMonths.length - 1];
  // 옛 엔진이 계산 기간을 정할 때 본 업데이트(사용 중) 날짜
  const activeUpd = table(sheets, '10_Update_Master').filter(r => s(r.UPDATE_ID) && on(r, 'ACTIVE'));
  const releaseMonthOf = (r: Row) => date(r.RELEASE_DATE)?.slice(0, 7) ?? month(r.TARGET_YEAR_MONTH);
  let start = capStart;
  let end = capEnd;
  if (compat) {
    const starts = activeUpd.map(r => month(r.PLAN_START_DATE)).filter((x): x is string => !!x).sort();
    const releases = activeUpd.map(releaseMonthOf).filter((x): x is string => !!x).sort();
    if (starts[0] && starts[0] < start) start = starts[0];
    const forecast = Math.max(1, Math.floor(cfgNum('ALLOCATION_FORECAST_HORIZON_MONTHS', 240)));
    const ends = [capEnd, releases[releases.length - 1], monthsBetween(start, '9999-12').slice(0, forecast).pop()].filter((x): x is string => !!x).sort();
    end = ends[ends.length - 1];
  }
  // 양식의 설정 "계획 시작 달 · 계획 끝 달"이 있으면 그 기간(내보낸 양식을 다시 가져올 때 기간이 그대로)
  if (!compat) {
    const ps = month(config.get('PLAN_START_MONTH') ?? null);
    const pe = month(config.get('PLAN_END_MONTH') ?? null);
    if (ps && pe && ps <= pe) { start = ps; end = pe; }
  }
  let span = monthsBetween(start, end);
  if (span.length > 60) {
    end = span[59];
    adjust(`인력 기간이 ${span.length}개월이라 앞 60개월(${start} ~ ${end})만 계획 기간으로 사용했습니다`);
    span = monthsBetween(start, end);
  }
  report.horizon = { start, end };
  // 휴일: 양식의 "휴일" 시트에 행이 있으면 그것만, 없으면 날짜가 고정된 공휴일
  const holidayRows = uniqueBy(table(sheets, 'HOLIDAYS').map(r => ({ date: date(r.DATE), name: s(r.NAME) || '휴일', kind: s(r.KIND) === 'COMPANY' ? 'COMPANY' : 'PUBLIC' }))
    .filter((h): h is { date: string; name: string; kind: string } => !!h.date), h => h.date, k => skip(`휴일 ${k}: 같은 날이 두 번 있어 뒤의 행을 건너뜀`));
  const autoHolidays = options.fixedHolidays !== false && !(config.has('AUTO_HOLIDAYS') && !bool(config.get('AUTO_HOLIDAYS') ?? null));
  const holidays = holidayRows.length ? holidayRows : autoHolidays ? fixedKoreanHolidays(start, end) : [];
  const holidaySet = new Set(holidays.map(h => h.date));
  const capacity: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let corrected = 0;
  for (const r of capRows) {
    const m = month(r.YEAR_MONTH);
    const part = s(r.PART_ID);
    if (!m) { skip(`인력 ${s(r.CAPACITY_ID)}: 달을 읽지 못함`); continue; }
    if (!partIds.has(part)) { skip(`인력 ${part}|${m}: 파트 마스터에 없는 파트`); continue; }
    if (m < start || m > end) continue;
    const key = `${part}|${m}`;
    if (seen.has(key)) { skip(`인력 ${key}: 같은 달이 두 번 있어 뒤의 것을 건너뜀`); continue; }
    seen.add(key);
    let productivity = n(r.PRODUCTIVITY_FACTOR) ?? cfgNum('DEFAULT_PRODUCTIVITY_FACTOR', 1);
    const legacyDays = n(r.BUSINESS_DAYS);
    if (keepWorkdays && legacyDays != null) {
      const wd = weekdays(m, holidaySet);
      if (wd > 0 && wd !== legacyDays) { productivity *= legacyDays / wd; corrected += 1; }
    }
    capacity.push({
      part_id: part, month: m,
      headcount: n(r.HEADCOUNT) ?? 0,
      utilization: n(r.UTILIZATION_RATE) ?? cfgNum('DEFAULT_UTILIZATION_RATE', 0.8),
      productivity,
      outsource_days: n(r.OUTSOURCE_CAPACITY_DAYS) ?? 0,
      support_days: n(r.TEMP_SUPPORT_DAYS) ?? 0,
      note: s(r.NOTE) || null,
    });
  }
  if (compat) {
    // 옛 REPEAT_LAST: 인력 행이 없는 달은 그 파트의 마지막 인력 행(달 순서로 마지막)을 되풀이한다
    let repeated = 0;
    for (const p of parts.filter(x => x.active)) {
      const own = capRows.filter(r => s(r.PART_ID) === p.part_id && month(r.YEAR_MONTH)).sort((a, b) => month(a.YEAR_MONTH)!.localeCompare(month(b.YEAR_MONTH)!));
      const last = own[own.length - 1];
      for (const m of span) {
        if (seen.has(`${p.part_id}|${m}`)) continue;
        seen.add(`${p.part_id}|${m}`);
        repeated += 1;
        const legacyDays = (last && n(last.BUSINESS_DAYS)) || cfgNum('DEFAULT_BUSINESS_DAYS_PER_MONTH', 20);
        const wd = weekdays(m, holidaySet);
        let productivity = (last && n(last.PRODUCTIVITY_FACTOR)) || cfgNum('DEFAULT_PRODUCTIVITY_FACTOR', 1);
        if (wd > 0 && wd !== legacyDays) { productivity *= legacyDays / wd; corrected += 1; }
        capacity.push({
          part_id: p.part_id, month: m,
          headcount: (last && n(last.HEADCOUNT)) || 0,
          utilization: (last && n(last.UTILIZATION_RATE)) || cfgNum('DEFAULT_UTILIZATION_RATE', 1),
          productivity,
          outsource_days: (last && n(last.OUTSOURCE_CAPACITY_DAYS)) || 0,
          support_days: (last && n(last.TEMP_SUPPORT_DAYS)) || 0,
          note: '옛 도구처럼 마지막 달 인력을 되풀이(대조용)',
        });
      }
    }
    if (repeated) adjust(`대조용: 인력 행이 없는 ${repeated}칸(파트 × 달)을 옛 도구처럼 그 파트의 마지막 인력 행으로 채웠습니다`);
  }
  if (corrected) adjust(`옛 월 근무일 수에 맞추려고 인력 ${corrected}행의 생산성을 보정했습니다(대조용 설정)`);
  else if (!options.keepLegacyWorkdays && !fromTemplate) adjust('월 근무일 수는 옛 BUSINESS_DAYS 대신 근무 달력(월–금' + (holidays.length ? ', 고정 공휴일 제외' : '') + ')으로 계산합니다. 작업 가능량이 옛 값과 조금 다를 수 있습니다');
  const missingCap = parts.filter(p => p.active).flatMap(p => span.filter(m => !seen.has(`${p.part_id}|${m}`)).map(m => `${p.name} ${m}`));
  if (missingCap.length) adjust(`인력 행이 없는 달 ${missingCap.length}개(예: ${missingCap.slice(0, 3).join(', ')}): 데이터 점검(C01)에서 채우십시오`);

  // ───────── 업데이트 유형 · 템플릿 ─────────
  const typeRows = uniqueBy(table(sheets, '05_Update_Type').filter(r => s(r.UPDATE_TYPE_ID)), r => s(r.UPDATE_TYPE_ID), k => skip(`업데이트 유형 ${k}: 같은 ID가 두 번 있어 뒤의 행을 건너뜀`));
  const updateTypes = typeRows.map((r, i) => {
    const id = s(r.UPDATE_TYPE_ID);
    const name = s(r.UPDATE_TYPE_NAME) || id;
    const launch = s(r.IS_LAUNCH) ? bool(r.IS_LAUNCH) : id.toUpperCase() === 'LAUNCH' || name.includes('런칭');
    return { update_type_id: id, name, is_launch: launch ? 1 : 0, sort_order: int(r.SORT_ORDER) ?? i + 1, active: on(r, 'ACTIVE') ? 1 : 0 };
  });
  const typeIds = new Set(updateTypes.map(t => t.update_type_id));
  const templates: Record<string, unknown>[] = [];
  let templateFilled = 0;
  for (const r of table(sheets, '06_Update_Volume_Template')) {
    if (!on(r, 'ACTIVE')) continue;
    const t = s(r.UPDATE_TYPE_ID);
    const rt = s(r.RESOURCE_ID);
    if (!typeIds.has(t) || !rtIds.has(rt)) { skip(`템플릿 ${t}|${rt}: 없는 유형이나 리소스`); continue; }
    if (templates.some(x => x.update_type_id === t && x.resource_type_id === rt)) { skip(`템플릿 ${t}|${rt}: 같은 행이 두 번 있어 뒤의 것을 건너뜀`); continue; }
    // 물량과 같게: 빈(또는 0) 최저 · 빈 확장은 목표와 같게
    const tTarget = int(r.TARGET_QTY);
    let tMin = int(r.MIN_QTY);
    let tStretch = int(r.STRETCH_QTY);
    if (tTarget != null && (tMin == null || (tMin === 0 && !fromTemplate)) && tMin !== tTarget) { tMin = tTarget; templateFilled += 1; }
    if (tTarget != null && tStretch == null) { tStretch = tTarget; templateFilled += 1; }
    templates.push({ update_type_id: t, resource_type_id: rt, min_qty: tMin, target_qty: tTarget, stretch_qty: tStretch });
  }

  if (templateFilled) adjust(`유형 템플릿의 빈 최소안·최대안 ${templateFilled}칸: 물량처럼 기본안과 같게 입력했습니다`);

  // ───────── 업데이트: 등급(HIGH/MEDIUM/LOW) → 숫자 순위 ─────────
  const updRows = uniqueBy(table(sheets, '10_Update_Master').filter(r => s(r.UPDATE_ID)), r => s(r.UPDATE_ID), k => skip(`업데이트 ${k}: 같은 ID가 두 번 있어 뒤의 행을 건너뜀`));
  let releaseFilled = 0;
  let startFilled = 0;
  const statusUnknown = new Set<string>();
  const ups = updRows.map((r, i) => {
    const id = s(r.UPDATE_ID);
    let type = s(r.UPDATE_TYPE_ID);
    if (!typeIds.has(type)) {
      skip(`업데이트 ${id}: 유형 "${type}"이 없어 "업데이트" 유형으로 입력했습니다`);
      if (!typeIds.has('UPDATE')) { updateTypes.push({ update_type_id: 'UPDATE', name: '업데이트', is_launch: 0, sort_order: 999, active: 1 }); typeIds.add('UPDATE'); }
      type = 'UPDATE';
    }
    let release = date(r.RELEASE_DATE);
    const ym = month(r.TARGET_YEAR_MONTH);
    if (!release && ym) { release = lastDay(ym); releaseFilled += 1; }
    const raw = s(r.STATUS).toUpperCase();
    let status = STATUS[raw] ?? 'PLANNED';
    if (raw && !STATUS[raw]) statusUnknown.add(raw);
    if (compat && on(r, 'ACTIVE') && (status === 'DONE' || status === 'CANCELLED')) status = 'PLANNED';
    if (!on(r, 'ACTIVE')) status = 'CANCELLED';
    return {
      row: {
        update_id: id, name: s(r.UPDATE_NAME) || id, update_type_id: type,
        // 시작일이 비면 옛 도구처럼 계산 기간의 첫날(arpResolveUpdateStartDate_의 fallback)
        start_date: date(r.PLAN_START_DATE) ?? (on(r, 'ACTIVE') ? (startFilled += 1, `${start}-01`) : null), freeze_date: date(r.CONTENT_FREEZE_DATE), release_date: release,
        priority: 0, status, sort_order: int(r.SORT_ORDER) ?? i + 1, note: s(r.DESCRIPTION) || null,
      },
      level: level(r.PRIORITY),
    };
  });
  if (startFilled) adjust(`시작일이 빈 업데이트 ${startFilled}개: 옛 도구처럼 계획 기간 첫날(${start}-01)로 채웠습니다. 실제 시작일을 입력하십시오`);
  if (releaseFilled) adjust(`출시일이 빈 업데이트 ${releaseFilled}개: 옛 도구처럼 목표 월(TARGET_YEAR_MONTH)의 말일로 채웠습니다`);
  if (statusUnknown.size) adjust(`알 수 없는 상태(${[...statusUnknown].join(', ')})는 "계획"으로 가져왔습니다`);
  const live = (x: { row: { status: string } }) => x.row.status === 'PLANNED' || x.row.status === 'IN_PROGRESS';
  const ordered = [...ups].sort((a, b) =>
    Number(!live(a)) - Number(!live(b)) || a.level - b.level
    || (a.row.release_date ?? '9999') .localeCompare(b.row.release_date ?? '9999') || a.row.sort_order - b.row.sort_order);
  ordered.forEach((x, i) => { x.row.priority = i + 1; });
  if (ups.length && !fromTemplate) adjust('우선순위 등급(HIGH/MEDIUM/LOW)을 숫자 순위로 변경했습니다: 등급 → 출시일 → 표시 순서');
  const updates = ups.map(x => x.row);
  const updIds = new Set(updates.map(u => u.update_id));
  if (!compat) {
    const liveRows = updates.filter(u => u.status === 'PLANNED' || u.status === 'IN_PROGRESS');
    const early = liveRows.filter(u => u.start_date && u.start_date.slice(0, 7) < capStart);
    if (early.length) adjust(`업데이트 ${early.length}개(${early.slice(0, 3).map(u => u.name).join(', ')})가 인력 첫 달(${capStart})보다 먼저 시작합니다. 옛 도구는 그 앞 달에도 마지막 달 인원이 있다고 보고 계산해 완료 예정이 더 빨랐습니다. 새 도구는 인력이 있는 달부터 계산합니다. 이미 한 작업은 작업 진척에 입력하십시오`);
    const late = liveRows.filter(u => u.release_date && u.release_date.slice(0, 7) > capEnd);
    if (late.length) adjust(`업데이트 ${late.length}개(${late.slice(0, 3).map(u => u.name).join(', ')})의 출시가 인력 마지막 달(${capEnd}) 뒤입니다. 옛 도구는 마지막 달 인원이 계속된다고 보고 계산했습니다. 인력 화면에서 계획 기간을 늘리십시오`);
    const volUpd = new Set(table(sheets, '11_Update_Volume').map(r => s(r.UPDATE_ID)));
    const closed = activeUpd.filter(r => { const st = STATUS[s(r.STATUS).toUpperCase()]; return (st === 'DONE' || st === 'CANCELLED') && volUpd.has(s(r.UPDATE_ID)); });
    if (closed.length) adjust(`출시 완료·취소 상태인 업데이트 ${closed.length}개(${closed.slice(0, 3).map(r => s(r.UPDATE_NAME) || s(r.UPDATE_ID)).join(', ')})는 계산에서 빠집니다. 옛 도구는 상태와 관계없이 사용(ACTIVE)이면 물량을 계산했습니다`);
  }
  const liveLaunch = updates.filter(u => (u.status === 'PLANNED' || u.status === 'IN_PROGRESS') && updateTypes.find(t => t.update_type_id === u.update_type_id)?.is_launch);
  if (liveLaunch.length > 1) adjust(`런칭 유형 업데이트가 ${liveLaunch.length}개입니다(${liveLaunch.map(u => u.name).join(', ')}). 하나만 남기십시오(U05)`);

  // ───────── 물량: 추가·이월·취소 수량을 물량에 합친다 ─────────
  const volumes: Record<string, unknown>[] = [];
  let folded = 0; let minFilled = 0; let stretchFilled = 0;
  const vSeen = new Set<string>();
  for (const r of table(sheets, '11_Update_Volume')) {
    const u = s(r.UPDATE_ID);
    const rt = s(r.RESOURCE_ID);
    if (!updIds.has(u)) { skip(`물량 ${u}|${rt}: 업데이트 마스터에 없는 업데이트`); continue; }
    if (!rtIds.has(rt)) { skip(`물량 ${u}|${rt}: 리소스 마스터에 없는 리소스`); continue; }
    if (vSeen.has(`${u}|${rt}`)) { skip(`물량 ${u}|${rt}: 같은 행이 두 번 있어 뒤의 것을 건너뜀`); continue; }
    vSeen.add(`${u}|${rt}`);
    const delta = (n(r.ADDED_QTY) ?? 0) + (n(r.CARRYOVER_IN_QTY) ?? 0) - (n(r.CANCELLED_QTY) ?? 0);
    if (delta) folded += 1;
    const fold = (x: number | null) => (x == null ? null : Math.max(0, Math.round(x + delta)));
    let target = fold(n(r.TARGET_QTY));
    let min = fold(n(r.MIN_QTY));
    let stretch = fold(n(r.STRETCH_QTY));
    if (target == null) target = 0;
    if (min == null || (n(r.MIN_QTY) === 0 && !fromTemplate)) { if (min !== target) minFilled += 1; min = target; }
    if (stretch == null) { stretch = target; stretchFilled += 1; }
    const lvl = s(r.REQUIRED_LEVEL).toUpperCase();
    volumes.push({
      update_id: u, resource_type_id: rt, min_qty: min, target_qty: target, stretch_qty: stretch,
      // 선택으로 볼 것만 선택(SHOULD·COULD 등). 빈칸과 옛 기본값 UNCLASSIFIED는 필수
      required: ['SHOULD', 'COULD', 'WONT', "WON'T", 'OPTIONAL', 'NICE', '선택'].includes(lvl) ? 0 : 1,
      priority: Math.max(1, level(r.PRIORITY)),
      difficulty: n(r.DIFFICULTY_FACTOR) || 1,
      reuse_rate: n(r.REUSE_RATE) ?? 0,
      outsource_qty: Math.max(0, Math.round(n(r.OUTSOURCE_QTY) ?? 0)),
      note: s(r.CHANGE_REASON) || null,
    });
  }
  if (folded) adjust(`물량 ${folded}행: 추가·이월·취소 수량을 템플릿 세 개에 합쳤습니다(새 구조에는 그 칸이 없습니다)`);
  if (minFilled) adjust(`최저가 비었거나 0인 물량 ${minFilled}행: 옛 도구처럼 목표와 같게 입력했습니다`);
  if (stretchFilled) adjust(`최대안이 빈 물량 ${stretchFilled}행: 기본안과 같게 입력했습니다`);
  if (!fromTemplate) adjust('필수 여부: SHOULD·COULD 등은 선택, 그 밖(MUST·빈칸·UNCLASSIFIED)은 필수로 가져왔습니다');

  // ───────── 실적: 완료 + 외주 완료 + 규격 제외 = 완료 수량 ─────────
  const progress: Record<string, unknown>[] = [];
  const pSeen = new Set<string>();
  for (const r of table(sheets, '13_Progress_Actual')) {
    const u = s(r.UPDATE_ID); const rt = s(r.RESOURCE_ID); const part = s(r.PART_ID);
    if (!updIds.has(u) || !rtIds.has(rt) || !partIds.has(part)) { skip(`작업 진척 ${u}|${rt}|${part}: 없는 업데이트·리소스·파트`); continue; }
    const qty = Math.round((n(r.COMPLETED_QTY) ?? 0) + (n(r.OUTSOURCE_COMPLETED_QTY) ?? 0) + (n(r.SPEC_OUT_QTY) ?? 0));
    const pk = `${u}|${rt}|${part}`;
    if (pSeen.has(pk)) {
      // 같은 실적 행이 또 나오면 뒤의 값을 쓴다(시트가 시간 순이면 최신 값)
      const i = progress.findIndex(p => `${p.update_id}|${p.resource_type_id}|${p.part_id}` === pk);
      if (i >= 0) progress.splice(i, 1);
      skip(`작업 진척 ${pk}: 같은 행이 두 번 있어 뒤의 값을 사용했습니다`);
    }
    pSeen.add(pk);
    if (!qty) continue;
    // 기준일은 AS_OF_DATE(없으면 UPDATED_AT), 실투입 인·일은 ACTUAL_EFFORT_DAYS
    const spent = n(r.ACTUAL_EFFORT_DAYS);
    progress.push({ update_id: u, resource_type_id: rt, part_id: part, completed_qty: qty, as_of: date(r.AS_OF_DATE) ?? date(r.UPDATED_AT), spent_days: spent != null && spent > 0 ? spent : null });
  }

  const now = options.now ?? new Date().toISOString();
  const rows: Rows = {
    meta: [
      { key: 'project_name', value: s(config.get('PROJECT_NAME') ?? null) || options.projectName?.trim() || '가져온 프로젝트' },
      ...(['MIN', 'TARGET', 'STRETCH'] as const).filter(m => s(config.get(`MODE_NAME_${m}`) ?? null)).map(m => ({ key: `mode_name_${m}`, value: s(config.get(`MODE_NAME_${m}`) ?? null).slice(0, 20) })),
      { key: 'created_at', value: now },
      { key: 'data_version', value: '1' },
      { key: 'saved_by_app', value: options.appVersion ?? 'arp-next' },
      { key: 'imported_from', value: 'legacy-google-sheet' },
    ],
    settings: [{
      id: 1, horizon_start_month: start, horizon_end_month: end,
      work_weekdays: /^[01]{7}$/.test(s(config.get('WORK_WEEKDAYS') ?? null)) && s(config.get('WORK_WEEKDAYS') ?? null).includes('1') ? s(config.get('WORK_WEEKDAYS') ?? null) : '1111100',
      buffer_rate: cfgNum('DEFAULT_BUFFER_RATE', 0), default_overlap_rate: defaultOverlap ?? LEGACY_BUILTIN_OVERLAP,
      load_warn_rate: cfgNum('CAPACITY_YELLOW_THRESHOLD', 0.8), load_over_rate: cfgNum('CAPACITY_ORANGE_THRESHOLD', 1), load_critical_rate: cfgNum('CAPACITY_RED_THRESHOLD', 1.2),
      late_warn_workdays: 10, default_plan_mode: ['MIN', 'TARGET', 'STRETCH'].includes(s(config.get('DEFAULT_PLAN_MODE') ?? null)) ? s(config.get('DEFAULT_PLAN_MODE') ?? null) : 'TARGET',
    }],
    holidays,
    parts,
    part_overlaps: overlaps,
    resource_groups: groups,
    resource_types: resourceTypes,
    resource_parts: resourceParts,
    effort_profiles: profiles,
    efforts,
    effort_mix: effortMix,
    update_types: updateTypes,
    type_templates: templates,
    updates,
    volumes,
    progress,
    capacity,
  };
  for (const [k, v] of Object.entries(rows)) if (k !== 'meta' && k !== 'settings') report.counts[k] = v.length;
  return { rows, report };
}

const ORDER = [
  'meta', 'settings', 'holidays', 'parts', 'part_overlaps', 'resource_groups', 'resource_types', 'resource_parts',
  'effort_profiles', 'efforts', 'effort_mix', 'update_types', 'type_templates', 'updates', 'volumes', 'progress', 'capacity',
];

/** 빈 DB에 구조를 만들고 가져온 행을 넣는다(한 트랜잭션) */
export function writeImported(db: SqlDb, schemaSql: string, rows: Rows): void {
  db.exec(schemaSql);
  migrate(db);
  db.exec('BEGIN');
  try {
    for (const t of ORDER) {
      for (const row of rows[t] ?? []) {
        const cols = Object.keys(row);
        db.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c]));
      }
    }
    ensureDefaultPipeline(db); // 리소스들이 거치는 파트를 파트 순서로(docs/29)
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`가져온 값을 저장하지 못했습니다: ${(error as Error).message}`);
  }
}
