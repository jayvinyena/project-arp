// 제작 현황판 시험(크롬, 화면 없음): 메뉴 맨 위 · 요약 4칸 · 추이 그래프(선 · 오늘 · 완료 예정 · 주마다 값) · 처리할 것 → 카드 바로 열기
//   · 항목 × 파트 칸 · 단계 분포 · 배치 · 에셋이 없는 예시에서도 나온다 · 가로 넘침
//   node tools/e2e-dashboard.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };
async function shot(cdp, name, width = 1440) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(500);
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const over = await cdp.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return !over;
}

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=assets&nosw&page=dashboard` });
  await cdp.waitUntil("document.querySelector('.dash-tiles .stat') && document.querySelector('.burnup svg path.line-actual')", 20000);
  await sleep(500);

  const first = await cdp.eval("document.querySelector('.sidebar .nav-item')?.textContent.trim()");
  check('메뉴 맨 위가 제작 현황판', first === '제작 현황판', first);
  const tiles = await cdp.eval("[...document.querySelectorAll('.dash-tiles .stat-label')].map(x => x.textContent).join(',')");
  check('요약 4칸: 진행률 · 계획선 대비 · 이번 주 완료 · 다음 배치 마감', tiles === '진행률,계획선 대비,이번 주 완료,다음 배치 마감', tiles);
  const rate = await cdp.eval("document.querySelector('.dash-tiles .stat .stat-num').textContent");
  check('진행률 4%(작업 진척과 같은 기준: 33 / 752 인·일)', rate === '4%' && (await cdp.eval("document.querySelector('.dash-tiles .stat').textContent.includes('33 / 752')")), rate);
  const verdict = await cdp.eval("document.querySelectorAll('.dash-tiles .stat')[1].textContent");
  check('계획선 대비 · 완료 예정(계산 엔진) · 판정', /영업일 (앞섬|늦음)|같음/.test(verdict) && /완료 예정 \d{4}\. \d+\. \d+\./.test(verdict) && verdict.includes('목표 안'), verdict.replace(/\s+/g, ' '));
  check('다음 배치 마감 D-day', /D-\d+/.test(await cdp.eval("document.querySelectorAll('.dash-tiles .stat')[3].textContent")));

  // 추이 그래프: 실제 · 계획선 · 오늘 · 완료 예정, 올리면 주 값
  const chart = await cdp.eval("(() => { const s = document.querySelector('.burnup svg'); return { actual: !!s.querySelector('.line-actual')?.getAttribute('d'), ideal: !!s.querySelector('.line-ideal')?.getAttribute('d'), today: !!s.querySelector('.mark-line.today'), forecast: !!s.querySelector('.dot-forecast') }; })()");
  check('추이: 실제 선 · 계획선 · 오늘 · 완료 예정 표시', chart.actual && chart.ideal && chart.today && chart.forecast, JSON.stringify(chart));
  await cdp.eval("(() => { const s = document.querySelector('.burnup svg'); const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + r.width * 0.6, clientY: r.top + 60 })); })()");
  await cdp.waitUntil("document.querySelector('.chart-tip')", 5000).catch(() => {});
  const tip = await cdp.eval("document.querySelector('.chart-tip')?.textContent ?? ''");
  check('그래프에 올리면 그 주의 실제 · 계획선 값', /주/.test(tip) && tip.includes('계획선'), tip);

  // 항목 × 파트 · 단계 분포 · 배치
  const cell = await cdp.eval("(() => { const r = [...document.querySelectorAll('table.dash-matrix tbody tr.row')].find(x => x.textContent.includes('신규 캐릭터')); return [...r.querySelectorAll('td.heat')].map(c => c.textContent.trim()).join(','); })()");
  check('항목 × 파트: 신규 캐릭터 원화 3/10 · 모델링 1/10', cell.startsWith('3 / 10,1 / 10'), cell);
  check('거치지 않는 파트는 빗금 칸', await cdp.eval("document.querySelectorAll('table.dash-matrix td.heat.off').length >= 5"));
  check('제작 단계 분포 막대(캐릭터 20)', await cdp.eval("document.querySelector('.stage-row')?.textContent.includes('캐릭터')"));
  check('배치 2개 · D-day', await cdp.eval("document.querySelectorAll('table.dash-batch-table tbody tr').length === 2 && document.querySelector('table.dash-batch-table').textContent.includes('D-')"));
  // 배치 카드: 완료 예정 칸(docs/33)
  const dfc = await cdp.eval("[...document.querySelectorAll('table.dash-batch-table tbody tr')].map(r => r.querySelector('.batch-when')?.textContent.trim() ?? '—').join(' | ')");
  check('배치 카드: 배치마다 완료 예정 · 판정', dfc.split(' | ').length === 2 && dfc.split(' | ').every(t => /(마감 안|빠듯|늦음|못 끝냄|마감 없음)/.test(t)), dfc);
  const okDash = await shot(cdp, 'dashboard-1440');
  const okDash390 = await shot(cdp, 'dashboard-390', 390);

  // 처리할 것 → 그 에셋 카드가 에셋 화면에서 바로 열린다
  const tabs = await cdp.eval("[...document.querySelectorAll('.todo-tabs button')].map(b => b.textContent).join(',')");
  check('처리할 것 탭: 검수 요청 1 · 수정 1 · 보류 1', tabs.includes('검수 요청1') && tabs.includes('수정1') && tabs.includes('보류1'), tabs);
  await cdp.eval("document.querySelector('.todo-item').click()");
  await cdp.waitUntil("document.querySelector('.asset-card-window')", 10000).catch(() => {});
  const title = await cdp.eval("document.querySelector('.asset-card-window input[aria-label=\"에셋 이름\"]')?.value ?? ''");
  check('처리할 것을 누르면 에셋 화면에서 그 카드가 열린다', title === '닌자맛 쿠키', title);

  // 에셋이 없는 예시
  // 업데이트 계획: 배치가 있는 업데이트 아래 배치 줄(docs/33)
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=assets&nosw&page=plan` });
  await cdp.waitUntil("document.querySelector('table.grid.list tbody tr.row')", 20000);
  await sleep(400);
  const lines = await cdp.eval("[...document.querySelectorAll('table.grid.list tr.batch-line')].map(r => r.querySelector('.batch-line-name').textContent.replace(/\\s+/g, ' ').trim() + ':' + (r.querySelector('.pill')?.textContent ?? '')).join(' | ')");
  const note = await cdp.eval("document.querySelector('.card-head p')?.textContent ?? ''");
  check('업데이트 계획: 런칭 아래 배치 줄 2개(배치 순서) · 판정 · 설명', /1차 납품:.+\| .*2차 납품:/.test(lines) && note.length > 0, lines);
  check('업데이트 계획 390px 가로 넘침 없음', await shot(cdp, 'plan-batches-390', 390));
  await shot(cdp, 'plan-batches-1440');
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal&nosw&page=dashboard` });
  await sleep(600);
  await cdp.waitUntil("document.querySelector('.dash-tiles .stat') && document.querySelector('table.dash-matrix')", 20000);
  const none = await cdp.eval("(() => ({ todo: document.querySelector('.dash-todo').textContent.includes('에셋을 등록하면'), stages: document.querySelector('.dash-stages').textContent.includes('에셋을 등록하면'), chart: !!document.querySelector('.burnup svg') }))()");
  check('에셋이 없는 예시도 진행률 · 추이 · 항목 × 파트가 나오고 에셋 칸은 안내', none.todo && none.stages && none.chart, JSON.stringify(none));
  check('가로 넘침 없음(1440 · 390)', okDash && okDash390);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
