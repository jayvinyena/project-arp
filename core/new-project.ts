// 새 프로젝트 만들기: 마법사 입력 → 검사 → 표 행 → 새 SQLite 파일. Node와 브라우저(Worker)가 같이 쓴다.
import type { SqlDb } from './db.ts';
import { migrate } from './migrate.ts';

export interface NewPart { name: string; headcount: number; utilization: number }
export interface NewResource { group: string; name: string; /** 파트 순서대로 1개당 공수(인·일). null = 거치지 않음 */ efforts: (number | null)[] }
export interface NewProjectInput {
  name: string;
  horizonStart: string; // YYYY-MM
  horizonEnd: string;   // YYYY-MM
  workWeekdays: string; // 월~일 7자리 0/1
  bufferRate: number;   // 0~1
  holidays: { date: string; name: string; kind: 'PUBLIC' | 'COMPANY' }[];
  parts: NewPart[];
  resources: NewResource[];
  launch: { name: string; startDate: string; freezeDate: string | null; releaseDate: string } | null;
  createdAt?: string;
  appVersion?: string;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** 날짜가 고정된 한국 공휴일(설·추석·대체 휴일은 날짜가 해마다 달라 직접 넣는다) */
export function fixedKoreanHolidays(startMonth: string, endMonth: string): NewProjectInput['holidays'] {
  const fixed: [string, string][] = [
    ['01-01', '신정'], ['03-01', '삼일절'], ['05-05', '어린이날'], ['06-06', '현충일'],
    ['08-15', '광복절'], ['10-03', '개천절'], ['10-09', '한글날'], ['12-25', '성탄절'],
  ];
  const startYear = Number(startMonth.slice(0, 4));
  const endYear = Number(endMonth.slice(0, 4));
  const out: NewProjectInput['holidays'] = [];
  for (let y = startYear; y <= endYear; y += 1) {
    for (const [md, name] of fixed) {
      const date = `${y}-${md}`;
      if (date.slice(0, 7) >= startMonth && date.slice(0, 7) <= endMonth) out.push({ date, name, kind: 'PUBLIC' });
    }
  }
  return out;
}

/** 마법사 기본값: 게임 아트에서 흔한 구성 */
export function defaultNewProject(today = new Date()): NewProjectInput {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const next = (add: number) => {
    const t = new Date(Date.UTC(y, m - 1 + add, 1));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const start = next(1);
  const end = next(24);
  const launchMonth = next(9);
  const lastDay = (ym: string) => {
    const [yy, mm] = ym.split('-').map(Number);
    return `${ym}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`;
  };
  return {
    name: '새 프로젝트',
    horizonStart: start,
    horizonEnd: end,
    workWeekdays: '1111100',
    bufferRate: 0.1,
    holidays: fixedKoreanHolidays(start, end),
    parts: [
      { name: '원화', headcount: 3, utilization: 0.8 },
      { name: '모델링', headcount: 4, utilization: 0.8 },
      { name: '애니메이션', headcount: 2, utilization: 0.8 },
      { name: 'FX', headcount: 1, utilization: 0.8 },
    ],
    resources: [
      { group: '캐릭터', name: '신규 캐릭터', efforts: [5, 10, 8, 3] },
      { group: '캐릭터', name: '코스튬', efforts: [3, 5, 2, null] },
      { group: '배경', name: '배경 맵', efforts: [8, 15, null, null] },
      { group: '배경', name: '프랍', efforts: [1, 2, null, null] },
      { group: 'UI · 이펙트', name: '아이콘', efforts: [0.5, null, null, null] },
      { group: 'UI · 이펙트', name: '이펙트', efforts: [null, null, null, 2] },
    ],
    launch: { name: '런칭', startDate: `${start}-01`, freezeDate: lastDay(next(8)), releaseDate: lastDay(launchMonth) },
  };
}

export interface InputProblem { step: 'basic' | 'parts' | 'resources' | 'launch'; message: string }

/** 사람이 고칠 수 있는 말로 문제를 돌려준다. 빈 배열이면 만들 수 있다 */
export function checkNewProject(input: NewProjectInput): InputProblem[] {
  const p: InputProblem[] = [];
  const add = (step: InputProblem['step'], message: string) => p.push({ step, message });
  if (!input.name.trim()) add('basic', '프로젝트 이름을 입력하십시오.');
  if (!MONTH.test(input.horizonStart) || !MONTH.test(input.horizonEnd)) add('basic', '계획 기간의 시작·끝 달을 선택하십시오.');
  else {
    const n = monthsBetween(input.horizonStart, input.horizonEnd).length;
    if (input.horizonEnd < input.horizonStart) add('basic', '계획 기간 끝 달이 시작 달보다 앞입니다.');
    else if (n > 60) add('basic', `계획 기간이 ${n}개월입니다. 60개월 이하로 줄이십시오.`);
  }
  if (!/^[01]{7}$/.test(input.workWeekdays) || input.workWeekdays === '0000000') add('basic', '근무 요일을 하루 이상 선택하십시오.');
  if (!(input.bufferRate >= 0 && input.bufferRate <= 1)) add('basic', '여유율은 0–100% 사이로 입력하십시오.');
  for (const h of input.holidays) if (!validDate(h.date)) add('basic', `휴일 날짜가 올바르지 않습니다: ${h.date}`);

  if (input.parts.length === 0) add('parts', '파트를 하나 이상 입력하십시오.');
  const partNames = new Set<string>();
  input.parts.forEach((part, i) => {
    const name = part.name.trim();
    if (!name) add('parts', `${i + 1}번째 파트 이름이 비었습니다.`);
    else if (partNames.has(name)) add('parts', `파트 이름 "${name}"이 겹칩니다.`);
    partNames.add(name);
    if (!(part.headcount >= 0)) add('parts', `${name || `${i + 1}번째 파트`}의 인원을 0 이상으로 입력하십시오.`);
    if (!(part.utilization > 0 && part.utilization <= 1)) add('parts', `${name || `${i + 1}번째 파트`}의 가동률은 1–100% 사이로 입력하십시오.`);
  });

  if (input.resources.length === 0) add('resources', '리소스 종류를 하나 이상 입력하십시오.');
  const resNames = new Set<string>();
  input.resources.forEach((r, i) => {
    const name = r.name.trim();
    const label = name || `${i + 1}번째 리소스`;
    if (!name) add('resources', `${i + 1}번째 리소스 이름이 비었습니다.`);
    else if (resNames.has(name)) add('resources', `리소스 이름 "${name}"이 겹칩니다.`);
    resNames.add(name);
    if (r.efforts.length !== input.parts.length) add('resources', `${label}의 파트별 공수 칸 수가 파트 수와 다릅니다.`);
    const used = r.efforts.filter(e => e != null);
    if (used.length === 0) add('resources', `${label}이 거치는 파트가 없습니다. 한 파트 이상 공수를 입력하십시오.`);
    if (used.some(e => !(Number(e) > 0))) add('resources', `${label}의 공수는 0보다 커야 합니다. 거치지 않는 파트는 비워 두십시오.`);
  });

  if (input.launch) {
    const l = input.launch;
    if (!l.name.trim()) add('launch', '런칭 이름을 입력하십시오.');
    if (!validDate(l.startDate)) add('launch', '작업 시작일을 선택하십시오.');
    if (!validDate(l.releaseDate)) add('launch', '출시일을 선택하십시오.');
    if (l.freezeDate && !validDate(l.freezeDate)) add('launch', '제작 완료 목표일이 올바르지 않습니다.');
    if (validDate(l.startDate) && validDate(l.releaseDate) && l.releaseDate < l.startDate) add('launch', '출시일이 작업 시작일보다 앞입니다.');
    if (l.freezeDate && validDate(l.freezeDate) && validDate(l.startDate) && l.freezeDate < l.startDate) add('launch', '제작 완료 목표일이 작업 시작일보다 앞입니다.');
    if (l.freezeDate && validDate(l.freezeDate) && validDate(l.releaseDate) && l.freezeDate > l.releaseDate) add('launch', '제작 완료 목표일이 출시일보다 뒤입니다.');
    if (validDate(l.releaseDate) && MONTH.test(input.horizonEnd) && l.releaseDate.slice(0, 7) > input.horizonEnd) add('launch', '출시일이 계획 기간 뒤입니다. 계획 기간을 늘리십시오.');
  }
  return p;
}

type Rows = Record<string, Record<string, unknown>[]>;
const code = (prefix: string, i: number, width = 2) => `${prefix}${String(i + 1).padStart(width, '0')}`;

/** 입력 → 표 행. ID는 순서대로 만든다(P01, G01, R001). 이름은 나중에 바꿔도 ID는 그대로다 */
export function newProjectRows(input: NewProjectInput): Rows {
  const months = monthsBetween(input.horizonStart, input.horizonEnd);
  const partIds = input.parts.map((_, i) => code('P', i));
  const groupNames = [...new Set(input.resources.map(r => r.group.trim() || '분류 없음'))];
  const groupId = new Map(groupNames.map((g, i) => [g, code('G', i)]));
  const resIds = input.resources.map((_, i) => code('R', i, 3));
  const rows: Rows = {
    meta: [
      { key: 'project_name', value: input.name.trim() },
      { key: 'created_at', value: input.createdAt ?? new Date().toISOString() },
      { key: 'data_version', value: '1' },
      { key: 'saved_by_app', value: input.appVersion ?? 'arp-next' },
    ],
    settings: [{
      id: 1, horizon_start_month: input.horizonStart, horizon_end_month: input.horizonEnd, work_weekdays: input.workWeekdays,
      buffer_rate: input.bufferRate, default_overlap_rate: 0, load_warn_rate: 0.8, load_over_rate: 1, load_critical_rate: 1.2,
      late_warn_workdays: 10, default_plan_mode: 'TARGET',
    }],
    holidays: [...new Map(input.holidays.map(h => [h.date, h])).values()].map(h => ({ date: h.date, name: h.name, kind: h.kind })),
    parts: input.parts.map((p, i) => ({ part_id: partIds[i], name: p.name.trim(), sort_order: i + 1, active: 1 })),
    part_overlaps: [],
    resource_groups: groupNames.map((g, i) => ({ group_id: groupId.get(g), name: g, sort_order: i + 1 })),
    resource_types: input.resources.map((r, i) => ({
      resource_type_id: resIds[i], group_id: groupId.get(r.group.trim() || '분류 없음'), name: r.name.trim(), sort_order: i + 1, active: 1,
    })),
    resource_parts: [],
    effort_profiles: [{ profile_id: 'BASE', name: '기본', sort_order: 1 }],
    efforts: [],
    update_types: [
      { update_type_id: 'LAUNCH', name: '런칭', is_launch: 1, sort_order: 1, active: 1 },
      { update_type_id: 'UPDATE', name: '업데이트', is_launch: 0, sort_order: 2, active: 1 },
    ],
    updates: [],
    volumes: [],
    capacity: input.parts.flatMap((p, i) => months.map(month => ({
      part_id: partIds[i], month, headcount: p.headcount, utilization: p.utilization, productivity: 1, outsource_days: 0, support_days: 0,
    }))),
  };
  input.resources.forEach((r, ri) => {
    r.efforts.forEach((days, pi) => {
      if (days == null) return;
      rows.resource_parts.push({ resource_type_id: resIds[ri], part_id: partIds[pi], rework_rate: 0 });
      rows.efforts.push({ resource_type_id: resIds[ri], part_id: partIds[pi], profile_id: 'BASE', days });
    });
  });
  if (input.launch) {
    rows.updates.push({
      update_id: 'LAUNCH', name: input.launch.name.trim(), update_type_id: 'LAUNCH',
      start_date: input.launch.startDate, freeze_date: input.launch.freezeDate || null, release_date: input.launch.releaseDate,
      priority: 1, status: 'PLANNED', sort_order: 1, note: null,
    });
    rows.volumes = resIds.map(id => ({ update_id: 'LAUNCH', resource_type_id: id, min_qty: 0, target_qty: 0, stretch_qty: 0 }));
  }
  return rows;
}

// 참조 순서대로 넣어야 외래 키가 통과한다
const ORDER = [
  'meta', 'settings', 'holidays', 'parts', 'part_overlaps', 'resource_groups', 'resource_types', 'resource_parts',
  'effort_profiles', 'efforts', 'update_types', 'updates', 'volumes', 'capacity',
];

/** 빈 DB에 구조를 만들고 행을 넣는다 */
export function writeNewProject(db: SqlDb, schemaSql: string, input: NewProjectInput): void {
  const problems = checkNewProject(input);
  if (problems.length) throw new Error(problems.map(x => x.message).join(' '));
  const rows = newProjectRows(input);
  db.exec(schemaSql);
  migrate(db);
  db.exec('BEGIN');
  try {
    for (const table of ORDER) {
      for (const row of rows[table] ?? []) {
        const cols = Object.keys(row);
        db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c]));
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
