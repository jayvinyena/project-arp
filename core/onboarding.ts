// 프로젝트 설정 단계(docs/23-ux-review.md 6.2 · 6.4): 처음 할 일 안내와 처음 화면 고르기에 쓴다.
import type { SqlDb } from './db.ts';

export interface SetupStatus {
  /** 1. 리소스 종류가 있고 1개당 기본 공수가 0보다 큰 칸이 있다 */
  resources: boolean;
  /** 2. 인원이 0보다 큰 파트 × 달이 있다 */
  capacity: boolean;
  /** 3. 계산하는 업데이트(첫 번째 = 보통 런칭)에 물량이 있다 */
  volume: boolean;
  /** 4. (선택) 에셋이 있다 */
  assets: boolean;
  /** 제작 기록(에셋 또는 완료 수량)이 있다 — 처음 화면을 현황판으로 */
  records: boolean;
  /** 첫 업데이트 ID(물량 화면으로 갈 때) */
  firstUpdateId: string | null;
}

const has = (db: SqlDb, sql: string) => !!db.get(`SELECT 1 AS ok WHERE EXISTS (${sql})`);

export function setupStatus(db: SqlDb): SetupStatus {
  const first = db.get(`SELECT update_id FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS') ORDER BY priority, sort_order LIMIT 1`);
  const assets = has(db, 'SELECT 1 FROM assets');
  return {
    resources: has(db, `SELECT 1 FROM efforts e JOIN resource_types r ON r.resource_type_id = e.resource_type_id WHERE r.active = 1 AND e.profile_id = 'BASE' AND e.days > 0`),
    capacity: has(db, 'SELECT 1 FROM capacity WHERE headcount > 0'),
    volume: has(db, `SELECT 1 FROM volumes v JOIN updates u ON u.update_id = v.update_id WHERE u.status IN ('PLANNED', 'IN_PROGRESS') AND coalesce(v.target_qty, 0) + coalesce(v.stretch_qty, 0) > 0`),
    assets,
    records: assets || has(db, 'SELECT 1 FROM progress WHERE completed_qty > 0'),
    firstUpdateId: first ? String(first.update_id) : null,
  };
}
