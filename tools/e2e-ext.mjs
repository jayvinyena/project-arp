// 6단계 시험(크롬, 화면 없음): 실투입 공수 · 공수 보정(미리 보기·적용) · 실적 엑셀 양식·넣기 · 열 때 변화 알림
//   node tools/e2e-ext.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';
import { writeXlsx } from './lib/xlsx-write.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };
async function shot(cdp, name) {
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
}
const typeIn = async (cdp, label, v) => {
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="${label}"]'); i.value = '${v}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await cdp.eval(`document.querySelector('input[aria-label="${label}"]').dispatchEvent(new FocusEvent('blur'))`);
  await sleep(450);
};
const clickText = (cdp, text, scope = 'document') => cdp.eval(`(() => { const b = [...${scope}.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('버튼 없음: ${text}'); b.click(); })()`);
const nav = (cdp, text) => cdp.eval(`[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
const toast = cdp => cdp.eval("document.querySelector('.toast')?.textContent ?? ''");

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const app = `${base}/app/index.html`;

  // 1. 실투입 공수
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&page=progress&nosw` });
  await cdp.waitUntil("document.querySelector('.progress-grid')");
  await cdp.eval("[...document.querySelectorAll('.progress-grid tbody tr.row')].find(r => r.textContent.startsWith('프랍')).querySelector('button').click()");
  await sleep(600);
  await clickText(cdp, '실투입 인·일');
  await cdp.waitUntil("document.querySelector('input[aria-label=\"프랍 원화 실투입\"]')");
  await typeIn(cdp, '프랍 원화 실투입', '63');   // 기준 50개 × 0.84 = 42 → 1.5배
  await typeIn(cdp, '프랍 모델링 실투입', '80'); // 기준 50개 × 2.1 = 105 → 0.76배
  check('실투입 칸에 값이 남는다', (await cdp.eval(`document.querySelector('input[aria-label="프랍 원화 실투입"]').value`)) === '63');

  // 2. 공수 보정
  await nav(cdp, '공수 보정');
  await cdp.waitUntil("document.querySelectorAll('table.calib tbody tr').length > 0", 10000);
  const rows = await cdp.eval("[...document.querySelectorAll('table.calib tbody tr')].map(r => r.textContent)");
  check('보정 제안 2줄(프랍 원화 +50%, 모델링 −24%)', rows.length === 2 && rows.some(t => t.includes('원화') && t.includes('+50%')) && rows.some(t => t.includes('모델링') && t.includes('−24%')), rows.join(' / ').slice(0, 120));
  await clickText(cdp, '미리 보기');
  await cdp.waitUntil("document.querySelector('.answer .tag')", 10000);
  check('미리 보기: 업데이트별 완료 예정 변화', (await cdp.eval("document.querySelectorAll('.answer .tag').length")) >= 4);
  await shot(cdp, 'calibration-1440');
  await cdp.eval("[...document.querySelectorAll('.card-head button')].find(b => b.textContent.includes('적용')).click()");
  await sleep(800);
  check('적용하면 보정 알림', (await toast(cdp)).includes('보정했습니다'), await toast(cdp));
  await nav(cdp, '변경 이력');
  await cdp.waitUntil("document.querySelector('.hist-summary')");
  check('보정은 변경 이력에 한 줄', (await cdp.eval("document.querySelector('.hist-summary').textContent")).includes('공수'));

  // 3. 실적 엑셀: 양식 받기 · 넣기
  await nav(cdp, '작업 진척');
  await cdp.waitUntil("document.querySelector('.progress-grid')");
  await cdp.eval(`(() => {
    window.__dl = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { const name = this.download; fetch(this.href).then(r => r.arrayBuffer()).then(b => { window.__dl = { name, size: b.byteLength }; }); return; }
      return orig.call(this);
    };
  })()`);
  await clickText(cdp, '양식 받기');
  await cdp.waitUntil('window.__dl', 8000);
  check('실적 양식(.xlsx) 받기', (await cdp.eval('window.__dl.name')).endsWith('작업 진척 양식.xlsx'));
  const xlsx = Buffer.from(writeXlsx({ '실적': [['업데이트', '리소스', '파트', '완료 수량', '실투입 인·일'], ['런칭', '신규 캐릭터', '원화', 9, 40], ['런칭', '없는 것', '원화', 1, null]] })).toString('base64');
  await cdp.eval(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(xlsx)}), c => c.charCodeAt(0));
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return orig.call(this);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], '실적.xlsx'));
      this.files = dt.files;
      this.dispatchEvent(new Event('change'));
    };
  })()`);
  await clickText(cdp, '엑셀로 넣기');
  await cdp.waitUntil("document.querySelector('.toast')?.textContent.includes('작업 진척을 입력했습니다')", 8000);
  const t = await toast(cdp);
  check('엑셀로 넣기: 2칸 바뀜 · 건너뛴 행 1개', t.includes('2칸 바뀜') && t.includes('건너뛴 행 1개'), t.slice(0, 60));
  await cdp.waitUntil(`document.querySelector('input[aria-label="신규 캐릭터 원화 완료"]')?.value === '9'`, 5000).catch(() => {});
  check('넣은 완료 수량이 표에 보인다', (await cdp.eval(`document.querySelector('input[aria-label="신규 캐릭터 원화 완료"]').value`)) === '9');

  // 4. 열 때 변화 알림: "나"가 본 뒤 "가"가 수정하면, "나"가 다시 열 때 알린다
  const asUser = name => cdp.eval(`localStorage.setItem('arp.editor', ${JSON.stringify(name)})`);
  await cdp.send('Page.navigate', { url: `${app}?nosw` });
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await asUser('나');
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&opfs=1&nosw` });
  await cdp.waitUntil("document.querySelector('.save-state')?.textContent.includes('저장됨')", 10000);
  await sleep(500);
  check('처음 열 때는 알림 없음', !(await cdp.eval("!!document.querySelector('.banner.notice')")));
  await clickText(cdp, '닫기', "document.querySelector('.sidebar')");
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await asUser('가');
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&opfs=1&keep=1&nosw` });
  await cdp.waitUntil("document.querySelector('input[aria-label=\"이펙트 기본안\"]')", 10000);
  await sleep(500);
  await typeIn(cdp, '이펙트 기본안', '40');
  await cdp.waitUntil("document.querySelector('.save-state')?.textContent.includes('저장됨')", 10000);
  await clickText(cdp, '닫기', "document.querySelector('.sidebar')");
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await asUser('나');
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&opfs=1&keep=1&nosw` });
  let banner = '';
  try { await cdp.waitUntil("document.querySelector('.banner.notice')", 10000); banner = await cdp.eval("document.querySelector('.banner.notice').textContent"); } catch { /* 없음 */ }
  check('다시 열면 "지난번에 본 뒤 바뀐 것": 런칭 완료 예정 변화 · 가님이 고침', banner.includes('런칭') && banner.includes('가님이 1번 수정했습니다'), banner.slice(0, 90));
  await shot(cdp, 'notice-1440');
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
