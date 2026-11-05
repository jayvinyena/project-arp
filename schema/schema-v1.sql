-- ARP 프로젝트 파일 구조 v1 (SQLite 3.37 이상, STRICT 표)
--
-- 원칙
--   * 표에 거는 제약은 "형식"만: 형, 날짜·월 모양, 0/1, 키, 참조.
--   * 값의 규칙(최저 ≤ 목표 ≤ 확장, 비율 0~1, 날짜 순서 등)은 검증 규칙(docs/03-validation-rules.md)이 맡는다.
--     그래야 가져오기와 작업 중 저장이 막히지 않고, 문제는 "계산 불가 + 이유"로 보인다.
--   * 비워 둘 수 있는 값은 NULL. 조용히 채우는 기본값은 두지 않는다(0, 1처럼 뜻이 분명한 것만 DEFAULT).
--
-- 파일 표시: PRAGMA application_id = 1095913521 ('ARP1'), PRAGMA user_version = 1 (구조 버전)

PRAGMA application_id = 1095913521;
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;

-- ───────────────────────── 파일 정보 ─────────────────────────

-- 키-값. project_name, created_at, data_version, lock_holder, lock_heartbeat_at, saved_by_app
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
) STRICT;

-- 프로젝트 설정: 한 줄짜리 표
CREATE TABLE settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  horizon_start_month   TEXT NOT NULL CHECK (horizon_start_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND date(horizon_start_month || '-01') IS NOT NULL),
  horizon_end_month     TEXT NOT NULL CHECK (horizon_end_month   GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND date(horizon_end_month   || '-01') IS NOT NULL),
  work_weekdays         TEXT NOT NULL DEFAULT '1111100' CHECK (length(work_weekdays) = 7 AND work_weekdays NOT GLOB '*[^01]*'), -- 월~일
  buffer_rate           REAL NOT NULL DEFAULT 0,      -- 여유율
  default_overlap_rate  REAL NOT NULL DEFAULT 0,      -- 겹침률이 따로 없는 파트 쌍
  load_warn_rate        REAL NOT NULL DEFAULT 0.8,    -- 부하율 주의
  load_over_rate        REAL NOT NULL DEFAULT 1.0,    -- 부하율 초과
  load_critical_rate    REAL NOT NULL DEFAULT 1.2,    -- 부하율 심각
  late_warn_workdays    INTEGER NOT NULL DEFAULT 10,  -- 출시일보다 이만큼(영업일) 넘게 늦으면 "심각"
  default_plan_mode     TEXT NOT NULL DEFAULT 'TARGET' CHECK (default_plan_mode IN ('MIN', 'TARGET', 'STRETCH'))
) STRICT;

-- 공휴일과 회사 휴무일. 근무 요일에 걸친 날만 근무일에서 뺀다.
CREATE TABLE holidays (
  date TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) = date),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (kind IN ('PUBLIC', 'COMPANY'))
) STRICT;

-- ───────────────────────── 조직과 리소스 ─────────────────────────

CREATE TABLE parts (
  part_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL,                       -- 공정 순서
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

-- 파트 쌍별 겹침률. 없으면 settings.default_overlap_rate
CREATE TABLE part_overlaps (
  from_part_id TEXT NOT NULL REFERENCES parts(part_id) ON DELETE CASCADE,
  to_part_id   TEXT NOT NULL REFERENCES parts(part_id) ON DELETE CASCADE,
  overlap_rate REAL NOT NULL,
  PRIMARY KEY (from_part_id, to_part_id)
) STRICT;

CREATE TABLE resource_groups (
  group_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL
) STRICT;

CREATE TABLE resource_types (
  resource_type_id TEXT PRIMARY KEY,
  group_id         TEXT REFERENCES resource_groups(group_id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  sort_order       INTEGER NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

-- 리소스 종류가 거치는 파트와 재작업률. 이 표에 있는 파트만 거친다.
CREATE TABLE resource_parts (
  resource_type_id TEXT NOT NULL REFERENCES resource_types(resource_type_id) ON DELETE CASCADE,
  part_id          TEXT NOT NULL REFERENCES parts(part_id) ON DELETE CASCADE,
  rework_rate      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_type_id, part_id)
) STRICT;

-- 공수 프로필. 'BASE'(기본)는 반드시 있다.
CREATE TABLE effort_profiles (
  profile_id TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL
) STRICT;

-- 리소스 1개당 공수(인·일), 프로필별
CREATE TABLE efforts (
  resource_type_id TEXT NOT NULL,
  part_id          TEXT NOT NULL,
  profile_id       TEXT NOT NULL REFERENCES effort_profiles(profile_id) ON DELETE CASCADE,
  days             REAL NOT NULL,
  PRIMARY KEY (resource_type_id, part_id, profile_id),
  FOREIGN KEY (resource_type_id, part_id) REFERENCES resource_parts(resource_type_id, part_id) ON DELETE CASCADE
) STRICT;

-- 파트별 공수 프로필 섞는 비율. 한 파트의 비율 합은 1.
-- 파트에 행이 없으면 그 파트는 BASE 100%(정의). 예: 원화 BASE 0.5 + AI 0.5
CREATE TABLE effort_mix (
  part_id    TEXT NOT NULL REFERENCES parts(part_id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES effort_profiles(profile_id) ON DELETE CASCADE,
  share      REAL NOT NULL,
  PRIMARY KEY (part_id, profile_id)
) STRICT;

-- ───────────────────────── 업데이트와 물량 ─────────────────────────

CREATE TABLE update_types (
  update_type_id TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  is_launch      INTEGER NOT NULL DEFAULT 0 CHECK (is_launch IN (0, 1)),
  sort_order     INTEGER NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

-- 유형별 기본 물량. 새 업데이트를 만들 때 복사한다(계산에는 쓰지 않는다).
CREATE TABLE type_templates (
  update_type_id   TEXT NOT NULL REFERENCES update_types(update_type_id) ON DELETE CASCADE,
  resource_type_id TEXT NOT NULL REFERENCES resource_types(resource_type_id) ON DELETE CASCADE,
  min_qty          INTEGER,
  target_qty       INTEGER,
  stretch_qty      INTEGER,
  PRIMARY KEY (update_type_id, resource_type_id)
) STRICT;

CREATE TABLE updates (
  update_id      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  update_type_id TEXT NOT NULL REFERENCES update_types(update_type_id),
  start_date     TEXT CHECK (start_date   IS NULL OR (start_date   GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(start_date)   = start_date)),
  freeze_date    TEXT CHECK (freeze_date  IS NULL OR (freeze_date  GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(freeze_date)  = freeze_date)),
  release_date   TEXT CHECK (release_date IS NULL OR (release_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(release_date) = release_date)),
  priority       INTEGER NOT NULL,                  -- 1이 가장 먼저
  status         TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  sort_order     INTEGER NOT NULL,
  note           TEXT
) STRICT;

-- 업데이트 × 리소스 종류 물량
CREATE TABLE volumes (
  update_id        TEXT NOT NULL REFERENCES updates(update_id) ON DELETE CASCADE,
  resource_type_id TEXT NOT NULL REFERENCES resource_types(resource_type_id),
  min_qty          INTEGER,
  target_qty       INTEGER,
  stretch_qty      INTEGER,
  required         INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)), -- 1 필수, 0 선택
  priority         INTEGER NOT NULL DEFAULT 1,      -- 업데이트 안에서의 순위
  difficulty       REAL NOT NULL DEFAULT 1,
  reuse_rate       REAL NOT NULL DEFAULT 0,
  outsource_qty    INTEGER NOT NULL DEFAULT 0,      -- 통째로 외주
  note             TEXT,
  PRIMARY KEY (update_id, resource_type_id)
) STRICT;
CREATE INDEX volumes_by_resource ON volumes(resource_type_id);

-- 실적: 파트별 완료 수량
CREATE TABLE progress (
  update_id        TEXT NOT NULL REFERENCES updates(update_id) ON DELETE CASCADE,
  resource_type_id TEXT NOT NULL REFERENCES resource_types(resource_type_id),
  part_id          TEXT NOT NULL REFERENCES parts(part_id),
  completed_qty    INTEGER NOT NULL,
  as_of            TEXT CHECK (as_of IS NULL OR (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(as_of) = as_of)),
  PRIMARY KEY (update_id, resource_type_id, part_id)
) STRICT;

-- ───────────────────────── 인력 ─────────────────────────

-- 파트 × 월. 계획 기간의 모든 달에 있어야 한다(조용한 연장 없음).
CREATE TABLE capacity (
  part_id        TEXT NOT NULL REFERENCES parts(part_id) ON DELETE CASCADE,
  month          TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND date(month || '-01') IS NOT NULL),
  headcount      REAL NOT NULL,
  utilization    REAL NOT NULL,
  productivity   REAL NOT NULL DEFAULT 1,
  outsource_days REAL NOT NULL DEFAULT 0,           -- 외주 인력(인·일)
  support_days   REAL NOT NULL DEFAULT 0,           -- 지원 인력(인·일)
  note           TEXT,
  PRIMARY KEY (part_id, month)
) STRICT;

-- ───────────────────────── 시나리오 ─────────────────────────

CREATE TABLE scenarios (
  scenario_id       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  note              TEXT,
  base_data_version INTEGER NOT NULL,               -- 만들 때의 원본 데이터 버전
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

-- 원본 위에 얹는 변경. op = SET(항목 값 바꾸기) / INSERT(행 추가, value_json = 행) / DELETE(행 빼기)
CREATE TABLE scenario_changes (
  scenario_id TEXT NOT NULL REFERENCES scenarios(scenario_id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('SET', 'INSERT', 'DELETE')),
  target      TEXT NOT NULL CHECK (target IN ('settings', 'part_overlaps', 'resource_parts', 'efforts', 'effort_mix', 'updates', 'volumes', 'capacity')),
  target_key  TEXT NOT NULL,                        -- 기본 키를 '|'로 이음. 예: 'LAUNCH|CHAR_NEW'
  field       TEXT,                                 -- SET일 때만
  value_json  TEXT,                                 -- JSON 값(SET) 또는 행(INSERT)
  PRIMARY KEY (scenario_id, seq)
) STRICT;

-- ───────────────────────── 변경 이력 ─────────────────────────

CREATE TABLE change_log (
  log_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id   TEXT NOT NULL,                         -- 한 번의 저장·반영 묶음
  at         TEXT NOT NULL,                         -- ISO 시각
  editor     TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  target     TEXT NOT NULL,
  target_key TEXT NOT NULL,
  field      TEXT,
  old_json   TEXT,
  new_json   TEXT,
  reason     TEXT
) STRICT;
CREATE INDEX change_log_by_target ON change_log(target, target_key);
