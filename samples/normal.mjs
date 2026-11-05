// 샘플 1 · 정상: 검증 문제 0개, 모든 파트 부하율 1 미만(목표안 기준)
// 가상의 게임 하나: 2027-06-30 런칭, 그 뒤 시즌 1 · 미니 1 · 시즌 2.
import { monthsBetween } from '../tools/lib/project-db.mjs';

export const expect = { errors: [], warnings: [] };

const HORIZON = ['2026-11', '2027-12'];

const PARTS = [
  { part_id: 'CONCEPT', name: '원화', sort_order: 1 },
  { part_id: 'MODELING', name: '모델링', sort_order: 2 },
  { part_id: 'ANIMATION', name: '애니메이션', sort_order: 3 },
  { part_id: 'FX', name: 'FX', sort_order: 4 },
];

// 리소스 종류: [ID, 이름, 분류, { 파트: [기본 공수, AI 공수 | null, 재작업률] }]
const RESOURCES = [
  ['CHAR_NEW', '신규 캐릭터', 'CHAR', { CONCEPT: [5, 3.5, 0.1], MODELING: [10, 8, 0.15], ANIMATION: [8, null, 0.1], FX: [3, null, 0.1] }],
  ['COSTUME', '코스튬', 'CHAR', { CONCEPT: [3, 2, 0.1], MODELING: [5, 4, 0.1], ANIMATION: [2, null, 0.05] }],
  ['BG_MAP', '배경 맵', 'BG', { CONCEPT: [8, 5, 0.15], MODELING: [15, 12, 0.15] }],
  ['PROP', '프랍', 'BG', { CONCEPT: [1, 0.6, 0.05], MODELING: [2, 1.6, 0.05] }],
  ['ICON', '아이콘', 'UIFX', { CONCEPT: [0.5, 0.3, 0.05] }],
  ['VFX', '이펙트', 'UIFX', { FX: [2, null, 0.1] }],
];

const SEASON_TEMPLATE = { CHAR_NEW: [2, 3, 4], COSTUME: [4, 6, 8], BG_MAP: [1, 1, 2], PROP: [10, 15, 20], ICON: [10, 20, 30], VFX: [5, 8, 10] };
const MINI_TEMPLATE = { COSTUME: [2, 3, 4], ICON: [5, 10, 15], VFX: [2, 3, 4] };

// 런칭 물량: [최저, 목표, 확장, 필수, 순위, 외주 수량]
const LAUNCH_VOLUMES = {
  CHAR_NEW: [8, 10, 12, 1, 1, 0],
  COSTUME: [10, 15, 20, 1, 2, 0],
  BG_MAP: [3, 4, 5, 1, 1, 0],
  PROP: [40, 60, 80, 1, 2, 10],
  ICON: [60, 80, 100, 1, 3, 0],
  VFX: [20, 30, 40, 0, 3, 0],
};

function templateRows(typeId, template) {
  return Object.entries(template).map(([rt, [min, target, stretch]]) => ({
    update_type_id: typeId, resource_type_id: rt, min_qty: min, target_qty: target, stretch_qty: stretch,
  }));
}

function volumesFromTemplate(updateId, template) {
  return Object.entries(template).map(([rt, [min, target, stretch]]) => ({
    update_id: updateId, resource_type_id: rt, min_qty: min, target_qty: target, stretch_qty: stretch,
  }));
}

// 파트·월 인원 (채용·충원 반영)
function headcount(part, month) {
  if (part === 'CONCEPT') return 3;
  if (part === 'MODELING') return month >= '2027-03' ? 5 : 4;
  if (part === 'ANIMATION') return 2;
  return month >= '2027-07' ? 2 : 1; // FX
}

export function build() {
  const months = monthsBetween(...HORIZON);
  return {
    meta: [
      { key: 'project_name', value: '샘플 · 정상' },
      { key: 'created_at', value: '2026-11-05T00:00:00.000Z' },
      { key: 'data_version', value: '1' },
      { key: 'saved_by_app', value: 'phase0-tools' },
    ],
    settings: [{
      id: 1, horizon_start_month: HORIZON[0], horizon_end_month: HORIZON[1], work_weekdays: '1111100',
      buffer_rate: 0.1, default_overlap_rate: 0, load_warn_rate: 0.8, load_over_rate: 1, load_critical_rate: 1.2,
      late_warn_workdays: 10, default_plan_mode: 'TARGET',
    }],
    // 예시: 날짜가 고정된 공휴일만
    holidays: [
      ['2026-12-25', '성탄절'], ['2027-01-01', '신정'], ['2027-03-01', '삼일절'], ['2027-05-05', '어린이날'],
      ['2027-06-06', '현충일'], ['2027-08-15', '광복절'], ['2027-10-03', '개천절'], ['2027-10-09', '한글날'], ['2027-12-25', '성탄절'],
    ].map(([date, name]) => ({ date, name, kind: 'PUBLIC' })).concat([{ date: '2027-04-15', name: '창립기념일(예시)', kind: 'COMPANY' }]),
    parts: PARTS.map(p => ({ ...p, active: 1 })),
    part_overlaps: [
      { from_part_id: 'CONCEPT', to_part_id: 'MODELING', overlap_rate: 0.2 },
      { from_part_id: 'MODELING', to_part_id: 'ANIMATION', overlap_rate: 0.2 },
      { from_part_id: 'ANIMATION', to_part_id: 'FX', overlap_rate: 0.3 },
    ],
    resource_groups: [
      { group_id: 'CHAR', name: '캐릭터', sort_order: 1 },
      { group_id: 'BG', name: '배경', sort_order: 2 },
      { group_id: 'UIFX', name: 'UI · 이펙트', sort_order: 3 },
    ],
    resource_types: RESOURCES.map(([id, name, group], i) => ({ resource_type_id: id, group_id: group, name, sort_order: i + 1, active: 1 })),
    resource_parts: RESOURCES.flatMap(([id, , , parts]) => Object.entries(parts).map(([part, [, , rework]]) => ({ resource_type_id: id, part_id: part, rework_rate: rework }))),
    effort_profiles: [
      { profile_id: 'BASE', name: '기본', sort_order: 1 },
      { profile_id: 'AI', name: 'AI 사용 시', sort_order: 2 },
    ],
    efforts: RESOURCES.flatMap(([id, , , parts]) => Object.entries(parts).flatMap(([part, [base, ai]]) => [
      { resource_type_id: id, part_id: part, profile_id: 'BASE', days: base },
      ...(ai == null ? [] : [{ resource_type_id: id, part_id: part, profile_id: 'AI', days: ai }]),
    ])),
    // 원화는 절반을 AI로 작업한다고 본다
    effort_mix: [
      { part_id: 'CONCEPT', profile_id: 'BASE', share: 0.5 },
      { part_id: 'CONCEPT', profile_id: 'AI', share: 0.5 },
    ],
    update_types: [
      { update_type_id: 'LAUNCH', name: '런칭', is_launch: 1, sort_order: 1, active: 1 },
      { update_type_id: 'SEASON', name: '시즌', is_launch: 0, sort_order: 2, active: 1 },
      { update_type_id: 'MINI', name: '미니', is_launch: 0, sort_order: 3, active: 1 },
    ],
    type_templates: [...templateRows('SEASON', SEASON_TEMPLATE), ...templateRows('MINI', MINI_TEMPLATE)],
    updates: [
      { update_id: 'LAUNCH', name: '런칭', update_type_id: 'LAUNCH', start_date: '2026-11-02', freeze_date: '2027-05-31', release_date: '2027-06-30', priority: 1, status: 'IN_PROGRESS', sort_order: 1 },
      { update_id: 'S1', name: '시즌 1', update_type_id: 'SEASON', start_date: '2027-04-01', freeze_date: '2027-08-13', release_date: '2027-08-31', priority: 2, status: 'PLANNED', sort_order: 2 },
      { update_id: 'MINI1', name: '미니 1', update_type_id: 'MINI', start_date: '2027-07-01', freeze_date: '2027-09-17', release_date: '2027-09-30', priority: 3, status: 'PLANNED', sort_order: 3 },
      { update_id: 'S2', name: '시즌 2', update_type_id: 'SEASON', start_date: '2027-08-02', freeze_date: '2027-11-12', release_date: '2027-11-30', priority: 4, status: 'PLANNED', sort_order: 4 },
    ],
    volumes: [
      ...Object.entries(LAUNCH_VOLUMES).map(([rt, [min, target, stretch, required, priority, outsource]]) => ({
        update_id: 'LAUNCH', resource_type_id: rt, min_qty: min, target_qty: target, stretch_qty: stretch,
        required, priority, difficulty: 1, reuse_rate: 0, outsource_qty: outsource,
      })),
      ...volumesFromTemplate('S1', SEASON_TEMPLATE),
      ...volumesFromTemplate('MINI1', MINI_TEMPLATE),
      ...volumesFromTemplate('S2', SEASON_TEMPLATE),
    ],
    progress: [
      { update_id: 'LAUNCH', resource_type_id: 'CHAR_NEW', part_id: 'CONCEPT', completed_qty: 3, as_of: '2026-11-04' },
      { update_id: 'LAUNCH', resource_type_id: 'CHAR_NEW', part_id: 'MODELING', completed_qty: 1, as_of: '2026-11-04' },
      { update_id: 'LAUNCH', resource_type_id: 'BG_MAP', part_id: 'CONCEPT', completed_qty: 1, as_of: '2026-11-04' },
    ],
    capacity: PARTS.flatMap(p => months.map(month => ({
      part_id: p.part_id, month, headcount: headcount(p.part_id, month), utilization: 0.8, productivity: 1,
      outsource_days: p.part_id === 'MODELING' && month >= '2027-02' && month <= '2027-05' ? 20 : 0,
      support_days: 0,
    }))),
    scenarios: [{ scenario_id: 'SC1', name: '모델링 1명 조기 채용 + 원화 AI 80%', base_data_version: 1, created_at: '2026-11-05T00:30:00.000Z', updated_at: '2026-11-05T00:30:00.000Z' }],
    scenario_changes: [
      { scenario_id: 'SC1', seq: 1, op: 'SET', target: 'capacity', target_key: 'MODELING|2027-01', field: 'headcount', value_json: '5', group_no: 1, label: '모델링 인원 +1명 (2027-01~2027-02)' },
      { scenario_id: 'SC1', seq: 2, op: 'SET', target: 'capacity', target_key: 'MODELING|2027-02', field: 'headcount', value_json: '5', group_no: 1, label: '모델링 인원 +1명 (2027-01~2027-02)' },
      { scenario_id: 'SC1', seq: 3, op: 'SET', target: 'effort_mix', target_key: 'CONCEPT|AI', field: 'share', value_json: '0.8', group_no: 2, label: '원화 AI 비율 80%' },
      { scenario_id: 'SC1', seq: 4, op: 'SET', target: 'effort_mix', target_key: 'CONCEPT|BASE', field: 'share', value_json: '0.2', group_no: 2, label: '원화 AI 비율 80%' },
    ],
    change_log: [],
  };
}
