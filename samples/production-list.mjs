// 팀 제작 리스트 형식의 가상 예시(docs/20-asset-management.md 19절). 실제 사내 자료가 아니다.
// 단위 검사(test/sheet-import.test.mjs)와 크롬 시험(tools/e2e-sheet-import.mjs)이 함께 쓴다.
// 가상의 제작 리스트: 캐릭터(한 줄 머리글 · 링크) · 코스튬(두 줄 머리글) · 요약(이름 칸 없음) · 레벨(파트 칸 없음)
export const BOOK = {
  '캐릭터': [
    ['캐릭터 제작 리스트'],
    ['마일스톤', '분류', '이름', '리소스명', '기획서', '관련 에픽', '속성', '등장 지역', '원화', '모델링', '애니', 'FX', '비고'],
    ['M1', '신규 캐릭터', '바람 기사', 'CH_WindKnight', '문서', 'ART-12', '바람', '초원', '완료', '완료', '작업 대기중', '없음', '보스 후보'],
    ['M1', '신규 캐릭터', '불꽃 마법사', 'CH_FireMage', null, 'ART-13', '불', null, '완료', null, null, null, null],
    ['시즌 1', '신규 캐릭터', '물의 정령', 'CH_WaterSpirit', null, null, '물', '호수', null, null, null, null, null],
    ['M9', '신규 캐릭터', '모르는 마일스톤', 'CH_Unknown', null, null, null, null, '완료', null, null, null, null],
    [null, null, null, null, null, null, null, null, null, null, null, null, null],
  ],
  '코스튬': [
    ['마일스톤', '대분류', '분류', '이름', '파트 상태', '파트 상태', '파트 상태', '데이터 연결', '원화 담당', null],
    [null, null, null, null, '원화', '모델링', '애니메이션', null, null, 'FX'],
    ['M1', '코스튬', '상의', '여름 셔츠', '완료', '진행', null, 'ITEM_001', '김원화', '완료'],
    ['미니 1', '신규', '캐릭터', '미니 손님', '완료', null, null, null, null, null],
  ],
  '요약': [['구분', '수량'], ['캐릭터', 4]],
  '레벨': [['이름', '경로'], ['초원 1', 'Levels/Field01']],
};
export const LINKS = { '캐릭터': { '2,4': 'https://docs.example.com/spec/wind', '2,5': 'https://example.atlassian.net/browse/ART-12' } };
