// 3단계 시험(크롬, 화면 없음): 업데이트 계획 · 만들기 · 상세에서 고치기 · 우선순위 · 유형 템플릿 · 인력 · 계획 기간.
// 화면 캡처도 남긴다(samples/out/shots/plan-*.png).
//   node tools/e2e-plan.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function shot(cdp, name, { width = 1440, dark = false } = {}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await sleep(250);
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  if (await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1')) console.log(`  ⚠ ${name}: 가로 넘침`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
}
const clickText = (cdp, text, scope = 'document') => cdp.eval(`(() => { const b = [...${scope}.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('버튼 없음: ${text}'); b.click(); })()`);
const setInput = async (cdp, selector, value, commit = 'blur') => {
  await cdp.eval(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  if (commit === 'blur') await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new FocusEvent('blur'))`);
  if (commit === 'change') await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
  await sleep(300);
};
const rowNames = "[...document.querySelectorAll('table.grid.list tbody tr')].map(r => r.querySelector('button.link')?.textContent)";

await withBrowser(async (cdp, base) => {
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal&page=plan` });
  await cdp.waitUntil("document.querySelectorAll('button.tl-item').length > 0");
  check('업데이트 계획: 타임라인에 업데이트 4개', (await cdp.eval("document.querySelectorAll('button.tl-item').length")) === 4);
  check('파트 부하 지도: 4파트 × 14달', (await cdp.eval("document.querySelectorAll('.hm-cell').length")) === 56);
  await shot(cdp, 'plan-1440');
  await shot(cdp, 'plan-1440-dark', { dark: true });
  await shot(cdp, 'plan-390', { width: 390 });

  // 업데이트 만들기
  await clickText(cdp, '업데이트 만들기');
  await cdp.waitUntil("document.querySelector('.dialog')");
  await setInput(cdp, 'input[aria-label="업데이트 이름"]', '시즌 3', 'none');
  await setInput(cdp, '#cu-startDate', '2027-09-01', 'none');
  await setInput(cdp, '#cu-freezeDate', '2027-11-20', 'none');
  await setInput(cdp, '#cu-releaseDate', '2027-12-10', 'none');
  await shot(cdp, 'plan-create');
  await clickText(cdp, '만들기', "document.querySelector('.dialog')");
  await cdp.waitUntil("!document.querySelector('.dialog') && document.querySelectorAll('button.tl-item').length === 5", 10000);
  check('업데이트 만들기: 타임라인에 5개', true);
  const names = await cdp.eval(rowNames);
  check('새 업데이트는 우선순위 맨 뒤', names[4] === '시즌 3', names.join(', '));

  // 우선순위 올리기
  await cdp.eval(`document.querySelector('button[aria-label="시즌 3 우선순위 올리기"]').click()`);
  await sleep(800);
  const after = await cdp.eval(rowNames);
  check('우선순위 올리기: 시즌 2 앞으로', after.indexOf('시즌 3') === 3, after.join(', '));

  // 상세 패널에서 물량·날짜 고치기
  await cdp.eval(`[...document.querySelectorAll('button.link')].find(b => b.textContent === '시즌 3').click()`);
  await cdp.waitUntil("document.querySelector('.drawer table.grid tbody tr.row')", 10000);
  const resCount = await cdp.eval("document.querySelectorAll('.drawer table.grid tbody tr.row').length");
  check('상세: 시즌 템플릿 물량 6종이 복사됨', resCount === 6, `${resCount}종`);
  await setInput(cdp, '.drawer input[aria-label="신규 캐릭터 기본안"]', '4');
  await sleep(500);
  const target = await cdp.eval(`document.querySelector('.drawer input[aria-label="신규 캐릭터 기본안"]').value`);
  check('상세: 물량 고치기 반영', target === '4', target);
  await setInput(cdp, '#ud-release_date', '2027-12-17', 'change');
  await sleep(500);
  await shot(cdp, 'plan-drawer');
  // 지우기
  await clickText(cdp, '이 업데이트 지우기', "document.querySelector('.drawer')");
  await sleep(200);
  await clickText(cdp, '지우기', "document.querySelector('.drawer')");
  await cdp.waitUntil("!document.querySelector('.drawer') && document.querySelectorAll('button.tl-item').length === 4", 10000);
  check('상세: 업데이트 지우기', true);

  // 유형 템플릿
  await clickText(cdp, '유형 템플릿', "document.querySelector('.sidebar')");
  await cdp.waitUntil("document.querySelector('.type-list')");
  await setInput(cdp, 'input[aria-label="새 유형 이름"]', '이벤트', 'none');
  await clickText(cdp, '유형 더하기');
  await sleep(600);
  const types = await cdp.eval("[...document.querySelectorAll('.type-list .nav-item')].map(b => b.childNodes[0].textContent)");
  check('유형 더하기', types.includes('이벤트'), types.join(', '));
  await cdp.eval("[...document.querySelectorAll('.type-list .nav-item')][0].click()");
  await sleep(300);
  await setInput(cdp, 'input[aria-label="코스튬 기본안"]', '7');
  const sumTarget = await cdp.eval("document.querySelector('tr.total td:nth-child(3)').textContent");
  check('템플릿 물량 고치기 → 합계 반영', sumTarget === '54', sumTarget);
  await shot(cdp, 'templates-1440');

  // 인력
  await clickText(cdp, '인력', "document.querySelector('.sidebar')");
  await cdp.waitUntil("document.querySelector('.cap-grid')");
  await setInput(cdp, 'input[aria-label="FX 2027-03 인원"]', '3');
  const fx = await cdp.eval(`document.querySelector('input[aria-label="FX 2027-03 인원"]').value`);
  check('인력 한 칸 고치기', fx === '3', fx);
  await setInput(cdp, 'input[aria-label="계획 끝 달"]', '2028-03', 'none');
  await clickText(cdp, '바꾸기');
  await cdp.waitUntil("document.querySelectorAll('.cap-grid tbody tr:first-child td').length === 1 + 17", 10000);
  const copied = await cdp.eval(`document.querySelector('input[aria-label="모델링 2028-03 인원"]').value`);
  check('계획 기간 늘리기: 17개월, 새 달은 앞 달 인원 복사', copied === '5', `모델링 2028-03 = ${copied}`);
  await shot(cdp, 'capacity-1440');

  // 다시 계획으로: 기간이 늘어난 타임라인
  await clickText(cdp, '업데이트 계획', "document.querySelector('.sidebar')");
  await cdp.waitUntil("document.querySelectorAll('.hm-cell').length === 4 * 17", 10000);
  check('계획 화면이 늘어난 기간으로 다시 계산', true);
  const saveState = await cdp.eval("document.querySelector('.save-state')?.textContent");
  check('고친 내용은 저장 대기(예시 파일)', saveState.includes('저장 안 된 변경'), saveState);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
