// 공정 순서 · 파이프라인 · 옮기기 시험(크롬, 화면 없음, docs/27 · docs/28):
//   파트 표 끌기(마우스) · 손잡이 키보드 · 파이프라인 만들기 · 단계 더하기 · 단계 겹침률 ·
//   리소스 파이프라인 고르기(밖 파트 옮기기 창) · 파이프라인 밖 칸 잠금 · 기록 있는 칸 비우기 → 옮기기 창 · → 로 옮기기 ·
//   에셋 보드 파이프라인 고르기(열 = 단계) · 배치 순서 끌기
//   node tools/e2e-pipeline.mjs [--no-build]
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
const q = s => JSON.stringify(s);
const typeIn = async (cdp, selector, v) => {
  await cdp.eval(`(() => { const i = document.querySelector(${q(selector)}); i.value = ${q(String(v))}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(120);
  await cdp.eval(`document.querySelector(${q(selector)}).dispatchEvent(new FocusEvent('blur'))`);
  await sleep(500);
};
const select = async (cdp, selector, value) => { await cdp.eval(`(() => { const s = document.querySelector(${q(selector)}); s.value = ${q(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(500); };
const clickText = (cdp, text, scope = 'document') => cdp.eval(`(() => { const b = [...${scope}.querySelectorAll('button')].find(x => x.textContent.trim() === ${q(text)}); if (!b) throw new Error('버튼 없음: ' + ${q(text)}); b.click(); })()`);
const nav = (cdp, text) => cdp.eval(`[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes(${q(text)})).click()`);
const partNames = cdp => cdp.eval("[...document.querySelectorAll('table.setup-parts tbody tr')].map(r => r.querySelector('input.field')?.value)");
const center = (cdp, selector) => cdp.eval(`(() => { const r = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top }; })()`);
/** 진짜 마우스로 끌기(포인터 사건은 브라우저가 만든다) */
async function mouseDrag(cdp, from, to, holdMs = 0) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  if (holdMs) await sleep(holdMs);
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6, button: 'left', buttons: 1 });
    await sleep(40);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
}
const key = (cdp, selector, k) => cdp.eval(`(() => { const b = document.querySelector(${q(selector)}); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: ${q(k)}, bubbles: true })); })()`);

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=assets&nosw&page=setup` });
  await cdp.waitUntil("document.querySelector('table.setup-parts tbody tr')", 20000);
  await sleep(500);

  // 1. 파트 표: 손잡이를 마우스로 끌기 · 줄을 길게 눌러 끌기 · 손잡이 키보드
  const before = await partNames(cdp);
  const h2 = await center(cdp, 'table.setup-parts tbody tr:nth-child(2) .reorder-handle');
  const r1 = await center(cdp, 'table.setup-parts tbody tr:nth-child(1)');
  await mouseDrag(cdp, h2, { x: h2.x, y: r1.top + 3 });
  const a1 = await partNames(cdp);
  check('파트 손잡이를 끌어 둘째를 맨 앞으로', a1[0] === before[1] && a1[1] === before[0], a1.join(' → '));
  // 줄(이름 칸 밖, 공수 숫자 칸)을 길게 눌러 끌기: 맨 앞 줄을 둘째 뒤로
  const cell = await center(cdp, 'table.setup-parts tbody tr:nth-child(1) td:nth-child(1)');
  cell.x -= 16; // 손잡이 단추 바깥(칸 여백)
  const r3 = await center(cdp, 'table.setup-parts tbody tr:nth-child(2)');
  await mouseDrag(cdp, cell, { x: cell.x, y: r3.y + 12 }, 450);
  const a2 = await partNames(cdp);
  check('줄을 길게 눌러 끌어 되돌리기', a2.join() === before.join(), a2.join(' → '));
  // 짧게 누르고 움직이면 끌기가 아니다
  await mouseDrag(cdp, cell, { x: cell.x, y: r3.y + 12 }, 0);
  check('짧게 눌러 움직이면 순서 그대로', (await partNames(cdp)).join() === before.join());
  await key(cdp, `button[aria-label^="${before[0]} 순서 옮기기"]`, 'ArrowDown');
  await sleep(700);
  const a3 = await partNames(cdp);
  check('손잡이에서 ↓ 로 한 칸 뒤로', a3[1] === before[0], a3.join(' → '));
  await key(cdp, `button[aria-label^="${before[0]} 순서 옮기기"]`, 'ArrowUp');
  await sleep(700);
  check('손잡이에서 ↑ 로 되돌리기', (await partNames(cdp)).join() === before.join());

  // 1-2. 새 파트는 파트 목록에만: 어느 파이프라인에도 들어가지 않고 알림(docs/29)
  const pipeNames = () => cdp.eval("[...document.querySelectorAll('.pipeline-card input.pipeline-name')].map(x => x.value).join(',')");
  check('예시 파일: 숨은 기본 순서 없이 "기본" 파이프라인 하나', (await pipeNames()) === '기본', await pipeNames());
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="새 파트 이름"]'); i.value = '배경 원화'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  await clickText(cdp, '파트 더하기');
  await cdp.waitUntil("[...document.querySelectorAll('table.setup-parts tbody tr')].length === 5", 8000);
  const loose = await cdp.eval("(() => { const r = [...document.querySelectorAll('table.setup-parts tbody tr')].find(x => x.querySelector('input.field')?.value === '배경 원화'); return r.querySelector('td.part-pipes').textContent; })()");
  const baseChips = await cdp.eval("[...[...document.querySelectorAll('.pipeline-card')].find(c => c.querySelector('input.pipeline-name')?.value === '기본').querySelectorAll('.step-chip')].map(c => c.textContent.trim()).join(',')");
  const note = await cdp.eval("document.querySelector('.pipe-note')?.textContent ?? ''");
  check('새 파트는 "파이프라인 없음" · 기본 파이프라인은 그대로 · 알림', loose === '파이프라인 없음' && !baseChips.includes('배경 원화') && note.includes('배경 원화'), `${loose} · ${baseChips} · ${note.slice(0, 40)}`);
  await cdp.eval(`(() => { const r = [...document.querySelectorAll('table.setup-parts tbody tr')].find(x => x.querySelector('input.field')?.value === '배경 원화'); r.querySelector('button[aria-label="배경 원화 파트 지우기"]').click(); })()`);
  await cdp.waitUntil("[...document.querySelectorAll('table.setup-parts tbody tr')].length === 4 && !document.querySelector('.pipe-note')", 8000).catch(() => {});

  // 2. 파이프라인 만들기 · 단계 더하기(모델링 → 원화, 거꾸로) · 단계 겹침률
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="새 파이프라인 이름"]'); i.value = '역순'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  await clickText(cdp, '파이프라인 만들기');
  await cdp.waitUntil(`!!document.querySelector('select[aria-label="역순 단계 더하기"]')`, 8000);
  await select(cdp, 'select[aria-label="역순 단계 더하기"]', 'MODELING');
  await select(cdp, 'select[aria-label="역순 단계 더하기"]', 'CONCEPT');
  const chipText = await cdp.eval("[...[...document.querySelectorAll('.pipeline-card')].find(c => c.querySelector('input.pipeline-name')?.value === '역순').querySelectorAll('.step-chip')].map(c => c.textContent.trim()).join(',')");
  check('파이프라인 만들기 + 단계 두 개(모델링 → 원화)', chipText === '1모델링,2원화', chipText);
  await cdp.eval(`document.querySelector('button.overlap-pill[aria-label^="역순: 모델링 → 원화 겹침률"]').click()`);
  await cdp.waitUntil(`!!document.querySelector('input.overlap-in')`, 5000);
  await typeIn(cdp, 'input.overlap-in', '40');
  const pill = await cdp.eval(`(() => { const b = document.querySelector('button.overlap-pill[aria-label^="역순: 모델링 → 원화 겹침률"]'); return { text: b.textContent, inherited: b.classList.contains('inherited') }; })()`);
  check('단계 겹침률 40% 적기(물려받은 값 표시가 아님)', pill.text.endsWith('40%') && !pill.inherited, JSON.stringify(pill));
  const pid = await cdp.eval(`[...document.querySelector('select[aria-label="신규 캐릭터 파이프라인"]').options].find(o => o.textContent === '역순').value`);

  // 3. 리소스 파이프라인 고르기: 밖 파트에 공수가 있으면 옮기기 창
  await select(cdp, 'select[aria-label="신규 캐릭터 파이프라인"]', pid);
  await cdp.waitUntil("!!document.querySelector('.move-dialog')", 5000).catch(() => {});
  const dlg = await cdp.eval("document.querySelector('.move-dialog')?.getAttribute('aria-label') ?? null");
  const rowsN = await cdp.eval("document.querySelectorAll('.move-dialog .move-table tbody tr').length");
  check('밖 파트에 공수가 있으면 파이프라인 바꾸기 창(파트마다 옮길 곳)', dlg === '파이프라인 바꾸기' && rowsN >= 1, `${dlg} · ${rowsN}줄`);
  check('창이 열려도 고르기 칸은 아직 그대로(기본)', (await cdp.eval(`document.querySelector('select[aria-label="신규 캐릭터 파이프라인"]').value`)) === 'L00');
  await clickText(cdp, '파이프라인 바꾸기', "document.querySelector('.move-dialog')");
  await cdp.waitUntil("!document.querySelector('.move-dialog')", 8000).catch(() => {});
  const locked = await cdp.eval(`document.querySelectorAll('[aria-label^="신규 캐릭터 "][aria-label$=" 파이프라인 밖"]').length`);
  check('파이프라인을 바꾸면 밖 파트 칸은 잠김', (await cdp.eval(`document.querySelector('select[aria-label="신규 캐릭터 파이프라인"]').value`)) === pid && locked === rowsN, `잠긴 칸 ${locked}`);

  // 4. 기록 있는 칸 비우기 → 옮기기 창 · 그만두면 값 그대로 · → 로 옮기기
  const costume = await cdp.eval(`document.querySelector('input[aria-label="코스튬 원화 기본 공수"]')?.value ?? null`);
  if (costume == null) check('코스튬 원화 공수 칸', false, '없음');
  else {
    await typeIn(cdp, 'input[aria-label="코스튬 원화 기본 공수"]', '');
    await cdp.waitUntil("!!document.querySelector('.move-dialog')", 5000).catch(() => {});
    check('기록(에셋 상태) 있는 칸을 비우면 옮기기 · 지우기 창', (await cdp.eval("document.querySelector('.move-dialog')?.getAttribute('aria-label')")) === '공수 옮기기 · 지우기');
    await clickText(cdp, '그만두기', "document.querySelector('.move-dialog')");
    await sleep(500);
    check('그만두면 칸 값이 돌아온다', (await cdp.eval(`document.querySelector('input[aria-label="코스튬 원화 기본 공수"]').value`)) === costume, costume);
    await shot(cdp, 'pipeline-setup-1440');
    await cdp.eval(`document.querySelector('button[aria-label="코스튬 원화 다른 파트로 옮기기"]').click()`);
    await cdp.waitUntil("!!document.querySelector('.move-dialog')", 5000);
    const to = await cdp.eval("document.querySelector('.move-dialog select[aria-label=\"옮길 파트\"]').value");
    await clickText(cdp, '옮기기', "document.querySelector('.move-dialog')");
    await cdp.waitUntil("!document.querySelector('.move-dialog')", 8000).catch(() => {});
    const after = await cdp.eval(`document.querySelector('input[aria-label="코스튬 원화 기본 공수"]').value`);
    check('→ 로 다른 파트에 옮기면 원화 칸이 빈다', after === '' && !!to, `→ ${to}`);
  }
  // 긴 파이프라인 이름(19자)도 리소스 표 고르기 칸에 다 보인다
  const longName = '캐릭터 제작 파이프라인 긴 이름 시험';
  await typeIn(cdp, 'input.pipeline-name', longName);
  const fit = await cdp.eval(`[...document.querySelectorAll('select.pipe-select')].map(s => {
    const cs = getComputedStyle(s); const c = document.createElement('canvas').getContext('2d'); c.font = cs.font;
    const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20; // 펼침 화살표
    return { t: s.selectedOptions[0]?.text ?? '', ok: c.measureText(s.selectedOptions[0]?.text ?? '').width <= room };
  })`);
  check('긴 파이프라인 이름도 리소스 표 칸에 다 보인다', fit.some(f => f.t === longName) && fit.every(f => f.ok), JSON.stringify(fit.filter(f => !f.ok)));
  check('기준 정보 390px 가로 넘침 없음', await shot(cdp, 'pipeline-setup-390', 390));

  // 5. 에셋 보드: 파이프라인을 고르면 그 파이프라인 에셋만, 열 = 단계
  await nav(cdp, '에셋 제작 현황');
  await cdp.waitUntil("document.querySelector('.asset-bar')", 10000);
  await cdp.eval("[...document.querySelectorAll('button[role=radio]')].find(b => b.textContent.includes('보드')).click()");
  await cdp.waitUntil(`!!document.querySelector('select[aria-label="보드 파이프라인"]')`, 8000);
  await select(cdp, 'select[aria-label="보드 파이프라인"]', pid);
  const cols = await cdp.eval("[...document.querySelectorAll('.kb-col')].map(c => c.dataset.col).join(',')");
  const cards = await cdp.eval("document.querySelectorAll('.kb-card').length");
  check('보드 파이프라인: 열 = 대기 · 모델링 · 원화 · 완료, 그 파이프라인 에셋(신규 캐릭터 12)', cols === 'TODO,MODELING,CONCEPT,DONE' && cards === 12, `${cols} · ${cards}장`);
  await shot(cdp, 'pipeline-board-1440');
  await select(cdp, 'select[aria-label="보드 파이프라인"]', 'all');
  await cdp.eval("[...document.querySelectorAll('button[role=radio]')].find(b => b.textContent.includes('리스트')).click()");

  // 6. 배치 순서: 손잡이 키보드
  await cdp.eval("[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.trim().startsWith('배치')).click()");
  await cdp.waitUntil("document.querySelector('table.batch-table tbody tr .reorder-handle')", 8000);
  const bn = () => cdp.eval("[...document.querySelectorAll('table.batch-table tbody tr')].map(r => r.querySelector('input.field')?.value).join(',')");
  const b0 = await bn();
  await key(cdp, 'button[aria-label^="2차 납품 순서 옮기기"]', 'ArrowUp');
  await sleep(700);
  check('배치 순서: 손잡이 ↑', (await bn()) === '2차 납품,1차 납품', `${b0} → ${await bn()}`);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
