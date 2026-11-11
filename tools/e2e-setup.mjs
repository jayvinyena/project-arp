// 만든 뒤 고치기 · 물량 템플릿 시험(크롬, 화면 없음):
//   프로젝트·파트·리소스 화면(기본 가동률을 기간 전체에, AI 활용 비율·AI 공수, 파트·리소스 더하기) · 템플릿 이름 바꾸기 · 템플릿 수량 복사
//   node tools/e2e-setup.mjs [--no-build]
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}
const typeIn = async (cdp, label, v) => {
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="${label}"]'); i.value = ${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await cdp.eval(`document.querySelector('input[aria-label="${label}"]').dispatchEvent(new FocusEvent('blur'))`);
  await sleep(500);
};
const value = (cdp, label) => cdp.eval(`document.querySelector('input[aria-label="${label}"]')?.value ?? null`);
const nav = (cdp, text) => cdp.eval(`[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
const clickText = (cdp, text) => cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('버튼 없음: ${text}'); b.click(); })()`);
const daysOf = (cdp, name) => cdp.eval(`(() => { const r = [...document.querySelectorAll('table.grid.vol tbody tr.row')].find(x => x.querySelector('.title')?.textContent.startsWith(${JSON.stringify(name)})); return r ? Number(r.querySelector('td.days .num')?.firstChild?.textContent.replace(/,/g, '')) : null; })()`);

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal&page=launch&nosw` });
  await cdp.waitUntil("document.querySelectorAll('.mode-card').length === 3", 15000);

  // 1. 물량 템플릿: 기본 이름 · 세 열 나란히 · 편집 중인 열만 입력
  const labels = await cdp.eval("[...document.querySelectorAll('.mode-card .label')].map(x => x.textContent)");
  check('템플릿 기본 이름: 최소안 · 기본안 · 최대안', labels.join(',') === '최소안,기본안,최대안', labels.join(','));
  check('물량 표는 세 템플릿 열 · 편집 중(기본안) 열만 입력 칸', !!(await value(cdp, '신규 캐릭터 기본안')) && (await cdp.eval("[...document.querySelectorAll('table.grid.vol th.mode-th')].map(x => x.textContent).join(',')")) === '최소안,기본안편집,최대안' && (await cdp.eval("document.querySelectorAll('table.grid.vol tr.row')[0].querySelectorAll('td.mode-cell.ro').length")) === 2);
  const charDays = await daysOf(cdp, '신규 캐릭터');

  // 2. 템플릿 이름 바꾸기
  await typeIn(cdp, '템플릿 이름', '계획안');
  await cdp.waitUntil("[...document.querySelectorAll('.mode-card .label')].some(x => x.textContent === '계획안')", 8000).catch(() => {});
  check('템플릿 이름을 바꾸면 탭·표·칸 이름이 바뀐다', (await cdp.eval("[...document.querySelectorAll('.mode-card .label')].map(x => x.textContent).join(',')")) === '최소안,계획안,최대안' && (await value(cdp, '신규 캐릭터 계획안')) !== null);

  // 3. 표의 최대안 머리글을 눌러 편집을 넘기고, 계획안 → 최대안 복사
  await cdp.eval("[...document.querySelectorAll('table.grid.vol th.mode-th button')].find(b => b.textContent === '최대안').click()");
  await cdp.waitUntil("document.querySelector('input[aria-label=\"신규 캐릭터 최대안\"]') && document.querySelector('.mode-card.selected .label')?.textContent === '최대안'", 8000);
  await cdp.eval("document.querySelector('button[aria-label=\"계획안 → 최대안 복사\"]').click()");
  await sleep(700);
  const same = await cdp.eval("[...document.querySelectorAll('table.grid.vol tbody tr.row')].every(r => r.querySelector('td.mode-cell.sel input.qty')?.value === r.querySelector('td.mode-cell[data-mode=\"TARGET\"] .ro-val')?.textContent)");
  check('머리글로 편집 전환 + 계획안 → 최대안 복사: 최대안 = 계획안', same);
  await shot(cdp, 'templates-1440');
  await cdp.eval("document.querySelectorAll('.mode-card')[1].click()");
  await sleep(400);

  // 4. 프로젝트·파트·리소스
  await nav(cdp, '프로젝트·파트·리소스');
  await cdp.waitUntil("document.querySelector('table.setup-parts tbody tr')", 10000);
  const partsN = await cdp.eval("document.querySelectorAll('table.setup-parts tbody tr').length");
  check('파트 표(마법사에서 넣은 4개)', partsN === 4, `${partsN}개`);
  await typeIn(cdp, 'FX 기본 가동률', '70');
  await cdp.waitUntil(`document.querySelector('input[aria-label="FX 기본 가동률"]')?.value === '70'`, 8000).catch(() => {});
  check('기본 가동률을 계획 기간 전체에 적용', (await value(cdp, 'FX 기본 가동률')) === '70');
  // AI: 원화 AI 활용 100%, 신규 캐릭터 원화 AI 공수 = 기본의 절반
  const baseDays = Number(await value(cdp, '신규 캐릭터 원화 기본 공수'));
  await typeIn(cdp, '신규 캐릭터 원화 AI 공수', String(baseDays / 2));
  await typeIn(cdp, '원화 AI 활용 비율', '100');
  check('AI 공수 · AI 활용 비율이 남는다', (await value(cdp, '신규 캐릭터 원화 AI 공수')) === String(baseDays / 2) && (await value(cdp, '원화 AI 활용 비율')) === '100');
  // 파트·리소스 더하기
  await typeIn(cdp, '새 파트 이름', '리깅');
  await clickText(cdp, '파트 더하기');
  await cdp.waitUntil("document.querySelectorAll('table.setup-parts tbody tr').length === 5", 8000).catch(() => {});
  check('파트 더하기', (await cdp.eval("document.querySelectorAll('table.setup-parts tbody tr').length")) === 5);
  await typeIn(cdp, '새 리소스 분류', '오브젝트');
  await typeIn(cdp, '새 리소스 이름', '탈것');
  await clickText(cdp, '리소스 더하기');
  await cdp.waitUntil(`!!document.querySelector('input[aria-label="탈것 원화 기본 공수"]')`, 8000).catch(() => {});
  await typeIn(cdp, '탈것 원화 기본 공수', '2');
  check('리소스 더하기 · 공수 넣기', (await value(cdp, '탈것 원화 기본 공수')) === '2' && (await value(cdp, '탈것 분류')) === '오브젝트');
  // 리소스 지우기: 물량에 쓰이는 리소스(이펙트)도 X → 함께 지워질 것을 보여 주는 창 → 모두 지우기
  await cdp.eval(`document.querySelector('button[aria-label="이펙트 리소스 지우기"]').click()`);
  await cdp.waitUntil(`!!document.querySelector('[aria-label="리소스 지우기"]')`, 5000).catch(() => {});
  const delText = await cdp.eval(`document.querySelector('[aria-label="리소스 지우기"]')?.textContent ?? ''`);
  check('쓰이는 리소스도 X를 누르면 함께 지워질 것(업데이트 물량 등)을 보여 준다', delText.includes('업데이트') && delText.includes('물량') && delText.includes('사용 안 함으로 두기'), delText.slice(0, 80));
  await cdp.eval(`[...document.querySelectorAll('[aria-label="리소스 지우기"] button')].find(b => b.textContent === '모두 지우기').click()`);
  await cdp.waitUntil(`!document.querySelector('button[aria-label="이펙트 리소스 지우기"]')`, 8000).catch(() => {});
  check('모두 지우기 → 리소스 줄이 사라진다', !(await cdp.eval(`!!document.querySelector('button[aria-label="이펙트 리소스 지우기"]')`)));
  await shot(cdp, 'setup-1440');
  await shot(cdp, 'setup-390', 390);

  // 5. AI를 쓰면 런칭의 필요 공수가 준다
  await nav(cdp, '런칭 물량 설계');
  await cdp.waitUntil("document.querySelectorAll('table.grid.vol tbody tr.row').length > 0", 10000);
  await sleep(500);
  const after = await daysOf(cdp, '신규 캐릭터');
  check('AI 활용을 입력하면 신규 캐릭터 필요 공수가 준다', after != null && charDays != null && after < charDays, `${charDays} → ${after}`);

  // 6. 화면 안내: 머리말의 버튼 → 패널 → 함께 쓰는 화면으로 이동 · 메뉴 이름 '작업 진척'
  await cdp.eval("document.querySelector('.page-head .help-btn').click()");
  await cdp.waitUntil("document.querySelector('.help-panel')", 5000);
  const helpTitle = await cdp.eval("document.querySelector('.help-panel h2').textContent");
  const steps = await cdp.eval("document.querySelectorAll('.help-panel .help-steps li').length");
  check('화면 안내 패널: 이 화면 이름 · 쓰는 순서', helpTitle === '런칭 물량 설계' && steps >= 3, `${helpTitle} · ${steps}단계`);
  await cdp.eval("[...document.querySelectorAll('.help-link')].find(b => b.textContent.includes('업데이트 계획')).click()");
  await cdp.waitUntil("!document.querySelector('.help-panel') && document.querySelector('.sidebar .nav-item.active')?.textContent.includes('업데이트 계획')", 8000).catch(() => {});
  const navNames = await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].map(b => b.textContent).join(',')");
  check('안내의 화면 링크로 이동 · 메뉴 "작업 진척"', (await cdp.eval("document.querySelector('.sidebar .nav-item.active')?.textContent")).includes('업데이트 계획') && navNames.includes('작업 진척') && !navNames.includes('진행 실적'));

  // 7. 변경 이력에 남는다
  await nav(cdp, '변경 이력');
  await cdp.waitUntil("document.querySelector('.hist-summary')", 8000);
  const hist = await cdp.eval("[...document.querySelectorAll('.hist-summary')].map(x => x.textContent).join(' / ')");
  check('변경 이력: 리소스·파트·AI 비율·템플릿 이름', ['리소스', '파트', 'AI 비율', '프로젝트'].every(w => hist.includes(w)), hist.slice(0, 160));
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
