// docs/03-validation-rules.md 만들기 (규칙 원본: rules/validation-rules.mjs)
//   node tools/gen-rules-doc.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RULES, AREAS } from '../rules/validation-rules.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const lines = [
  '# 검증 규칙 v1',
  '',
  '> 이 문서는 `rules/validation-rules.mjs`에서 만든다(`node tools/gen-rules-doc.mjs`). 직접 고치지 않는다.',
  '',
  '## 등급',
  '',
  '| 등급 | 뜻 |',
  '|---|---|',
  '| **오류** | 계산 불가. 모든 업데이트가 같은 인력을 나눠 쓰므로, 한 곳이 틀리면 다른 업데이트의 결과도 틀린다. 그래서 일부만 계산하지 않고 전체를 막고 이유를 보여준다. |',
  '| **주의** | 계산은 하고 결과 옆에 표시한다. |',
  '',
  '- 검사 대상 업데이트는 상태가 **계획** 또는 **진행**인 것만이다. 완료·취소 업데이트는 계산에도 검사에도 넣지 않는다.',
  '- 시나리오 계산은 원본에 시나리오 변경을 얹은 데이터로 같은 규칙을 다시 돌린다(1단계 엔진).',
  '- 표 형식(숫자 칸에 글자, 날짜 모양, 없는 ID 참조)은 저장 단계에서 막으므로 여기에 없다. [데이터 모델](01-data-model.md) 참고.',
  '',
  `## 규칙 (${RULES.length}개: 오류 ${RULES.filter(r => r.level === 'ERROR').length} · 주의 ${RULES.filter(r => r.level === 'WARN').length})`,
  '',
];

for (const [prefix, area] of Object.entries(AREAS)) {
  const rules = RULES.filter(r => r.code.startsWith(prefix));
  if (!rules.length) continue;
  lines.push(`### ${area}`, '', '| 코드 | 등급 | 문제 | 고치는 방법 |', '|---|---|---|---|');
  for (const r of rules) lines.push(`| ${r.code} | ${r.level === 'ERROR' ? '오류' : '주의'} | ${r.title} | ${r.fix} |`);
  lines.push('');
}

writeFileSync(`${ROOT}docs/03-validation-rules.md`, lines.join('\n'), 'utf8');
console.log('docs/03-validation-rules.md 갱신');
