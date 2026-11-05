// 물량 템플릿 3개(엔진의 MIN · TARGET · STRETCH)의 이름. 프로젝트마다 meta에 둔다(mode_name_MIN …).
// 엔진·파일 구조는 그대로(min_qty · target_qty · stretch_qty)이고, 사람에게 보이는 이름만 바꾼다.
import type { PlanMode } from '../engine/types.ts';

export const PLAN_MODES: PlanMode[] = ['MIN', 'TARGET', 'STRETCH'];
export const DEFAULT_MODE_NAMES: Record<PlanMode, string> = { MIN: '최소안', TARGET: '기본안', STRETCH: '최대안' };
export const MODE_FIELD: Record<PlanMode, 'min_qty' | 'target_qty' | 'stretch_qty'> = { MIN: 'min_qty', TARGET: 'target_qty', STRETCH: 'stretch_qty' };
export const modeMetaKey = (m: PlanMode) => `mode_name_${m}`;

/** meta 표(키 → 값)에서 템플릿 이름. 없으면 기본 이름 */
export function modeNamesFrom(meta: Record<string, unknown>): Record<PlanMode, string> {
  const out = { ...DEFAULT_MODE_NAMES };
  for (const m of PLAN_MODES) {
    const v = meta[modeMetaKey(m)];
    if (typeof v === 'string' && v.trim()) out[m] = v.trim();
  }
  return out;
}

/** DB에서 바로 읽기 */
export function readModeNames(db: { all(sql: string, params?: unknown[]): Record<string, unknown>[] }): Record<PlanMode, string> {
  return modeNamesFrom(Object.fromEntries(db.all("SELECT key, value FROM meta WHERE key LIKE 'mode_name_%'").map(r => [String(r.key), r.value])));
}
