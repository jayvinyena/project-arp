// 작업자 명단 시험(크롬, 화면 없음) — docs/24-people.md
//   인력 화면은 기본 "파트 × 달 인력" 탭, "작업자" 탭에 명단 · 더하기 · 이메일 검사 · 참여 끄기 · 지우기 / 에셋 담당 칸 이름 제안 / 넘침
//   node tools/e2e-people.mjs [--no-build]
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
const typeIn = async (cdp, label, value, blur = true) => {
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label=${JSON.stringify(label)}]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(120);
  if (blur) { await cdp.eval(`document.querySelector('input[aria-label=${JSON.stringify(label)}]').dispatchEvent(new FocusEvent('blur'))`); await sleep(400); }
};
const names = cdp => cdp.eval("[...document.querySelectorAll('table.people-table tbody tr.row')].map(r => r.querySelector('input').value).join(',')");

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=assets&nosw&page=capacity` });
  await cdp.waitUntil("document.querySelector('table.cap-grid')", 20000);
  await sleep(300);
  const tabs = await cdp.eval("[...document.querySelectorAll('[aria-label=\"인력 화면\"] button')].map(b => b.textContent + (b.classList.contains('on') ? '*' : '')).join(',')");
  check('인력 화면은 파트 × 달 인력 탭이 먼저, 작업자 탭에 인원 수', tabs === '파트 × 달 인력*,작업자 4', tabs);

  await cdp.eval("[...document.querySelectorAll('[aria-label=\"인력 화면\"] button')].find(b => b.textContent.startsWith('작업자')).click()");
  await cdp.waitUntil("document.querySelector('table.people-table')", 5000);
  check('작업자 탭: 소속팀은 공정 순(원화 → 모델링 → 애니메이션)', (await names(cdp)) === '김원화,이원화,박모델,최애니', await names(cdp));
  const summary = await cdp.eval("document.querySelector('.card-head .small.muted').textContent");
  check('요약: 참여 중 3명 · 팀별 인원', summary.includes('참여 중 3명') && summary.includes('원화 2'), summary);

  // 더하기 · 이메일 · 특이사항
  await typeIn(cdp, '새 작업자 이름', '정이펙트', false);
  await typeIn(cdp, '새 작업자 소속팀', 'FX', false);
  await cdp.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('작업자 더하기')).click()");
  await cdp.waitUntil("[...document.querySelectorAll('table.people-table input')].some(i => i.value === '정이펙트')", 5000);
  await typeIn(cdp, '정이펙트 이메일', 'jung@');
  const toast = await cdp.eval("document.querySelector('.toast')?.textContent ?? ''");
  check('이메일 형식이 틀리면 알리고 되돌린다', toast.includes('이메일 형식') && (await cdp.eval("document.querySelector('input[aria-label=\"정이펙트 이메일\"]').value")) === '', toast);
  await typeIn(cdp, '정이펙트 이메일', 'jung@example.com');
  await typeIn(cdp, '정이펙트 특이사항', '2027년 1월 합류');
  const row = await cdp.eval("(() => { const v = l => document.querySelector(`input[aria-label=\"정이펙트 ${l}\"]`).value; return [v('소속팀'), v('이메일'), v('특이사항')].join('|'); })()");
  check('더한 작업자: 소속팀 · 이메일 · 특이사항 저장', row === 'FX|jung@example.com|2027년 1월 합류', row);

  // 참여 끄기 · 지우기
  await cdp.eval("document.querySelector('input[aria-label=\"정이펙트 참여\"]').click()");
  await sleep(500);
  check('참여를 끄면 흐리게', await cdp.eval("[...document.querySelectorAll('table.people-table tr.row')].find(r => r.querySelector('input').value === '정이펙트').classList.contains('off')"));
  const okPeople = await shot(cdp, 'people-1440');
  const okPeople390 = await shot(cdp, 'people-390', 390);
  await cdp.eval("document.querySelector('button[aria-label=\"정이펙트 지우기\"]').click()");
  await sleep(500);
  check('지우기', !(await names(cdp)).includes('정이펙트'));

  // 에셋 담당 칸: 참여 중인 작업자만 제안
  await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes('에셋 제작 현황')).click()");
  await cdp.waitUntil("document.querySelector('#asset-people')", 10000);
  const opts = await cdp.eval("[...document.querySelectorAll('#asset-people option')].map(o => o.value).join(',')");
  const listed = await cdp.eval("!!document.querySelector('input[aria-label$=\" 담당\"][list=\"asset-people\"]')");
  check('에셋 담당 칸에 참여 중인 작업자 이름 제안(최애니 빠짐)', opts.includes('김원화') && opts.includes('박모델') && !opts.includes('최애니') && listed, opts);
  check('가로 넘침 없음(작업자 1440 · 390)', okPeople && okPeople390);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
