// 5단계 안정화 시험(크롬, 화면 없음): 되돌리기 · 작업 복구 · 최근 파일 · 옛 구조 원본 · 엑셀 내보내기 · 오프라인
//   node tools/e2e-stable.mjs [--no-build]
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
const DL = `${ROOT}samples/out/downloads`;
mkdirSync(OUT, { recursive: true });
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };
async function shot(cdp, name) {
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
}
const setQty = async (cdp, label, value) => {
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="${label}"]'); i.value = '${value}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await cdp.eval(`document.querySelector('input[aria-label="${label}"]').dispatchEvent(new FocusEvent('blur'))`);
  await sleep(400);
};
const nav = (cdp, text) => cdp.eval(`[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
const value = (cdp, label) => cdp.eval(`document.querySelector('input[aria-label="${label}"]')?.value`);

await withBrowser(async (cdp, base) => {
  const app = `${base}/app/index.html`;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 1. 되돌리기
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&nosw` });
  await cdp.waitUntil("document.querySelectorAll('table.grid tbody tr.row').length > 0");
  await setQty(cdp, '프랍 기본안', '70');
  await nav(cdp, '변경 이력');
  await cdp.waitUntil("document.querySelectorAll('.hist-item').length > 0");
  const summary = await cdp.eval("document.querySelector('.hist-summary')?.textContent");
  check('변경 이력에 방금 수정한 것', summary === '물량 기본안', summary);
  await cdp.eval("[...document.querySelectorAll('.hist-item button')].find(b => b.textContent.includes('되돌리기')).click()");
  await sleep(150);
  await cdp.eval("[...document.querySelectorAll('.hist-item button')].find(b => b.textContent.trim() === '되돌리기').click()");
  await cdp.waitUntil("document.querySelector('.hist-item.undone')", 8000);
  await shot(cdp, 'history-1440');
  await nav(cdp, '런칭 물량 설계');
  await cdp.waitUntil("document.querySelector('input[aria-label=\"프랍 기본안\"]')");
  check('되돌리면 값이 돌아온다(70 → 60)', (await value(cdp, '프랍 기본안')) === '60');

  // 2. 엑셀 내보내기
  // 화면 없는 크롬은 내려받기를 폴더에 남기지 않을 수 있어, 내려받기 링크를 가로채 파일 내용을 확인한다
  await cdp.eval(`(() => {
    window.__dl = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { const name = this.download; fetch(this.href).then(r => r.arrayBuffer()).then(b => { const u = new Uint8Array(b); window.__dl = { name, size: b.byteLength, magic: String.fromCharCode(u[0], u[1]) }; }); return; }
      return orig.call(this);
    };
  })()`);
  await cdp.eval("[...document.querySelectorAll('.sidebar button')].find(b => b.textContent.includes('보고용 엑셀 내보내기')).click()");
  await cdp.waitUntil('window.__dl', 10000);
  const dl = await cdp.eval('window.__dl');
  check('보고용 엑셀 내보내기: .xlsx(압축 서명 PK)', dl.name.endsWith('.xlsx') && dl.magic === 'PK' && dl.size > 5000, `${dl.name} · ${dl.size}바이트`);
  await cdp.eval('window.__dl = null');
  await cdp.eval("[...document.querySelectorAll('.sidebar button')].find(b => b.textContent.includes('편집용 엑셀 내보내기')).click()");
  await cdp.waitUntil('window.__dl', 10000);
  const dl2 = await cdp.eval('window.__dl');
  check('편집용 엑셀 내보내기: 가져오기 양식(.xlsx)', dl2.name.includes('편집용') && dl2.magic === 'PK' && dl2.size > 5000, `${dl2.name} · ${dl2.size}바이트`);

  // 3. 작업 복구: 고친 뒤 저장하지 않고 창을 다시 열면 되살리기
  await setQty(cdp, '배경 맵 기본안', '7');
  await sleep(2200); // 사본은 1.5초 뒤
  await cdp.send('Page.navigate', { url: `${app}?nosw` });
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await sleep(400);
  const banner = await cdp.eval("document.querySelector('.welcome-card .banner')?.textContent ?? ''");
  check('다시 열면 "저장하지 않은 작업" 되살리기 제안', banner.includes('저장하지 않은 작업'), banner.slice(0, 30));
  await shot(cdp, 'recovery-1440');
  await cdp.eval("[...document.querySelectorAll('.welcome-card button')].find(b => b.textContent === '되살리기').click()");
  await cdp.waitUntil("document.querySelector('input[aria-label=\"배경 맵 기본안\"]')", 10000);
  check('되살리면 고친 값(7)과 "저장 안 된 변경"', (await value(cdp, '배경 맵 기본안')) === '7' && (await cdp.eval("document.querySelector('.save-state').textContent")).includes('저장 안 된'));

  // 4. 최근 파일: 핸들로 연 파일은 시작 화면에 남고, 누르면 다시 열린다
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&opfs=1&nosw` });
  await cdp.waitUntil("document.querySelector('.save-state')?.textContent.includes('저장됨')", 10000);
  await cdp.eval("[...document.querySelectorAll('.sidebar button')].find(b => b.textContent.trim() === '파일 닫기').click()");
  await cdp.waitUntil("document.querySelector('.recent-item')", 8000);
  const recent = await cdp.eval("document.querySelector('.recent-item span')?.textContent");
  check('최근 파일 목록', recent === 'normal.arp', recent);
  await cdp.eval("document.querySelector('.recent-item').click()");
  await cdp.waitUntil("document.querySelector('.project-chip .name')", 10000);
  check('최근 파일을 누르면 열린다', (await cdp.eval("document.querySelector('.save-state').textContent")).includes('저장'));

  // 5. 옛 구조(v1) 파일: 새 구조로 열고 원본 받기를 알린다
  await cdp.send('Page.navigate', { url: `${app}?sample=normal-v1&nosw` });
  await cdp.waitUntil("document.querySelectorAll('table.grid tbody tr.row').length > 0", 10000);
  const v1 = await cdp.eval("document.querySelector('.main .banner.warn')?.textContent ?? ''");
  check('옛 구조 파일 → 새 구조로 열고 원본 받기 알림', v1.includes('옛 구조(v1)') && v1.includes('원본 받기'), v1.slice(0, 30));

  // 6. 오프라인: 배포 빌드는 서비스 워커가 파일을 담아 두어 인터넷 없이도 뜬다
  await cdp.send('Page.navigate', { url: app });
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await cdp.eval('navigator.serviceWorker.ready.then(() => true)');
  await cdp.waitUntil('navigator.serviceWorker.controller || (location.reload(), false)', 15000).catch(() => {});
  await cdp.waitUntil("document.querySelector('.welcome-card') && navigator.serviceWorker.controller", 15000);
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await cdp.send('Page.navigate', { url: app });
  let offlineOk = false;
  try { await cdp.waitUntil("document.querySelector('.welcome-card')", 10000); offlineOk = true; } catch { /* 실패 */ }
  check('인터넷이 끊겨도 앱이 뜬다(서비스 워커)', offlineOk);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
