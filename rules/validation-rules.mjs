// ARP 검증 규칙 v1 — 규칙의 원본. docs/03-validation-rules.md 는 이 파일에서 만든다(tools/gen-rules-doc.mjs).
//
// level  ERROR = 계산 불가. 모든 업데이트가 같은 인력을 나눠 쓰므로 한 곳이 틀리면 전체 결과가 틀린다.
//        WARN  = 계산은 하되 결과 옆에 표시한다.
// sql    문제 하나당 한 줄을 돌려준다. 열: key(어디), detail(무엇이 어떻게).
//        아래 PRELUDE의 임시 뷰를 쓸 수 있다.
//
// 계산 대상 업데이트 = 상태가 계획(PLANNED) 또는 진행(IN_PROGRESS). 완료·취소는 검사하지 않는다.

export const PRELUDE = `
CREATE TEMP VIEW IF NOT EXISTS live_updates AS
  SELECT * FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS');
CREATE TEMP VIEW IF NOT EXISTS live_volumes AS
  SELECT v.* FROM volumes v JOIN live_updates u ON u.update_id = v.update_id;
CREATE TEMP VIEW IF NOT EXISTS horizon_months AS
  WITH RECURSIVE m(month) AS (
    SELECT horizon_start_month FROM settings
    UNION ALL
    SELECT strftime('%Y-%m', date(m.month || '-01', '+1 month')) FROM m
    WHERE m.month < (SELECT horizon_end_month FROM settings) AND m.month < '9999-12'
  )
  SELECT month FROM m;
-- 리소스마다 거치는 파트의 공정 위치(docs/28): 고른 파이프라인 단계 순서, 단계에 없거나 파이프라인이 없으면 파트 표 순서
CREATE TEMP VIEW IF NOT EXISTS step_pos AS
  SELECT rp.resource_type_id, rp.part_id, CASE WHEN ps.seq IS NOT NULL THEN ps.seq ELSE 1000000 + p.sort_order END AS pos
  FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id
  JOIN resource_types r ON r.resource_type_id = rp.resource_type_id
  LEFT JOIN pipeline_steps ps ON ps.pipeline_id = r.pipeline_id AND ps.part_id = rp.part_id;
`;

const q = s => s.replace(/\s+/g, ' ').trim();

// 규칙마다 읽는 표. 시나리오처럼 일부 표만 바뀐 경우, 그 표를 읽는 규칙만 다시 돌리고 나머지는 원본 결과를 쓴다.
// horizon_months는 settings, live_* 는 updates·volumes를 읽는다. 규칙을 수정하면 여기도 맞춘다(검사가 빠진 규칙을 잡는다).
export const RULE_TABLES = {
  S01: ['settings'], S02: ['settings'], S03: ['settings'],
  P01: ['parts'], P02: ['parts'], P03: ['part_overlaps'], P04: ['part_overlaps', 'parts', 'pipeline_steps'],
  E01: ['effort_profiles'],
  E02: ['volumes', 'updates', 'resource_parts', 'parts'],
  E03: ['volumes', 'updates', 'resource_parts', 'parts', 'efforts'],
  E04: ['efforts'], E05: ['resource_parts'], E06: ['effort_mix'],
  E07: ['effort_mix', 'resource_parts', 'efforts'],
  E08: ['volumes', 'updates', 'resource_parts', 'parts', 'efforts'],
  E09: ['resource_parts', 'resource_types', 'pipeline_steps'],
  E10: ['resource_types'],
  U01: ['updates'], U02: ['updates'], U03: ['updates'], U04: ['updates', 'settings'],
  U05: ['updates', 'update_types'], U06: ['updates'], U07: ['updates', 'volumes'],
  V01: ['volumes', 'updates'], V02: ['volumes', 'updates'], V03: ['volumes', 'updates'], V04: ['volumes', 'updates'],
  V05: ['volumes', 'updates', 'resource_types'],
  A01: ['progress'], A02: ['progress', 'updates', 'volumes'], A03: ['progress', 'resource_parts'],
  A04: ['progress', 'updates', 'parts', 'resource_parts', 'resource_types', 'pipeline_steps'],
  C01: ['parts', 'capacity', 'settings'], C02: ['capacity'],
  C03: ['parts', 'resource_parts', 'volumes', 'updates', 'capacity', 'settings'],
  T01: ['type_templates'],
  X01: ['scenario_changes', 'part_overlaps', 'resource_parts', 'efforts', 'effort_mix', 'updates', 'volumes', 'capacity'],
  X02: ['scenarios', 'change_log'],
};

export const AREAS = {
  S: '설정',
  P: '파트 · 공정',
  E: '리소스 · 공수',
  U: '업데이트',
  V: '물량',
  A: '작업 진척',
  C: '인력',
  T: '유형 템플릿',
  X: '시나리오',
};

export const RULES = [
  // ───────── 설정 ─────────
  {
    code: 'S01', level: 'ERROR', title: '설정이 없다',
    fix: '프로젝트 설정에서 계획 기간과 근무 요일을 입력한다.',
    sql: q(`SELECT 'settings' AS key, '설정이 없습니다' AS detail WHERE NOT EXISTS (SELECT 1 FROM settings)`),
  },
  {
    code: 'S02', level: 'ERROR', title: '계획 기간이 거꾸로이거나 60개월을 넘는다',
    fix: '끝 월을 시작 월 이후로, 기간은 60개월 이내로 맞춘다.',
    sql: q(`SELECT 'settings' AS key, printf('계획 기간 %s ~ %s', horizon_start_month, horizon_end_month) AS detail FROM settings
      WHERE horizon_end_month < horizon_start_month
         OR (CAST(substr(horizon_end_month, 1, 4) AS INTEGER) * 12 + CAST(substr(horizon_end_month, 6, 2) AS INTEGER))
          - (CAST(substr(horizon_start_month, 1, 4) AS INTEGER) * 12 + CAST(substr(horizon_start_month, 6, 2) AS INTEGER)) + 1 > 60`),
  },
  {
    code: 'S03', level: 'ERROR', title: '설정 값이 범위를 벗어난다',
    fix: '여유율·기본 겹침률은 0–1, 부하율 기준은 0 < 주의 < 초과 < 심각, 근무 요일은 하루 이상, 늦음 기준은 0 이상.',
    sql: q(`
      SELECT 'settings.buffer_rate' AS key, printf('여유율 %g', buffer_rate) AS detail FROM settings WHERE buffer_rate NOT BETWEEN 0 AND 1
      UNION ALL SELECT 'settings.default_overlap_rate', printf('기본 겹침률 %g', default_overlap_rate) FROM settings WHERE default_overlap_rate NOT BETWEEN 0 AND 1
      UNION ALL SELECT 'settings.load_rates', printf('부하율 기준 %g / %g / %g', load_warn_rate, load_over_rate, load_critical_rate) FROM settings
        WHERE NOT (0 < load_warn_rate AND load_warn_rate < load_over_rate AND load_over_rate < load_critical_rate)
      UNION ALL SELECT 'settings.work_weekdays', '근무 요일이 하루도 없습니다' FROM settings WHERE work_weekdays = '0000000'
      UNION ALL SELECT 'settings.late_warn_workdays', printf('늦음 기준 %d영업일', late_warn_workdays) FROM settings WHERE late_warn_workdays < 0`),
  },

  // ───────── 파트 · 공정 ─────────
  {
    code: 'P01', level: 'ERROR', title: '사용 중인 파트가 없다',
    fix: '파트를 하나 이상 만들고 사용으로 둔다.',
    sql: q(`SELECT 'parts' AS key, '사용 중인 파트가 없습니다' AS detail WHERE NOT EXISTS (SELECT 1 FROM parts WHERE active = 1)`),
  },
  {
    code: 'P02', level: 'ERROR', title: '사용 중인 파트의 순서가 겹친다',
    fix: '공정 순서가 정해지도록 파트마다 다른 순서 번호를 준다.',
    sql: q(`SELECT group_concat(part_id, ', ') AS key, printf('순서 %d 중복', sort_order) AS detail FROM parts WHERE active = 1 GROUP BY sort_order HAVING count(*) > 1`),
  },
  {
    code: 'P03', level: 'ERROR', title: '겹침률이 0–1 밖이다',
    fix: '겹침률을 0(끝난 뒤 시작)부터 1(바로 시작) 사이로 고친다.',
    sql: q(`SELECT from_part_id || '>' || to_part_id AS key, printf('겹침률 %g', overlap_rate) AS detail FROM part_overlaps WHERE overlap_rate NOT BETWEEN 0 AND 1`),
  },
  {
    code: 'P04', level: 'WARN', title: '쓰이지 않는 겹침률',
    fix: '앞 파트가 공정 순서상 먼저 오도록 고치거나 행을 지운다.',
    sql: q(`SELECT o.from_part_id || '>' || o.to_part_id AS key, '공정 순서와 반대이거나 쓰지 않는 파트입니다' AS detail
      FROM part_overlaps o JOIN parts a ON a.part_id = o.from_part_id JOIN parts b ON b.part_id = o.to_part_id
      WHERE a.active = 0 OR b.active = 0 OR (a.sort_order >= b.sort_order AND NOT EXISTS (
        SELECT 1 FROM pipeline_steps x JOIN pipeline_steps y ON y.pipeline_id = x.pipeline_id AND y.seq > x.seq
        WHERE x.part_id = o.from_part_id AND y.part_id = o.to_part_id))`),
  },

  // ───────── 리소스 · 공수 ─────────
  {
    code: 'E01', level: 'ERROR', title: '기본 공수 프로필이 없다',
    fix: '공수 프로필에 BASE(기본)를 만든다.',
    sql: q(`SELECT 'effort_profiles' AS key, '기본(BASE) 공수 프로필이 없습니다' AS detail WHERE NOT EXISTS (SELECT 1 FROM effort_profiles WHERE profile_id = 'BASE')`),
  },
  {
    code: 'E02', level: 'ERROR', title: '물량이 있는 리소스 종류가 거치는 파트가 없다',
    fix: '리소스 종류에 거치는 파트를 하나 이상 지정한다.',
    sql: q(`SELECT DISTINCT v.resource_type_id AS key, '거치는 파트가 없습니다' AS detail FROM live_volumes v
      WHERE NOT EXISTS (SELECT 1 FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id AND p.active = 1 WHERE rp.resource_type_id = v.resource_type_id)`),
  },
  {
    code: 'E03', level: 'ERROR', title: '물량이 있는 리소스 종류에 기본 공수가 없다',
    fix: '그 리소스·파트의 기본(BASE) 공수를 입력한다.',
    sql: q(`SELECT rp.resource_type_id || '|' || rp.part_id AS key, '기본 공수가 없습니다' AS detail
      FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id AND p.active = 1
      WHERE rp.resource_type_id IN (SELECT resource_type_id FROM live_volumes)
        AND NOT EXISTS (SELECT 1 FROM efforts e WHERE e.resource_type_id = rp.resource_type_id AND e.part_id = rp.part_id AND e.profile_id = 'BASE')`),
  },
  {
    code: 'E04', level: 'ERROR', title: '공수가 0보다 작다',
    // 0은 받는다: 옛 도구 데이터에서 "그 파트에서는 할 일 없음"으로 쓰이고, 엔진도 0일 공정으로 옛 엔진과 같게 계산한다(2026-11-05 실제 운영 시트)
    fix: '1개당 인·일을 0 이상으로 입력한다. 그 파트를 거치지 않으면 거치는 파트에서 빼거나 0으로 둔다.',
    sql: q(`SELECT resource_type_id || '|' || part_id || '|' || profile_id AS key, printf('공수 %g', days) AS detail FROM efforts WHERE days < 0`),
  },
  {
    code: 'E05', level: 'ERROR', title: '재작업률이 0–1 밖이다',
    fix: '재작업률을 0–1로 고친다(0.1 = 10%).',
    sql: q(`SELECT resource_type_id || '|' || part_id AS key, printf('재작업률 %g', rework_rate) AS detail FROM resource_parts WHERE rework_rate NOT BETWEEN 0 AND 1`),
  },
  {
    code: 'E06', level: 'ERROR', title: '공수 프로필 비율의 합이 1이 아니다',
    fix: '파트마다 프로필 비율을 0 이상, 합 1로 맞춘다.',
    sql: q(`SELECT part_id AS key, printf('비율 합 %g', sum(share)) AS detail FROM effort_mix GROUP BY part_id HAVING abs(sum(share) - 1) > 1e-9 OR min(share) < 0`),
  },
  {
    code: 'E07', level: 'WARN', title: '섞어 쓰는 프로필의 공수가 일부 없다',
    fix: '그 프로필 공수를 입력하거나, 없으면 기본 공수를 쓴다는 것을 확인한다.',
    sql: q(`SELECT m.part_id || '|' || m.profile_id AS key, printf('리소스 %d개에 이 프로필 공수가 없어 기본 공수를 씁니다', count(*)) AS detail
      FROM effort_mix m JOIN resource_parts rp ON rp.part_id = m.part_id
      WHERE m.profile_id <> 'BASE' AND m.share > 0
        AND NOT EXISTS (SELECT 1 FROM efforts e WHERE e.resource_type_id = rp.resource_type_id AND e.part_id = rp.part_id AND e.profile_id = m.profile_id)
      GROUP BY m.part_id, m.profile_id`),
  },
  {
    code: 'E09', level: 'WARN', title: '파이프라인에 없는 파트에 공수가 있다',
    fix: '기준 정보 › 파이프라인에서 그 파트를 단계로 더하거나, 리소스 · 공수 표에서 그 칸을 비우거나 다른 파트로 옮긴다.',
    sql: q(`SELECT rp.resource_type_id || '|' || rp.part_id AS key, printf('%s · %s: 파이프라인 단계가 아니라 맨 뒤에 계산합니다', r.name, p.name) AS detail
      FROM resource_parts rp JOIN resource_types r ON r.resource_type_id = rp.resource_type_id JOIN parts p ON p.part_id = rp.part_id
      WHERE r.pipeline_id IS NOT NULL AND EXISTS (SELECT 1 FROM pipelines pl WHERE pl.pipeline_id = r.pipeline_id)
        AND NOT EXISTS (SELECT 1 FROM pipeline_steps ps WHERE ps.pipeline_id = r.pipeline_id AND ps.part_id = rp.part_id)`),
  },
  {
    code: 'E10', level: 'WARN', title: '없는 파이프라인을 고른 리소스',
    fix: '리소스 · 공수 표에서 파이프라인을 다시 고른다(그동안은 파트 표 순서로 계산).',
    sql: q(`SELECT resource_type_id AS key, printf('%s: 파이프라인 %s 없음', name, pipeline_id) AS detail FROM resource_types
      WHERE pipeline_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pipelines pl WHERE pl.pipeline_id = resource_types.pipeline_id)`),
  },
  {
    // 제작 리스트 가져오기에서 새로 만든 리소스 종류는 공수 0(거치지만 공수 미정)으로 만든다(docs/20-asset-management.md 21절)
    code: 'E08', level: 'WARN', title: '물량이 있는 리소스 종류의 기본 공수가 모두 0이다',
    fix: '기준 정보의 리소스 표에서 그 리소스의 파트별 1개당 인·일을 입력한다. 0이면 일이 없는 것으로 계산된다.',
    sql: q(`SELECT rp.resource_type_id AS key, '기본 공수가 모두 0이라 일이 없는 것으로 계산합니다' AS detail
      FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id AND p.active = 1
      JOIN efforts e ON e.resource_type_id = rp.resource_type_id AND e.part_id = rp.part_id AND e.profile_id = 'BASE'
      WHERE rp.resource_type_id IN (SELECT resource_type_id FROM live_volumes)
      GROUP BY rp.resource_type_id HAVING max(e.days) = 0`),
  },

  // ───────── 업데이트 ─────────
  {
    code: 'U01', level: 'ERROR', title: '시작일이 없다',
    fix: '업데이트 작업을 시작할 수 있는 날을 입력한다.',
    sql: q(`SELECT update_id AS key, '시작일이 없습니다' AS detail FROM live_updates WHERE start_date IS NULL`),
  },
  {
    code: 'U02', level: 'WARN', title: '출시일이 없다',
    fix: '출시일을 입력한다. 없으면 완료 예정일만 보여주고 늦음 여부는 판단하지 않는다.',
    sql: q(`SELECT update_id AS key, '출시일이 없어 늦음 여부를 판단하지 않습니다' AS detail FROM live_updates WHERE release_date IS NULL`),
  },
  {
    code: 'U03', level: 'ERROR', title: '날짜 순서가 틀렸다',
    fix: '시작일 ≤ 제작 완료 목표일 ≤ 출시일로 맞춘다.',
    sql: q(`SELECT update_id AS key, printf('시작 %s · 제작 완료 %s · 출시 %s', coalesce(start_date, '-'), coalesce(freeze_date, '-'), coalesce(release_date, '-')) AS detail
      FROM live_updates
      WHERE (start_date IS NOT NULL AND freeze_date IS NOT NULL AND freeze_date < start_date)
         OR (freeze_date IS NOT NULL AND release_date IS NOT NULL AND release_date < freeze_date)
         OR (start_date IS NOT NULL AND release_date IS NOT NULL AND release_date < start_date)`),
  },
  {
    code: 'U04', level: 'WARN', title: '날짜가 계획 기간 밖이다',
    fix: '계획 기간을 늘리고 그 달들의 인력을 입력한다.',
    sql: q(`SELECT u.update_id AS key, printf('시작 %s · 출시 %s, 계획 기간 끝 %s', coalesce(u.start_date, '-'), coalesce(u.release_date, '-'), s.horizon_end_month) AS detail
      FROM live_updates u, settings s
      WHERE u.release_date > date(s.horizon_end_month || '-01', '+1 month', '-1 day')
         OR u.start_date > date(s.horizon_end_month || '-01', '+1 month', '-1 day')`),
  },
  {
    code: 'U05', level: 'ERROR', title: '런칭이 둘 이상이다',
    fix: '런칭 유형 업데이트를 하나만 남기고 나머지는 다른 유형으로 바꾼다.',
    sql: q(`SELECT key, detail FROM (
      SELECT group_concat(u.update_id, ', ') AS key, printf('런칭이 %d개입니다', count(*)) AS detail, count(*) AS n
      FROM live_updates u JOIN update_types t ON t.update_type_id = u.update_type_id WHERE t.is_launch = 1) WHERE n > 1`),
  },
  {
    code: 'U06', level: 'WARN', title: '우선순위와 출시일이 같은 업데이트가 있다',
    fix: '인력 배정 순서를 정하려면 우선순위를 다르게 준다. 그대로 두면 표시 순서를 따른다.',
    sql: q(`SELECT group_concat(update_id, ', ') AS key, printf('우선순위 %d · 출시일 %s', priority, coalesce(release_date, '없음')) AS detail
      FROM live_updates GROUP BY priority, release_date HAVING count(*) > 1`),
  },
  {
    code: 'U07', level: 'WARN', title: '물량이 없는 업데이트',
    fix: '유형 템플릿에서 물량을 채우거나 업데이트를 취소 상태로 둔다.',
    sql: q(`SELECT u.update_id AS key, '목표 물량이 하나도 없습니다' AS detail FROM live_updates u
      WHERE NOT EXISTS (SELECT 1 FROM volumes v WHERE v.update_id = u.update_id AND coalesce(v.target_qty, 0) > 0)`),
  },

  // ───────── 물량 ─────────
  {
    code: 'V01', level: 'ERROR', title: '물량 템플릿 세 개 중 빈칸이 있다',
    fix: '세 템플릿(기본 이름: 최소안·기본안·최대안)의 수량을 모두 입력한다. 나눌 필요가 없으면 세 값을 같게 둔다.',
    sql: q(`SELECT update_id || '|' || resource_type_id AS key,
        printf('템플릿1 %s · 템플릿2 %s · 템플릿3 %s', coalesce(min_qty, '빈칸'), coalesce(target_qty, '빈칸'), coalesce(stretch_qty, '빈칸')) AS detail
      FROM live_volumes WHERE min_qty IS NULL OR target_qty IS NULL OR stretch_qty IS NULL`),
  },
  {
    // 템플릿은 이름 붙은 수량 묶음이라 순서를 일부러 다르게 둘 수 있다 → 계산을 막지 않는 주의(2026-11-05)
    code: 'V02', level: 'WARN', title: '템플릿 수량이 1 ≤ 2 ≤ 3 순서가 아니다',
    fix: '보통은 템플릿1(최소안) ≤ 템플릿2(기본안) ≤ 템플릿3(최대안)으로 둔다. 일부러 다르게 둔 것이면 그대로 둬도 계산된다.',
    sql: q(`SELECT update_id || '|' || resource_type_id AS key, printf('템플릿1 %d · 템플릿2 %d · 템플릿3 %d', min_qty, target_qty, stretch_qty) AS detail
      FROM live_volumes WHERE min_qty IS NOT NULL AND target_qty IS NOT NULL AND stretch_qty IS NOT NULL
        AND NOT (0 <= min_qty AND min_qty <= target_qty AND target_qty <= stretch_qty)`),
  },
  {
    code: 'V03', level: 'ERROR', title: '난이도·재사용률·외주 수량이 범위 밖이다',
    fix: '난이도 > 0, 재사용률 0–1, 외주 수량 0 이상.',
    sql: q(`SELECT update_id || '|' || resource_type_id AS key, printf('난이도 %g · 재사용률 %g · 외주 %d', difficulty, reuse_rate, outsource_qty) AS detail
      FROM live_volumes WHERE difficulty <= 0 OR reuse_rate NOT BETWEEN 0 AND 1 OR outsource_qty < 0`),
  },
  {
    code: 'V04', level: 'WARN', title: '외주 수량이 물량보다 많다',
    fix: '외주 수량을 템플릿3(최대안) 물량 이하로 고친다. 넘는 만큼은 계산에서 0으로 본다.',
    sql: q(`SELECT update_id || '|' || resource_type_id AS key, printf('외주 %d > 템플릿3 %d', outsource_qty, stretch_qty) AS detail
      FROM live_volumes WHERE stretch_qty IS NOT NULL AND outsource_qty > stretch_qty`),
  },
  {
    code: 'V05', level: 'WARN', title: '쓰지 않는 리소스 종류에 물량이 있다',
    fix: '리소스 종류를 사용으로 바꾸거나 물량을 지운다.',
    sql: q(`SELECT v.update_id || '|' || v.resource_type_id AS key, '사용 안 함 리소스 종류입니다' AS detail
      FROM live_volumes v JOIN resource_types r ON r.resource_type_id = v.resource_type_id WHERE r.active = 0`),
  },

  // ───────── 실적 ─────────
  {
    code: 'A01', level: 'ERROR', title: '완료 수량이 음수다',
    fix: '완료 수량을 0 이상으로 고친다.',
    sql: q(`SELECT update_id || '|' || resource_type_id || '|' || part_id AS key, printf('완료 %d', completed_qty) AS detail FROM progress WHERE completed_qty < 0`),
  },
  {
    code: 'A02', level: 'WARN', title: '완료 수량이 세 번째 템플릿 물량보다 많거나 물량에 없다',
    fix: '물량을 늘리거나 작업 진척을 고친다.',
    sql: q(`SELECT a.update_id || '|' || a.resource_type_id || '|' || a.part_id AS key,
        CASE WHEN v.update_id IS NULL THEN '물량에 없는 리소스의 작업 진척입니다' ELSE printf('완료 %d > 템플릿3 %d', a.completed_qty, v.stretch_qty) END AS detail
      FROM progress a JOIN live_updates u ON u.update_id = a.update_id
      LEFT JOIN volumes v ON v.update_id = a.update_id AND v.resource_type_id = a.resource_type_id
      WHERE v.update_id IS NULL OR (v.stretch_qty IS NOT NULL AND a.completed_qty > v.stretch_qty)`),
  },
  {
    code: 'A03', level: 'WARN', title: '거치지 않는 파트의 작업 진척',
    fix: '파트를 고치거나, 그 파트를 거치는 파트로 추가한다.',
    sql: q(`SELECT a.update_id || '|' || a.resource_type_id || '|' || a.part_id AS key, '이 리소스가 거치지 않는 파트입니다' AS detail
      FROM progress a WHERE NOT EXISTS (SELECT 1 FROM resource_parts rp WHERE rp.resource_type_id = a.resource_type_id AND rp.part_id = a.part_id)`),
  },
  {
    code: 'A04', level: 'WARN', title: '뒤 공정이 앞 공정보다 많이 끝났다',
    fix: '앞 공정 진척이 빠졌는지 확인한다.',
    sql: q(`SELECT b.update_id || '|' || b.resource_type_id || '|' || b.part_id AS key,
        printf('%s 완료 %d > 앞 공정 %s 완료 %d', pb.name, b.completed_qty, pa.name, coalesce(a.completed_qty, 0)) AS detail
      FROM progress b
      JOIN live_updates u ON u.update_id = b.update_id
      JOIN parts pb ON pb.part_id = b.part_id
      JOIN step_pos sb ON sb.resource_type_id = b.resource_type_id AND sb.part_id = b.part_id
      JOIN step_pos sa ON sa.resource_type_id = b.resource_type_id AND sa.pos < sb.pos
      JOIN parts pa ON pa.part_id = sa.part_id AND pa.active = 1
      LEFT JOIN progress a ON a.update_id = b.update_id AND a.resource_type_id = b.resource_type_id AND a.part_id = sa.part_id
      WHERE b.completed_qty > coalesce(a.completed_qty, 0)`),
  },

  // ───────── 인력 ─────────
  {
    code: 'C01', level: 'ERROR', title: '계획 기간 중 인력이 없는 달이 있다',
    fix: '빠진 달의 인력을 입력한다("마지막 달 값으로 채우기"를 써도 된다).',
    sql: q(`SELECT p.part_id AS key, printf('인력 행이 없는 달 %d개 (처음 %s)', count(*), min(m.month)) AS detail
      FROM parts p CROSS JOIN horizon_months m
      WHERE p.active = 1 AND NOT EXISTS (SELECT 1 FROM capacity c WHERE c.part_id = p.part_id AND c.month = m.month)
      GROUP BY p.part_id`),
  },
  {
    code: 'C02', level: 'ERROR', title: '인력 값이 범위 밖이다',
    fix: '인원·외주·지원 0 이상, 가동률 0–1, 생산성 0보다 크게.',
    sql: q(`SELECT part_id || '|' || month AS key,
        printf('인원 %g · 가동률 %g · 생산성 %g · 외주 %g · 지원 %g', headcount, utilization, productivity, outsource_days, support_days) AS detail
      FROM capacity WHERE headcount < 0 OR utilization NOT BETWEEN 0 AND 1 OR productivity <= 0 OR outsource_days < 0 OR support_days < 0`),
  },
  {
    code: 'C03', level: 'WARN', title: '할 일이 있는데 작업 가능량이 계속 0인 파트',
    fix: '인원·외주·지원 중 하나를 넣는다. 그대로면 그 파트를 거치는 일은 끝나지 않는다.',
    sql: q(`SELECT p.part_id AS key, '계획 기간 내내 작업 가능량이 0입니다' AS detail FROM parts p
      WHERE p.active = 1
        AND EXISTS (SELECT 1 FROM resource_parts rp JOIN live_volumes v ON v.resource_type_id = rp.resource_type_id WHERE rp.part_id = p.part_id AND coalesce(v.target_qty, 0) > 0)
        AND NOT EXISTS (SELECT 1 FROM capacity c JOIN horizon_months m ON m.month = c.month
          WHERE c.part_id = p.part_id AND (c.headcount * c.utilization * c.productivity > 0 OR c.outsource_days > 0 OR c.support_days > 0))`),
  },

  // ───────── 유형 템플릿 ─────────
  {
    code: 'T01', level: 'WARN', title: '유형 템플릿 물량이 비었거나 순서가 틀렸다',
    fix: '세 수량(최소안·기본안·최대안)을 채우고 보통은 작은 것부터 둔다. 이 템플릿으로 만드는 새 업데이트가 같은 값을 받는다.',
    sql: q(`SELECT update_type_id || '|' || resource_type_id AS key,
        printf('템플릿1 %s · 템플릿2 %s · 템플릿3 %s', coalesce(min_qty, '빈칸'), coalesce(target_qty, '빈칸'), coalesce(stretch_qty, '빈칸')) AS detail
      FROM type_templates WHERE min_qty IS NULL OR target_qty IS NULL OR stretch_qty IS NULL
        OR NOT (0 <= min_qty AND min_qty <= target_qty AND target_qty <= stretch_qty)`),
  },

  // ───────── 시나리오 ─────────
  {
    code: 'X01', level: 'WARN', title: '시나리오가 고치려는 대상이 원본에 없다',
    fix: '그 변경을 삭제하거나, 대상이 새로 생길 것이면 INSERT로 바꾼다.',
    sql: q(`SELECT sc.scenario_id || '#' || sc.seq AS key, printf('%s %s 대상이 없습니다', sc.target, sc.target_key) AS detail
      FROM scenario_changes sc WHERE sc.op IN ('SET', 'DELETE') AND NOT (
           sc.target = 'settings'
        OR (sc.target = 'part_overlaps'  AND EXISTS (SELECT 1 FROM part_overlaps  x WHERE x.from_part_id || '|' || x.to_part_id = sc.target_key))
        OR (sc.target = 'resource_parts' AND EXISTS (SELECT 1 FROM resource_parts x WHERE x.resource_type_id || '|' || x.part_id = sc.target_key))
        OR (sc.target = 'efforts'        AND EXISTS (SELECT 1 FROM efforts        x WHERE x.resource_type_id || '|' || x.part_id || '|' || x.profile_id = sc.target_key))
        OR (sc.target = 'effort_mix'     AND EXISTS (SELECT 1 FROM effort_mix     x WHERE x.part_id || '|' || x.profile_id = sc.target_key))
        OR (sc.target = 'updates'        AND EXISTS (SELECT 1 FROM updates        x WHERE x.update_id = sc.target_key))
        OR (sc.target = 'volumes'        AND EXISTS (SELECT 1 FROM volumes        x WHERE x.update_id || '|' || x.resource_type_id = sc.target_key))
        OR (sc.target = 'capacity'       AND EXISTS (SELECT 1 FROM capacity       x WHERE x.part_id || '|' || x.month = sc.target_key)))`),
  },
  {
    code: 'X02', level: 'WARN', title: '원본이 바뀌기 전에 만든 시나리오',
    fix: '시나리오 결과를 다시 계산해 확인한다. 바뀐 원본 위에서 계산된다.',
    // 저장할 때마다 오르는 데이터 버전이 아니라, 시나리오를 만든 뒤 계획 데이터를 고친 변경 이력이 있는지로 본다
    sql: q(`SELECT s.scenario_id AS key, printf('시나리오를 만든 뒤 원본을 %d번 고쳤습니다', count(c.log_id)) AS detail
      FROM scenarios s JOIN change_log c ON c.at > s.created_at
      WHERE s.applied_at IS NULL
      GROUP BY s.scenario_id`),
  },
];
