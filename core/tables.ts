// 표 목록 한 곳(docs/25-maintenance-review.md B). 새 표를 더하면 migrate.ts 단계와 함께 여기에만 적는다.
// 이 목록을 읽는 곳: 변경 이력 · 되돌리기(history.ts), 예시 파일 만들기 순서(tools/lib/project-db.mjs),
// 옛 구조(v1) 시험 파일(tools/build-samples.mjs). test/tables.test.mjs가 실제 구조와 어긋나면 실패한다.

export interface TableInfo {
  /** 표 이름 */
  name: string;
  /** 변경 이력에 보이는 이름 */
  label: string;
  /** 되돌리기에서 행을 찾는 키 칸(target_key = 이 칸 값들을 '|'로 이은 것). null = 행 단위 되돌리기 대상 아님 */
  keys: string[] | null;
  /** 이 표가 생긴 파일 구조 버전(migrate.ts) */
  since: number;
  /** 부모 행을 지울 때 이력에 함께 남기는 딸린 행이면 그 이름(old_json 안의 키) */
  childKey?: string;
  /** 예시 파일을 만들 때 넣는 표인가(썸네일 · 이력처럼 만들지 않는 표는 false) */
  sample?: boolean;
}

/** 외래 키 순서(부모가 먼저). 예시 파일에 넣는 순서이자 딸린 행을 다시 넣는 순서 */
export const TABLES: TableInfo[] = [
  { name: 'meta', label: '프로젝트', keys: ['key'], since: 1, sample: true },
  { name: 'settings', label: '설정', keys: null, since: 1, sample: true },
  { name: 'holidays', label: '휴일', keys: ['date'], since: 1, sample: true },
  { name: 'parts', label: '파트', keys: ['part_id'], since: 1, sample: true },
  { name: 'part_overlaps', label: '겹침률', keys: ['from_part_id', 'to_part_id'], since: 1, childKey: 'part_overlaps', sample: true },
  { name: 'resource_groups', label: '분류', keys: ['group_id'], since: 1, sample: true },
  { name: 'resource_types', label: '리소스', keys: ['resource_type_id'], since: 1, sample: true },
  { name: 'resource_parts', label: '거치는 파트', keys: ['resource_type_id', 'part_id'], since: 1, childKey: 'resource_parts', sample: true },
  { name: 'effort_profiles', label: '공수 프로필', keys: ['profile_id'], since: 1, sample: true },
  { name: 'efforts', label: '공수', keys: ['resource_type_id', 'part_id', 'profile_id'], since: 1, childKey: 'efforts', sample: true },
  { name: 'effort_mix', label: 'AI 비율', keys: ['part_id', 'profile_id'], since: 1, childKey: 'effort_mix', sample: true },
  { name: 'update_types', label: '유형', keys: ['update_type_id'], since: 1, sample: true },
  { name: 'type_templates', label: '템플릿', keys: ['update_type_id', 'resource_type_id'], since: 1, childKey: 'template', sample: true },
  { name: 'updates', label: '업데이트', keys: ['update_id'], since: 1, sample: true },
  { name: 'volumes', label: '물량', keys: ['update_id', 'resource_type_id'], since: 1, childKey: 'volumes', sample: true },
  { name: 'progress', label: '작업 진척', keys: ['update_id', 'resource_type_id', 'part_id'], since: 1, childKey: 'progress', sample: true },
  { name: 'capacity', label: '인력', keys: ['part_id', 'month'], since: 1, childKey: 'capacity', sample: true },
  { name: 'scenarios', label: '시나리오', keys: null, since: 1, sample: true },
  { name: 'scenario_changes', label: '시나리오 변경', keys: null, since: 1, sample: true },
  { name: 'batches', label: '배치', keys: ['batch_id'], since: 4, sample: true },
  { name: 'assets', label: '에셋', keys: ['asset_id'], since: 4, sample: true },
  { name: 'asset_parts', label: '에셋 상태', keys: ['asset_id', 'part_id'], since: 4, childKey: 'asset_parts', sample: true },
  { name: 'asset_thumbs', label: '썸네일', keys: null, since: 4 },
  { name: 'asset_links', label: '에셋 링크', keys: ['link_id'], since: 5, childKey: 'asset_links', sample: true },
  { name: 'asset_comments', label: '에셋 댓글', keys: ['comment_id'], since: 5, childKey: 'asset_comments', sample: true },
  { name: 'asset_attrs', label: '에셋 속성', keys: ['asset_id', 'name'], since: 6, childKey: 'asset_attrs', sample: true },
  { name: 'people', label: '작업자', keys: ['person_id'], since: 7, sample: true },
  { name: 'news', label: '소식', keys: ['news_id'], since: 8, sample: true },
  { name: 'teams', label: '지원 팀', keys: ['team_id'], since: 9, sample: true },
  { name: 'change_log', label: '변경 이력', keys: null, since: 1, sample: true },
];

/** v1 뒤에 기존 표에 더한 칸(옛 구조 시험 파일을 만들 때 뺀다). 새 칸을 더하면 여기에도 적는다 */
export const ADDED_COLUMNS: { table: string; column: string; since: number }[] = [
  { table: 'scenario_changes', column: 'group_no', since: 2 },
  { table: 'scenario_changes', column: 'label', since: 2 },
  { table: 'scenarios', column: 'applied_at', since: 2 },
  { table: 'progress', column: 'spent_days', since: 3 },
];

export const tableKeys = (): Record<string, string[]> => Object.fromEntries(TABLES.filter(t => t.keys).map(t => [t.name, t.keys!]));
export const tableLabels = (): Record<string, string> => Object.fromEntries(TABLES.map(t => [t.name, t.label]));
/** 딸린 행: [old_json 키, 표] — 외래 키 순서 */
export const childTables = (): [string, string][] => TABLES.filter(t => t.childKey).map(t => [t.childKey!, t.name]);
export const sampleOrder = (): string[] => TABLES.filter(t => t.sample).map(t => t.name);
/** 옛 구조(v1)로 되돌리는 SQL: 나중에 생긴 표(자식부터) · 칸을 지우고 버전 1로 */
export function downgradeToV1Sql(): string {
  const tables = TABLES.filter(t => t.since > 1).reverse().map(t => `DROP TABLE ${t.name};`);
  const cols = ADDED_COLUMNS.map(c => `ALTER TABLE ${c.table} DROP COLUMN ${c.column};`);
  return [...tables, ...cols, 'PRAGMA user_version = 1;'].join(' ');
}
