// 샘플 3 · 빈 값과 잘못된 값: 정상 샘플에 흔한 입력 실수를 넣었다.
// 파일은 문제없이 저장되고(형식은 맞음), 검증이 아래 규칙들을 찾아내야 한다.
import { build as buildNormal } from './normal.mjs';

export const expect = {
  errors: ['C01', 'E03', 'P03', 'U01', 'V01', 'V02'],
  warnings: ['A04', 'T01', 'U02', 'X01'],
};

export function build() {
  const data = buildNormal();
  data.meta.find(r => r.key === 'project_name').value = '샘플 · 빈 값';

  const update = id => data.updates.find(u => u.update_id === id);
  const volume = (u, rt) => data.volumes.find(v => v.update_id === u && v.resource_type_id === rt);

  update('S2').release_date = null;                 // U02 출시일 없음
  update('MINI1').start_date = null;                // U01 시작일 없음
  volume('LAUNCH', 'COSTUME').min_qty = null;       // V01 빈칸
  volume('LAUNCH', 'ICON').min_qty = 90;            // V02 최저 90 > 목표 80

  // E03 배경 맵 모델링 기본 공수 빠짐(AI 공수만 있음)
  data.efforts = data.efforts.filter(e => !(e.resource_type_id === 'BG_MAP' && e.part_id === 'MODELING' && e.profile_id === 'BASE'));

  // C01 FX 마지막 3개월 인력 없음
  data.capacity = data.capacity.filter(c => !(c.part_id === 'FX' && c.month >= '2027-10'));

  // P03 겹침률 1.5
  data.part_overlaps.find(o => o.from_part_id === 'ANIMATION').overlap_rate = 1.5;

  // A04 애니메이션 완료 2 > 모델링 완료 1
  data.progress.push({ update_id: 'LAUNCH', resource_type_id: 'CHAR_NEW', part_id: 'ANIMATION', completed_qty: 2, as_of: '2026-11-04' });

  // T01 미니 템플릿 코스튬 확장 빈칸
  data.type_templates.find(t => t.update_type_id === 'MINI' && t.resource_type_id === 'COSTUME').stretch_qty = null;

  // X01 시나리오가 계획 기간 밖 달을 고침
  data.scenario_changes.push({ scenario_id: 'SC1', seq: 5, op: 'SET', target: 'capacity', target_key: 'MODELING|2030-01', field: 'headcount', value_json: '6' });

  return data;
}
