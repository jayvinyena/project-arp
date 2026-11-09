// 메뉴별 화면 캡처(배치 점검용): 모든 메뉴를 1440px·390px로 찍는다. 결과 PNG는 samples/out/shots/pages/
//   node tools/capture-pages.mjs [--no-build] [--only=launch,simulation] [--sample=normal]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, ROOT, sleep } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots/pages`;
mkdirSync(OUT, { recursive: true });
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const only = arg('only')?.split(',');
const sample = arg('sample') ?? 'normal';
const PAGES = ['dashboard', 'launch', 'plan', 'assets', 'progress', 'simulation', 'advisor', 'setup', 'templates', 'capacity', 'calibration', 'history', 'check'];

async function shot(cdp, name, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(350);
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const overflow = await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
  console.log(`  ${name}.png${overflow ? '  ⚠ 가로 넘침' : ''}`);
}

await withBrowser(async (cdp, base) => {
  for (const page of PAGES.filter(p => !only || only.includes(p))) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=${sample}&nosw&page=${page}` });
    await cdp.waitUntil("document.querySelector('.page h1')", 20000);
    await sleep(1200);
    if (page === 'simulation') {
      // 시나리오 하나를 펼쳐 동작 입력 칸까지 보이게
      await cdp.eval("document.querySelector('.scenario-name')?.click()");
      await sleep(600);
    }
    await shot(cdp, `${page}-1440`, 1440);
    await shot(cdp, `${page}-390`, 390);
    if (page === 'launch') {
      // 화면 안내 패널(키보드 ?)
      await cdp.eval("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))");
      await cdp.waitUntil("document.querySelector('.help-panel')", 5000);
      await shot(cdp, 'help-1440', 1440);
      await shot(cdp, 'help-390', 390);
    }
  }
}, { build: !process.argv.includes('--no-build') });

console.log(`저장: ${OUT}`);
