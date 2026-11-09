// 에셋 제작 현황 시험(크롬, 화면 없음) — 리스트 + 보드(칸반) + 카드 창(docs/20-asset-management.md 16절)
//   리스트: 단계 · 세부 상태 칸에서 바꾸기 → 작업 진척 집계 · 잠금
//   보드: 카드를 다른 열로 끌기(앞으로) · 뒤로 끌면 확인 · 모든 에셋이 같은 파이프라인(해당 없음 파트 열에 놓으면 켜짐) · 같은 열 안 순서
//   카드 창: 썸네일 끌어놓기(256px) · 설명 · 마감일 · 링크 · 댓글 / 보조 탭: 배치 · 물량 대조
//   node tools/e2e-assets.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function shot(cdp, name, width = 1440) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(400);
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const over = await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return !over;
}
const clickText = (cdp, text, scope = 'document') => cdp.eval(`(() => { const b = [...${scope}.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('버튼 없음: ${text}'); b.click(); })()`);
const select = (cdp, selector, value) => cdp.eval(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const typeIn = async (cdp, selector, value, blur = true) => {
  await cdp.eval(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(120);
  if (blur) { await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new FocusEvent('blur'))`); await sleep(400); }
};
const nav = (cdp, text) => cdp.eval(`[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
/** 보드에서 카드를 열로 끌기(HTML5 끌어놓기 사건을 차례로) */
const drag = (cdp, id, col, before = null) => cdp.eval(`(() => {
  const card = document.querySelector('.kb-card[data-id="${id}"]');
  const colEl = document.querySelector('.kb-col[data-col="${col}"]');
  if (!card || !colEl) throw new Error('카드나 열 없음');
  const dt = new DataTransfer();
  card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  const target = ${before ? `document.querySelector('.kb-card[data-id="${before}"]')` : 'null'};
  const r = (target ?? colEl).getBoundingClientRect();
  const y = target ? r.top + 2 : r.bottom - 4;
  return new Promise(res => setTimeout(() => {
    colEl.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: y }));
    setTimeout(() => {
      colEl.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: y }));
      card.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      res(true);
    }, 60);
  }, 60));
})()`);
const colIds = (cdp, col) => cdp.eval(`[...document.querySelectorAll('.kb-col[data-col="${col}"] .kb-card')].map(c => c.dataset.id)`);

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=assets&nosw&page=assets` });
  await cdp.waitUntil("document.querySelector('.asset-bar')", 20000);
  await cdp.eval("localStorage.setItem('arp.assets.view', 'list'); localStorage.setItem('arp.assets.groupBy', 'group'); localStorage.setItem('arp.assets.boardBy', 'stage')");
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=assets&nosw&page=assets&v=2` });
  await sleep(800);
  await cdp.waitUntil("document.querySelectorAll('table.asset-list tbody tr.row').length === 20", 20000);

  // 1. 리스트: 20줄 · 요약 · 칸에서 바꾸기
  const rows = await cdp.eval("document.querySelectorAll('table.asset-list tbody tr.row').length");
  check('리스트: 예시 에셋 20줄(항목으로 묶음)', rows === 20, `${rows}줄`);
  const sum = await cdp.eval("document.querySelector('.asset-summary').textContent.replace(/\\s+/g, ' ')");
  check('요약 줄: 단계별 수 · 검수 요청 · 수정', /대기 12/.test(sum) && /검수 요청 1/.test(sum) && /수정 1/.test(sum), sum);
  await select(cdp, 'select[aria-label="닌자맛 쿠키 세부 상태"]', 'WIP');
  await cdp.waitUntil("document.querySelector('select[aria-label=\"닌자맛 쿠키 세부 상태\"]')?.value === 'WIP'", 8000);
  await select(cdp, 'select[aria-label="닌자맛 쿠키 단계"]', 'MODELING');
  const moved = await cdp.waitUntil("document.querySelector('select[aria-label=\"닌자맛 쿠키 단계\"]')?.value === 'MODELING' && document.querySelector('select[aria-label=\"닌자맛 쿠키 세부 상태\"]')?.value === 'WIP'", 15000).then(() => true).catch(() => false);
  check('리스트: 단계를 모델링으로 → 원화 완료 · 모델링 진행', moved);
  await nav(cdp, '작업 진척');
  await cdp.waitUntil("document.querySelector('table.progress-grid tbody tr.row')", 10000);
  const row = await cdp.eval("(() => { const r = [...document.querySelectorAll('table.progress-grid tbody tr.row')].find(x => x.textContent.includes('신규 캐릭터')); return { locked: !!r.querySelector('.locked-cell'), first: r.querySelectorAll('td')[2].textContent.trim() }; })()");
  check('작업 진척: 에셋에서 집계(잠금 · 원화 3 → 4)', row.locked && row.first === '4', JSON.stringify(row));
  await cdp.eval("[...document.querySelectorAll('table.progress-grid tbody tr.row')].find(x => x.textContent.includes('신규 캐릭터')).querySelector('.tag-link').click()");
  await cdp.waitUntil("document.querySelector('.page h1')?.textContent === '에셋 제작 현황'", 8000);
  check('"에셋에서 집계"를 누르면 에셋 화면으로', true);

  // 2. 보드: 앞으로 끌기 · 뒤로 끌면 확인 · 놓을 수 없는 열 · 순서
  await clickText(cdp, '보드');
  await cdp.waitUntil("document.querySelector('.kanban .kb-card')", 8000);
  const cols = await cdp.eval("[...document.querySelectorAll('.kb-col .kb-head b')].map(b => b.textContent).join(',')");
  check('보드 열 = 제작 단계', cols === '대기,원화,모델링,애니메이션,FX,완료', cols);
  await drag(cdp, 'A00006', 'MODELING'); // 좀비맛 쿠키: 대기 → 모델링
  await cdp.waitUntil("(() => [...document.querySelectorAll('.kb-col[data-col=\"MODELING\"] .kb-card')].some(c => c.dataset.id === 'A00006'))()", 8000).catch(() => {});
  check('카드를 모델링 열로 끌기(앞으로)', (await colIds(cdp, 'MODELING')).includes('A00006'));
  await drag(cdp, 'A00006', 'CONCEPT'); // 뒤로 → 확인
  await cdp.waitUntil("document.querySelector('.confirm-dialog')", 5000).catch(() => {});
  check('뒤 열로 끌면 먼저 확인을 묻는다', await cdp.eval("!!document.querySelector('.confirm-dialog')"));
  await clickText(cdp, '되돌리기', "document.querySelector('.confirm-dialog')");
  await cdp.waitUntil("(() => [...document.querySelectorAll('.kb-col[data-col=\"CONCEPT\"] .kb-card')].some(c => c.dataset.id === 'A00006'))()", 8000).catch(() => {});
  const sub = await cdp.eval("document.querySelector('.kb-card[data-id=\"A00006\"] select')?.value");
  check('되돌리면 원화 열 · 세부 상태 "수정"', (await colIds(cdp, 'CONCEPT')).includes('A00006') && sub === 'RETAKE', sub);
  // 모든 에셋이 같은 파이프라인: 코스튬은 FX가 기본 "해당 없음"이지만 FX 열이 막히지 않고, 놓으면 FX가 켜진다
  await cdp.eval(`(() => { const card = document.querySelector('.kb-card[data-id="A00015"]'); card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: new DataTransfer(), bubbles: true })); })()`);
  await sleep(200);
  const blocked = await cdp.eval("document.querySelector('.kb-col[data-col=\"FX\"]').classList.contains('blocked')");
  await cdp.eval("document.querySelector('.kb-card[data-id=\"A00015\"]').dispatchEvent(new DragEvent('dragend', { bubbles: true }))");
  await sleep(200);
  await drag(cdp, 'A00015', 'FX');
  await sleep(500);
  check('해당 없음 파트 열에도 놓을 수 있다(코스튬 → FX 열: FX가 켜진다)', !blocked && (await colIds(cdp, 'FX')).includes('A00015'));
  // 같은 열 안 순서: 대기 열 셋째 카드를 맨 앞으로
  const before = await colIds(cdp, 'TODO');
  await drag(cdp, before[2], 'TODO', before[0]);
  await cdp.waitUntil(`(() => document.querySelector('.kb-col[data-col="TODO"] .kb-card')?.dataset.id === ${JSON.stringify(before[2])})()`, 8000).catch(() => {});
  check('같은 열 안에서 끌어 순서 바꾸기', (await colIds(cdp, 'TODO'))[0] === before[2]);
  // 체크한 카드 여러 장을 함께
  await cdp.eval("['A00008', 'A00009'].forEach(id => document.querySelector(`.kb-card[data-id=\"${id}\"] .kb-check`).click())");
  await sleep(200);
  await drag(cdp, 'A00008', 'DONE');
  await cdp.waitUntil("(() => { const ids = [...document.querySelectorAll('.kb-col[data-col=\"DONE\"] .kb-card')].map(c => c.dataset.id); return ids.includes('A00008') && ids.includes('A00009'); })()", 8000).catch(() => {});
  const done = await colIds(cdp, 'DONE');
  check('체크한 카드 2장을 함께 완료 열로', done.includes('A00008') && done.includes('A00009'), done.join(','));
  await clickText(cdp, '원화 상태');
  await cdp.waitUntil("[...document.querySelectorAll('.kb-col .kb-head b')].map(b => b.textContent).join(',') === '대기,진행,검수 요청,수정,완료,보류'", 8000).catch(() => {});
  check('파트별 보기: 원화 상태 열', (await cdp.eval("[...document.querySelectorAll('.kb-col .kb-head b')].map(b => b.textContent).join(',')")) === '대기,진행,검수 요청,수정,완료,보류');
  await clickText(cdp, '제작 단계');
  await sleep(300);
  const okBoard = await shot(cdp, 'assets-board-1440');

  // 3. 카드 창: 썸네일 · 설명 · 마감일 · 링크 · 댓글
  await cdp.eval("document.querySelector('.kb-card[data-id=\"A00001\"]').click()");
  await cdp.waitUntil("document.querySelector('.asset-card-window')", 8000);
  await cdp.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d'); g.fillStyle = '#e7a35a'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#5b3a1e'; g.beginPath(); g.arc(320, 240, 150, 0, 7); g.fill();
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'cookie.png', { type: 'image/png' }));
    document.querySelector('.asset-card-window .cw-cover').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await cdp.waitUntil("document.querySelector('.asset-card-window .cw-cover img')", 10000).catch(() => {});
  const img = await cdp.eval("(() => { const i = document.querySelector('.asset-card-window .cw-cover img'); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null; })()");
  check('카드 창: 썸네일 끌어놓기 → 256px로 줄여 표지에', img && img.w === 256 && img.h === 192, JSON.stringify(img));
  await typeIn(cdp, '.asset-card-window textarea[aria-label="설명"]', '실루엣 확정본 기준으로 작업\n표정 3종 포함');
  await select(cdp, '.asset-card-window input[aria-label="에셋 마감일"]', '2027-01-15');
  await sleep(400);
  await typeIn(cdp, '.asset-card-window input[aria-label="링크 제목"]', '컨셉 문서', false);
  await typeIn(cdp, '.asset-card-window input[aria-label="링크 주소"]', 'https://wiki.example.com/cookie', false);
  await clickText(cdp, '링크 더하기', "document.querySelector('.asset-card-window')");
  await typeIn(cdp, '.asset-card-window textarea[aria-label="댓글"]', '모델링 들어가기 전에 확인 부탁드립니다', false);
  await clickText(cdp, '남기기', "document.querySelector('.asset-card-window')");
  await cdp.waitUntil("document.querySelectorAll('.asset-card-window .cw-feed li.cmt').length === 1 && document.querySelectorAll('.asset-card-window .cw-links a').length >= 2", 8000).catch(() => {});
  const cw = await cdp.eval("(() => { const w = document.querySelector('.asset-card-window'); return { note: w.querySelector('textarea[aria-label=\"설명\"]').value, due: w.querySelector('input[aria-label=\"에셋 마감일\"]').value, links: [...w.querySelectorAll('.cw-links a')].map(a => a.textContent), comments: w.querySelectorAll('.cw-feed li.cmt').length }; })()");
  check('카드 창: 설명(여러 줄) · 마감일 · 링크(Jira + 문서) · 댓글', cw.note.includes('\n') && cw.due === '2027-01-15' && cw.links.includes('ART-101') && cw.links.includes('컨셉 문서') && cw.comments === 1, JSON.stringify(cw));
  const okCard = await shot(cdp, 'assets-card-1440');
  await cdp.eval("document.querySelector('.asset-card-window .cw-close').click()");
  await sleep(300);
  check('보드 카드에도 썸네일 · 댓글 수', await cdp.eval("(() => { const c = document.querySelector('.kb-card[data-id=\"A00001\"]'); return !!c.querySelector('img') && c.textContent.includes('💬 1'); })()"));

  // 4. 보조 탭: 물량 대조 · 배치
  await cdp.eval("[...document.querySelectorAll('.sub-tabs button')].find(b => b.textContent.startsWith('물량 대조')).click()");
  await cdp.waitUntil("document.querySelector('table.vol-compare')", 8000);
  await cdp.eval("[...document.querySelectorAll('table.vol-compare tbody tr.row')].find(r => r.textContent.startsWith('코스튬')).querySelector('button').click()");
  await cdp.waitUntil("[...document.querySelectorAll('table.vol-compare tbody tr.row')].find(r => r.textContent.startsWith('코스튬'))?.querySelectorAll('td')[2]?.textContent.replace(/\\s/g, '') === '10·15·20'", 10000).catch(() => {});
  const reg = await cdp.eval("[...document.querySelectorAll('table.vol-compare tbody tr.row')].find(r => r.textContent.startsWith('코스튬')).querySelectorAll('td')[2].textContent.replace(/\\s/g, '')");
  check('물량 대조 탭: 빈 에셋 만들기(10 · 15 · 20)', reg === '10·15·20', reg);
  await cdp.eval("[...document.querySelectorAll('.sub-tabs button')].find(b => b.textContent.startsWith('배치')).click()");
  await cdp.waitUntil("document.querySelector('table.batch-table')", 8000);
  await typeIn(cdp, 'input[aria-label="새 배치 이름"]', '3차 납품', false);
  await clickText(cdp, '배치 더하기');
  await cdp.waitUntil("[...document.querySelectorAll('table.batch-table tbody tr')].some(r => r.querySelector('input')?.value === '3차 납품')", 8000).catch(() => {});
  check('배치 탭: 배치 더하기', await cdp.eval("[...document.querySelectorAll('table.batch-table tbody tr')].some(r => r.querySelector('input')?.value === '3차 납품')"));

  // 5. 저장 대기 · 넘침
  const save = await cdp.eval("document.querySelector('.save-state')?.textContent ?? ''");
  check('고친 내용은 저장할 변경으로 남는다', save.includes('저장 안 된 변경'), save);
  await cdp.eval("[...document.querySelectorAll('.sub-tabs button')].find(b => b.textContent.startsWith('에셋')).click()");
  await clickText(cdp, '리스트');
  await sleep(400);
  const ok1440 = await shot(cdp, 'assets-1440');
  const ok390 = await shot(cdp, 'assets-390', 390);
  check('가로 넘침 없음(리스트 1440 · 390 · 보드 · 카드 창)', ok1440 && ok390 && okBoard && okCard);

  // 6. 화면 폭: 넓게(모든 화면, 이 브라우저에 기억)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const pageW = () => cdp.eval("Math.round(document.querySelector('main .page:last-of-type, main .page').getBoundingClientRect().width)");
  const w0 = await pageW();
  await cdp.eval("[...document.querySelectorAll('[aria-label=\"화면 폭\"] button')].find(b => b.textContent === '넓게').click()");
  await sleep(300);
  const widths = {};
  for (const [label, menu] of [['에셋', '에셋 제작 현황'], ['현황판', '제작 현황판'], ['업데이트 계획', '업데이트 계획'], ['리소스', '프로젝트']]) {
    await nav(cdp, menu);
    await sleep(700);
    widths[label] = await pageW();
  }
  check('넓게: 모든 화면이 창 폭 전부(기본 1240px 넘음)', w0 <= 1240 && Object.values(widths).every(w => w > 1700), `기본 ${w0} → ${JSON.stringify(widths)}`);
  await nav(cdp, '에셋 제작 현황');
  await sleep(600);
  await clickText(cdp, '보드');
  await sleep(400);
  const fill = await cdp.eval("(() => { const k = document.querySelector('.kanban'); return k.scrollWidth <= k.clientWidth + 1 && document.querySelector('.kb-col').getBoundingClientRect().width > 264; })()");
  check('넓게: 보드 열이 늘어나 가로 스크롤 없이 모든 열이 보인다', fill);
  await cdp.send('Page.reload', {});
  await cdp.waitUntil("document.querySelector('.sidebar')", 20000);
  await sleep(800);
  const kept = await cdp.eval("document.querySelector('.app').classList.contains('wide') && document.querySelector('[aria-label=\"화면 폭\"] button.on').textContent === '넓게'");
  check('새로 고침해도 넓게가 유지된다', kept);
  await cdp.eval("[...document.querySelectorAll('[aria-label=\"화면 폭\"] button')].find(b => b.textContent === '기본').click()");
  await sleep(300);
  check('기본으로 되돌리기', !(await cdp.eval("document.querySelector('.app').classList.contains('wide')")) && (await pageW()) <= 1240);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
