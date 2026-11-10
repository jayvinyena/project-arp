// 파일 구조 버전 전환 (docs/02-file-format.md 5절)
// 새 파일도 v1 구조를 만든 뒤 이 단계를 차례로 밟는다. 그래서 "새로 만든 파일"과 "옛 파일을 바꾼 것"이 항상 같다.
import type { SqlDb } from './db.ts';

export const LATEST_SCHEMA = 11;

/**
 * 파이프라인이 없는(또는 없는 파이프라인을 고른) 리소스에 "기본" 파이프라인을 만들어 준다(docs/29).
 * 단계 = 그 리소스들이 실제로 거치는 파트(파트 표 순서) — 아무도 거치지 않는 파트는 넣지 않는다.
 * allParts면(새 프로젝트) 파이프라인이 하나도 없을 때 사용 중 파트 모두를 마법사 순서로.
 * 단계 겹침률은 비워 두므로(파트 쌍 → 기본 값을 물려받음) 계산 결과는 그대로다.
 */
export function defaultPipelineSql(allParts = false): string {
  const orphan = (t: string) => `(${t}.pipeline_id IS NULL OR NOT EXISTS (SELECT 1 FROM pipelines x WHERE x.pipeline_id = ${t}.pipeline_id))`;
  return `
    DROP TABLE IF EXISTS temp._arp_dp;
    CREATE TEMP TABLE _arp_dp AS
      SELECT CASE WHEN EXISTS (SELECT 1 FROM pipelines WHERE pipeline_id = 'L00') THEN 'L00B' ELSE 'L00' END AS id,
             CASE WHEN EXISTS (SELECT 1 FROM pipelines WHERE name = '기본') THEN '기본 순서' ELSE '기본' END AS name
      WHERE EXISTS (SELECT 1 FROM resource_types r WHERE ${orphan('r')})
        ${allParts ? 'OR (NOT EXISTS (SELECT 1 FROM pipelines) AND EXISTS (SELECT 1 FROM parts WHERE active = 1))' : ''};
    INSERT INTO pipelines (pipeline_id, name, sort_order)
      SELECT id, name, coalesce((SELECT min(sort_order) FROM pipelines), 1) - 1 FROM _arp_dp;
    INSERT INTO pipeline_steps (pipeline_id, part_id, seq, overlap_rate)
      SELECT (SELECT id FROM _arp_dp), p.part_id, ROW_NUMBER() OVER (ORDER BY p.sort_order, p.part_id), NULL FROM parts p
      WHERE EXISTS (SELECT 1 FROM _arp_dp) AND (
        p.part_id IN (SELECT rp.part_id FROM resource_parts rp JOIN resource_types r ON r.resource_type_id = rp.resource_type_id WHERE ${orphan('r')})
        ${allParts ? 'OR p.active = 1' : ''});
    UPDATE resource_types SET pipeline_id = (SELECT id FROM _arp_dp) WHERE EXISTS (SELECT 1 FROM _arp_dp) AND ${orphan('resource_types')};
    DROP TABLE temp._arp_dp;
  `;
}

/** 파일을 새로 쓴 뒤(새 프로젝트 · 옛 도구 가져오기 · 예시 파일) 부른다 */
export function ensureDefaultPipeline(db: SqlDb, allParts = false): void {
  db.exec(defaultPipelineSql(allParts));
}

const STEPS: { to: number; note: string; sql: string }[] = [
  {
    to: 2,
    note: '시나리오 변경을 동작 단위로 묶기(group_no·label), 원본 반영 기록(applied_at)',
    sql: `
      ALTER TABLE scenario_changes ADD COLUMN group_no INTEGER;
      ALTER TABLE scenario_changes ADD COLUMN label TEXT;
      ALTER TABLE scenarios ADD COLUMN applied_at TEXT;
      UPDATE scenario_changes SET group_no = seq WHERE group_no IS NULL;
    `,
  },
  {
    to: 3,
    note: '실적에 실투입 공수(spent_days, 인·일) — 공수 보정 제안에 쓴다',
    sql: `ALTER TABLE progress ADD COLUMN spent_days REAL;`,
  },
  {
    to: 4,
    note: '에셋 관리: 배치 · 에셋 · 에셋 파트별 상태 · 썸네일(docs/20-asset-management.md)',
    sql: `
      CREATE TABLE batches (
        batch_id   TEXT PRIMARY KEY,
        update_id  TEXT NOT NULL REFERENCES updates(update_id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        due_date   TEXT CHECK (due_date IS NULL OR (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(due_date) = due_date)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        note       TEXT
      ) STRICT;
      CREATE TABLE assets (
        asset_id         TEXT PRIMARY KEY,
        update_id        TEXT NOT NULL REFERENCES updates(update_id) ON DELETE CASCADE,
        batch_id         TEXT REFERENCES batches(batch_id) ON DELETE SET NULL,
        resource_type_id TEXT NOT NULL REFERENCES resource_types(resource_type_id),
        name             TEXT NOT NULL,
        code             TEXT,
        tier             TEXT NOT NULL DEFAULT 'TARGET' CHECK (tier IN ('MIN', 'TARGET', 'STRETCH')),
        jira_key         TEXT,
        note             TEXT,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL
      ) STRICT;
      CREATE INDEX assets_by_update ON assets(update_id, resource_type_id);
      CREATE INDEX assets_by_batch ON assets(batch_id);
      -- 상태가 대기가 아닌 파트만 행이 있다(없으면 대기)
      CREATE TABLE asset_parts (
        asset_id   TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        part_id    TEXT NOT NULL REFERENCES parts(part_id),
        status     TEXT NOT NULL CHECK (status IN ('TODO', 'WIP', 'REVIEW', 'RETAKE', 'DONE', 'HOLD', 'OMIT')),
        started_at TEXT,
        done_at    TEXT CHECK (done_at IS NULL OR (done_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(done_at) = done_at)),
        retakes    INTEGER NOT NULL DEFAULT 0,
        assignee   TEXT,
        jira_key   TEXT,
        PRIMARY KEY (asset_id, part_id)
      ) STRICT;
      CREATE TABLE asset_thumbs (
        asset_id   TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
        mime       TEXT NOT NULL,
        data       BLOB NOT NULL,
        width      INTEGER,
        height     INTEGER,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    to: 5,
    note: '에셋 카드: 에셋 마감일 · 링크 · 댓글(docs/20-asset-management.md 16절)',
    sql: `
      ALTER TABLE assets ADD COLUMN due_date TEXT CHECK (due_date IS NULL OR (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(due_date) = due_date));
      CREATE TABLE asset_links (
        link_id    TEXT PRIMARY KEY,
        asset_id   TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        url        TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX asset_links_by_asset ON asset_links(asset_id);
      CREATE TABLE asset_comments (
        comment_id TEXT PRIMARY KEY,
        asset_id   TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        at         TEXT NOT NULL,
        author     TEXT NOT NULL,
        body       TEXT NOT NULL
      ) STRICT;
      CREATE INDEX asset_comments_by_asset ON asset_comments(asset_id);
    `,
  },
  {
    to: 6,
    note: '에셋 세부 분류 · 속성(팀 제작 리스트 가져오기, docs/20-asset-management.md 19절)',
    sql: `
      ALTER TABLE assets ADD COLUMN category TEXT;
      CREATE TABLE asset_attrs (
        asset_id   TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        value      TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (asset_id, name)
      ) STRICT;
    `,
  },
  {
    to: 7,
    note: '작업자 명단: 이름 · 소속팀 · 이메일 · 특이사항 · 참여(docs/24-people.md)',
    sql: `
      CREATE TABLE people (
        person_id  TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        team       TEXT,
        email      TEXT,
        note       TEXT,
        active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `,
  },
  {
    to: 8,
    note: '소식: 편집자가 쓰는 짧은 글(보기 모드 첫 화면, docs/26-viewer.md)',
    sql: `
      CREATE TABLE news (
        news_id   TEXT PRIMARY KEY,
        at        TEXT NOT NULL,
        author    TEXT NOT NULL,
        title     TEXT NOT NULL,
        body      TEXT,
        important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1))
      ) STRICT;
      CREATE INDEX news_by_at ON news(at);
    `,
  },
  {
    to: 9,
    note: '작업자 소속팀은 목록에서만: 파트 + 지원 팀(PM · 기획 등). 지금 적힌 소속팀 중 파트가 아닌 것은 지원 팀으로 옮긴다(docs/24-people.md)',
    sql: `
      CREATE TABLE teams (
        team_id    TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO teams (team_id, name, sort_order)
        SELECT printf('T%02d', row_number() OVER (ORDER BY min(sort_order), team)), team, row_number() OVER (ORDER BY min(sort_order), team)
        FROM people WHERE team IS NOT NULL AND team <> '' AND team NOT IN (SELECT name FROM parts) GROUP BY team;
    `,
  },
  {
    to: 10,
    note: '리소스별 파이프라인: 이름 붙인 단계 목록(순서 · 단계 겹침률), 리소스가 하나를 고른다. 고르지 않으면 지금처럼 파트 표 순서(docs/28-resource-pipelines.md)',
    sql: `
      CREATE TABLE pipelines (
        pipeline_id TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        sort_order  INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE pipeline_steps (
        pipeline_id  TEXT NOT NULL REFERENCES pipelines(pipeline_id) ON DELETE CASCADE,
        part_id      TEXT NOT NULL REFERENCES parts(part_id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        overlap_rate REAL CHECK (overlap_rate IS NULL OR overlap_rate BETWEEN 0 AND 1),
        PRIMARY KEY (pipeline_id, part_id)
      ) STRICT;
      ALTER TABLE resource_types ADD COLUMN pipeline_id TEXT;
    `,
  },
  {
    to: 11,
    note: '파트 목록과 파이프라인 나누기: 파이프라인이 없는 리소스는 "기본" 파이프라인(그 리소스들이 거치는 파트만, 파트 표 순서)으로. 계산은 그대로(docs/29-pipeline-catalog.md)',
    sql: defaultPipelineSql(),
  },
];

export interface MigrationResult { from: number; to: number; notes: string[] }

/** 지금 버전에서 최신까지. 한 트랜잭션이라 실패하면 그대로다. 더 새 버전이면 거절 */
export function migrate(db: SqlDb): MigrationResult {
  const from = Number(db.get('PRAGMA user_version')?.user_version ?? 0);
  if (from > LATEST_SCHEMA) throw new Error(`더 새 구조(v${from})의 파일입니다. 앱을 새로 고침하십시오.`);
  const steps = STEPS.filter(s => s.to > from);
  if (!steps.length) return { from, to: from, notes: [] };
  db.exec('BEGIN');
  try {
    for (const s of steps) {
      db.exec(s.sql);
      db.exec(`PRAGMA user_version = ${s.to}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`구조를 바꾸지 못했습니다: ${(error as Error).message}`);
  }
  return { from, to: LATEST_SCHEMA, notes: steps.map(s => s.note) };
}
