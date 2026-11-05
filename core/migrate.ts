// 파일 구조 버전 전환 (docs/02-file-format.md 5절)
// 새 파일도 v1 구조를 만든 뒤 이 단계를 차례로 밟는다. 그래서 "새로 만든 파일"과 "옛 파일을 바꾼 것"이 항상 같다.
import type { SqlDb } from './db.ts';

export const LATEST_SCHEMA = 2;

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
];

export interface MigrationResult { from: number; to: number; notes: string[] }

/** 지금 버전에서 최신까지. 한 트랜잭션이라 실패하면 그대로다. 더 새 버전이면 거절 */
export function migrate(db: SqlDb): MigrationResult {
  const from = Number(db.get('PRAGMA user_version')?.user_version ?? 0);
  if (from > LATEST_SCHEMA) throw new Error(`더 새 구조(v${from})의 파일이에요. 앱을 새로 고쳐 주세요.`);
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
    throw new Error(`구조를 바꾸지 못했어요: ${(error as Error).message}`);
  }
  return { from, to: LATEST_SCHEMA, notes: steps.map(s => s.note) };
}
