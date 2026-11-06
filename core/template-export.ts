// 지금 프로젝트 → 가져오기 양식(편집용 엑셀). 엑셀에서 대량으로 고친 뒤 "엑셀로 가져오기"로 다시 가져오면 같은 계산이 나온다.
// 양식에 담지 않는 것: 시나리오 · 변경 이력 · 편집 중 표시(파일 안의 기록이라 엑셀로 옮기지 않는다)
import type { SqlDb } from './db.ts';
import type { Cell } from './xlsx.ts';
import { IMPORT_SPEC, templateBook, weekdayText } from './import-spec.ts';
import { readModeNames } from './modes.ts';

type Obj = Record<string, Cell | undefined>;
const pctText = (x: unknown) => (x == null ? null : `${Number((Number(x) * 100).toFixed(4))}%`);
const yn = (x: unknown) => (Number(x) ? 'Y' : 'N');
const num = (x: unknown): Cell => (x == null ? null : Number(x));
const STATUS_KO: Record<string, string> = { PLANNED: '계획', IN_PROGRESS: '진행', DONE: '완료', CANCELLED: '취소' };

/** 시트 키 → 규격 칸 순서의 행 */
function toRows(key: string, objs: Obj[]): Cell[][] {
  const spec = IMPORT_SPEC.find(s => s.key === key)!;
  return objs.map(o => spec.columns.map(c => (o[c.key] === undefined ? null : o[c.key]!)));
}

export function projectData(db: SqlDb): { data: Record<string, Cell[][]>; projectName: string } {
  const meta = Object.fromEntries(db.all('SELECT key, value FROM meta').map(r => [String(r.key), r.value == null ? '' : String(r.value)]));
  const st = db.get('SELECT * FROM settings WHERE id = 1') ?? {};
  const modes = readModeNames(db);
  const groups = new Map(db.all('SELECT group_id, name FROM resource_groups').map(r => [String(r.group_id), String(r.name)]));
  const config: Obj[] = [
    { CONFIG_KEY: '프로젝트 이름', CONFIG_VALUE: meta.project_name ?? '' },
    { CONFIG_KEY: '여유율', CONFIG_VALUE: pctText(st.buffer_rate ?? 0) },
    { CONFIG_KEY: '기본 겹침률', CONFIG_VALUE: pctText(st.default_overlap_rate ?? 0) },
    { CONFIG_KEY: '근무 요일', CONFIG_VALUE: weekdayText(String(st.work_weekdays ?? '1111100')) },
    { CONFIG_KEY: '계획 시작 달', CONFIG_VALUE: String(st.horizon_start_month ?? '') },
    { CONFIG_KEY: '계획 끝 달', CONFIG_VALUE: String(st.horizon_end_month ?? '') },
    ...(db.get('SELECT 1 AS x FROM holidays LIMIT 1') ? [] : [{ CONFIG_KEY: '공휴일 자동 넣기', CONFIG_VALUE: 'N' }]),
    { CONFIG_KEY: '템플릿1 이름', CONFIG_VALUE: modes.MIN },
    { CONFIG_KEY: '템플릿2 이름', CONFIG_VALUE: modes.TARGET },
    { CONFIG_KEY: '템플릿3 이름', CONFIG_VALUE: modes.STRETCH },
    ...db.all('SELECT from_part_id, to_part_id, overlap_rate FROM part_overlaps ORDER BY from_part_id, to_part_id')
      .map(r => ({ CONFIG_KEY: `겹침률:${r.from_part_id}>${r.to_part_id}`, CONFIG_VALUE: pctText(r.overlap_rate) })),
    ...db.all("SELECT part_id, share FROM effort_mix WHERE profile_id = 'AI' AND share > 0 ORDER BY part_id")
      .map(r => ({ CONFIG_KEY: `AI 활용:${r.part_id}`, CONFIG_VALUE: pctText(r.share) })),
  ];
  const data: Record<string, Cell[][]> = {
    '00_Config': toRows('00_Config', config),
    '01_Part_Master': toRows('01_Part_Master', db.all('SELECT * FROM parts ORDER BY sort_order, part_id')
      .map(r => ({ PART_ID: String(r.part_id), PART_NAME: String(r.name), SORT_ORDER: num(r.sort_order), ACTIVE: yn(r.active) }))),
    '02_Resource_Master': toRows('02_Resource_Master', db.all(`SELECT t.* FROM resource_types t LEFT JOIN resource_groups g ON g.group_id = t.group_id
        ORDER BY COALESCE(g.sort_order, 1e9), t.sort_order, t.resource_type_id`)
      .map(r => ({ RESOURCE_ID: String(r.resource_type_id), RESOURCE_NAME: String(r.name), GROUP_NAME: r.group_id ? groups.get(String(r.group_id)) ?? null : null, SORT_ORDER: num(r.sort_order), ACTIVE: yn(r.active) }))),
    '03_Effort_Standard': toRows('03_Effort_Standard', db.all(`SELECT rp.resource_type_id, rp.part_id, rp.rework_rate,
        (SELECT days FROM efforts e WHERE e.resource_type_id = rp.resource_type_id AND e.part_id = rp.part_id AND e.profile_id = 'BASE') AS base,
        (SELECT days FROM efforts e WHERE e.resource_type_id = rp.resource_type_id AND e.part_id = rp.part_id AND e.profile_id = 'AI') AS ai
        FROM resource_parts rp JOIN resource_types t ON t.resource_type_id = rp.resource_type_id JOIN parts p ON p.part_id = rp.part_id
        ORDER BY t.sort_order, p.sort_order`)
      .map(r => ({ RESOURCE_ID: String(r.resource_type_id), PART_ID: String(r.part_id), BASE_DAYS: num(r.base), AI_ASSISTED_DAYS: num(r.ai), DEFAULT_REWORK_RATE: Number(r.rework_rate) ? pctText(r.rework_rate) : null }))),
    '05_Update_Type': toRows('05_Update_Type', db.all('SELECT * FROM update_types ORDER BY sort_order, update_type_id')
      .map(r => ({ UPDATE_TYPE_ID: String(r.update_type_id), UPDATE_TYPE_NAME: String(r.name), IS_LAUNCH: yn(r.is_launch), SORT_ORDER: num(r.sort_order), ACTIVE: yn(r.active) }))),
    '06_Update_Volume_Template': toRows('06_Update_Volume_Template', db.all(`SELECT tt.* FROM type_templates tt JOIN update_types u ON u.update_type_id = tt.update_type_id
        JOIN resource_types t ON t.resource_type_id = tt.resource_type_id ORDER BY u.sort_order, t.sort_order`)
      .map(r => ({ UPDATE_TYPE_ID: String(r.update_type_id), RESOURCE_ID: String(r.resource_type_id), MIN_QTY: num(r.min_qty), TARGET_QTY: num(r.target_qty), STRETCH_QTY: num(r.stretch_qty) }))),
    '10_Update_Master': toRows('10_Update_Master', db.all('SELECT * FROM updates ORDER BY sort_order, update_id')
      .map(r => ({
        UPDATE_ID: String(r.update_id), UPDATE_NAME: String(r.name), UPDATE_TYPE_ID: String(r.update_type_id),
        PLAN_START_DATE: (r.start_date as string) ?? null, CONTENT_FREEZE_DATE: (r.freeze_date as string) ?? null, RELEASE_DATE: (r.release_date as string) ?? null,
        PRIORITY: num(r.priority), STATUS: STATUS_KO[String(r.status)] ?? '계획', DESCRIPTION: (r.note as string) ?? null,
      }))),
    '11_Update_Volume': toRows('11_Update_Volume', db.all(`SELECT v.* FROM volumes v JOIN updates u ON u.update_id = v.update_id
        JOIN resource_types t ON t.resource_type_id = v.resource_type_id ORDER BY u.sort_order, t.sort_order`)
      .map(r => ({
        UPDATE_ID: String(r.update_id), RESOURCE_ID: String(r.resource_type_id), MIN_QTY: num(r.min_qty), TARGET_QTY: num(r.target_qty), STRETCH_QTY: num(r.stretch_qty),
        OUTSOURCE_QTY: num(r.outsource_qty), PRIORITY: num(r.priority), REQUIRED_LEVEL: Number(r.required) ? '필수' : '선택',
        DIFFICULTY_FACTOR: num(r.difficulty), REUSE_RATE: Number(r.reuse_rate) ? pctText(r.reuse_rate) : null, CHANGE_REASON: (r.note as string) ?? null,
      }))),
    '12_Capacity_Monthly': toRows('12_Capacity_Monthly', db.all('SELECT c.* FROM capacity c JOIN parts p ON p.part_id = c.part_id ORDER BY c.month, p.sort_order')
      .map(r => ({
        YEAR_MONTH: String(r.month), PART_ID: String(r.part_id), HEADCOUNT: num(r.headcount), UTILIZATION_RATE: pctText(r.utilization),
        PRODUCTIVITY_FACTOR: num(r.productivity), OUTSOURCE_CAPACITY_DAYS: num(r.outsource_days), TEMP_SUPPORT_DAYS: num(r.support_days), NOTE: (r.note as string) ?? null,
      }))),
    'HOLIDAYS': toRows('HOLIDAYS', db.all('SELECT * FROM holidays ORDER BY date')
      .map(r => ({ DATE: String(r.date), NAME: String(r.name), KIND: r.kind === 'COMPANY' ? '회사 휴무일' : '공휴일' }))),
    '13_Progress_Actual': toRows('13_Progress_Actual', db.all(`SELECT a.* FROM progress a JOIN updates u ON u.update_id = a.update_id
        JOIN resource_types t ON t.resource_type_id = a.resource_type_id JOIN parts p ON p.part_id = a.part_id ORDER BY u.sort_order, t.sort_order, p.sort_order`)
      .map(r => ({ UPDATE_ID: String(r.update_id), RESOURCE_ID: String(r.resource_type_id), PART_ID: String(r.part_id), COMPLETED_QTY: num(r.completed_qty), ACTUAL_EFFORT_DAYS: num(r.spent_days), AS_OF_DATE: (r.as_of as string) ?? null }))),
  };
  return { data, projectName: meta.project_name ?? '' };
}

/** 편집용 엑셀(가져오기 양식 + 지금 값) */
export function projectTemplateBook(db: SqlDb, now = new Date()) {
  const { data, projectName } = projectData(db);
  return templateBook({ data, source: projectName, now });
}
