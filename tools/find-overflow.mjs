// 좁은 화면에서 가로로 넘치는 요소 찾기(배치 점검용)
//   node tools/find-overflow.mjs [--no-build] [--page=advisor] [--width=390]
import { withBrowser, sleep } from './lib/cdp.mjs';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const page = arg('page') ?? 'launch';
const width = Number(arg('width') ?? 390);
await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal&nosw&page=${page}` });
  await cdp.waitUntil("document.querySelector('.page h1')", 20000);
  await sleep(1500);
  const r = await cdp.eval(`(() => {
    const W = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('.app *')) {
      const b = el.getBoundingClientRect();
      if (b.right > W + 1 && !el.closest('.table-wrap, .timeline-wrap, .card-body:has(> .heatmap), .segmented.scroll, .nav')) out.push(el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' ' + Math.round(b.left) + '→' + Math.round(b.right) + ' ' + (el.textContent || '').trim().slice(0, 30));
    }
    return { scroll: document.documentElement.scrollWidth, W, out: out.slice(0, 12) };
  })()`);
  console.log(JSON.stringify(r, null, 1));
}, { build: !process.argv.includes('--no-build') });
