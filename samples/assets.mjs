// 샘플 4 · 에셋: 정상 샘플 + 런칭의 에셋 · 배치(docs/20-asset-management.md).
// 신규 캐릭터는 정상 샘플의 작업 진척(원화 3 · 모델링 1, 기준일 11-04)과 같은 상태라 계산 결과가 정상 샘플과 같다.
// 화면 캡처 · 크롬 시험용. 썸네일은 시험에서 넣는다.
import { build as buildNormal } from './normal.mjs';

export const expect = { errors: [], warnings: [] };

const CHARS = ['용감한 쿠키', '딸기맛 쿠키', '마법사맛 쿠키', '닌자맛 쿠키', '천사맛 쿠키', '좀비맛 쿠키', '연금술사맛 쿠키', '해적맛 쿠키', '달빛술사 쿠키', '바다요정 쿠키', '서리여왕 쿠키', '불꽃정령 쿠키'];
const COSTUMES = ['학교 교복', '여름 수영복', '겨울 털옷', '할로윈 망토', '크리스마스 리본', '설날 한복', '봄꽃 원피스', '기사 갑옷'];

export function build() {
  const data = buildNormal();
  data.meta.find(r => r.key === 'project_name').value = '샘플 · 에셋';
  const at = '2026-11-01T09:00:00.000Z';
  data.batches = [
    { batch_id: 'B001', update_id: 'LAUNCH', name: '1차 납품', due_date: '2027-01-29', sort_order: 1, note: null },
    { batch_id: 'B002', update_id: 'LAUNCH', name: '2차 납품', due_date: '2027-03-31', sort_order: 2, note: null },
  ];
  data.assets = [];
  data.asset_parts = [];
  let n = 0;
  const tierOf = (i, [min, target]) => (i < min ? 'MIN' : i < target ? 'TARGET' : 'STRETCH');
  CHARS.forEach((name, i) => {
    const id = `A${String((n += 1)).padStart(5, '0')}`;
    data.assets.push({
      asset_id: id, update_id: 'LAUNCH', batch_id: i < 6 ? 'B001' : 'B002', resource_type_id: 'CHAR_NEW', name, code: `CK_${String(i + 1).padStart(3, '0')}`,
      tier: tierOf(i, [8, 10]), jira_key: i < 4 ? `ART-${101 + i}` : null, note: null, sort_order: i + 1, created_at: at,
    });
    // 정상 샘플의 작업 진척과 같게: 원화 3개 완료, 모델링 1개 완료(기준일 11-04)
    if (i < 3) data.asset_parts.push({ asset_id: id, part_id: 'CONCEPT', status: 'DONE', started_at: '2026-11-02', done_at: '2026-11-04', retakes: i === 1 ? 1 : 0, assignee: '김원화', jira_key: null });
    if (i === 3) data.asset_parts.push({ asset_id: id, part_id: 'CONCEPT', status: 'REVIEW', started_at: '2026-11-02', done_at: null, retakes: 0, assignee: '김원화', jira_key: null });
    if (i === 4) data.asset_parts.push({ asset_id: id, part_id: 'CONCEPT', status: 'WIP', started_at: '2026-11-04', done_at: null, retakes: 0, assignee: '이원화', jira_key: null });
    if (i === 0) data.asset_parts.push({ asset_id: id, part_id: 'MODELING', status: 'DONE', started_at: '2026-11-03', done_at: '2026-11-04', retakes: 0, assignee: '박모델', jira_key: null });
    if (i === 1) data.asset_parts.push({ asset_id: id, part_id: 'MODELING', status: 'RETAKE', started_at: '2026-11-04', done_at: null, retakes: 1, assignee: '박모델', jira_key: null });
    if (i === 11) data.asset_parts.push({ asset_id: id, part_id: 'CONCEPT', status: 'HOLD', started_at: null, done_at: null, retakes: 0, assignee: null, jira_key: null });
  });
  COSTUMES.forEach((name, i) => {
    const id = `A${String((n += 1)).padStart(5, '0')}`;
    data.assets.push({
      asset_id: id, update_id: 'LAUNCH', batch_id: i < 4 ? 'B001' : null, resource_type_id: 'COSTUME', name, code: null,
      tier: 'MIN', jira_key: null, note: null, sort_order: i + 1, created_at: at,
    });
    if (i < 2) data.asset_parts.push({ asset_id: id, part_id: 'CONCEPT', status: 'WIP', started_at: '2026-11-04', done_at: null, retakes: 0, assignee: '이원화', jira_key: null });
  });
  data.meta.push({ key: 'jira_base_url', value: 'https://example.atlassian.net/browse/' });
  // 소식(가상): 보기 모드 첫 화면 시험용
  data.news = [
    { news_id: 'N0001', at: '2026-11-03T09:00:00.000Z', author: '김피엠', title: '런칭 1차 납품 범위 확정', body: '신규 캐릭터 6종 · 코스튬 4종을 1차 납품에 넣습니다.', important: 0 },
    { news_id: 'N0002', at: '2026-11-06T09:00:00.000Z', author: '김피엠', title: '원화 검수 일정 하루 당김', body: null, important: 1 },
  ];
  // 작업자 명단(가상): 에셋 담당 이름과 같게
  data.people = [
    { person_id: 'P001', name: '김원화', team: '원화', email: 'kim@example.com', note: null, active: 1, sort_order: 1 },
    { person_id: 'P002', name: '이원화', team: '원화', email: null, note: '12월 휴가 예정', active: 1, sort_order: 2 },
    { person_id: 'P003', name: '박모델', team: '모델링', email: 'park@example.com', note: null, active: 1, sort_order: 3 },
    { person_id: 'P004', name: '최애니', team: '애니메이션', email: null, note: '외주', active: 0, sort_order: 4 },
  ];
  return data;
}
