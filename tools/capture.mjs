// 앱 화면 캡처: 데스크톱·모바일·다크 모드, 고치기·역산 상태까지. 결과 PNG는 samples/out/shots/
//   node tools/capture.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, ROOT, sleep } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });

async function shot(cdp, name, { width, height = 900, dark = false, full = true }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await sleep(250);
  let clip;
  if (full) {
    const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
    const w = await cdp.eval('Math.ceil(document.documentElement.scrollWidth)');
    clip = { x: 0, y: 0, width: Math.max(width, w), height: Math.max(height, h), scale: 1 };
  }
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const overflow = await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
  console.log(`  ${name}.png ${width}px${dark ? ' 다크' : ''}${overflow ? '  ⚠ 가로 넘침' : ''}`);
}

const ready = "document.querySelector('.mode-card') && document.querySelectorAll('table.grid tbody tr.row').length > 0";

await withBrowser(async (cdp, base) => {
  // 시작 화면
  await cdp.send('Page.navigate', { url: `${base}/app/index.html` });
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await shot(cdp, '01-welcome', { width: 1440, full: false });

  // 런칭 물량 설계
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal` });
  await cdp.waitUntil(ready);
  await shot(cdp, '02-launch-1440', { width: 1440 });
  await shot(cdp, '03-launch-1440-dark', { width: 1440, dark: true });
  await shot(cdp, '04-launch-390', { width: 390, height: 844 });

  // 역산 두 개 실행
  await cdp.eval("[...document.querySelectorAll('.ask .btn')].forEach(b => b.click())");
  await sleep(300);
  await cdp.eval("[...document.querySelectorAll('.ask .btn')][1]?.click()");
  await cdp.waitUntil("document.querySelectorAll('.answer').length === 2", 20000);
  await shot(cdp, '05-reverse-1440', { width: 1440 });

  // 최대안 선택
  await cdp.eval("document.querySelectorAll('.mode-card')[2].click()");
  await sleep(300);
  await shot(cdp, '06-stretch-1440', { width: 1440 });

  // 잘못된 값: 최대안의 프랍 수량을 비운다(계산이 막힌다)
  await cdp.eval(`(() => {
    const input = document.querySelector('input[aria-label="프랍 최대안"]');
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150); // 입력 상태가 그려진 뒤 칸을 벗어난다
  await cdp.eval(`document.querySelector('input[aria-label="프랍 최대안"]').dispatchEvent(new FocusEvent('blur'))`);
  await cdp.waitUntil("document.querySelector('.banner.bad')");
  await shot(cdp, '07-error-1440', { width: 1440 });

  // 과부하 예시
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=overload` });
  await cdp.waitUntil(ready);
  await cdp.eval("[...document.querySelectorAll('.ask .btn')][1]?.click()");
  await cdp.waitUntil("document.querySelectorAll('.answer').length >= 1", 20000);
  await shot(cdp, '08-overload-1440', { width: 1440 });
}, { build: !process.argv.includes('--no-build') });

console.log(`저장: ${OUT}`);
