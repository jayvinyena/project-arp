// 7단계 시험(크롬, 화면 없음): 마감 맞추기 — 이미 맞음 · 못 맞춤(과부하) · 수단 끄기 · 맞춤(현실 규모) → 시나리오로 만들기 → 시뮬레이션 비교
//   node tools/e2e-advisor.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };
async function shot(cdp, name, width = 1440) {
  const h = await cdp.eval('Math.ceil(document.documentElement.scrollHeight)');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(width < 600 ? 844 : 900, h), scale: 1 } });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
}
const verdict = cdp => cdp.eval("document.querySelector('.banner[role=status]')?.textContent ?? ''");
const waitResult = cdp => cdp.waitUntil("document.querySelector('.banner[role=status]') && !document.querySelector('.stack.busy')", 20000);
const toggle = async (cdp, label) => {
  await cdp.eval(`document.querySelector('input[aria-label="${label}"]').click()`);
  await sleep(150);
  await waitResult(cdp);
};

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const app = `${base}/app/index.html`;

  // 1. 정상 샘플: 이미 다 맞음
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&page=advisor&nosw` });
  await waitResult(cdp);
  check('정상 샘플: "이미 지켜요"', (await verdict(cdp)).includes('이미'), (await verdict(cdp)).slice(0, 40));
  check('메뉴에 "마감 맞추기"', await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].some(b => b.textContent.includes('마감 맞추기') && b.classList.contains('active'))"));

  // 2. 과부하 샘플: 할 수 있는 만큼 당기고 못 맞춘 것과 이유
  await cdp.send('Page.navigate', { url: `${app}?sample=overload&page=advisor&nosw` });
  await waitResult(cdp);
  const v2 = await verdict(cdp);
  check('과부하: "다 맞추지는 못했어요"', v2.includes('다 맞추지는 못했어요'), v2.slice(0, 50));
  const steps = await cdp.eval("document.querySelectorAll('.advice-steps li').length");
  check('바꾸는 순서가 나온다', steps > 0, `${steps}걸음`);
  check('못 맞춘 업데이트와 이유', await cdp.eval("[...document.querySelectorAll('.report-list li')].length > 0 && [...document.querySelectorAll('.report-list li')].every(li => li.textContent.includes('—'))"));
  await shot(cdp, 'advisor-overload-1440');

  // 3. 수단 끄기: 모두 끄면 "켜 둔 수단이 없어요"
  for (const l of ['인원 늘리기', '물량 줄이기', '우선순위 바꾸기']) await toggle(cdp, l);
  check('수단을 모두 끄면 안내', (await verdict(cdp)).includes('켜 둔 수단이 없어요'));
  await toggle(cdp, '외주 맡기기');
  check('외주를 켜면 외주 상한 칸이 나오고 외주 걸음만', await cdp.eval("!!document.querySelector('input[aria-label=\"외주 상한\"]') && [...document.querySelectorAll('.advice-steps .tag')].every(t => t.textContent === '외주')"));

  // 4. 현실 규모 샘플: 맞출 수 있음 → 시나리오로 만들기 → 시뮬레이션에서 원본과 비교
  await cdp.send('Page.navigate', { url: `${app}?sample=scale&page=advisor&nosw` });
  await waitResult(cdp);
  const v4 = await verdict(cdp);
  check('현실 규모: "모두 마감을 지켜요"', v4.includes('모두 마감을 지켜요'), v4.slice(0, 50));
  const totals = await cdp.eval("[...document.querySelectorAll('.advisor-totals b')].map(b => b.textContent)");
  check('비용 요약 4칸', totals.length === 4, totals.join(' / '));
  const lateAfter = await cdp.eval("[...document.querySelectorAll('table.advisor-table tbody tr')].filter(r => r.querySelectorAll('td')[3].textContent.includes('늦음')).length");
  check('제안대로 하면 늦는 업데이트 0개', lateAfter === 0);
  await shot(cdp, 'advisor-1440');
  await cdp.eval("[...document.querySelectorAll('.advisor-verdict button')].find(b => b.textContent.includes('시나리오로 만들기')).click()");
  await cdp.waitUntil("document.querySelectorAll('table.compare thead th').length >= 3", 20000);
  const heads = await cdp.eval("[...document.querySelectorAll('table.compare thead th')].map(t => t.textContent)");
  check('시뮬레이션으로 넘어가 원본과 비교', heads.some(h => h.includes('원본')) && heads.some(h => h.includes('마감 맞춤')), heads.join(' | ').slice(0, 80));
  check('만든 시나리오가 골라져 있다', await cdp.eval("[...document.querySelectorAll('.scenario-item')].some(i => i.className.includes('active') && i.textContent.includes('마감 맞춤'))"));
  const lateInScenario = await cdp.eval(`(() => {
    const idx = [...document.querySelectorAll('table.compare thead th')].findIndex(t => t.textContent.includes('마감 맞춤'));
    return [...document.querySelectorAll('table.compare tbody tr')].filter(r => /늦음|못 끝냄/.test(r.querySelectorAll('td')[idx]?.textContent ?? '')).length;
  })()`);
  check('시나리오 열에 늦음·못 끝냄 없음(제안 = 시나리오 결과)', lateInScenario === 0, `${lateInScenario}`);

  // 5. 휴대폰 폭
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: `${app}?sample=overload&page=advisor&nosw` });
  await waitResult(cdp);
  check('휴대폰 폭: 가로로 넘치지 않는다', await cdp.eval('document.documentElement.scrollWidth <= 390'), `${await cdp.eval('document.documentElement.scrollWidth')}px`);
  await shot(cdp, 'advisor-390', 390);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
