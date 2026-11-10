// 사용 동선 시험(크롬, 화면 없음) — docs/23-ux-review.md
//   메뉴 4묶음 · 순서 / 처음 화면(제작 기록이 있으면 현황판) / 업데이트(마일스톤) 하나를 모든 화면이 함께 /
//   현황판 → 보드로 같은 업데이트 / 파일마다 마지막으로 본 화면 기억
//   node tools/e2e-flow.mjs [--no-build]
import { withBrowser, sleep } from './lib/cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const nav = (cdp, text) => cdp.eval(`[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
const h1 = cdp => cdp.eval("document.querySelector('main .page-head h1')?.textContent ?? ''");
const pickSel = (cdp, label, value) => cdp.eval(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const selVal = (cdp, label) => cdp.eval(`document.querySelector('select[aria-label=${JSON.stringify(label)}]')?.value ?? null`);

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const app = `${base}/app/index.html`;

  // 1. 메뉴 4묶음 · 순서 + 처음 화면(예시 normal은 작업 진척 기록이 있다 → 현황판)
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&nosw` });
  await cdp.waitUntil("document.querySelector('.sidebar .nav-item') && document.querySelector('main .page-head h1')", 20000);
  await sleep(500);
  const menu = await cdp.eval(`(() => { const out = []; for (const el of document.querySelectorAll('.sidebar .nav > *')) out.push(el.classList.contains('nav-label') ? '#' + el.textContent : el.textContent.replace(/\\d+$/, '').trim()); return out.join(','); })()`);
  check('메뉴 4묶음 · 순서(현황 → 계획 → 기준 정보 → 기록 · 점검)',
    menu === '#현황,제작 현황판,에셋 제작 현황,작업 진척,소식,#계획,런칭 물량 설계,업데이트 계획,시뮬레이션,마감 맞추기,#기준 정보,프로젝트·파트·리소스,인력,유형 템플릿,공수 보정,#기록 · 점검,데이터 점검,변경 이력', menu);
  check('제작 기록이 있는 파일은 현황판으로 열린다', (await h1(cdp)) === '제작 현황판', await h1(cdp));
  check('필수 설정이 끝난 파일은 처음 할 일 안내가 없다', !(await cdp.eval("!!document.querySelector('.setup-guide')")));
  // 메뉴 묶음이 늘어도 화면 높이 안에 저장 · 내보내기가 보인다(1440 × 900, 1440 × 700)
  const footIn = async () => cdp.eval("(() => { const f = document.querySelector('.sidebar-foot').getBoundingClientRect(); return f.bottom <= window.innerHeight + 1; })()");
  const in900 = await footIn();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const in700 = await footIn();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  check('사이드바 아래(저장 · 내보내기)가 화면 높이 안(900 · 700px, 낮으면 메뉴만 스크롤)', in900 && in700);

  // 2. 업데이트 하나를 모든 화면이 함께(동선 B: 다시 고르기 0번)
  await pickSel(cdp, '업데이트(마일스톤)', 'S1');
  await sleep(600);
  const dashSel = await selVal(cdp, '업데이트(마일스톤)');
  await nav(cdp, '에셋 제작 현황');
  await cdp.waitUntil("document.querySelector('select[aria-label=\"업데이트(마일스톤)\"]')", 10000);
  await sleep(300);
  const assetSel = await selVal(cdp, '업데이트(마일스톤)');
  await nav(cdp, '작업 진척');
  await cdp.waitUntil("document.querySelector('select[aria-label=\"진척 업데이트\"]')", 10000);
  await sleep(300);
  const progSel = await selVal(cdp, '진척 업데이트');
  await nav(cdp, '시뮬레이션');
  await cdp.waitUntil("document.querySelector('select[aria-label=\"분석할 업데이트\"]')", 10000);
  await sleep(300);
  const simSel = await selVal(cdp, '분석할 업데이트');
  check('현황판에서 고른 업데이트(시즌 1)가 에셋 · 작업 진척 · 시뮬레이션에 이어진다', [dashSel, assetSel, progSel, simSel].every(x => x === 'S1'), [dashSel, assetSel, progSel, simSel].join(','));
  // 작업 진척에서 바꾸면 현황판도
  await nav(cdp, '작업 진척');
  await cdp.waitUntil("document.querySelector('select[aria-label=\"진척 업데이트\"]')", 10000);
  await pickSel(cdp, '진척 업데이트', 'LAUNCH');
  await sleep(500);
  await nav(cdp, '제작 현황판');
  await cdp.waitUntil("document.querySelector('select[aria-label=\"업데이트(마일스톤)\"]')", 10000);
  await sleep(300);
  check('작업 진척에서 바꾼 업데이트(런칭)가 현황판에도', (await selVal(cdp, '업데이트(마일스톤)')) === 'LAUNCH');

  // 3. 현황판 → 보드에서 보기: 같은 업데이트로
  await pickSel(cdp, '업데이트(마일스톤)', 'S1');
  await sleep(500);
  await cdp.eval("[...document.querySelectorAll('main button')].find(b => b.textContent === '보드에서 보기').click()");
  await cdp.waitUntil("document.querySelector('.assets-page select[aria-label=\"업데이트(마일스톤)\"]')", 10000);
  await sleep(300);
  check('현황판 "보드에서 보기"가 같은 업데이트로 에셋 화면을 연다', (await selVal(cdp, '업데이트(마일스톤)')) === 'S1');

  // 4. 파일마다 마지막으로 본 화면(브라우저 저장소의 파일 = 예시가 아닌 파일)
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&opfs=1&nosw` });
  await cdp.waitUntil("document.querySelector('main .page-head h1')", 20000);
  await sleep(600);
  const first = await h1(cdp);
  await nav(cdp, '인력');
  await sleep(600);
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&opfs=1&keep=1&nosw` });
  await cdp.waitUntil("document.querySelector('main .page-head h1')", 20000);
  await sleep(600);
  const again = await cdp.eval("document.querySelector('.sidebar .nav-item.active')?.textContent ?? ''");
  // 같은 이름(normal.arp)이라 3번에서 마지막으로 본 에셋 화면으로 먼저 열리고, 인력으로 옮긴 뒤 다시 열면 인력
  check('다시 열면 마지막으로 본 화면으로 연다(에셋 → 인력)', first === '에셋 제작 현황' && again === '인력', `${first} → ${again}`);

  // 제작 기록이 없는 파일 → 런칭 물량 설계: 예시는 모두 기록이 있어 단위 검사(test/onboarding.test.mjs)에서 본다
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
