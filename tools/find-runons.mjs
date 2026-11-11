// 글 나열 검출(전 화면 · 1440): 값 여러 개를 " · "로 이어 붙인 한 줄(이름 없이 숫자 · 날짜가 이어지는 곳)을 찾는다.
// 사람이 보고 고칠 곳을 고르는 목록이다(통과 · 실패 기준 아님).
//   node tools/find-runons.mjs [--no-build]
import { withBrowser, sleep } from './lib/cdp.mjs';

const PAGES = ['news', 'dashboard', 'launch', 'plan', 'assets', 'progress', 'simulation', 'advisor', 'setup', 'templates', 'capacity', 'calibration', 'history', 'check'];
const SCAN = `(() => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('p, span, div, td, li, b, small')) {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    if (el.closest('table.grid thead, .nav, .sidebar, select, option, .legend, .chip-row')) continue;
    // 글 상자(안에 블록 자식이 없는 것)만
    if ([...el.children].some(c => ['DIV', 'P', 'UL', 'TABLE', 'SECTION'].includes(c.tagName))) continue;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    const dots = (t.match(/ · /g) || []).length;
    const nums = (t.match(/\\d/g) || []).length;
    if (dots >= 2 && nums >= 3 && t.length >= 24 && !seen.has(t)) {
      // 바깥 상자가 같은 글이면 안쪽만
      if (el.parentElement && (el.parentElement.innerText || '').replace(/\\s+/g, ' ').trim() === t) continue;
      seen.add(t);
      const c = el.closest('section.card, .card, [role=dialog], .page-head');
      const h = c?.querySelector('h1, h2, h3');
      out.push({ where: (h?.textContent || '').trim().slice(0, 24), text: t.slice(0, 110) });
    }
  }
  return out;
})()`;

const all = new Map();
await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const open = async (q, ready = "document.querySelector('.page h1')") => {
    await cdp.send('Page.navigate', { url: `${base}/app/index.html?${q}&nosw` });
    await cdp.waitUntil(ready, 25000).catch(() => {}); await sleep(900);
  };
  const scan = async (label) => { for (const f of await cdp.eval(SCAN)) { const k = f.where + '|' + f.text; if (!all.has(k)) all.set(k, { screen: label, ...f }); } };
  for (const p of PAGES) { await open(`sample=assets&page=${p}`); await scan(p); }
  await open('sample=assets&page=plan', "document.querySelector('.hm-cell')");
  await cdp.eval("document.querySelector('.hm-cell')?.click()"); await sleep(300); await scan('plan/부하 누름');
  await cdp.eval("document.querySelector('table.grid.list tbody tr.row button.link')?.click()"); await sleep(900); await scan('plan/상세');
  await open('sample=assets&page=assets', "document.querySelector('.asset-bar')");
  await cdp.eval("document.querySelector('table.asset-list button.link-btn')?.click()"); await sleep(900); await scan('assets/카드');
}, { build: !process.argv.includes('--no-build') });
for (const f of all.values()) console.log(`- [${f.screen}] ${f.where || '—'} :: ${f.text}`);
console.log(`\n${all.size}곳`);
