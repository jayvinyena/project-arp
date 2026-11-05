// 샘플 2 · 과부하: 검증 문제는 없지만 런칭 물량이 3배, 인원이 절반, 외주가 없다.
// 1단계 엔진이 "늦음"과 병목 파트를 찾아내는지 보는 데이터.
import { build as buildNormal } from './normal.mjs';

export const expect = { errors: [], warnings: [], minLoadRate: 1.2 };

export function build() {
  const data = buildNormal();
  data.meta.find(r => r.key === 'project_name').value = '샘플 · 과부하';
  for (const v of data.volumes) {
    if (v.update_id !== 'LAUNCH') continue;
    v.min_qty *= 3; v.target_qty *= 3; v.stretch_qty *= 3;
  }
  for (const c of data.capacity) {
    c.headcount /= 2;
    c.outsource_days = 0;
  }
  return data;
}
