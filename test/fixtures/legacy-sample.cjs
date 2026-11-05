/**
 * (arp/tests/fixtures/sample.fixture.js 복사본: 옛 도구 시트 구조의 합성 데이터. 가져오기 검사용)
 * 합성 데이터 fixture: 파트 4개, LEAF 리소스 4종, 업데이트 3건, 8개월 Capacity.
 * 실데이터 export(xlsx → json)로 교체 가능하도록 시트별 2차원 배열(첫 행 = 헤더) 형식을 쓴다.
 */
'use strict';

const PARTS = [
  ['CONCEPT', '원화', 1, 3],
  ['MODEL', '3D 모델링', 2, 4],
  ['ANIM', '애니메이션', 3, 2],
  ['UI', 'UI', 4, 2],
];

// RESOURCE_ID, RESOURCE_NAME, FINAL_PART_ID, { PART_ID: [BASE_DAYS, AI_ASSISTED_DAYS, REWORK_RATE] }
const RESOURCES = [
  ['CHAR_COSTUME', '캐릭터 코스튬', 'ANIM', { CONCEPT: [3, 2, 0.1], MODEL: [5, 4, 0.1], ANIM: [2, 1.5, 0.05] }],
  ['CHAR_NEW', '신규 캐릭터', 'ANIM', { CONCEPT: [6, 4, 0.15], MODEL: [10, 8, 0.15], ANIM: [8, 6, 0.1] }],
  ['BG_PROP', '배경 프랍', 'MODEL', { CONCEPT: [1, 0.5, 0.05], MODEL: [2, 1.5, 0.05] }],
  ['UI_ICON', 'UI 아이콘', 'UI', { UI: [0.5, 0.3, 0] }],
];

const GROUPS = [['CHAR', '캐릭터'], ['BG', '배경'], ['UIG', 'UI']];
const PARENT_OF = { CHAR_COSTUME: 'CHAR', CHAR_NEW: 'CHAR', BG_PROP: 'BG', UI_ICON: 'UIG' };

const MONTHS =['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'];

module.exports = function buildSampleFixture() {
  const sheets = {};

  sheets['00_Config'] = [
    ['CONFIG_KEY', 'CONFIG_VALUE', 'VALUE_TYPE'],
    ['DATA_VERSION', 'FIXTURE_V1', 'TEXT'],
    ['DEFAULT_PLAN_MODE', 'TARGET', 'TEXT'],
    ['DEFAULT_BUFFER_RATE', 0.2, 'NUMBER'],
    ['CAPACITY_YELLOW_THRESHOLD', 0.8, 'NUMBER'],
    ['CAPACITY_ORANGE_THRESHOLD', 1.0, 'NUMBER'],
    ['CAPACITY_RED_THRESHOLD', 1.2, 'NUMBER'],
    ['BASE_PERIOD_MONTHS', 8, 'NUMBER'],
    ['DEFAULT_BUSINESS_DAYS_PER_MONTH', 20, 'NUMBER'],
    ['DEFAULT_UTILIZATION_RATE', 0.8, 'NUMBER'],
    ['DEFAULT_PRODUCTIVITY_FACTOR', 1, 'NUMBER'],
    ['ALLOCATION_FORECAST_HORIZON_MONTHS', 24, 'NUMBER'],
    ['EFFORT_PROFILE', 'STANDARD', 'TEXT'],
  ];

  sheets['01_Part_Master'] = [['PART_ID', 'PART_NAME', 'SORT_ORDER', 'ACTIVE', 'IS_CAPACITY_TARGET']]
    .concat(PARTS.map(([id, name, order]) => [id, name, order, true, true]));

  sheets['02_Resource_Master'] = [['RESOURCE_ID', 'RESOURCE_NAME', 'RESOURCE_LEVEL', 'PARENT_RESOURCE_ID', 'FINAL_PART_ID', 'SORT_ORDER', 'ACTIVE']]
    .concat(GROUPS.map(([id, name], i) => [id, name, 'GROUP', '', '', i + 1, true]))
    .concat(RESOURCES.map(([id, name, finalPart], i) => [id, name, 'LEAF', PARENT_OF[id], finalPart, 10 + i, true]));

  sheets['03_Effort_Standard'] = [['RESOURCE_ID', 'PART_ID', 'BASE_DAYS', 'AI_ASSISTED_DAYS', 'DEFAULT_REWORK_RATE']];
  RESOURCES.forEach(([id, , , efforts]) => {
    Object.entries(efforts).forEach(([partId, [base, ai, rework]]) => {
      sheets['03_Effort_Standard'].push([id, partId, base, ai, rework]);
    });
  });

  sheets['04_Pipeline_Template'] = [['PIPELINE_ID', 'RESOURCE_ID', 'RESOURCE_GROUP_ID', 'STAGE_ID', 'STAGE_NAME', 'PART_ID',
    'PREDECESSOR_STAGE_ID', 'HANDOFF_TYPE', 'HANDOFF_RATIO', 'BATCH_SIZE', 'LAG_DAYS', 'EFFORT_MULTIPLIER', 'SORT_ORDER', 'ACTIVE', 'NOTE']];
  RESOURCES.forEach(([id, , , efforts]) => {
    let prev = '';
    Object.keys(efforts).forEach((partId, i) => {
      const stageId = `${id}_${partId}`;
      sheets['04_Pipeline_Template'].push([`PL_${id}`, id, '', stageId, partId, partId, prev,
        prev ? 'FINISH_TO_START' : '', 1, 1, 0, 1, i + 1, true, '']);
      prev = stageId;
    });
  });

  sheets['05_Update_Type'] = [['UPDATE_TYPE_ID', 'UPDATE_TYPE_NAME', 'SORT_ORDER', 'ACTIVE'],
    ['LAUNCH', '런칭 기준안', 0, true], ['SEASON', '시즌 업데이트', 1, true], ['EVENT', '이벤트', 2, true]];

  sheets['06_Update_Volume_Template'] = [['UPDATE_TYPE_ID', 'RESOURCE_ID', 'MIN_QTY', 'TARGET_QTY', 'STRETCH_QTY', 'ACTIVE'],
    ['SEASON', 'CHAR_NEW', 1, 2, 3, true], ['SEASON', 'CHAR_COSTUME', 4, 6, 8, true],
    ['EVENT', 'CHAR_COSTUME', 2, 3, 4, true], ['EVENT', 'UI_ICON', 10, 20, 30, true]];

  sheets['10_Update_Master'] = [['UPDATE_ID', 'UPDATE_NAME', 'UPDATE_TYPE_ID', 'PLAN_START_DATE', 'CONTENT_FREEZE_DATE',
    'RELEASE_DATE', 'TARGET_YEAR_MONTH', 'PRIORITY', 'STATUS', 'CONFIDENCE', 'OWNER', 'DESCRIPTION', 'ROW_VERSION', 'SORT_ORDER', 'ACTIVE'],
  ['LAUNCH_BASE', '런칭 기준안', 'LAUNCH', '2026-11-02', '2027-04-01', '2027-04-29', '2027-04', 'HIGH', 'IN_PROGRESS', 'HIGH', 'art-lead', '', 1, 0, true],
  ['UPD_2027_S1', '2027 시즌1', 'SEASON', '2026-11-02', '2027-02-04', '2027-02-25', '2027-02', 'HIGH', 'IN_PROGRESS', 'HIGH', 'art-lead', '', 1, 1, true],
  ['UPD_2027_EV1', '설날 이벤트', 'EVENT', '2026-12-01', '2027-01-14', '2027-01-28', '2027-01', 'MEDIUM', 'PLANNED', 'MEDIUM', 'art-lead', '', 1, 2, true],
  ['UPD_2027_S2', '2027 시즌2', 'SEASON', '2027-02-01', '2027-05-06', '2027-05-27', '2027-05', 'MEDIUM', 'PLANNED', 'LOW', 'art-lead', '', 1, 3, true]];

  sheets['11_Update_Volume'] = [['UPDATE_RESOURCE_KEY', 'UPDATE_ID', 'RESOURCE_ID', 'MIN_QTY', 'TARGET_QTY', 'STRETCH_QTY',
    'COMPLETED_QTY', 'ADDED_QTY', 'CANCELLED_QTY', 'CARRYOVER_IN_QTY', 'OUTSOURCE_QTY', 'REUSE_RATE', 'DIFFICULTY_FACTOR',
    'REQUIRED_LEVEL', 'PRIORITY', 'CHANGE_REASON']];
  [
    ['LAUNCH_BASE', 'CHAR_NEW', 4, 6, 8, 0, 0, 0, 0, 0, 1, 'MUST', 'HIGH'],
    ['LAUNCH_BASE', 'BG_PROP', 20, 30, 40, 0, 0, 0, 0, 0, 1, 'MUST', 'MEDIUM'],
    ['UPD_2027_S1', 'CHAR_NEW', 1, 2, 3, 0, 0, 0, 0, 0, 1, 'MUST', 'HIGH'],
    ['UPD_2027_S1', 'CHAR_COSTUME', 4, 6, 8, 0, 0, 1, 0, 0.1, 1, 'MUST', 'HIGH'],
    ['UPD_2027_S1', 'BG_PROP', 10, 15, 20, 0, 0, 0, 5, 0.2, 1, 'SHOULD', 'MEDIUM'],
    ['UPD_2027_EV1', 'CHAR_COSTUME', 2, 3, 4, 0, 0, 0, 0, 0, 1, 'MUST', 'HIGH'],
    ['UPD_2027_EV1', 'UI_ICON', 10, 20, 30, 0, 0, 0, 0, 0, 1, 'SHOULD', 'MEDIUM'],
    ['UPD_2027_S2', 'CHAR_NEW', 1, 2, 2, 0, 0, 0, 0, 0, 1.2, 'MUST', 'HIGH'],
    ['UPD_2027_S2', 'CHAR_COSTUME', 4, 5, 7, 0, 0, 0, 0, 0, 1, 'SHOULD', 'MEDIUM'],
  ].forEach(([u, r, min, target, stretch, added, cancelled, carry, outsource, reuse, diff, level, prio]) => {
    sheets['11_Update_Volume'].push([`${u}|${r}`, u, r, min, target, stretch, '', added, cancelled, carry, outsource,
      reuse, diff, level, prio, '']);
  });

  sheets['12_Capacity_Monthly'] = [['CAPACITY_ID', 'YEAR_MONTH', 'PART_ID', 'HEADCOUNT', 'BUSINESS_DAYS', 'UTILIZATION_RATE',
    'PRODUCTIVITY_FACTOR', 'OUTSOURCE_CAPACITY_DAYS', 'TEMP_SUPPORT_DAYS', 'NOTE']];
  MONTHS.forEach(month => {
    PARTS.forEach(([partId, , , headcount]) => {
      sheets['12_Capacity_Monthly'].push([`${month}|${partId}`, `${month}-01`, partId, headcount, 20, 0.8, 1, 0, 0, '']);
    });
  });

  sheets['13_Progress_Actual'] = [['UPDATE_ID', 'RESOURCE_ID', 'PART_ID', 'COMPLETED_QTY', 'OUTSOURCE_COMPLETED_QTY', 'SPEC_OUT_QTY', 'UPDATED_AT'],
    ['UPD_2027_S1', 'CHAR_COSTUME', 'CONCEPT', 3, 0, 0, '2026-11-01'],
    ['UPD_2027_S1', 'BG_PROP', 'CONCEPT', 5, 0, 0, '2026-11-01']];

  sheets['20_Scenario_Master'] = [['SCENARIO_ID', 'SCENARIO_NAME', 'DESCRIPTION', 'CALC_MODE', 'STATUS', 'OWNER_EMAIL',
    'VISIBILITY', 'LOCKED', 'EFFORT_PROFILE', 'CREATED_AT', 'UPDATED_AT']];
  sheets['21_Scenario_Override'] = [['SCENARIO_ID', 'TARGET_TYPE', 'TARGET_KEY', 'FIELD_NAME', 'BASE_VALUE', 'OVERRIDE_VALUE',
    'REASON', 'EFFECTIVE_FROM', 'EFFECTIVE_TO']];
  sheets['90_Change_History'] = [['CHANGED_AT', 'USER_EMAIL', 'TARGET_TYPE', 'TARGET_KEY', 'FIELD_NAME', 'OLD_VALUE', 'NEW_VALUE', 'REASON']];

  return { name: 'ARP sample fixture', sheets };
};
