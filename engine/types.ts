// ARP 계산 엔진 자료형. 입력 행은 프로젝트 파일의 열 이름을 그대로 쓴다(바꿔 담는 단계가 없게).
// Node(타입 제거 실행)와 브라우저 번들 모두에서 쓰므로 enum·namespace 같은 TS 전용 문법은 쓰지 않는다.

export type PlanMode = 'MIN' | 'TARGET' | 'STRETCH';

export interface Settings {
  horizon_start_month: string;
  horizon_end_month: string;
  work_weekdays: string;
  buffer_rate: number;
  default_overlap_rate: number;
  load_warn_rate: number;
  load_over_rate: number;
  load_critical_rate: number;
  late_warn_workdays: number;
  default_plan_mode: PlanMode;
}

export interface Holiday { date: string; name: string; kind?: string }
export interface Part { part_id: string; name: string; sort_order: number; active: number }
export interface PartOverlap { from_part_id: string; to_part_id: string; overlap_rate: number }
export interface ResourceType { resource_type_id: string; group_id: string | null; name: string; sort_order: number; active: number }
export interface ResourcePart { resource_type_id: string; part_id: string; rework_rate: number }
export interface Effort { resource_type_id: string; part_id: string; profile_id: string; days: number }
export interface EffortMix { part_id: string; profile_id: string; share: number }
export interface UpdateType { update_type_id: string; name: string; is_launch: number; sort_order: number; active: number }

export interface Update {
  update_id: string;
  name: string;
  update_type_id: string;
  start_date: string | null;
  freeze_date: string | null;
  release_date: string | null;
  priority: number;
  status: string;
  sort_order: number;
}

export interface Volume {
  update_id: string;
  resource_type_id: string;
  min_qty: number | null;
  target_qty: number | null;
  stretch_qty: number | null;
  required: number;
  priority: number;
  difficulty: number;
  reuse_rate: number;
  outsource_qty: number;
}

export interface Progress { update_id: string; resource_type_id: string; part_id: string; completed_qty: number }

export interface Capacity {
  part_id: string;
  month: string;
  headcount: number;
  utilization: number;
  productivity: number;
  outsource_days: number;
  support_days: number;
}

/** 계산에 쓰는 표만. 시나리오는 이미 얹힌 상태로 들어온다. */
export interface ProjectData {
  settings: Settings;
  holidays: Holiday[];
  parts: Part[];
  part_overlaps: PartOverlap[];
  resource_types: ResourceType[];
  resource_parts: ResourcePart[];
  efforts: Effort[];
  effort_mix: EffortMix[];
  update_types: UpdateType[];
  updates: Update[];
  volumes: Volume[];
  progress: Progress[];
  capacity: Capacity[];
}

export interface PlanOptions {
  planMode?: PlanMode;
}

// ───────── 결과 ─────────

/** 출시 판정: 목표 안(제작 완료 목표일 이내) · 빠듯(출시일 이내) · 늦음 · 기간 안에 못 끝냄 · 출시일 없음 */
export type UpdateStatus = 'ON_TRACK' | 'TIGHT' | 'LATE' | 'UNFINISHED' | 'NO_RELEASE_DATE';
export type LoadLevel = 'OK' | 'WARN' | 'OVER' | 'CRITICAL';

export interface StageResult {
  updateId: string;
  resourceTypeId: string;
  partId: string;
  predecessorPartId: string | null;
  overlapRate: number | null;
  overlapSource: 'FIRST' | 'PAIR' | 'DEFAULT';
  requiredDays: number;
  remainingDays: number;
  /** 앞 공정 조건을 처음 채운 날 (null = 계획 기간 안에 못 채움 또는 이미 끝남) */
  readyDate: string | null;
  startDate: string | null;
  workDoneDate: string | null;
  completionDate: string | null;
  alreadyDone: boolean;
  /** 준비된 뒤 인력을 기다린 영업일 */
  waitWorkdays: number | null;
  /** 시작 순간 앞 공정 진행률(검사용) */
  predecessorProgressAtStart: number | null;
}

export interface UpdateReason {
  partId: string;
  resourceTypeId: string;
  waitWorkdays: number | null;
  workWorkdays: number | null;
  remainingDays: number;
}

export interface UpdateResult {
  updateId: string;
  name: string;
  isLaunch: boolean;
  priority: number;
  startDate: string | null;
  freezeDate: string | null;
  releaseDate: string | null;
  expectedCompletionDate: string | null;
  status: UpdateStatus;
  lateWorkdays: number | null;
  critical: boolean;
  requiredDays: number;
  remainingDays: number;
  /** 가장 늦게 끝나는(또는 못 끝낸) 스테이지: 결과의 근거 */
  reason: UpdateReason | null;
}

export interface PartMonthResult {
  partId: string;
  month: string;
  workdays: number;
  capacityDays: number;
  assignedDays: number;
  utilization: number;
  /** 그 달 마지막 영업일 끝에 남은 일(시작한 업데이트 기준) */
  remainingDays: number;
}

export interface PartResult {
  partId: string;
  name: string;
  requiredDays: number;
  capacityDays: number;
  loadRate: number;
  level: LoadLevel;
  /** 가장 밀린 달: 달 끝에 남은 일이 가장 많은 달 */
  peakMonth: string | null;
}

export interface PlanResult {
  planMode: PlanMode;
  horizon: { start: string; end: string; workdays: number };
  updates: UpdateResult[];
  parts: PartResult[];
  partMonths: PartMonthResult[];
  stages: StageResult[];
  /** 날짜별·파트별 배정량(검사·차트용): dailyAssigned[파트 순번][영업일 순번] */
  daily: { dates: string[]; partIds: string[]; capacity: number[][]; assigned: number[][] };
  meta: { stageCount: number; elapsedMs: number };
}
