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
export interface ResourceType { resource_type_id: string; group_id: string | null; name: string; sort_order: number; active: number; /** 고른 파이프라인(없으면 파트 표 순서) */ pipeline_id?: string | null }
/** 파이프라인 단계: 순서(seq)와 앞 단계와의 겹침률(비우면 파트 쌍 → 기본) */
/** with_prev = 1이면 앞 단계와 같은 묶음(병렬, docs/30). 없으면 0 */
export interface PipelineStep { pipeline_id: string; part_id: string; seq: number; overlap_rate: number | null; with_prev?: number }
export interface ResourcePart { resource_type_id: string; part_id: string; rework_rate: number }
/** 배치(납품 묶음, docs/33): 업데이트 안 순서(sort_order)대로 일한다 */
export interface Batch { batch_id: string; update_id: string; name: string; due_date: string | null; sort_order: number }
/**
 * 배치 작업량(core가 에셋 표에서 만든다, docs/33 5.6): 업데이트 × 리소스 × 파트 × 배치 × 포함 템플릿마다
 * 그 파트가 아직 끝나지 않은 에셋 수 · 끝낸(완료 · 해당 없음) 에셋 수
 */
export interface BatchWork { update_id: string; resource_type_id: string; part_id: string; batch_id: string; tier: 'MIN' | 'TARGET' | 'STRETCH'; remaining_qty: number; done_qty: number }
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

export interface Progress { update_id: string; resource_type_id: string; part_id: string; completed_qty: number; as_of?: string | null }

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
  /** 리소스별 파이프라인 단계(없으면 모든 리소스가 파트 표 순서) */
  pipeline_steps?: PipelineStep[];
  /** 배치 · 배치 작업량(없으면 배치 없이 지금처럼 계산, docs/33) */
  batches?: Batch[];
  batch_work?: BatchWork[];
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
  /**
   * 옛 도구와 대조할 때만 true: 작업 진척 기준일을 보지 않고(남은 일도 업데이트 시작일부터),
   * 앞 공정 진행률을 남은 일 기준으로 센다(옛 엔진 방식).
   */
  legacyProgress?: boolean;
}

// ───────── 결과 ─────────

/** 출시 판정: 목표 안(제작 완료 목표일 이내) · 빠듯(출시일 이내) · 늦음 · 기간 안에 못 끝냄 · 출시일 없음 */
export type UpdateStatus = 'ON_TRACK' | 'TIGHT' | 'LATE' | 'UNFINISHED' | 'NO_RELEASE_DATE';
export type LoadLevel = 'OK' | 'WARN' | 'OVER' | 'CRITICAL';

export interface StageResult {
  updateId: string;
  resourceTypeId: string;
  partId: string;
  /** 앞 공정(여럿이면 첫째). 병렬 묶음 뒤 단계는 predecessorPartIds에 모두 */
  predecessorPartId: string | null;
  predecessorPartIds: string[];
  /** 배치 스테이지면 그 배치(docs/33). 배치 밖 일은 null */
  batchId: string | null;
  overlapRate: number | null;
  overlapSource: 'FIRST' | 'STEP' | 'PAIR' | 'DEFAULT';
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

/** 배치 판정(docs/33 5.4): 마감 안 · 빠듯(마감 전 늦음 경고 영업일 안) · 늦음 · 못 끝냄 · 마감 없음 */
export type BatchStatus = 'ON_TRACK' | 'TIGHT' | 'LATE' | 'UNFINISHED' | 'NO_DUE';
export interface BatchResult {
  batchId: string;
  updateId: string;
  name: string;
  dueDate: string | null;
  expectedCompletionDate: string | null;
  status: BatchStatus;
  /** 늦음이면 마감 뒤 영업일, 빠듯이면 남은 여유 영업일 */
  lateWorkdays: number | null;
  slackWorkdays: number | null;
  /** 물량 밖: 배치 에셋이 남은 물량보다 많아 계산에 넣지 못한 에셋 수(파트 중 가장 많은 수) */
  overQty: number;
  /** 이 배치에 남은 에셋 수(파트 중 가장 많은 수) · 남은 일(인·일) */
  remainingQty: number;
  remainingDays: number;
  /** 가장 늦게 끝나는(또는 못 끝낸) 스테이지 */
  reason: UpdateReason | null;
}

export interface PlanResult {
  planMode: PlanMode;
  horizon: { start: string; end: string; workdays: number };
  updates: UpdateResult[];
  parts: PartResult[];
  partMonths: PartMonthResult[];
  stages: StageResult[];
  /** 배치별 완료 예정(배치가 있는 업데이트만, docs/33) */
  batches: BatchResult[];
  /** 날짜별·파트별 배정량(검사·차트용): dailyAssigned[파트 순번][영업일 순번] */
  daily: { dates: string[]; partIds: string[]; capacity: number[][]; assigned: number[][] };
  meta: { stageCount: number; elapsedMs: number };
}
