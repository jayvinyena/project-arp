// UI/UX 전수 검사용 캡처(docs/34): 모든 화면 · 주요 상태를 1440 · 390으로 찍는다(크롬, 화면 없음).
//   node tools/ux-capture.mjs [--no-build]  → samples/out/shots/ux/*.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots/ux`;
mkdirSync(OUT, { recursive: true });
const PAGES = ['news', 'dashboard', 'launch', 'plan', 'assets', 'progress', 'simulation', 'advisor', 'setup', 'templates', 'capacity', 'calibration', 'history', 'check'];

async function shot(cdp, name, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(500);
  const h = Math.min(4200, await cdp.eval('Math.ceil(document.documentElement.scrollHeight)'));
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}-${width}.png`, Buffer.from(r.data, 'base64'));
  const over = await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
  console.log(`${name}-${width}${over ? ' (가로 넘침)' : ''} h=${h}`);
}
const both = async (cdp, name) => { await shot(cdp, name, 1440); await shot(cdp, name, 390); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); };
const open = async (cdp, base, q, ready) => { await cdp.send('Page.navigate', { url: `${base}/app/index.html?${q}&nosw` }); await cdp.waitUntil(ready, 25000).catch(() => {}); await sleep(700); };
const click = (cdp, sel, text) => cdp.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // 시작 화면 · 새 프로젝트 마법사
  await open(cdp, base, 'x=1', "document.querySelector('.start, .start-screen, main, #root > *')");
  await both(cdp, '00-start');
  await open(cdp, base, 'new=1', "document.querySelector('.stepper, .wizard, .new-project')");
  await both(cdp, '01-new-project');
  // 화면마다(에셋 예시)
  for (const [i, p] of PAGES.entries()) {
    await open(cdp, base, `sample=assets&page=${p}`, "document.querySelector('.main h1, .page-title, main h1')");
    await both(cdp, `${String(i + 10)}-${p}`);
  }
  // 상태: 에셋 보드 · 카드 창 · 배치 탭, 인력 작업자 탭, 업데이트 상세, 안내 패널, 보기 모드
  await open(cdp, base, 'sample=assets&page=assets', "document.querySelector('.asset-bar')");
  await click(cdp, 'button[role=radio]', '보드'); await sleep(500);
  await both(cdp, '40-assets-board');
  await click(cdp, 'button[role=radio]', '리스트'); await sleep(400);
  await cdp.eval("document.querySelector('button.link-btn')?.click()"); await cdp.waitUntil("!!document.querySelector('[aria-label=\"에셋 카드\"]')", 8000).catch(() => {}); await sleep(600);
  await both(cdp, '41-assets-card');
  await cdp.eval("document.querySelector('[aria-label=\"에셋 카드\"] button[aria-label=\"닫기\"]')?.click()"); await sleep(300);
  await click(cdp, '.sub-tabs button', '배치'); await sleep(500);
  await both(cdp, '42-assets-batches');
  await open(cdp, base, 'sample=assets&page=capacity', "document.querySelector('table.cap-grid')");
  await click(cdp, '[aria-label="인력 화면"] button', '작업자'); await sleep(500);
  await both(cdp, '43-capacity-people');
  await open(cdp, base, 'sample=assets&page=plan', "document.querySelector('table.grid.list')");
  await cdp.eval("document.querySelector('table.grid.list tbody tr.row button.link')?.click()"); await sleep(900);
  await both(cdp, '44-plan-detail');
  await open(cdp, base, 'sample=assets&page=dashboard', "document.querySelector('.dash-tiles')");
  await click(cdp, 'button', '이 화면 안내'); await sleep(500);
  await both(cdp, '45-help-panel');
  await open(cdp, base, 'sample=assets&view=1&page=dashboard', "document.querySelector('.dash-tiles')");
  await both(cdp, '46-viewer-dashboard');
  // 다크 모드 두 장
  await open(cdp, base, 'sample=assets&page=dashboard&theme=dark', "document.querySelector('.dash-tiles')");
  await shot(cdp, '47-dark-dashboard', 1440);
  await open(cdp, base, 'sample=assets&page=setup&theme=dark', "document.querySelector('table.setup-parts')");
  await shot(cdp, '48-dark-setup', 1440);
}, { build: !process.argv.includes('--no-build') });
