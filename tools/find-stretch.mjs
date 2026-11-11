// 넓은 화면에서 한 칸만 늘어지는 표 찾기: 넓게 보기(2000px)로 모든 화면 · 주요 상태의 표마다
// 칸 폭 - 그 칸 내용 폭(남는 폭)을 재서, 한 칸에 표 폭의 35% 넘는 빈 폭이 몰리면 알린다. 0개여야 통과.
//   node tools/find-stretch.mjs [--no-build] [--width=2000]
import { withBrowser, sleep } from './lib/cdp.mjs';

const W = Number(process.argv.find(a => a.startsWith('--width='))?.split('=')[1] ?? 2000);
const PAGES = ['news', 'dashboard', 'launch', 'plan', 'assets', 'progress', 'simulation', 'advisor', 'setup', 'templates', 'capacity', 'calibration', 'history', 'check'];
const SCAN = `(() => {
  const out = [];
  for (const t of document.querySelectorAll('table')) {
    const tr = t.getBoundingClientRect(); if (tr.width < 400 || tr.height < 2) continue;
    if (getComputedStyle(t).display !== 'table') continue; // 카드로 바뀐 표(휴대폰)는 빼기
    const head = t.tHead?.rows[0] ?? t.rows[0]; if (!head) continue;
    const n = [...head.cells].reduce((k, c) => k + (c.colSpan || 1), 0);
    const colW = new Array(n).fill(0); const need = new Array(n).fill(0);
    for (const row of t.rows) {
      let i = 0;
      for (const c of row.cells) {
        const span = c.colSpan || 1;
        if (span === 1) {
          const r = c.getBoundingClientRect(); colW[i] = Math.max(colW[i], r.width);
          // 내용 폭: 글자 · 자식 상자의 오른쪽 끝 - 칸 왼쪽(입력 칸 · 고르기는 그 칸 폭 전부를 쓰므로 최소 폭으로)
          let w = 0; const cs = getComputedStyle(c);
          const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
          const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
          for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) { if (!tn.textContent.trim()) continue; const g = document.createRange(); g.selectNodeContents(tn); for (const x of g.getClientRects()) w = Math.max(w, x.width); }
          let sum = 0; for (const ch of c.children) { if (ch.matches('input, select, textarea, .field')) sum = Math.max(sum, 140); else { const b = ch.getBoundingClientRect(); sum += Math.min(b.width, 600); } }
          need[i] = Math.max(need[i], Math.max(w, sum) + pad);
        }
        i += span;
      }
    }
    const slack = colW.map((w, i) => w - need[i]);
    const iMax = slack.indexOf(Math.max(...slack));
    if (slack[iMax] > tr.width * 0.35 && slack[iMax] > 300) {
      const c = t.closest('section.card, .card, [role=dialog]'); const h = c?.querySelector('h1, h2, h3');
      const th = (head.cells[iMax]?.textContent || '').trim() || '(빈 머리)';
      out.push({ table: (t.className || '').replace(/\\s+/g, '.'), where: (h?.textContent || '').trim().slice(0, 24), col: iMax + 1 + ' ' + th.slice(0, 16), slack: Math.round(slack[iMax]), width: Math.round(tr.width) });
    }
  }
  return out;
})()`;

const found = new Map();
await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: 1000, deviceScaleFactor: 1, mobile: false });
  const open = async (q, ready = "document.querySelector('.page h1')") => {
    await cdp.send('Page.navigate', { url: `${base}/app/index.html?${q}&nosw` });
    await cdp.waitUntil(ready, 25000).catch(() => {});
    await cdp.eval("(() => { if (!document.querySelector('.app.wide')) document.querySelector('.width-toggle')?.click(); })()");
    await sleep(900);
  };
  const scan = async label => { for (const f of await cdp.eval(SCAN)) { const k = `${f.table}|${f.col}`; if (!found.has(k)) found.set(k, { screen: label, ...f }); } };
  for (const s of ['assets', 'normal']) for (const p of PAGES) { await open(`sample=${s}&page=${p}`); await scan(`${s}/${p}`); }
  // 탭 · 상태
  await open('sample=assets&page=assets', "document.querySelector('.asset-bar')");
  for (const t of ['배치', '물량 대조']) { await cdp.eval(`[...document.querySelectorAll('.sub-tabs button')].find(b => b.textContent.startsWith(${JSON.stringify(t)}))?.click()`); await sleep(600); await scan(`assets/${t}`); }
  await cdp.eval("[...document.querySelectorAll('.sub-tabs button')].find(b => b.textContent.startsWith('에셋'))?.click()"); await sleep(500);
  await cdp.eval("document.querySelector('table.asset-list button.link-btn')?.click()"); await sleep(900); await scan('assets/카드');
  await open('sample=assets&page=capacity', "document.querySelector('table.cap-grid')");
  await cdp.eval("[...document.querySelectorAll('[aria-label=\"인력 화면\"] button')].find(b => b.textContent.startsWith('작업자'))?.click()"); await sleep(600); await scan('capacity/작업자');
  await open('sample=normal&page=plan', "document.querySelector('table.grid.list')");
  await cdp.eval("document.querySelector('table.grid.list tbody tr.row button.link')?.click()"); await sleep(900); await scan('plan/상세');
}, { build: !process.argv.includes('--no-build') });
for (const f of found.values()) console.log(`- [${f.screen}] ${f.where || '—'} · table.${f.table} · ${f.col}열 빈 폭 ${f.slack}px / 표 ${f.width}px`);
console.log(`\n${found.size === 0 ? '통과' : '찾음'}: ${found.size}개`);
process.exitCode = found.size ? 1 : 0;
