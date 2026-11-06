// 작업 진척 시험(크롬, 화면 없음): 칸 넣기 → 진행률 → 주의 칸 → 다 끝남 → 업데이트 계획에서 완료 예정이 당겨짐
//   node tools/e2e-progress.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function shot(cdp, name, width = 1440) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(250);
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  if (await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1')) console.log(`  ⚠ ${name}: 가로 넘침`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}
const setInput = async (cdp, selector, value) => {
  await cdp.eval(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new FocusEvent('blur'))`);
  await sleep(400);
};
const total = "document.querySelector('.progress-total .big')?.textContent";
const launchCompletion = "[...document.querySelectorAll('table.grid.list tbody tr')].find(r => r.textContent.includes('런칭'))?.querySelectorAll('td')[6]?.childNodes[0]?.textContent";

await withBrowser(async (cdp, base) => {
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal&page=plan` });
  await cdp.waitUntil("document.querySelectorAll('table.grid.list tbody tr').length > 0");
  const before = await cdp.eval(launchCompletion);

  await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes('작업 진척')).click()");
  await cdp.waitUntil("document.querySelector('.progress-grid')");
  const rows = await cdp.eval("document.querySelectorAll('.progress-grid tbody tr.row').length");
  const off = await cdp.eval("document.querySelectorAll('.progress-grid .off-cell').length");
  check('런칭 리소스 6종, 거치지 않는 칸은 회색', rows === 6 && off === 11, `${rows}줄, 회색 ${off}칸`);
  const t0 = await cdp.eval(total);

  await setInput(cdp, 'input[aria-label="프랍 원화 완료"]', '40');
  const t1 = await cdp.eval(total);
  check('칸을 넣으면 전체 진행률이 오른다', parseInt(t1) > parseInt(t0), `${t0} → ${t1}`);

  await setInput(cdp, 'input[aria-label="신규 캐릭터 애니메이션 완료"]', '2');
  const warn = await cdp.eval(`document.querySelector('input[aria-label="신규 캐릭터 애니메이션 완료"]').classList.contains('warn')`);
  const banner = await cdp.eval("document.querySelector('.banner.warn')?.textContent ?? ''");
  check('앞 공정보다 많이 끝나면 주황 칸 + 확인 알림', warn && banner.includes('확인할 칸'), banner.slice(0, 20));
  await setInput(cdp, 'input[aria-label="신규 캐릭터 애니메이션 완료"]', '');

  for (const name of ['신규 캐릭터', '배경 맵', '프랍', '코스튬']) {
    await cdp.eval(`[...document.querySelectorAll('.progress-grid tbody tr.row')].find(r => r.textContent.startsWith(${JSON.stringify(name)}))?.querySelector('button')?.click()`);
    await sleep(400);
  }
  const done = await cdp.eval("[...document.querySelectorAll('.progress-grid tbody tr.row')].filter(r => r.querySelector('.fill.done')).length");
  check('다 끝남 4줄 → 100% 표시', done === 4, `${done}줄`);
  await shot(cdp, 'progress-1440');
  await shot(cdp, 'progress-390', 390);

  await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes('업데이트 계획')).click()");
  await cdp.waitUntil("document.querySelectorAll('table.grid.list tbody tr').length > 0");
  await sleep(300);
  const after = await cdp.eval(launchCompletion);
  const toNum = s => { const m = /(\d+)월 (\d+)일/.exec(s ?? ''); return m ? Number(m[1]) * 100 + Number(m[2]) : NaN; };
  check('업데이트 계획에서 런칭 완료 예정이 당겨진다', toNum(after) < toNum(before), `${before} → ${after}`);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
