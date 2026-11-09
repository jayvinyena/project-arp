// 에셋 제작 현황 시험(크롬, 화면 없음): 예시 에셋 보기 · 항목 탭 · 표 보기에서 상태 바꾸기 → 작업 진척 집계 · 잠금
//   → 빈 에셋 만들기 · 썸네일 넣기(끌어놓기) · 일괄 배치 옮기기 · 배치 더하기 · 에셋 엑셀 받기
//   node tools/e2e-assets.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function shot(cdp, name, width = 1440) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(300);
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const over = await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return !over;
}
const clickText = (cdp, text, scope = 'document') => cdp.eval(`(() => { const b = [...${scope}.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('버튼 없음: ${text}'); b.click(); })()`);
const select = (cdp, selector, value) => cdp.eval(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const nav = (cdp, text) => cdp.eval(`[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=assets&nosw&page=assets` });
  await cdp.waitUntil("document.querySelectorAll('.asset-card').length > 0", 20000);

  // 1. 예시: 카드 20개, 항목 탭, 숫자 칸
  const cards = await cdp.eval("document.querySelectorAll('.asset-card').length");
  check('예시 에셋 20개가 카드로 보인다', cards === 20, `${cards}개`);
  const tabs = await cdp.eval("[...document.querySelectorAll('.group-tab')].map(b => b.firstChild.textContent).join(',')");
  check('항목 탭: 전체 + 분류', tabs.startsWith('전체,캐릭터'), tabs);
  await cdp.eval("[...document.querySelectorAll('.group-tab')].find(b => b.textContent.startsWith('배경')).click()");
  await sleep(300);
  check('분류를 고르면 그 분류만(배경: 에셋 없음 안내)', await cdp.eval("document.querySelectorAll('.asset-card').length === 0 && !!document.querySelector('.empty-assets')"));
  await cdp.eval("[...document.querySelectorAll('.group-tab')].find(b => b.textContent.startsWith('캐릭터')).click()");
  await sleep(300);

  // 2. 표 보기: 넷째 쿠키(검수 요청) 원화를 완료로 → 작업 진척 원화 4
  await clickText(cdp, '표');
  await cdp.waitUntil("document.querySelector('table.asset-table')", 8000);
  const sel = 'select[aria-label="닌자맛 쿠키 원화 상태"]';
  check('표 보기: 칸마다 상태 고르기', (await cdp.eval(`document.querySelector('${sel}')?.value`)) === 'REVIEW');
  await select(cdp, sel, 'DONE');
  await cdp.waitUntil(`document.querySelector('${sel}')?.value === 'DONE'`, 8000);
  await nav(cdp, '작업 진척');
  await cdp.waitUntil("document.querySelector('table.progress-grid tbody tr.row')", 10000);
  const row = await cdp.eval("(() => { const r = [...document.querySelectorAll('table.progress-grid tbody tr.row')].find(x => x.textContent.includes('신규 캐릭터')); return { locked: !!r.querySelector('.locked-cell'), tag: !!r.querySelector('.tag-link'), first: r.querySelectorAll('td')[2].textContent.trim() }; })()");
  check('작업 진척: 에셋에서 집계(잠금 · 원화 3 → 4)', row.locked && row.tag && row.first === '4', JSON.stringify(row));
  // 작업 진척에서 "에셋에서 집계"를 누르면 에셋 화면으로
  await cdp.eval("[...document.querySelectorAll('table.progress-grid tbody tr.row')].find(x => x.textContent.includes('신규 캐릭터')).querySelector('.tag-link').click()");
  await cdp.waitUntil("document.querySelector('.page h1')?.textContent === '에셋 제작 현황'", 8000);
  check('"에셋에서 집계"를 누르면 에셋 화면으로', true);

  // 3. 빈 에셋 만들기(코스튬 8 → 최대안 20)
  await cdp.waitUntil("document.querySelector('table.vol-compare')", 8000);
  await cdp.eval("[...document.querySelectorAll('table.vol-compare tbody tr')].find(r => r.textContent.startsWith('코스튬')).querySelector('button').click()");
  await cdp.waitUntil("[...document.querySelectorAll('table.vol-compare tbody tr')].find(r => r.textContent.startsWith('코스튬'))?.querySelectorAll('td')[2]?.textContent.replace(/\\s/g, '') === '10·15·20'", 10000).catch(() => {});
  const reg = await cdp.eval("[...document.querySelectorAll('table.vol-compare tbody tr')].find(r => r.textContent.startsWith('코스튬')).querySelectorAll('td')[2].textContent.replace(/\\s/g, '')");
  check('빈 에셋 만들기: 템플릿 구간별로 물량만큼(10 · 15 · 20)', reg === '10·15·20', reg);

  // 4. 카드 보기 · 상세 패널 · 썸네일 넣기(끌어놓기)
  await clickText(cdp, '카드');
  await cdp.waitUntil("document.querySelector('.asset-card')", 8000);
  await cdp.eval("document.querySelector('.asset-card-open').click()");
  await cdp.waitUntil("document.querySelector('.asset-drawer .thumb-drop')", 8000);
  await cdp.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d'); g.fillStyle = '#e7a35a'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#5b3a1e'; g.beginPath(); g.arc(320, 240, 150, 0, 7); g.fill();
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'cookie.png', { type: 'image/png' }));
    document.querySelector('.asset-drawer .thumb-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await cdp.waitUntil("document.querySelector('.asset-drawer .thumb img')", 10000).catch(() => {});
  const img = await cdp.eval("(() => { const i = document.querySelector('.asset-drawer .thumb img'); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null; })()");
  check('썸네일 끌어놓기 → 긴 변 256px로 줄여 저장 · 표시', img && img.w === 256 && img.h === 192, JSON.stringify(img));
  const okDrawer = await shot(cdp, 'assets-drawer-1440');
  await cdp.eval("document.querySelector('.asset-drawer button[aria-label=\"닫기\"]').click()");
  await sleep(300);
  check('카드에도 썸네일이 보인다', await cdp.waitUntil("document.querySelector('.asset-card .thumb img')", 8000).then(() => true).catch(() => false));

  // 5. 여러 개 골라 배치 옮기기 · 배치 더하기
  await cdp.eval("[...document.querySelectorAll('.asset-check')].slice(0, 3).forEach(c => c.click())");
  await cdp.waitUntil("document.querySelector('.bulk-bar.on')", 5000);
  const before = await cdp.eval("document.querySelector('.bulk-bar').getBoundingClientRect().height");
  await select(cdp, 'select[aria-label="옮길 배치"]', 'B002');
  await clickText(cdp, '배치 옮기기');
  await sleep(600);
  const b2 = await cdp.eval("[...document.querySelectorAll('table.batch-table tbody tr')].find(r => r.querySelector('input')?.value === '2차 납품')?.querySelectorAll('td')[3]?.textContent");
  check('여러 개 골라 배치 옮기기(2차 납품 6 → 9)', b2 === '9', b2);
  await cdp.eval("(() => { const i = document.querySelector('input[aria-label=\"새 배치 이름\"]'); i.value = '3차 납품'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sleep(150);
  await clickText(cdp, '배치 더하기');
  await cdp.waitUntil("[...document.querySelectorAll('table.batch-table tbody tr')].some(r => r.querySelector('input')?.value === '3차 납품')", 8000).catch(() => {});
  check('배치 더하기', await cdp.eval("[...document.querySelectorAll('table.batch-table tbody tr')].some(r => r.querySelector('input')?.value === '3차 납품')"));
  await cdp.eval("document.querySelectorAll('.asset-check:checked').forEach(c => c.click())");
  await sleep(300);
  const after = await cdp.eval("document.querySelector('.bulk-bar').getBoundingClientRect().height");
  check('일괄 고치기 줄은 고르기 전후로 높이가 같다(화면이 들썩이지 않음)', Math.abs(before - after) < 1, `${before} / ${after}`);

  // 6. 엑셀 받기 · 저장 표시 · 화면
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: `${ROOT}samples/out` }).catch(() => {});
  await clickText(cdp, '엑셀 받기');
  await sleep(500);
  const save = await cdp.eval("document.querySelector('.save-state')?.textContent ?? ''");
  check('고친 내용은 저장할 변경으로 남는다', save.includes('저장 안 된 변경'), save);
  const ok1440 = await shot(cdp, 'assets-1440');
  const ok390 = await shot(cdp, 'assets-390', 390);
  check('가로 넘침 없음(1440 · 390 · 상세 패널)', ok1440 && ok390 && okDrawer);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
