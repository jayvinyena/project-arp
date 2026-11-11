// 보기 모드 · 소식 시험(크롬, 화면 없음) — docs/26-viewer.md
//   ?view로 열면 보기 메뉴(소식 · 현황판 · 에셋 · 업데이트 계획) · 새 소식이 있으면 소식부터 · 입력 · 저장 단추 없음 /
//   파일에 쓰지 않음(편집 중 표시 · 저장 없음) · 편집자가 저장하면 다시 읽음 / 편집 화면에서 소식 올리기 · 알리기 문구 복사
//   node tools/e2e-viewer.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };
async function shot(cdp, name, width = 1440) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(400);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const over = await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return !over;
}
const nav = (cdp, text) => cdp.eval(`[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
const active = cdp => cdp.eval("document.querySelector('.sidebar .nav-item.active')?.textContent.replace(/\\d+$/, '').trim() ?? ''");

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const app = `${base}/app/index.html`;

  // 1. 보기로 열기: 새 소식이 있으면 소식부터, 보기 메뉴만
  await cdp.send('Page.navigate', { url: `${app}?sample=assets&view&nosw` });
  await cdp.waitUntil("document.querySelector('.news-page')", 20000);
  await sleep(400);
  const menu = await cdp.eval(`[...document.querySelectorAll('.sidebar .nav > *')].map(el => el.classList.contains('nav-label') ? '#' + el.textContent : el.textContent.replace(/\\d+$/, '').trim()).join(',')`);
  check('보기 메뉴: 소식 · 현황판 · 에셋 · 업데이트 계획', menu === '#보기,소식,제작 현황판,에셋 제작 현황,업데이트 계획', menu);
  check('새 소식이 있으면 소식 화면부터', (await active(cdp)) === '소식');
  const page = await cdp.eval(`(() => ({
    banner: document.querySelector('.viewer-banner')?.textContent ?? '',
    save: [...document.querySelectorAll('.sidebar-foot button')].map(b => b.textContent).join(','),
    write: !!document.querySelector('input[aria-label="소식 제목"]'),
    items: document.querySelectorAll('.news-item').length, fresh: document.querySelectorAll('.news-item.fresh').length,
    copy: document.querySelectorAll('.news-item button').length,
  }))()`);
  check('보기 모드 띠 · 저장 단추 없음 · 소식 쓰기 없음', page.banner.includes('보기 모드') && !page.save.includes('저장') && !page.write, page.save);
  check('예시 소식 2개 모두 새 소식 · 알리기 문구 복사 단추', page.items === 2 && page.fresh === 2 && page.copy === 2, JSON.stringify(page));
  const okNews = await shot(cdp, 'viewer-news');
  const okNews390 = await shot(cdp, 'viewer-news-390', 390);

  // 고치는 칸이 없다: 에셋(더하기 · 단계 고르기), 다른 화면으로 가는 주소는 현황판으로
  await nav(cdp, '에셋 제작 현황');
  await cdp.waitUntil("document.querySelector('.asset-list') || document.querySelector('.kanban')", 10000);
  await sleep(300);
  const ro = await cdp.eval(`(() => ({
    add: [...document.querySelectorAll('.asset-bar button')].some(b => b.textContent.includes('에셋 더하기') || b.textContent.includes('엑셀에서 가져오기')),
    stage: [...document.querySelectorAll('select[aria-label$=" 단계"]')].every(s => s.disabled),
  }))()`);
  check('에셋: 더하기 · 엑셀 넣기 없음, 단계 칸 잠김', !ro.add && ro.stage, JSON.stringify(ro));
  // 다시 보기로 열면 새 소식이 없으니 현황판부터
  await cdp.send('Page.navigate', { url: `${app}?sample=assets&view&nosw` });
  await cdp.waitUntil("document.querySelector('.sidebar .nav-item.active')", 20000);
  await sleep(500);
  check('소식을 본 뒤 다시 열면 현황판부터(새 소식 없음)', (await active(cdp)) === '제작 현황판', await active(cdp));

  // 2. 파일에 쓰지 않음 + 편집자가 저장하면 다시 읽음(브라우저 저장소 파일)
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&opfs=1&view&nosw` });
  await cdp.waitUntil("document.querySelector('.viewer-banner')", 20000);
  const stamp = () => cdp.eval("(async () => { const d = await navigator.storage.getDirectory(); return (await (await d.getFileHandle('normal.arp')).getFile()).lastModified; })()");
  const t0 = await stamp();
  await sleep(2500);
  const t1 = await stamp();
  check('보기 모드는 파일에 쓰지 않는다(편집 중 표시 · 저장 없음)', t0 === t1 && (await cdp.eval("document.querySelector('.sidebar-foot .save-state').textContent")) === '보기 모드', `${t0} → ${t1}`);
  // 편집자가 저장한 것처럼: 같은 파일에 다른 내용(에셋 예시)을 쓰고 창으로 돌아온다
  await cdp.eval(`(async () => {
    const b = await (await fetch('../assets.arp', { cache: 'no-store' })).arrayBuffer();
    const d = await navigator.storage.getDirectory();
    const w = await (await d.getFileHandle('normal.arp')).createWritable(); await w.write(b); await w.close();
    window.dispatchEvent(new Event('focus'));
  })()`);
  await cdp.waitUntil("document.querySelector('.project-chip .name')?.textContent === '샘플 · 에셋'", 10000).catch(() => {});
  const name = await cdp.eval("document.querySelector('.project-chip .name')?.textContent");
  const toast = await cdp.eval("document.querySelector('.toast')?.textContent ?? ''");
  check('편집자가 저장하면 최신 저장본으로 다시 읽는다', name === '샘플 · 에셋' && toast.includes('최신 저장본'), `${name} · ${toast}`);

  // 3. 편집 화면: 소식 올리기 · 메뉴 숫자 · 알리기 문구
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&page=news&nosw` });
  await cdp.waitUntil("document.querySelector('input[aria-label=\"소식 제목\"]')", 20000);
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="소식 제목"]'); i.value = 'M4 원화 2주 당김'; i.dispatchEvent(new Event('input', { bubbles: true })); const t = document.querySelector('textarea[aria-label="소식 내용"]'); t.value = '동료쿠키 3종 먼저'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await cdp.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('소식 올리기')).click()");
  await cdp.waitUntil("[...document.querySelectorAll('.news-title')].some(x => x.textContent === 'M4 원화 2주 당김')", 5000).catch(() => {});
  const posted = await cdp.eval("[...document.querySelectorAll('.news-item')].map(x => x.textContent).join('|')");
  const badge = await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.startsWith('소식'))?.querySelector('.pill')?.textContent ?? ''");
  check('편집 화면: 소식 올리기(쓴 사람 · 내용), 보고 있는 동안은 새 소식 숫자 없음', posted.includes('M4 원화 2주 당김') && posted.includes('동료쿠키 3종 먼저') && badge === '', `${posted.slice(0, 40)} · 숫자 ${badge}`);
  const share = await cdp.eval(`(async () => {
    let text = '';
    navigator.clipboard.writeText = async t => { text = t; };
    [...document.querySelectorAll('.news-item')].find(x => x.textContent.includes('M4 원화 2주 당김')).querySelector('button').click();
    await new Promise(r => setTimeout(r, 200));
    return text;
  })()`);
  check('알리기 문구: 제목 · 내용 · 완료 예정 · 보기 모드 안내', share.startsWith('[ARP · 샘플 · 정상] M4 원화 2주 당김') && share.includes('완료 예정(기본안)') && share.includes('보기 모드'), share.split('\n')[0]);
  check('가로 넘침 없음(소식 1440 · 390)', okNews && okNews390);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
