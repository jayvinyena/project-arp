// 새 프로젝트 만들기 시험(크롬, 화면 없음): 마법사 4단계 → 파일 만들기(OPFS) → 런칭 화면 → 물량 넣고 계산.
// 단계마다 캡처도 남긴다(samples/out/shots/new-*.png).
//   node tools/e2e-new.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function shot(cdp, name, width = 1440) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(200);
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const overflow = await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
  if (overflow) console.log(`  ⚠ ${name}: 가로 넘침`);
}
const click = (cdp, text) => cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('버튼 없음: ${text}'); b.click(); })()`);
const type = async (cdp, selector, value) => {
  await cdp.eval(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(120);
};
const heading = "document.querySelector('.wizard-body h1')?.textContent";

await withBrowser(async (cdp, base) => {
  await cdp.send('Page.navigate', { url: `${base}/app/index.html` });
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await cdp.eval("localStorage.setItem('arp.editor', '검사자')");
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?new&opfs=1` });
  await cdp.waitUntil("document.querySelector('.wizard')");
  await shot(cdp, 'new-1-basic');
  await shot(cdp, 'new-1-basic-390', 390);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 이름을 비우면 다음으로 못 간다
  await type(cdp, '.wizard-body input.field', '');
  await click(cdp, '다음');
  await sleep(150);
  check('이름이 비면 문제를 보여 주고 머문다', (await cdp.eval("document.querySelector('.wizard .banner.bad')?.textContent ?? ''")).includes('이름') && (await cdp.eval(heading)) === '기본 정보');
  await type(cdp, '.wizard-body input.field', '시험 프로젝트');

  await click(cdp, '다음');
  await cdp.waitUntil(`${heading} === '파트'`);
  await shot(cdp, 'new-2-parts');
  // 파트 하나 더하고 이름 넣기
  await click(cdp, '파트 더하기');
  await type(cdp, 'input[aria-label="5번째 파트 이름"]', 'UI');
  await click(cdp, '다음');
  await cdp.waitUntil(`${heading} === '리소스'`);
  const cols = await cdp.eval("document.querySelectorAll('.wizard table.grid thead th').length");
  check('파트를 더하면 리소스 표에 공수 칸이 생긴다', cols === 2 + 5 + 1, `머리글 ${cols}칸`);
  await type(cdp, 'input[aria-label="아이콘 UI 공수"]', '0.5');
  await shot(cdp, 'new-3-resources');
  await click(cdp, '다음');
  await cdp.waitUntil(`${heading} === '런칭'`);
  await shot(cdp, 'new-4-launch');

  await click(cdp, '만들고 저장 위치 고르기');
  await cdp.waitUntil("document.querySelectorAll('table.grid tbody tr.row').length > 0", 20000);
  const name = await cdp.eval("document.querySelector('.project-chip .name')?.textContent");
  check('만들면 런칭 물량 설계 화면이 열린다', name === '시험 프로젝트', name);
  const rows = await cdp.eval("document.querySelectorAll('table.grid tbody tr.row').length");
  check('리소스 6종이 물량 표에 있다', rows === 6, `${rows}줄`);
  const saved = await cdp.eval("document.querySelector('.save-state')?.textContent ?? ''");
  check('만든 파일이 저장됐다', saved.includes('저장됨'), saved);
  const file = await cdp.eval(`(async () => { const d = await navigator.storage.getDirectory(); const f = await (await d.getFileHandle('시험 프로젝트.arp')).getFile(); return f.size; })()`);
  check('파일이 생겼다', file > 10000, `${file}바이트`);
  const icon = await cdp.eval(`[...document.querySelectorAll('tr.row')].find(r => r.textContent.includes('아이콘'))?.querySelector('.steps')?.textContent ?? ''`);
  check('아이콘이 원화·UI를 거친다', icon.includes('원화') && icon.includes('UI'), icon);

  // 물량 넣고 계산
  // 기본안에 넣고 "다른 템플릿에도 똑같이"로 세 템플릿을 채운다(계산이 막혀 있어도 템플릿 전환·채우기가 된다)
  check('계산이 막혀도 템플릿을 고를 수 있다', await cdp.eval("document.querySelectorAll('[aria-label=\"물량 템플릿\"] button').length === 3"));
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="신규 캐릭터 기본안"]'); i.value = '6'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await cdp.eval(`document.querySelector('input[aria-label="신규 캐릭터 기본안"]').dispatchEvent(new FocusEvent('blur'))`);
  await sleep(400);
  await cdp.eval("[...document.querySelectorAll('button')].find(b => b.textContent === '다른 템플릿에도 똑같이').click()");
  await sleep(600);
  await cdp.waitUntil("document.querySelectorAll('.mode-card').length === 3");
  const big = await cdp.eval("document.querySelectorAll('.mode-card .big')[1]?.textContent");
  check('물량을 넣으면 완료 예정일이 나온다', /월 \d+일/.test(big ?? ''), big);
  await shot(cdp, 'new-5-created');
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
