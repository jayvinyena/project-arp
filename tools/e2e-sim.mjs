// 시뮬레이션 시험(크롬, 화면 없음): 비교 · 시나리오 만들기 · 동작 더하기 · 차이 · 분석 · 원본에 반영
//   node tools/e2e-sim.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function shot(cdp, name, { width = 1440, dark = false } = {}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await sleep(300);
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  if (await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1')) console.log(`  ⚠ ${name}: 가로 넘침`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
}
const typeIn = async (cdp, selector, value) => {
  await cdp.eval(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(120);
};
const clickText = (cdp, text, scope = 'document') => cdp.eval(`(() => { const b = [...${scope}.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('버튼 없음: ${text}'); b.click(); })()`);
const headers = "[...document.querySelectorAll('table.compare thead th')].map(t => t.textContent)";
const launchCells = "[...[...document.querySelectorAll('table.compare tbody tr')].find(r => r.textContent.startsWith('런칭')).querySelectorAll('td')].map(t => t.textContent)";

/** 동작 종류 고르기(바꿀 것 칩) */
const pickKind = async (cdp, kind) => {
  await cdp.eval(`document.querySelector('.action-form .kind-chip[data-kind="${kind}"]').click()`);
  await sleep(150);
};

await withBrowser(async (cdp, base) => {
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal&page=simulation` });
  await cdp.waitUntil("document.querySelectorAll('table.compare tbody tr').length > 0", 15000);
  const h0 = await cdp.eval(headers);
  check('처음엔 원본 + 예시 시나리오가 비교에 들어 있다', h0.length === 3 && h0[1] === '원본', h0.join(' | '));
  const labels = await cdp.eval("[...document.querySelectorAll('.action-item span')].map(s => s.textContent)");
  check('예시 시나리오의 동작 이름', labels.includes('원화 AI 비율 80%'), labels.join(', '));

  // 시나리오 만들기 → 인원 동작
  await typeIn(cdp, 'input[aria-label="새 시나리오 이름"]', 'FX 충원');
  await clickText(cdp, '만들기');
  await cdp.waitUntil(`(${headers}).includes('FX 충원')`, 10000);
  await pickKind(cdp, 'headcount');
  await cdp.eval(`(() => { const s = document.querySelector('.action-form select[aria-label="파트"]'); s.value = 'FX'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(100);
  await typeIn(cdp, '.action-form input[aria-label="더할 인원"]', '2');
  await clickText(cdp, '더하기', "document.querySelector('.action-form')");
  await cdp.waitUntil("[...document.querySelectorAll('.action-item span')].some(s => s.textContent.startsWith('FX 인원 +2명'))", 10000);
  await sleep(600);
  const cells = await cdp.eval(launchCells);
  const delta = cells[cells.length - 1];
  check('인원을 더하면 런칭 완료가 당겨진다(− 차이)', /−\d+영업일/.test(delta), delta);

  // 두 번째: 물량 150%
  await typeIn(cdp, 'input[aria-label="새 시나리오 이름"]', '확장 물량');
  await clickText(cdp, '만들기');
  await cdp.waitUntil(`(${headers}).includes('확장 물량')`, 10000);
  await pickKind(cdp, 'volumeScale');
  await typeIn(cdp, '.action-form input[aria-label="물량 배율"]', '150');
  await clickText(cdp, '더하기', "document.querySelector('.action-form')");
  await cdp.waitUntil("[...document.querySelectorAll('.action-item span')].some(s => s.textContent.includes('×150%'))", 10000);
  await sleep(600);
  const h3 = await cdp.eval(headers);
  check('원본 + 시나리오 3개를 나란히', h3.length === 5 && h3.includes('확장 물량'), h3.join(' | '));
  const c3 = await cdp.eval(launchCells);
  check('물량을 늘리면 런칭이 늦어진다(+ 차이)', /\+\d+영업일/.test(c3[c3.length - 1]), c3[c3.length - 1]);

  // 바꿀 것: 네 무리(인력·효율·물량·일정)에 모든 종류가 보인다 · 가동률 · AI 공수 절감 · 리소스 수량 · 결과 미리보기
  const groups = await cdp.eval("[...document.querySelectorAll('.kind-group')].map(g => g.querySelector('.kind-group-name').textContent + ':' + g.querySelectorAll('.kind-chip').length).join(' ')");
  check('바꿀 것 17종이 네 무리로 보인다', groups === '인력:5 효율:5 물량:3 일정:4', groups);
  await pickKind(cdp, 'utilization');
  await cdp.eval(`(() => { const s = document.querySelector('.action-form select[aria-label="파트"]'); s.value = 'FX'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(100);
  await typeIn(cdp, '.action-form input[aria-label="가동률"]', '100');
  await clickText(cdp, '더하기', "document.querySelector('.action-form')");
  await cdp.waitUntil("[...document.querySelectorAll('.action-item span')].some(s => s.textContent.startsWith('FX 가동률 100%'))", 10000);
  await pickKind(cdp, 'aiEffort');
  const aiNow = await cdp.eval("document.querySelector('.action-form .now-val')?.textContent ?? ''");
  await typeIn(cdp, '.action-form input[aria-label="AI 공수 절감"]', '60');
  await clickText(cdp, '더하기', "document.querySelector('.action-form')");
  await cdp.waitUntil("[...document.querySelectorAll('.action-item span')].some(s => /AI 공수 60% 절감/.test(s.textContent))", 10000);
  await pickKind(cdp, 'volumeQty');
  await typeIn(cdp, '.action-form input[aria-label="수량"]', '30');
  await clickText(cdp, '더하기', "document.querySelector('.action-form')");
  await cdp.waitUntil("[...document.querySelectorAll('.action-item span')].some(s => / 30개$/.test(s.textContent))", 10000);
  check('가동률 · AI 공수 절감 · 리소스 수량을 더한다(지금 값 표시)', aiNow.startsWith('지금'), aiNow);
  await sleep(600);
  const preview = await cdp.eval("document.querySelector('.sim-preview')?.textContent ?? ''");
  const chipsN = await cdp.eval("document.querySelectorAll('.sim-preview .preview-chip').length");
  check('바꿀 것 아래 결과 미리보기(원본 대비, 업데이트 4개)', chipsN === 4 && /런칭(\d+월\d+일|기간밖)/.test(preview.replace(/\s/g, '')), preview.slice(0, 80));

  // 분석
  await cdp.waitUntil("document.querySelectorAll('.sens-row').length === 4", 10000);
  check('분석: 파트 4개의 +1명 효과', true);
  await clickText(cdp, '계산', "document.querySelectorAll('.answer')[1]");
  await cdp.waitUntil("document.querySelectorAll('.answer')[1].textContent.length > 25", 15000);
  await shot(cdp, 'sim-1440');
  await shot(cdp, 'sim-1440-dark', { dark: true });
  await shot(cdp, 'sim-390', { width: 390 });

  // "모델링 충원"을 원본에 반영
  await cdp.eval("[...document.querySelectorAll('.scenario-name')].find(b => b.textContent.includes('FX 충원')).click()");
  await sleep(400);
  const expected = await cdp.eval(`(() => { const hs = ${headers}; const i = hs.indexOf('FX 충원'); return i < 0 ? null : (${launchCells})[i].match(/\\d+월 \\d+일/)?.[0]; })()`);
  await clickText(cdp, '원본에 반영');
  await sleep(150);
  await clickText(cdp, '반영');
  await cdp.waitUntil("document.querySelector('.pill.ok')?.textContent.includes('반영됨')", 10000);
  const baseNow = await cdp.eval(`(${launchCells})[1].match(/\\d+월 \\d+일/)?.[0]`);
  check('반영하면 원본 결과 = 그 시나리오 결과', expected && baseNow === expected, `${expected} / ${baseNow}`);
  const save = await cdp.eval("document.querySelector('.save-state')?.textContent ?? ''");
  check('반영은 저장할 변경으로 남는다', save.includes('저장 안 된 변경'), save);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
