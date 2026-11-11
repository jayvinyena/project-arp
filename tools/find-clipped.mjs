// 글자 잘림 · 넘침 검출(전 화면 · 1440 · 390): 단추 · 알약 · 탭 글자가 상자 밖으로 나가거나 짧은 글이 꺾임,
// 입력 칸 · 고르기 칸의 값(또는 안내 글)이 칸보다 길어 잘림. 0개여야 통과.
//   node tools/find-clipped.mjs [--no-build] [--json]
import { withBrowser, sleep } from './lib/cdp.mjs';

const PAGES = ['news', 'dashboard', 'launch', 'plan', 'assets', 'progress', 'simulation', 'advisor', 'setup', 'templates', 'capacity', 'calibration', 'history', 'check'];
const SAMPLES = ['assets', 'normal'];

// 화면 안에서 도는 검사(문자열로 넘긴다)
const SCAN = `(() => {
  const out = [];
  const shown = el => { const dt = el.closest('details'); if (dt && !dt.open && !el.closest('summary')) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[aria-hidden="true"], .reserve'); };
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.value || el.placeholder || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  const where = el => { const c = el.closest('section.card, .card, [role=dialog], .sidebar, .page-head'); const h = c?.querySelector('h1, h2, h3, [aria-label]'); return (c?.getAttribute('aria-label') || h?.textContent || '').trim().slice(0, 24); };
  const textRects = el => {
    const rs = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim()) continue; const g = document.createRange(); g.selectNodeContents(n); rs.push(...[...g.getClientRects()].filter(x => x.width > 0)); }
    return rs;
  };
  // 1. 단추 · 알약 · 탭 · 칩
  for (const el of document.querySelectorAll('button, .btn, .pill, .tag, .label-chip, [role=tab], [role=radio], .sum-item')) {
    if (!shown(el) || el.matches('.hm-cell, .heat-btn, .tl-item, .thumb-btn, .link, .link-btn, .hist-toggle, .kb-card, .nav-item, .lever, .toast-undo') || el.closest('.cw-feed, svg')) continue;
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim(); if (!t) continue;
    const r = el.getBoundingClientRect(); const rs = textRects(el); if (!rs.length) continue;
    const L = Math.min(...rs.map(x => x.left)), R = Math.max(...rs.map(x => x.right)), T = Math.min(...rs.map(x => x.top)), B = Math.max(...rs.map(x => x.bottom));
    const clipX = getComputedStyle(el).overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1;
    if (L < r.left - 1 || R > r.right + 1 || T < r.top - 2 || B > r.bottom + 2 || clipX) { out.push({ kind: '글자가 상자 밖', what: t.slice(0, 40), where: where(el) }); continue; }
    // 줄 수: 세로로 겹치는 글자 상자는 같은 줄(작은 숫자 표 · 아이콘 옆 글자는 한 줄)
    const sorted = [...rs].sort((x, y) => x.top - y.top); let lines = 0; let bottom = -1e9;
    for (const x of sorted) { if (x.top >= bottom - 2) { lines++; bottom = x.bottom; } else bottom = Math.max(bottom, x.bottom); }
    if (lines > 1 && t.length <= 24) out.push({ kind: '짧은 글이 꺾임', what: t, where: where(el) });
  }
  // 2. 입력 칸 · 고르기 칸: 값(없으면 안내 글)이 칸보다 김
  const cv = document.createElement('canvas').getContext('2d');
  const width = (el, s) => { const cs = getComputedStyle(el); cv.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; return cv.measureText(s).width; };
  for (const el of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not([type=date]):not([type=month]):not([type=color]), select, textarea')) {
    if (!shown(el) || el.tagName === 'TEXTAREA') continue;
    const cs = getComputedStyle(el);
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (el.tagName === 'SELECT' ? 18 : 0);
    const s = el.tagName === 'SELECT' ? (el.selectedOptions[0]?.textContent ?? '') : (el.value || el.placeholder || '');
    if (!s) continue;
    const need = width(el, s);
    if (need > inner + 2) out.push({ kind: el.tagName === 'SELECT' ? '고르기 값 잘림' : el.value ? '입력 값 잘림' : '안내 글 잘림', what: (el.getAttribute('aria-label') ? el.getAttribute('aria-label') + ': ' : '') + s.slice(0, 40) + ' (' + Math.round(need) + ' > ' + Math.round(inner) + 'px)', where: where(el) });
  }
  // 3. 날짜 칸: 기본 크기보다 좁음
  for (const el of document.querySelectorAll('input[type=date], input[type=month]')) {
    if (!shown(el)) continue;
    if (el.getBoundingClientRect().width < (el.type === 'date' ? 118 : 112)) out.push({ kind: '날짜 칸 좁음', what: (el.getAttribute('aria-label') || el.type) + ' ' + Math.round(el.getBoundingClientRect().width) + 'px', where: where(el) });
  }
  return out;
})()`;

const json = process.argv.includes('--json');
const all = [];
await withBrowser(async (cdp, base) => {
  const open = async (q, ready = "document.querySelector('.page h1, .start, main')") => {
    await cdp.send('Page.navigate', { url: `${base}/app/index.html?${q}&nosw` });
    await cdp.waitUntil(ready, 25000).catch(() => {}); await sleep(900);
  };
  const scan = async (label) => {
    for (const w of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
      await sleep(350);
      const found = await cdp.eval(SCAN);
      for (const f of found) all.push({ screen: label, w, ...f });
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  };
  for (const s of SAMPLES) for (const p of PAGES) { await open(`sample=${s}&page=${p}`); await scan(`${s}/${p}`); }
  // 상태: 에셋 카드 패널 · 보드 · 작업자 탭 · 업데이트 상세 · 새 업데이트 창
  await open('sample=assets&page=assets', "document.querySelector('.asset-bar')");
  await cdp.eval("[...document.querySelectorAll('button[role=radio]')].find(b => b.textContent.trim().startsWith('보드'))?.click()"); await sleep(500);
  await scan('assets/보드');
  await cdp.eval("document.querySelector('.kb-card')?.click()"); await cdp.waitUntil("document.querySelector('.asset-card-window')", 8000).catch(() => {}); await sleep(600);
  await scan('assets/카드');
  await open('sample=assets&page=capacity', "document.querySelector('table.cap-grid')");
  await cdp.eval("[...document.querySelectorAll('[aria-label=\"인력 화면\"] button')].find(b => b.textContent.startsWith('작업자'))?.click()"); await sleep(500);
  await scan('capacity/작업자');
  await open('sample=normal&page=plan', "document.querySelector('table.grid.list')");
  await cdp.eval("document.querySelector('table.grid.list tbody tr.row button.link')?.click()"); await sleep(900);
  await scan('plan/상세');
}, { build: !process.argv.includes('--no-build') });

// 같은 것은 한 줄로
const key = f => `${f.kind}|${f.what.replace(/\(\d+ > \d+px\)/, '')}|${f.where}`;
const grouped = new Map();
for (const f of all) { const k = key(f); const g = grouped.get(k) ?? { ...f, screens: new Set() }; g.screens.add(`${f.screen}@${f.w}`); grouped.set(k, g); }
if (json) console.log(JSON.stringify([...grouped.values()].map(g => ({ ...g, screens: [...g.screens] })), null, 1));
else {
  for (const g of grouped.values()) console.log(`- [${g.kind}] ${g.what} · ${g.where || '—'} · ${[...g.screens].slice(0, 4).join(', ')}${g.screens.size > 4 ? ` 외 ${g.screens.size - 4}` : ''}`);
  console.log(`\n${grouped.size === 0 ? '통과' : '찾음'}: ${grouped.size}종 · ${all.length}곳`);
}
process.exitCode = grouped.size ? 1 : 0;
