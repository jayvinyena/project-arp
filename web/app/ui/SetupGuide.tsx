// 처음 할 일 안내(docs/23-ux-review.md 6.4): 새 프로젝트 · 비어 있는 프로젝트에서 무엇부터 채울지.
// 단계는 데이터로 자동 체크하고, 누르면 그 화면으로 간다. 필수 3단계가 끝나면 사라진다.
import type { SetupStatus } from '../../../core/onboarding.ts';
import type { HelpPage } from './Help.tsx';
import { IconX } from './icons.tsx';

const STEPS: { key: keyof SetupStatus; page: HelpPage; title: string; sub: string; optional?: boolean }[] = [
  { key: 'resources', page: 'setup', title: '파트 · 리소스 · 공수', sub: '리소스 종류와 1개당 공수(인·일)' },
  { key: 'capacity', page: 'capacity', title: '인력', sub: '파트 × 달 인원 · 가동률' },
  { key: 'volume', page: 'launch', title: '런칭 물량', sub: '계산할 업데이트의 물량' },
  { key: 'assets', page: 'assets', title: '에셋', sub: '제작 리스트 엑셀 가져오기 · 에셋 더하기', optional: true },
];

/** 필수 단계가 모두 끝났나 */
export const setupDone = (s: SetupStatus) => STEPS.every(x => x.optional || s[x.key]);

export function SetupGuide(props: { status: SetupStatus; onGo: (page: HelpPage) => void; onHide: () => void }) {
  const need = STEPS.filter(x => !x.optional);
  const done = need.filter(x => props.status[x.key]).length;
  const next = STEPS.find(x => !props.status[x.key]);
  return (
    <section class="card setup-guide" aria-label="처음 할 일">
      <div class="setup-guide-head">
        <div><h2>처음 할 일 <span class="small faint">{done} / {need.length} 끝남</span></h2>
          <p class="small muted" style="margin-top: 2px">위에서부터 채우면 완료 예정이 계산됩니다. 채운 단계는 자동으로 체크되고, 필수 단계가 끝나면 이 안내는 사라집니다.</p></div>
        <button type="button" class="btn ghost icon-btn" aria-label="처음 할 일 안내 닫기" title="이 파일에서 다시 보지 않기" onClick={props.onHide}><IconX /></button>
      </div>
      <ol class="setup-steps">
        {STEPS.map((x, i) => {
          const ok = !!props.status[x.key];
          return (
            <li>
              <button type="button" class={`setup-step${ok ? ' done' : ''}${next === x ? ' next' : ''}`} onClick={() => props.onGo(x.page)}>
                <span class="setup-step-mark" aria-hidden="true">{ok ? '✓' : i + 1}</span>
                <span class="setup-step-text"><b>{x.title}{x.optional && <span class="faint small"> · 선택</span>}</b><span class="small faint">{x.sub}</span></span>
                <span class="sr-only">{ok ? '끝남' : '아직'}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
