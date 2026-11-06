// 엑셀 가져오기 규격(한 곳에서만 정의). 이 정의로 ① 양식 파일(빈 양식·예시 양식) ② 가져오기 전 한글 시트·머리글 바꾸기
// ③ 화면의 규격 요약 표 ④ 문서를 만든다. 가져오기 본체(import-legacy.ts)는 옛 도구의 시트 이름·영문 머리글을 읽는다.
//  - 시트 이름: 한글("파트") 또는 옛 이름("01_Part_Master")
//  - 머리글: 한글("파트 ID", 끝의 * 무시) 또는 옛 영문("PART_ID")
//  - 양식의 2행(첫 칸이 ※로 시작)은 설명 줄이라 읽지 않는다
import type { Cell, Sheets } from './xlsx.ts';
import type { StyledCell, Cell as WCell } from './xlsx-write.ts';

export interface SpecColumn {
  /** 옛 도구 머리글(가져오기 본체가 읽는 이름) */
  key: string;
  /** 양식 머리글 */
  ko: string;
  required?: boolean;
  /** 형식 설명(안내 시트·화면 표) */
  format: string;
  desc: string;
  /** 0~1 비율 칸: 80, "80%"도 0.8로 읽는다 */
  pct?: boolean;
  /** 사용 여부 칸: Y/N 외에 O·X·사용·미사용도 읽는다 */
  flag?: boolean;
}
export interface SpecSheet {
  key: string;
  ko: string;
  required: boolean;
  desc: string;
  columns: SpecColumn[];
}

const ID = '영문·숫자·밑줄';
export const IMPORT_SPEC: SpecSheet[] = [
  {
    key: '00_Config', ko: '설정', required: false, desc: '프로젝트 공통 값. 비우면 기본값(여유율 0%, 겹침률 20%, 가동률 80%)을 사용합니다.',
    columns: [
      { key: 'CONFIG_KEY', ko: '항목', required: true, format: '아래 항목 이름', desc: '프로젝트 이름 · 여유율 · 기본 겹침률 · 기본 가동률 · 기본 생산성 · 근무 요일 · 계획 시작 달 · 계획 끝 달 · 겹침률:앞파트ID>뒤파트ID · AI 활용:파트ID · 템플릿1·2·3 이름' },
      { key: 'CONFIG_VALUE', ko: '값', required: true, format: '숫자(비율은 0.1 또는 10%)', desc: '항목의 값' },
    ],
  },
  {
    key: '01_Part_Master', ko: '파트', required: true, desc: '작업 공정(원화 · 모델링 등). 순서가 곧 공정 순서입니다.',
    columns: [
      { key: 'PART_ID', ko: '파트 ID', required: true, format: ID, desc: '다른 시트에서 파트를 가리키는 값(예: ART)' },
      { key: 'PART_NAME', ko: '파트 이름', required: true, format: '글자', desc: '화면에 표시할 이름' },
      { key: 'SORT_ORDER', ko: '순서', format: '정수', desc: '공정 순서. 비우면 행 순서' },
      { key: 'ACTIVE', ko: '사용', format: 'Y / N', desc: '비우거나 칸이 없으면 사용', flag: true },
    ],
  },
  {
    key: '02_Resource_Master', ko: '리소스', required: true, desc: '만드는 아트 리소스 종류(신규 캐릭터 · 배경 맵 등)와 분류.',
    columns: [
      { key: 'RESOURCE_ID', ko: '리소스 ID', required: true, format: ID, desc: '다른 시트에서 리소스를 가리키는 값(예: CHAR_NEW)' },
      { key: 'RESOURCE_NAME', ko: '리소스 이름', required: true, format: '글자', desc: '화면에 표시할 이름' },
      { key: 'GROUP_NAME', ko: '분류', format: '글자', desc: '같은 분류끼리 묶어 표시(예: 캐릭터)' },
      { key: 'SORT_ORDER', ko: '순서', format: '정수', desc: '표시 순서. 비우면 행 순서' },
      { key: 'ACTIVE', ko: '사용', format: 'Y / N', desc: '비우거나 칸이 없으면 사용', flag: true },
    ],
  },
  {
    key: '03_Effort_Standard', ko: '공수', required: true, desc: '리소스 1개를 파트에서 만드는 데 드는 인·일. 거치지 않는 파트는 행을 두지 않습니다.',
    columns: [
      { key: 'RESOURCE_ID', ko: '리소스 ID', required: true, format: '리소스 시트의 ID', desc: '' },
      { key: 'PART_ID', ko: '파트 ID', required: true, format: '파트 시트의 ID', desc: '' },
      { key: 'BASE_DAYS', ko: '기본 공수', required: true, format: '숫자(인·일/개)', desc: 'AI 없이 만들 때' },
      { key: 'AI_ASSISTED_DAYS', ko: 'AI 공수', format: '숫자(인·일/개)', desc: 'AI를 쓸 때. 비우면 기본과 같음' },
      { key: 'DEFAULT_REWORK_RATE', ko: '재작업률', format: '비율(0.1 또는 10%)', desc: '수정 · 재작업으로 더 드는 몫', pct: true },
    ],
  },
  {
    key: '05_Update_Type', ko: '업데이트 유형', required: false, desc: '런칭 · 시즌 · 미니 등. ID가 LAUNCH이거나 이름에 "런칭"이 있으면 런칭 유형입니다.',
    columns: [
      { key: 'UPDATE_TYPE_ID', ko: '유형 ID', required: true, format: ID, desc: '예: LAUNCH, SEASON' },
      { key: 'UPDATE_TYPE_NAME', ko: '유형 이름', required: true, format: '글자', desc: '' },
      { key: 'IS_LAUNCH', ko: '런칭 여부', format: 'Y / N', desc: '비우면 ID가 LAUNCH이거나 이름에 "런칭"이 있을 때 런칭', flag: true },
      { key: 'SORT_ORDER', ko: '순서', format: '정수', desc: '' },
      { key: 'ACTIVE', ko: '사용', format: 'Y / N', desc: '비우거나 칸이 없으면 사용', flag: true },
    ],
  },
  {
    key: '06_Update_Volume_Template', ko: '유형 템플릿', required: false, desc: '유형별 기본 물량. 새 업데이트를 만들 때 복사합니다.',
    columns: [
      { key: 'UPDATE_TYPE_ID', ko: '유형 ID', required: true, format: '업데이트 유형 시트의 ID', desc: '' },
      { key: 'RESOURCE_ID', ko: '리소스 ID', required: true, format: '리소스 시트의 ID', desc: '' },
      { key: 'MIN_QTY', ko: '최소안', format: '정수', desc: '비우면 기본안과 같음' },
      { key: 'TARGET_QTY', ko: '기본안', required: true, format: '정수', desc: '' },
      { key: 'STRETCH_QTY', ko: '최대안', format: '정수', desc: '비우면 기본안과 같음' },
    ],
  },
  {
    key: '10_Update_Master', ko: '업데이트', required: true, desc: '런칭과 이후 업데이트. 우선순위가 높을수록 인력을 먼저 사용합니다.',
    columns: [
      { key: 'UPDATE_ID', ko: '업데이트 ID', required: true, format: ID, desc: '예: LAUNCH, S1' },
      { key: 'UPDATE_NAME', ko: '업데이트 이름', required: true, format: '글자', desc: '' },
      { key: 'UPDATE_TYPE_ID', ko: '유형 ID', required: true, format: '업데이트 유형 시트의 ID', desc: '' },
      { key: 'PLAN_START_DATE', ko: '작업 시작일', required: true, format: '날짜(2027-03-15)', desc: '' },
      { key: 'CONTENT_FREEZE_DATE', ko: '제작 완료 목표일', format: '날짜', desc: '아트 작업을 끝내야 하는 날' },
      { key: 'RELEASE_DATE', ko: '출시일', required: true, format: '날짜', desc: '' },
      { key: 'PRIORITY', ko: '우선순위', format: '높음 / 보통 / 낮음 또는 숫자', desc: '같으면 출시일이 빠른 순' },
      { key: 'STATUS', ko: '상태', format: '계획 / 진행 / 완료 / 취소', desc: '완료 · 취소는 계산에서 빠짐' },
      { key: 'DESCRIPTION', ko: '메모', format: '글자', desc: '' },
    ],
  },
  {
    key: '11_Update_Volume', ko: '물량', required: true, desc: '업데이트마다 만들 리소스 수량. 템플릿 세 개(최소안 · 기본안 · 최대안)로 나눠 적습니다.',
    columns: [
      { key: 'UPDATE_ID', ko: '업데이트 ID', required: true, format: '업데이트 시트의 ID', desc: '' },
      { key: 'RESOURCE_ID', ko: '리소스 ID', required: true, format: '리소스 시트의 ID', desc: '' },
      { key: 'MIN_QTY', ko: '최소안', format: '정수', desc: '비우면 기본안과 같음' },
      { key: 'TARGET_QTY', ko: '기본안', required: true, format: '정수', desc: '' },
      { key: 'STRETCH_QTY', ko: '최대안', format: '정수', desc: '비우면 기본안과 같음' },
      { key: 'OUTSOURCE_QTY', ko: '외주 수량', format: '정수', desc: '외주로 만드는 개수(공수 계산에서 뺌)' },
      { key: 'PRIORITY', ko: '순위', format: '정수(1 = 먼저)', desc: '업데이트 안에서 먼저 만들 순서. 비우면 2' },
      { key: 'REQUIRED_LEVEL', ko: '필수 여부', format: '필수 / 선택', desc: '선택 리소스는 마감 맞추기에서 먼저 줄임' },
      { key: 'DIFFICULTY_FACTOR', ko: '난이도', format: '배수(1 = 보통)', desc: '공수에 곱함' },
      { key: 'REUSE_RATE', ko: '재사용률', format: '비율(0.2 또는 20%)', desc: '기존 리소스를 고쳐 쓰는 몫', pct: true },
      { key: 'CHANGE_REASON', ko: '메모', format: '글자', desc: '' },
    ],
  },
  {
    key: '12_Capacity_Monthly', ko: '인력', required: true, desc: '파트 × 달 인력. 이 시트의 첫 달 ~ 마지막 달이 계획 기간이 됩니다.',
    columns: [
      { key: 'YEAR_MONTH', ko: '달', required: true, format: '2027-03', desc: '' },
      { key: 'PART_ID', ko: '파트 ID', required: true, format: '파트 시트의 ID', desc: '' },
      { key: 'HEADCOUNT', ko: '인원', required: true, format: '숫자(명, 0.5 가능)', desc: '정규 인원' },
      { key: 'UTILIZATION_RATE', ko: '가동률', format: '비율(0.8 또는 80%)', desc: '근무일 중 제작에 쓰는 비율. 비우면 80%', pct: true },
      { key: 'PRODUCTIVITY_FACTOR', ko: '생산성', format: '배수(1 = 보통)', desc: '신규 인원은 1보다 작게' },
      { key: 'OUTSOURCE_CAPACITY_DAYS', ko: '외주 인·일', format: '숫자', desc: '그 달 외부에서 받는 작업 가능량' },
      { key: 'TEMP_SUPPORT_DAYS', ko: '지원 인·일', format: '숫자', desc: '다른 조직 지원' },
      { key: 'NOTE', ko: '메모', format: '글자', desc: '' },
    ],
  },
  {
    key: 'HOLIDAYS', ko: '휴일', required: false, desc: '근무하지 않는 날. 이 시트에 행이 있으면 이 휴일만 쓰고, 없으면 날짜가 고정된 공휴일을 자동으로 넣습니다(설정 "공휴일 자동 넣기" = N이면 넣지 않음).',
    columns: [
      { key: 'DATE', ko: '날짜', required: true, format: '날짜', desc: '' },
      { key: 'NAME', ko: '이름', required: true, format: '글자', desc: '예: 창립기념일' },
      { key: 'KIND', ko: '구분', format: '공휴일 / 회사 휴무일', desc: '비우면 공휴일' },
    ],
  },
  {
    key: '13_Progress_Actual', ko: '작업 진척', required: false, desc: '이미 끝낸 수량. 끝낸 만큼 빼고 남은 일만 계산합니다.',
    columns: [
      { key: 'UPDATE_ID', ko: '업데이트 ID', required: true, format: '업데이트 시트의 ID', desc: '' },
      { key: 'RESOURCE_ID', ko: '리소스 ID', required: true, format: '리소스 시트의 ID', desc: '' },
      { key: 'PART_ID', ko: '파트 ID', required: true, format: '파트 시트의 ID', desc: '' },
      { key: 'COMPLETED_QTY', ko: '완료 수량', required: true, format: '정수', desc: '그 파트 공정을 끝낸 개수' },
      { key: 'ACTUAL_EFFORT_DAYS', ko: '실투입 인·일', format: '숫자', desc: '공수 보정에 사용' },
      { key: 'AS_OF_DATE', ko: '기준일', format: '날짜', desc: '' },
    ],
  },
];

const CONFIG_KO: Record<string, string> = {
  '프로젝트 이름': 'PROJECT_NAME', '근무 요일': 'WORK_WEEKDAYS', '계획 시작 달': 'PLAN_START_MONTH', '계획 끝 달': 'PLAN_END_MONTH', '공휴일 자동 넣기': 'AUTO_HOLIDAYS',
  '템플릿1 이름': 'MODE_NAME_MIN', '템플릿2 이름': 'MODE_NAME_TARGET', '템플릿3 이름': 'MODE_NAME_STRETCH',
  '여유율': 'DEFAULT_BUFFER_RATE', '기본 겹침률': 'STAGE_OVERLAP_RATE_DEFAULT', '겹침률': 'STAGE_OVERLAP_RATE_DEFAULT',
  '기본 가동률': 'DEFAULT_UTILIZATION_RATE', '기본 생산성': 'DEFAULT_PRODUCTIVITY_FACTOR',
};
const PCT_CONFIG = new Set(['DEFAULT_BUFFER_RATE', 'STAGE_OVERLAP_RATE_DEFAULT', 'DEFAULT_UTILIZATION_RATE']);
const PRIORITY_KO: Record<string, string> = { '최우선': 'CRITICAL', '긴급': 'CRITICAL', '높음': 'HIGH', '상': 'HIGH', '보통': 'MEDIUM', '중': 'MEDIUM', '낮음': 'LOW', '하': 'LOW' };
const FLAG_KO: Record<string, string> = { 'O': 'Y', '○': 'Y', 'V': 'Y', '사용': 'Y', '예': 'Y', 'X': 'N', '×': 'N', '미사용': 'N', '사용 안 함': 'N', '아니오': 'N' };

const squash = (v: Cell) => (v == null ? '' : String(v).replace(/\*/g, '').replace(/\s+/g, '').trim().toUpperCase());
/** "80%" · 80 → 0.8. 1 이하는 그대로 */
function pct(v: Cell): Cell {
  if (v == null || v === '') return v;
  const t = String(v).trim();
  const x = Number(t.replace(/%$/, '').replace(/,/g, ''));
  if (!Number.isFinite(x)) return v;
  return t.endsWith('%') || x > 1 ? x / 100 : x;
}

/** "월화수목금" · "월,화,수" · "1111100" → 월~일 7자리 0/1 */
export function weekdayBits(v: Cell): Cell {
  const t = String(v ?? '').trim();
  if (/^[01]{7}$/.test(t)) return t;
  const days = '월화수목금토일';
  const bits = [...days].map(d => (t.includes(d) ? '1' : '0')).join('');
  return bits.includes('1') ? bits : v;
}
export const weekdayText = (bits: string) => [...'월화수목금토일'].filter((_, i) => bits[i] === '1').join('');

/**
 * 한글 양식 → 옛 도구 구조. 옛 시트(영문)는 그대로 둔다(칸 값도 바꾸지 않는다: 옛 계산과 대조가 같아야 한다).
 * 한글 머리글로 찾은 칸만 값 규칙(비율 %, 사용 O/X, 우선순위 높음/보통/낮음)을 넓혀 읽는다.
 */
export function normalizeSheets(sheets: Sheets): Sheets {
  const out: Sheets = {};
  for (const [name, rows] of Object.entries(sheets)) {
    const spec = IMPORT_SPEC.find(sp => sp.key === name || squash(sp.ko) === squash(name.replace(/^\d+[_\s.-]*/, '')) || squash(sp.ko) === squash(name));
    if (!spec || !rows.length) { out[name] = rows; continue; }
    const head = rows[0];
    const cols = head.map(h => {
      const k = squash(h);
      const byKo = spec.columns.find(c => squash(c.ko) === k);
      if (byKo) return { key: byKo.key, col: byKo, ko: true };
      const byKey = spec.columns.find(c => c.key === k);
      return { key: byKey?.key ?? (h == null ? '' : String(h).trim()), col: byKey, ko: false };
    });
    const korean = cols.some(c => c.ko);
    const body = rows.slice(1).filter(r => !String(r.find(v => v != null && v !== '') ?? '').trim().startsWith('※'));
    if (!korean) { out[spec.key] = [cols.map(c => c.key), ...body]; continue; }
    const fixed = body.map(r => cols.map((c, i) => {
      const v = r[i] ?? null;
      if (!c.ko || !c.col) return v;
      if (c.col.pct) return pct(v);
      if (c.col.flag) { const t = String(v ?? '').trim(); return FLAG_KO[t.toUpperCase()] ?? FLAG_KO[t] ?? v; }
      if (c.key === 'PRIORITY') return PRIORITY_KO[String(v ?? '').trim()] ?? v;
      if (c.key === 'REQUIRED_LEVEL') return String(v ?? '').trim() === '선택' ? 'SHOULD' : v;
      if (c.key === 'KIND' && spec.key === 'HOLIDAYS') return /회사/.test(String(v ?? '')) ? 'COMPANY' : 'PUBLIC';
      return v;
    }));
    // 설정: 한글 항목 이름 · 겹침률:A>B
    if (spec.key === '00_Config') {
      const ki = cols.findIndex(c => c.key === 'CONFIG_KEY');
      const vi = cols.findIndex(c => c.key === 'CONFIG_VALUE');
      for (const r of fixed) {
        const raw = String(r[ki] ?? '').trim();
        const pair = /^겹침률\s*[:：]\s*(.+?)\s*>\s*(.+)$/.exec(raw);
        const ai = /^AI\s*활용\s*[:：]\s*(.+)$/i.exec(raw);
        const key = pair ? `STAGE_OVERLAP_RATE:${pair[1]}>${pair[2]}` : ai ? `AI_SHARE:${ai[1].trim()}` : CONFIG_KO[raw] ?? raw;
        r[ki] = key;
        if (vi >= 0 && (PCT_CONFIG.has(key) || pair || ai)) r[vi] = pct(r[vi]);
        if (vi >= 0 && key === 'WORK_WEEKDAYS') r[vi] = weekdayBits(r[vi]);
      }
    }
    // 리소스: "분류" 칸 → 옛 구조의 GROUP 행 + 부모 ID
    if (spec.key === '02_Resource_Master') {
      const gi = cols.findIndex(c => c.key === 'GROUP_NAME');
      if (gi >= 0) {
        const head2 = [...cols.map(c => c.key), 'RESOURCE_LEVEL', 'PARENT_RESOURCE_ID'];
        const groups: string[] = [];
        const gid = (i: number) => `G${String(i + 1).padStart(2, '0')}`;
        const idx = (k: string) => cols.findIndex(c => c.key === k);
        const resRows = fixed.map(r => {
          const g = String(r[gi] ?? '').trim();
          if (g && !groups.includes(g)) groups.push(g);
          return [...r, 'ITEM', g ? gid(groups.indexOf(g)) : null];
        });
        const groupRows = groups.map((g, i) => {
          const row: Cell[] = head2.map(() => null);
          row[idx('RESOURCE_ID')] = gid(i);
          row[idx('RESOURCE_NAME')] = g;
          if (idx('SORT_ORDER') >= 0) row[idx('SORT_ORDER')] = i + 1;
          row[head2.length - 2] = 'GROUP';
          return row;
        });
        out[spec.key] = [head2, ...groupRows, ...resRows];
        continue;
      }
    }
    out[spec.key] = [cols.map(c => c.key), ...fixed];
  }
  return out;
}

/** 한글 양식으로 만든 파일인가(시트 이름이 한글이거나 머리글이 한글). 옛 도구 전용 보고 문구를 줄이는 데 쓴다 */
export function isTemplateBook(sheets: Sheets): boolean {
  return Object.entries(sheets).some(([name, rows]) => {
    const byKo = IMPORT_SPEC.find(sp => squash(sp.ko) === squash(name.replace(/^\d+[_\s.-]*/, '')) || squash(sp.ko) === squash(name));
    if (byKo) return true;
    const byKey = IMPORT_SPEC.find(sp => sp.key === name);
    return !!byKey && (rows[0] ?? []).some(h => byKey.columns.some(c => squash(c.ko) === squash(h)));
  });
}

/** 빠진 필수 시트를 한글 이름으로 */
export function missingSheetNames(keys: string[]): string[] {
  return keys.map(k => IMPORT_SPEC.find(s => s.key === k)?.ko ?? k);
}

// ───────── 양식 파일 ─────────
type Book = Record<string, (WCell | StyledCell)[][]>;

const ym = (base: Date, add: number) => {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + add, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const day = (base: Date, addMonths: number, dayOfMonth: number | 'last') => {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + addMonths + (dayOfMonth === 'last' ? 1 : 0), dayOfMonth === 'last' ? 0 : dayOfMonth));
  return d.toISOString().slice(0, 10);
};

/** 예시 데이터(파트 3 · 리소스 4 · 업데이트 2). 날짜는 만드는 날 기준 다음 달부터 */
function exampleRows(now: Date): Record<string, Cell[][]> {
  const months = Array.from({ length: 15 }, (_, i) => ym(now, i + 1));
  const heads: Record<string, number> = { ART: 3, MODEL: 4, ANIM: 2 };
  return {
    '00_Config': [['프로젝트 이름', '예시 프로젝트'], ['여유율', '10%'], ['기본 겹침률', '20%'], ['기본 가동률', '80%'], ['근무 요일', '월화수목금'], ['AI 활용:ART', '50%']],
    '01_Part_Master': [['ART', '원화', 1, 'Y'], ['MODEL', '모델링', 2, 'Y'], ['ANIM', '애니메이션', 3, 'Y']],
    '02_Resource_Master': [['CHAR_NEW', '신규 캐릭터', '캐릭터', 1, 'Y'], ['COSTUME', '코스튬', '캐릭터', 2, 'Y'], ['BG_MAP', '배경 맵', '배경', 3, 'Y'], ['ICON', '아이콘', 'UI', 4, 'Y']],
    '03_Effort_Standard': [
      ['CHAR_NEW', 'ART', 5, 3.5, null], ['CHAR_NEW', 'MODEL', 10, 8, '10%'], ['CHAR_NEW', 'ANIM', 8, null, null],
      ['COSTUME', 'ART', 3, 2, null], ['COSTUME', 'MODEL', 5, 4, null],
      ['BG_MAP', 'ART', 8, 5, null], ['BG_MAP', 'MODEL', 15, 12, null],
      ['ICON', 'ART', 0.5, 0.3, null],
    ],
    '05_Update_Type': [['LAUNCH', '런칭', 'Y', 1, 'Y'], ['SEASON', '시즌', 'N', 2, 'Y']],
    '06_Update_Volume_Template': [['SEASON', 'CHAR_NEW', 2, 3, 4], ['SEASON', 'COSTUME', 4, 6, 8], ['SEASON', 'BG_MAP', 1, 1, 2], ['SEASON', 'ICON', 10, 20, 30]],
    '10_Update_Master': [
      ['LAUNCH', '런칭', 'LAUNCH', day(now, 1, 1), day(now, 7, 'last'), day(now, 8, 'last'), '높음', '계획', null],
      ['S1', '시즌 1', 'SEASON', day(now, 6, 1), day(now, 10, 15), day(now, 10, 'last'), '보통', '계획', '런칭 다음 시즌'],
    ],
    '11_Update_Volume': [
      ['LAUNCH', 'CHAR_NEW', 8, 10, 12, 0, 1, '필수', 1, null, null], ['LAUNCH', 'COSTUME', 10, 15, 20, 0, 1, '필수', 1, null, null],
      ['LAUNCH', 'BG_MAP', 3, 4, 5, 0, 1, '필수', 1, null, null], ['LAUNCH', 'ICON', 60, 80, 100, 20, 2, '선택', 1, '20%', '기존 아이콘 일부 재사용'],
      ['S1', 'CHAR_NEW', 2, 3, 4, 0, 1, '필수', 1, null, null], ['S1', 'COSTUME', 4, 6, 8, 0, 1, '필수', 1, null, null],
    ],
    '12_Capacity_Monthly': months.flatMap(m => Object.entries(heads).map(([p, h]) => [m, p, p === 'MODEL' && m >= months[4] ? h + 1 : h, '80%', 1, 0, 0, null] as Cell[])),
    '13_Progress_Actual': [['LAUNCH', 'CHAR_NEW', 'ART', 2, 9, day(now, 1, 20)]],
  };
}

/** 양식 파일 시트(안내 + 데이터 시트). example = 예시 데이터를 채운다 */
export function templateBook(options: {
  example?: boolean; now?: Date;
  /** 지금 프로젝트를 내보낼 때: 시트 키(01_Part_Master …) → 규격 칸 순서의 행 */
  data?: Record<string, Cell[][]>; source?: string;
} = {}): { sheets: Book; freezeRows: Record<string, number> } {
  const now = options.now ?? new Date();
  const ex = options.data ?? (options.example ? exampleRows(now) : {});
  const sheets: Book = {};
  const freezeRows: Record<string, number> = { '안내': 0 };
  const guide: (Cell | StyledCell)[][] = [
    [{ v: 'ARP 가져오기 양식', s: 'title' }],
    [options.data ? `프로젝트 "${options.source ?? ''}"에서 내보낸 양식입니다(${now.toISOString().slice(0, 10)}). 엑셀에서 수정한 뒤 다시 가져오면 새 프로젝트 파일이 됩니다. 시나리오 · 변경 이력은 들어 있지 않습니다.`
      : options.example ? '예시 데이터가 들어 있는 양식입니다. 값을 바꿔 그대로 가져올 수 있습니다.' : '빈 양식입니다. 시트마다 3행부터 데이터를 입력합니다.'],
    [],
    [{ v: '사용 방법', s: 'sub' }],
    ['1. 필수 시트(파트 · 리소스 · 공수 · 업데이트 · 물량 · 인력)를 채웁니다. 선택 시트는 비워 둬도 됩니다.'],
    ['2. 색이 진한 머리글은 필수 칸입니다. 시트 이름과 머리글은 바꾸지 않습니다(열 순서는 바꿔도 됩니다).'],
    ['3. 2행(※로 시작하는 회색 줄)은 설명이라 가져올 때 읽지 않습니다. 지워도 됩니다.'],
    ['4. 앱 시작 화면 → "엑셀로 가져오기" → 채운 파일을 선택합니다. 가져온 뒤 바꾼 값 · 건너뛴 행을 보고서로 확인합니다.'],
    [],
    [{ v: '공통 규칙', s: 'sub' }],
    ['· ID는 시트 사이를 잇는 값입니다(영문 · 숫자 · 밑줄). 이름은 화면에 표시할 글자입니다.'],
    ['· 날짜는 엑셀 날짜 또는 2027-03-15 · 2027.03.15 형식, 달은 2027-03 형식입니다.'],
    ['· 비율은 0.8 또는 80%로 입력합니다. 사용 여부는 Y/N(또는 O/X)이며 비우면 사용입니다.'],
    ['· 옛 도구(구글 시트)에서 내려받은 파일(01_Part_Master 등 영문 시트)도 그대로 가져올 수 있습니다.'],
    [],
    [{ v: '시트', s: 'sub' }, { v: '칸', s: 'sub' }, { v: '필수', s: 'sub' }, { v: '형식', s: 'sub' }, { v: '설명', s: 'sub' }],
  ];
  for (const sp of IMPORT_SPEC) {
    guide.push([`${sp.ko}${sp.required ? ' (필수 시트)' : ' (선택 시트)'}`, '', '', '', sp.desc]);
    for (const c of sp.columns) guide.push(['', c.ko, c.required ? '필수' : '', c.format, c.desc]);
  }
  sheets['안내'] = guide;
  for (const sp of IMPORT_SPEC) {
    const head: StyledCell[] = sp.columns.map(c => ({ v: c.required ? `${c.ko} *` : c.ko, s: c.required ? 'req' : 'opt' }));
    const note: StyledCell[] = sp.columns.map((c, i) => ({ v: `${i === 0 ? '※ ' : ''}${[c.format, c.desc].filter(Boolean).join(' · ')}`, s: 'note' }));
    const rows: Cell[][] = (ex[sp.key] ?? (sp.key === '00_Config' && !options.data ? [['프로젝트 이름', ''], ['여유율', '0%'], ['기본 겹침률', '20%'], ['기본 가동률', '80%'], ['근무 요일', '월화수목금']] : []));
    sheets[sp.ko] = [head, note, ...rows];
    freezeRows[sp.ko] = 2;
  }
  return { sheets, freezeRows };
}

/** 화면 요약 표용 */
export function specSummary(): { name: string; required: boolean; desc: string; columns: string[] }[] {
  return IMPORT_SPEC.map(s => ({ name: s.ko, required: s.required, desc: s.desc, columns: s.columns.filter(c => c.required).map(c => c.ko) }));
}
