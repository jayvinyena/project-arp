// 운영 시트 흉내: 옛 도구(구글 시트) 구조 그대로, 실제 운영 규모와 운영 중에 생기는 흔적을 넣은 합성 데이터.
//   - 옛 엔진 대조용 fixture(시트별 2차원 배열, 날짜는 'YYYY-MM-DD' 글자 → 하네스가 Date로 바꿈)
//   - 구글 시트 "다운로드 → Microsoft Excel"과 같은 모양의 .xlsx(날짜는 엑셀 날짜)
//   node tools/gen-operating-sheet.mjs            → samples/out/operating-sheet.xlsx · .json
'use strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeXlsx } from './lib/xlsx-write.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// 파트: ID, 이름, 순서, ACTIVE, 작업 가능량 대상, 기본 인원
const PARTS = [
  ['CONCEPT', '원화', 1, true, true, 5],
  ['MODEL', '3D 모델링', 2, true, true, 8],
  ['RIG', '리깅', 3, true, true, 2],
  ['ANIM', '애니메이션', 4, true, true, 5],
  ['FX', '이펙트', 5, true, true, 3],
  ['UI', 'UI', 6, 'TRUE', true, 3],          // 글자로 적힌 TRUE
  ['TA', '테크아트', 7, true, false, 1],       // 작업 가능량 대상 아님
  ['SOUND', '사운드', 8, false, false, 0],    // 사용 안 함
];

const GROUPS = [['G_CHAR', '캐릭터'], ['G_COS', '코스튬'], ['G_BG', '배경'], ['G_PROP', '프랍'], ['G_VFX', '이펙트'], ['G_UI', 'UI'], ['G_MKT', '마케팅']];

// 리소스: ID, 이름, 분류, ACTIVE, { 파트: [기본, AI, 재작업률] }
const RESOURCES = [
  ['CHAR_HERO', '영웅 캐릭터', 'G_CHAR', true, { CONCEPT: [8, 6, 0.15], MODEL: [14, 11, 0.15], RIG: [5, 4, 0.1], ANIM: [12, 9, 0.1], FX: [3, 2.5, 0.05] }],
  ['CHAR_NPC', 'NPC', 'G_CHAR', true, { CONCEPT: [3, 2, 0.1], MODEL: [6, 4.5, 0.1], RIG: [2, 1.5, 0.05], ANIM: [3, 2.5, 0.05] }], // 이펙트는 거치지 않음(옛 도구는 기본 공수가 빈 행을 거부)
  ['CHAR_MONSTER', '몬스터', 'G_CHAR', true, { CONCEPT: [4, 3, 0.1], MODEL: [8, 6, 0.1], RIG: [3, 2.5, 0.1], ANIM: [6, 4.5, 0.1], FX: [2, 1.5, 0.05] }],
  ['CHAR_BOSS', '보스', 'G_CHAR', true, { CONCEPT: [10, 7, 0.2], MODEL: [18, 14, 0.15], RIG: [6, 5, 0.1], ANIM: [15, 11, 0.1], FX: [6, 4.5, 0.1] }],
  ['CHAR_OLD', '구형 캐릭터(안 씀)', 'G_CHAR', false, { CONCEPT: [6, 4, 0.1], MODEL: [10, 8, 0.1] }],
  ['COS_SKIN', '스킨', 'G_COS', true, { CONCEPT: [2.5, 1.8, 0.1], MODEL: [4, 3, 0.1], FX: [1, 0.8, 0] }],
  ['COS_ACC', '액세서리', 'G_COS', true, { CONCEPT: [0.8, 0.5, 0.05], MODEL: [1.5, 1.1, 0.05] }],
  ['COS_WEAPON', '무기 스킨', 'G_COS', true, { CONCEPT: [1.2, 0.8, 0.05], MODEL: [2.5, 1.8, 0.05], FX: [1.2, 1, 0.05] }],
  ['COS_EMOTE', '감정 표현', 'G_COS', true, { ANIM: [2, 1.5, 0.05], FX: [0.5, 0.4, 0] }],
  ['BG_FIELD', '필드 맵', 'G_BG', true, { CONCEPT: [10, 8, 0.1], MODEL: [24, 19, 0.1], FX: [4, 3, 0.05] }],
  ['BG_DUNGEON', '던전', 'G_BG', true, { CONCEPT: [7, 5, 0.1], MODEL: [16, 12, 0.1], FX: [3, 2.5, 0.05] }],
  ['BG_LOBBY', '로비', 'G_BG', true, { CONCEPT: [5, 4, 0.1], MODEL: [9, 7, 0.1], UI: [3, 2.5, 0.05] }],
  ['PROP_S', '소형 프랍', 'G_PROP', true, { CONCEPT: [0.4, 0.3, 0.05], MODEL: [0.8, 0.6, 0.05] }],
  ['PROP_L', '대형 프랍', 'G_PROP', true, { CONCEPT: [1.2, 0.9, 0.05], MODEL: [2.5, 1.9, 0.05] }],
  ['PROP_INTER', '상호작용 프랍', 'G_PROP', true, { CONCEPT: [0.8, 0.6, 0.05], MODEL: [1.6, 1.2, 0.05], ANIM: [1.2, 0.9, 0.05], FX: [0.8, 0.6, 0] }],
  ['VFX_SKILL', '스킬 이펙트', 'G_VFX', true, { FX: [1.6, 1.3, 0.1] }],
  ['VFX_ENV', '환경 이펙트', 'G_VFX', 'Y', { FX: [1.2, 1, 0.05] }],     // 글자 Y
  ['UI_ICON', '아이콘', 'G_UI', true, { UI: [0.25, 0.15, 0] }],
  ['UI_SCREEN', 'UI 화면', 'G_UI', true, { UI: [3.5, 2.8, 0.1] }],
  ['UI_BANNER', '배너', 'G_UI', true, { CONCEPT: [0.8, 0.6, 0.05], UI: [0.8, 0.6, 0.05] }],
  ['MKT_KEYART', '키 아트', 'G_MKT', true, { CONCEPT: [7, 5, 0.1] }],
];

// 계획 기간: 2026-11 ~ 2028-10 (24개월). 옛 BUSINESS_DAYS는 사람이 적은 값(명절 달은 적다)
const MONTHS = [];
for (let i = 0; i < 24; i += 1) { const y = 2026 + Math.floor((10 + i) / 12); const m = ((10 + i) % 12) + 1; MONTHS.push(`${y}-${String(m).padStart(2, '0')}`); }
const BUSINESS_DAYS = { '2026-12': 21, '2027-01': 20, '2027-02': 17, '2027-03': 22, '2027-05': 19, '2027-09': 18, '2027-10': 19, '2028-01': 18, '2028-02': 20, '2028-05': 20, '2028-10': 18 };

// 업데이트: ID, 이름, 유형, 시작, 제작 완료 목표, 출시, 목표 월, 등급, 상태, ACTIVE
const UPDATES = [
  ['CBT_2026', 'CBT 빌드', 'LAUNCH', '2026-03-02', '2026-09-11', '2026-10-15', '2026-10', 'HIGH', 'RELEASED', true],
  ['LAUNCH_2027', '정식 런칭', 'LAUNCH', '2026-09-01', '2027-06-30', '2027-07-29', '2027-07', 'HIGH', 'IN_PROGRESS', true],
  ['UPD_S1', '시즌 1', 'SEASON', '2027-04-01', '2027-09-03', '2027-09-30', '2027-09', 'HIGH', 'PLANNED', true],
  ['UPD_EV_CHUSEOK', '추석 이벤트', 'EVENT', '2027-07-01', '2027-08-27', '2027-09-09', '2027-09', 'MEDIUM', 'PLANNED', true],
  ['UPD_MINI1', '미니 1', 'MINI', '2027-08-02', '2027-10-15', '2027-10-28', '2027-10', 'MEDIUM', 'PLANNED', true],
  ['UPD_S2', '시즌 2', 'SEASON', '2027-08-02', '2027-12-03', '2027-12-23', '2027-12', 'HIGH', 'PLANNED', true],
  ['UPD_EV_XMAS', '겨울 이벤트', 'EVENT', '2027-10-04', '2027-12-03', '2027-12-16', '2027-12', 'LOW', 'PLANNED', true],
  ['UPD_COLLAB', '콜라보(무산)', 'COLLAB', '2027-09-01', '2027-11-26', '2027-12-09', '2027-12', 'MEDIUM', 'CANCELLED', true],
  ['UPD_EV_NY', '설날 이벤트', 'EVENT', '2027-12-01', '2028-01-14', '2028-01-27', '2028-01', 'MEDIUM', 'PLANNED', true],
  ['UPD_MINI2', '미니 2', 'MINI', '2027-11-01', '2028-01-28', '2028-02-24', '2028-02', 'MEDIUM', 'PLANNED', true],
  ['UPD_S3', '시즌 3', 'SEASON', '2027-12-01', '2028-03-31', '2028-04-27', '2028-04', 'HIGH', 'PLANNED', true],
  ['UPD_MINI3', '미니 3(보류)', 'MINI', '2028-02-01', '2028-04-14', '2028-04-27', '2028-04', 'LOW', 'PLANNED', false],
  ['UPD_S4', '시즌 4', 'SEASON', '2028-03-02', '', '', '2028-07', 'HIGH', 'PLANNED', true],   // 날짜 아직 안 정함
  ['UPD_EV_SUMMER', '여름 이벤트', 'EVENT', '2028-05-01', '2028-07-07', '2028-07-20', '2028-07', 'LOW', 'PLANNED', true],
];

// 유형 템플릿: [최저, 목표, 최대]
const TEMPLATES = {
  SEASON: { CHAR_HERO: [2, 3, 4], CHAR_MONSTER: [4, 6, 8], CHAR_BOSS: [1, 1, 2], COS_SKIN: [8, 12, 16], COS_WEAPON: [4, 6, 8], BG_FIELD: [1, 1, 2], BG_DUNGEON: [1, 2, 2], PROP_S: [30, 40, 60], PROP_L: [8, 12, 16], VFX_SKILL: [12, 18, 24], UI_ICON: [60, 80, 100], UI_SCREEN: [3, 4, 6], UI_BANNER: [6, 8, 10], MKT_KEYART: [1, 1, 2] },
  MINI: { CHAR_HERO: [1, 1, 2], COS_SKIN: [4, 6, 8], COS_ACC: [6, 10, 12], PROP_S: [10, 20, 30], VFX_SKILL: [4, 6, 8], UI_ICON: [20, 30, 40], UI_BANNER: [3, 4, 6] },
  EVENT: { COS_SKIN: [3, 4, 6], COS_EMOTE: [2, 3, 4], PROP_INTER: [3, 5, 6], VFX_ENV: [2, 3, 4], UI_ICON: [15, 20, 30], UI_BANNER: [4, 6, 8] },
};

// 업데이트 물량: 리소스 → [최저(빈칸 가능), 목표, 최대, 추가, 이월, 취소, 외주, 재사용률, 난이도, 필수, 우선]
const V = (min, target, stretch, o = {}) => [min, target, stretch, o.added ?? 0, o.carry ?? 0, o.cancel ?? 0, o.out ?? 0, o.reuse ?? 0, o.diff ?? 1, o.level ?? 'MUST', o.prio ?? 'HIGH'];
const VOLUMES = {
  CBT_2026: { CHAR_HERO: V(4, 4, 4), CHAR_MONSTER: V(6, 6, 6) },
  LAUNCH_2027: {
    CHAR_HERO: V(10, 14, 18, { added: 2 }), CHAR_NPC: V(16, 24, 32, { level: 'SHOULD', prio: 'MEDIUM' }), CHAR_MONSTER: V(14, 18, 24, { carry: 2 }),
    CHAR_BOSS: V(3, 4, 5, { diff: 1.2 }), COS_SKIN: V(16, 24, 32, { out: 6 }), COS_WEAPON: V(8, 12, 16, { level: 'SHOULD', prio: 'MEDIUM' }),
    BG_FIELD: V(2, 3, 3, { diff: 1.1 }), BG_DUNGEON: V(3, 4, 5), BG_LOBBY: V(1, 1, 1), PROP_S: V('', 140, 180, { reuse: 0.2 }),
    PROP_L: V(28, 36, 44, { cancel: 4 }), PROP_INTER: V(10, 14, 18, { level: 'COULD', prio: 'LOW' }), VFX_SKILL: V(40, 56, 70),
    VFX_ENV: V(12, 18, 24, { level: 'SHOULD' }), UI_ICON: V(200, 280, 340, { reuse: 0.1 }), UI_SCREEN: V(24, 30, 36), UI_BANNER: V(10, 14, 18, { prio: 'LOW' }),
    MKT_KEYART: V(2, 3, 4, { out: 1 }),
  },
  UPD_S1: { CHAR_HERO: V(2, 3, 4), CHAR_MONSTER: V(4, 6, 8, { carry: 1 }), CHAR_BOSS: V(1, 1, 2), COS_SKIN: V(8, 12, 16), COS_WEAPON: V(4, 6, 8, { level: 'SHOULD' }), BG_DUNGEON: V(1, 2, 2), PROP_S: V(30, 40, 60, { reuse: 0.3 }), PROP_L: V(8, 12, 16), VFX_SKILL: V(12, 18, 24), UI_ICON: V(60, 80, 100), UI_SCREEN: V(3, 4, 6), UI_BANNER: V(6, 8, 10, { prio: 'LOW' }), MKT_KEYART: V(1, 1, 2) },
  UPD_EV_CHUSEOK: { COS_SKIN: V(3, 4, 6), COS_EMOTE: V(2, 3, 4), PROP_INTER: V(3, 5, 6), VFX_ENV: V(2, 3, 4), UI_ICON: V(15, 20, 30), UI_BANNER: V(4, 6, 8) },
  UPD_MINI1: { CHAR_HERO: V(1, 1, 2), COS_SKIN: V(4, 6, 8), COS_ACC: V(6, 10, 12, { level: 'SHOULD' }), PROP_S: V(10, 20, 30), VFX_SKILL: V(4, 6, 8), UI_ICON: V(20, 30, 40), UI_BANNER: V(3, 4, 6) },
  UPD_S2: { CHAR_HERO: V(2, 3, 4), CHAR_MONSTER: V(4, 6, 8), CHAR_BOSS: V(1, 1, 2, { diff: 1.3 }), COS_SKIN: V(8, 12, 16, { added: 2 }), COS_WEAPON: V(4, 6, 8), BG_FIELD: V(1, 1, 2), PROP_S: V(30, 40, 60), PROP_L: V(8, 12, 16), VFX_SKILL: V(12, 18, 24), UI_ICON: V(60, 80, 100), UI_SCREEN: V(3, 4, 6), UI_BANNER: V(6, 8, 10), MKT_KEYART: V(1, 1, 2) },
  UPD_EV_XMAS: { COS_SKIN: V(3, 4, 6), COS_EMOTE: V(2, 3, 4), PROP_INTER: V(3, 5, 6), VFX_ENV: V(2, 3, 4), UI_ICON: V(15, 20, 30), UI_BANNER: V(4, 6, 8) },
  UPD_COLLAB: { CHAR_HERO: V(2, 2, 2), COS_SKIN: V(6, 6, 6) },
  UPD_EV_NY: { COS_SKIN: V(3, 4, 6), COS_EMOTE: V(2, 3, 4), PROP_INTER: V(3, 5, 6), VFX_ENV: V(2, 3, 4), UI_ICON: V(15, 20, 30), UI_BANNER: V(4, 6, 8) },
  UPD_MINI2: { CHAR_HERO: V(1, 1, 2), COS_SKIN: V(4, 6, 8), COS_ACC: V(6, 10, 12), PROP_S: V(10, 20, 30), VFX_SKILL: V(4, 6, 8), UI_ICON: V(20, 30, 40), UI_BANNER: V(3, 4, 6) },
  UPD_S3: { CHAR_HERO: V(2, 3, 4), CHAR_MONSTER: V(4, 6, 8), CHAR_BOSS: V(1, 1, 2), COS_SKIN: V(8, 12, 16), COS_WEAPON: V(4, 6, 8), BG_FIELD: V(1, 1, 2), BG_DUNGEON: V(1, 2, 2), PROP_S: V(30, 40, 60), PROP_L: V(8, 12, 16), VFX_SKILL: V(12, 18, 24), UI_ICON: V(60, 80, 100), UI_SCREEN: V(3, 4, 6), UI_BANNER: V(6, 8, 10), MKT_KEYART: V(1, 1, 2) },
  // UPD_MINI3(사용 안 함)은 물량 행이 없다: 옛 도구는 사용 안 함 업데이트에 물량이 남으면 계산을 거부한다
  UPD_S4: { CHAR_HERO: V(2, 3, 4), CHAR_MONSTER: V(4, 6, 8), COS_SKIN: V(8, 12, 16), PROP_S: V(30, 40, 60), VFX_SKILL: V(12, 18, 24), UI_ICON: V(60, 80, 100), UI_BANNER: V(6, 8, 10) },
  UPD_EV_SUMMER: { COS_SKIN: V(3, 4, 6), COS_EMOTE: V(2, 3, 4), VFX_ENV: V(2, 3, 4), UI_ICON: V(15, 20, 30), UI_BANNER: V(4, 6, 8) },
};

// 런칭 진행 실적: 리소스 → { 파트: [완료, 외주 완료, 규격 제외] }
const PROGRESS = {
  LAUNCH_2027: {
    CHAR_HERO: { CONCEPT: [9, 0, 0], MODEL: [5, 0, 0], RIG: [3, 0, 0], ANIM: [2, 0, 0] },
    CHAR_NPC: { CONCEPT: [10, 0, 1], MODEL: [4, 0, 0] },
    CHAR_MONSTER: { CONCEPT: [8, 0, 0], MODEL: [6, 0, 0], RIG: [4, 0, 0], ANIM: [3, 0, 0] },
    COS_SKIN: { CONCEPT: [12, 2, 0], MODEL: [6, 2, 0] },
    BG_FIELD: { CONCEPT: [2, 0, 0], MODEL: [1, 0, 0] },
    PROP_S: { CONCEPT: [70, 0, 5], MODEL: [40, 10, 0] },
    UI_ICON: { UI: [120, 0, 0] },
    UI_SCREEN: { UI: [8, 0, 0] },
    MKT_KEYART: { CONCEPT: [1, 0, 0] },
  },
};

/** 인력: 파트·달별 인원. 충원·외주·지원은 운영 중에 바뀐 흔적 */
function headcount(part, base, ym) {
  let h = base;
  if (part === 'MODEL' && ym >= '2027-03') h += 1;
  if (part === 'ANIM' && ym >= '2027-06') h += 1;
  if (part === 'FX' && ym >= '2027-04') h += 1;
  if (part === 'CONCEPT' && ym >= '2028-01') h -= 1;
  if (part === 'UI' && ym === '2027-02') h = 2.5; // 한 명 반 달 휴가
  return h;
}

export function buildOperatingFixture() {
  const sheets = {};
  sheets['사용 안내'] = [['아트 리소스 플래너 데이터 시트'], ['이 시트는 웹 앱이 읽고 씁니다. 머리글(1행)은 바꾸지 마세요.'], ['문의: 아트 PM']];

  sheets['00_Config'] = [
    ['CONFIG_KEY', 'CONFIG_VALUE', 'VALUE_TYPE', 'DESCRIPTION'],
    ['DATA_VERSION', 'M38_20261101_0912', 'TEXT', '데이터 버전(앱이 갱신)'],
    ['DEFAULT_PLAN_MODE', 'TARGET', 'TEXT', ''],
    ['DEFAULT_BUFFER_RATE', 0.15, 'NUMBER', '계획 여유율'],
    ['CAPACITY_YELLOW_THRESHOLD', 0.85, 'NUMBER', ''],
    ['CAPACITY_ORANGE_THRESHOLD', 1.0, 'NUMBER', ''],
    ['CAPACITY_RED_THRESHOLD', 1.15, 'NUMBER', ''],
    ['BASE_PERIOD_MONTHS', 24, 'NUMBER', ''],
    ['DEFAULT_BUSINESS_DAYS_PER_MONTH', 20, 'NUMBER', ''],
    ['DEFAULT_UTILIZATION_RATE', 0.8, 'NUMBER', ''],
    ['DEFAULT_PRODUCTIVITY_FACTOR', 1, 'NUMBER', ''],
    ['ALLOCATION_FORECAST_HORIZON_MONTHS', 24, 'NUMBER', ''],
    ['EFFORT_PROFILE', 'STANDARD', 'TEXT', ''],
    ['STAGE_OVERLAP_RATE_DEFAULT', 0.3, 'NUMBER', '앞 공정이 70% 진행되면 다음 공정 시작'],
    ['STAGE_OVERLAP_RATE:CONCEPT>MODEL', 0.2, 'NUMBER', ''],
    ['STAGE_OVERLAP_RATE:RIG>ANIM', 0.5, 'NUMBER', '리깅 절반이면 애니 시작'],
    ['M3812_FAST_CACHE_ENABLED', 'TRUE', 'BOOLEAN', '옛 앱 캐시 설정(새 앱과 무관)'],
  ];

  sheets['01_Part_Master'] = [['PART_ID', 'PART_NAME', 'SORT_ORDER', 'ACTIVE', 'IS_CAPACITY_TARGET', 'LEAD', 'NOTE']]
    .concat(PARTS.map(([id, name, order, active, target]) => [id, name, order, active, target, `${name} 리드`, id === 'SOUND' ? '외부 스튜디오로 이관' : '']));

  sheets['02_Resource_Master'] = [['RESOURCE_ID', 'RESOURCE_NAME', 'RESOURCE_LEVEL', 'PARENT_RESOURCE_ID', 'FINAL_PART_ID', 'SORT_ORDER', 'ACTIVE', 'NOTE']]
    .concat(GROUPS.map(([id, name], i) => [id, name, 'GROUP', '', '', i + 1, true, '']))
    .concat(RESOURCES.map(([id, name, group, active, efforts], i) => [id, name, 'LEAF', group, Object.keys(efforts).at(-1), 100 + i, active, '']));

  sheets['03_Effort_Standard'] = [['RESOURCE_ID', 'PART_ID', 'BASE_DAYS', 'AI_ASSISTED_DAYS', 'DEFAULT_REWORK_RATE', 'UPDATED_AT', 'UPDATED_BY']];
  for (const [id, , , , efforts] of RESOURCES) {
    for (const [part, [base, ai, rework]] of Object.entries(efforts)) {
      sheets['03_Effort_Standard'].push([id, part, base ?? '', ai ?? '', rework ?? '', '2026-08-14', 'art-pm']);
    }
  }

  sheets['04_Pipeline_Template'] = [['PIPELINE_ID', 'RESOURCE_ID', 'RESOURCE_GROUP_ID', 'STAGE_ID', 'STAGE_NAME', 'PART_ID', 'PREDECESSOR_STAGE_ID', 'HANDOFF_TYPE', 'HANDOFF_RATIO', 'BATCH_SIZE', 'LAG_DAYS', 'EFFORT_MULTIPLIER', 'SORT_ORDER', 'ACTIVE', 'NOTE']];
  for (const [id, , , , efforts] of RESOURCES) {
    let prev = '';
    Object.keys(efforts).forEach((part, i) => {
      sheets['04_Pipeline_Template'].push([`PL_${id}`, id, '', `${id}_${part}`, part, part, prev, prev ? 'FINISH_TO_START' : '', 1, 1, 0, 1, i + 1, true, '']);
      prev = `${id}_${part}`;
    });
  }

  sheets['05_Update_Type'] = [['UPDATE_TYPE_ID', 'UPDATE_TYPE_NAME', 'SORT_ORDER', 'ACTIVE'],
    ['LAUNCH', '런칭', 0, true], ['SEASON', '시즌 업데이트', 1, true], ['MINI', '미니 업데이트', 2, true], ['EVENT', '이벤트', 3, true], ['COLLAB', '콜라보', 4, false]];

  sheets['06_Update_Volume_Template'] = [['UPDATE_TYPE_ID', 'RESOURCE_ID', 'MIN_QTY', 'TARGET_QTY', 'STRETCH_QTY', 'ACTIVE']];
  for (const [type, rows] of Object.entries(TEMPLATES)) for (const [res, [a, b, c]] of Object.entries(rows)) sheets['06_Update_Volume_Template'].push([type, res, a, b, c, true]);

  sheets['10_Update_Master'] = [['UPDATE_ID', 'UPDATE_NAME', 'UPDATE_TYPE_ID', 'PLAN_START_DATE', 'CONTENT_FREEZE_DATE', 'RELEASE_DATE', 'TARGET_YEAR_MONTH',
    'PRIORITY', 'STATUS', 'CONFIDENCE', 'OWNER', 'DESCRIPTION', 'ROW_VERSION', 'SORT_ORDER', 'ACTIVE', 'LAST_EDITED_BY', 'LAST_EDITED_AT']];
  UPDATES.forEach(([id, name, type, start, freeze, release, ym, prio, status, active], i) => {
    sheets['10_Update_Master'].push([id, name, type, start, freeze, release, `${ym}-01`, prio, status, prio === 'HIGH' ? 'HIGH' : 'MEDIUM', 'art-pm',
      id === 'UPD_S4' ? '일정 미정(사업부 확인 중)' : '', 3 + (i % 4), i, active, 'art-pm', '2026-10-28']);
  });

  sheets['11_Update_Volume'] = [['UPDATE_RESOURCE_KEY', 'UPDATE_ID', 'RESOURCE_ID', 'MIN_QTY', 'TARGET_QTY', 'STRETCH_QTY', 'COMPLETED_QTY', 'ADDED_QTY', 'CANCELLED_QTY',
    'CARRYOVER_IN_QTY', 'OUTSOURCE_QTY', 'REUSE_RATE', 'DIFFICULTY_FACTOR', 'REQUIRED_LEVEL', 'PRIORITY', 'CHANGE_REASON', 'LAST_EDITED_AT']];
  for (const [u, rows] of Object.entries(VOLUMES)) {
    for (const [r, [min, target, stretch, added, carry, cancel, out, reuse, diff, level, prio]] of Object.entries(rows)) {
      const reason = added ? '기획 추가 요청' : carry ? '이전 업데이트에서 이월' : cancel ? '기획 축소' : '';
      sheets['11_Update_Volume'].push([`${u}|${r}`, u, r, min, target, stretch, '', added, cancel, carry, out, reuse, diff, level, prio, reason, '2026-10-28']);
    }
    if (u === 'UPD_S1') sheets['11_Update_Volume'].push(Array(17).fill('')); // 중간에 남은 빈 행
  }

  sheets['12_Capacity_Monthly'] = [['CAPACITY_ID', 'YEAR_MONTH', 'PART_ID', 'HEADCOUNT', 'BUSINESS_DAYS', 'UTILIZATION_RATE', 'PRODUCTIVITY_FACTOR', 'OUTSOURCE_CAPACITY_DAYS', 'TEMP_SUPPORT_DAYS', 'NOTE']];
  for (const ym of MONTHS) {
    for (const [part, , , , target, base] of PARTS) {
      if (!target) continue;
      const out = part === 'MODEL' && ym >= '2027-02' && ym <= '2027-05' ? 20 : part === 'ANIM' && ym >= '2027-04' && ym <= '2027-06' ? 10 : 0;
      const support = part === 'FX' && (ym === '2027-05' || ym === '2027-06') ? 5 : 0;
      const util = part === 'CONCEPT' && ym <= '2027-01' ? 0.75 : 0.8;
      const note = out ? '외주 계약' : support ? '타 팀 지원' : '';
      sheets['12_Capacity_Monthly'].push([`${ym}|${part}`, `${ym}-01`, part, headcount(part, base, ym), BUSINESS_DAYS[ym] ?? 21, util, part === 'RIG' ? 0.9 : 1, out, support, note]);
    }
  }

  sheets['13_Progress_Actual'] = [['UPDATE_ID', 'RESOURCE_ID', 'PART_ID', 'COMPLETED_QTY', 'OUTSOURCE_COMPLETED_QTY', 'SPEC_OUT_QTY', 'UPDATED_AT', 'UPDATED_BY']];
  for (const [u, rows] of Object.entries(PROGRESS)) {
    for (const [r, parts] of Object.entries(rows)) {
      for (const [p, [done, out, spec]] of Object.entries(parts)) sheets['13_Progress_Actual'].push([u, r, p, done, out, spec, '2026-11-02', 'art-pm']);
    }
  }

  sheets['20_Scenario_Master'] = [['SCENARIO_ID', 'SCENARIO_NAME', 'DESCRIPTION', 'CALC_MODE', 'STATUS', 'OWNER_EMAIL', 'VISIBILITY', 'LOCKED', 'EFFORT_PROFILE', 'CREATED_AT', 'UPDATED_AT'],
    ['SC_HIRE', '모델러 2명 충원안', '', 'TARGET', 'DRAFT', 'pm@example.com', 'TEAM', false, 'STANDARD', '2026-10-01', '2026-10-20']];
  sheets['21_Scenario_Override'] = [['SCENARIO_ID', 'TARGET_TYPE', 'TARGET_KEY', 'FIELD_NAME', 'BASE_VALUE', 'OVERRIDE_VALUE', 'REASON', 'EFFECTIVE_FROM', 'EFFECTIVE_TO'],
    ['SC_HIRE', 'CAPACITY', 'MODEL', 'HEADCOUNT', 8, 10, '충원', '2027-01-01', '2027-06-30']];
  sheets['33_Update_Allocation_Snapshot'] = [['SNAPSHOT_AT', 'UPDATE_ID', 'PART_ID', 'ALLOCATED_DAYS'], ['2026-10-28', 'LAUNCH_2027', 'MODEL', 812.5]];
  sheets['34_Update_Roadmap_Snapshot'] = [['SNAPSHOT_AT', 'UPDATE_ID', 'EXPECTED_COMPLETION'], ['2026-10-28', 'LAUNCH_2027', '2027-06-18']];
  sheets['98_Input_Hub_Baseline'] = [['KEY', 'VALUE'], ['BASELINE_AT', '2026-10-28'], ['ROWS', 214]];
  sheets['90_Change_History'] = [['CHANGED_AT', 'USER_EMAIL', 'TARGET_TYPE', 'TARGET_KEY', 'FIELD_NAME', 'OLD_VALUE', 'NEW_VALUE', 'REASON']];
  for (let i = 0; i < 60; i += 1) {
    const [u] = UPDATES[1 + (i % 12)];
    sheets['90_Change_History'].push([`2026-${String(8 + Math.floor(i / 20)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, 'pm@example.com', 'UPDATE_VOLUME', `${u}|COS_SKIN`, 'TARGET_QTY', 10 + (i % 5), 12 + (i % 5), '기획 조정']);
  }
  return { name: 'ARP 운영 시트 흉내(합성)', sheets };
}

/** 구글 시트 → 엑셀 내보내기 모양: 'YYYY-MM-DD' 글자를 엑셀 날짜로 */
export function toExportedXlsx(fixture) {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const sheets = Object.fromEntries(Object.entries(fixture.sheets).map(([name, rows]) => [name,
    rows.map((row, r) => (r === 0 ? row : row.map(v => (typeof v === 'string' && DATE.test(v) ? new Date(`${v}T00:00:00Z`) : v))))]));
  return writeXlsx(sheets);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = buildOperatingFixture();
  mkdirSync(`${ROOT}samples/out`, { recursive: true });
  writeFileSync(`${ROOT}samples/out/operating-sheet.xlsx`, toExportedXlsx(fixture));
  writeFileSync(`${ROOT}samples/out/operating-sheet.json`, JSON.stringify(fixture));
  const count = name => fixture.sheets[name].length - 1;
  console.log(`운영 시트: 시트 ${Object.keys(fixture.sheets).length}개 · 파트 ${count('01_Part_Master')} · 리소스 ${count('02_Resource_Master')} · 업데이트 ${count('10_Update_Master')} · 물량 ${count('11_Update_Volume')} · 인력 ${count('12_Capacity_Monthly')}`);
  console.log('→ samples/out/operating-sheet.xlsx · operating-sheet.json');
}
