// 화면에서 쓰는 물량 템플릿 이름(프로젝트마다 다름). App이 파일을 열 때마다 meta에서 채운다.
import type { PlanMode } from '../../../engine/types.ts';
import { DEFAULT_MODE_NAMES, modeNamesFrom } from '../../../core/modes.ts';

export const MODE_LABEL: Record<PlanMode, string> = { ...DEFAULT_MODE_NAMES };
export function setModeNames(meta: Record<string, unknown>): void {
  Object.assign(MODE_LABEL, modeNamesFrom(meta));
}
