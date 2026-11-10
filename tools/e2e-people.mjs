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
const pick = (cdp, label, value) => cdp.eval(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
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
  const summary = await cdp.eval("document.querySelector('.people-head .small.muted').textContent");
  const chips = await cdp.eval("[...document.querySelectorAll('.people-chip')].map(c => c.textContent).join(',')");
  check('요약: 참여 중 3명 · 팀 거르기 칩(전체 · 팀별 인원 · 빠진 사람)', summary.includes('참여 중 3명') && chips === '전체4,원화2,모델링1,애니메이션1,빠진 사람1', chips);
  const groups = await cdp.eval("[...document.querySelectorAll('table.people-table tr.group b')].map(b => b.textContent).join(',')");
  check('팀별로 묶어 보기(공정 순)', groups === '원화,모델링,애니메이션', groups);
  // 팀 거르기 · 찾기
  await cdp.eval("[...document.querySelectorAll('.people-chip')].find(c => c.textContent.startsWith('원화')).click()");
  await sleep(200);
  const onlyWon = await names(cdp);
  await cdp.eval("[...document.querySelectorAll('.people-chip')].find(c => c.textContent.startsWith('빠진 사람')).click()");
  await sleep(200);
  const offOnly = await names(cdp);
  await cdp.eval("[...document.querySelectorAll('.people-chip')].find(c => c.textContent.startsWith('전체')).click()");
  await cdp.eval("(() => { const i = document.querySelector('input[aria-label=\"작업자 찾기\"]'); i.value = '휴가'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sleep(200);
  const found = await names(cdp);
  await cdp.eval("(() => { const i = document.querySelector('input[aria-label=\"작업자 찾기\"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sleep(200);
  check('팀 칩(원화 · 빠진 사람) · 찾기(특이사항 "휴가")', onlyWon === '김원화,이원화' && offOnly === '최애니' && found === '이원화', `${onlyWon} / ${offOnly} / ${found}`);

  // 더하기 · 이메일 · 특이사항
  // 한 번에 더하기: 이름 · 소속팀 · 이메일 · 특이사항, Enter
  await typeIn(cdp, '새 작업자 이름', '한모델', false);
  await pick(cdp, '새 작업자 소속팀', '모델링');
  await typeIn(cdp, '새 작업자 이메일', 'han@example.com', false);
  await typeIn(cdp, '새 작업자 특이사항', '외주', false);
  await cdp.eval("document.querySelector('input[aria-label=\"새 작업자 특이사항\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await cdp.waitUntil("[...document.querySelectorAll('table.people-table input')].some(i => i.value === '한모델')", 5000).catch(() => {});
  const han = await cdp.eval("(() => { const v = l => document.querySelector(`[aria-label=\"한모델 ${l}\"]`)?.value; return [v('소속팀'), v('이메일'), v('특이사항')].join('|'); })()");
  const keep = await cdp.eval("[document.querySelector('input[aria-label=\"새 작업자 이름\"]').value, document.querySelector('select[aria-label=\"새 작업자 소속팀\"]').value].join('|')");
  check('한 번에 더하기(Enter): 소속팀 · 이메일 · 특이사항까지, 소속팀은 남겨 다음 사람 입력이 빠르다', han === '모델링|han@example.com|외주' && keep === '|모델링', `${han} · ${keep}`);
  await cdp.eval("document.querySelector('button[aria-label=\"한모델 지우기\"]').click()");
  await sleep(400);

  await typeIn(cdp, '새 작업자 이름', '정이펙트', false);
  // 소속팀은 목록에서만: 고르기 칸(입력 칸 아님) · 파트 + 지원 팀, "팀" 단추로 지원 팀 더하기
  const isSelect = await cdp.eval("document.querySelector('[aria-label=\"새 작업자 소속팀\"]').tagName");
  const groupsOpt = await cdp.eval("[...document.querySelectorAll('select[aria-label=\"새 작업자 소속팀\"] optgroup')].map(g => g.label + ':' + [...g.children].map(o => o.value).join('/')).join(' ')");
  check('소속팀은 고르기 칸(파트 목록) — 임의로 적을 수 없다', isSelect === 'SELECT' && groupsOpt === '파트:원화/모델링/애니메이션/FX', `${isSelect} ${groupsOpt}`);
  await cdp.eval("[...document.querySelectorAll('.people-team-pick button')][0].click()");
  await cdp.waitUntil("document.querySelector('.people-teams')", 3000);
  await typeIn(cdp, '새 지원 팀 이름', '원화', false);
  await cdp.eval("[...document.querySelectorAll('.people-teams button')].find(b => b.textContent === '팀 추가').click()");
  await sleep(400);
  const dupToast = await cdp.eval("document.querySelector('.toast')?.textContent ?? ''");
  await typeIn(cdp, '새 지원 팀 이름', 'PM', false);
  await cdp.eval("document.querySelector('input[aria-label=\"새 지원 팀 이름\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await cdp.waitUntil("[...document.querySelectorAll('select[aria-label=\"새 작업자 소속팀\"] optgroup')].some(g => g.label === '지원 팀')", 5000).catch(() => {});
  const afterAdd = await cdp.eval("({ chosen: document.querySelector('select[aria-label=\"새 작업자 소속팀\"]').value, tags: [...document.querySelectorAll('.people-teams .team-tag:not(.part)')].map(t => t.textContent).join(',') })");
  check('팀 추가: 파트 이름은 거절, "PM"은 지원 팀으로 더해지고 바로 골라진다', dupToast.includes('이미 파트') && afterAdd.chosen === 'PM' && afterAdd.tags.startsWith('PM'), `${dupToast.slice(0, 20)} · ${JSON.stringify(afterAdd)}`);
  await typeIn(cdp, '새 작업자 이름', '김피엠', false);
  await cdp.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('작업자 더하기')).click()");
  await cdp.waitUntil("[...document.querySelectorAll('table.people-table input')].some(i => i.value === '김피엠')", 5000).catch(() => {});
  const pmGroup = await cdp.eval("[...document.querySelectorAll('table.people-table tr.group b')].map(b => b.textContent).join(',')");
  const delDisabled = await cdp.eval("document.querySelector('button[aria-label=\"PM 팀 지우기\"]').disabled");
  check('지원 팀 작업자는 파트 다음에 묶이고, 작업자가 있는 팀은 지울 수 없다', pmGroup === '원화,모델링,애니메이션,PM' && delDisabled, pmGroup);
  await cdp.eval("document.querySelector('button[aria-label=\"김피엠 지우기\"]').click()");
  await sleep(400);
  await pick(cdp, '새 작업자 소속팀', 'FX');
  await typeIn(cdp, '새 작업자 이름', '정이펙트', false);
  await cdp.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('작업자 더하기')).click()");
  await cdp.waitUntil("[...document.querySelectorAll('table.people-table input')].some(i => i.value === '정이펙트')", 5000);
  await typeIn(cdp, '정이펙트 이메일', 'jung@');
  const toast = await cdp.eval("document.querySelector('.toast')?.textContent ?? ''");
  check('이메일 형식이 틀리면 알리고 되돌린다', toast.includes('이메일 형식') && (await cdp.eval("document.querySelector('input[aria-label=\"정이펙트 이메일\"]').value")) === '', toast);
  await typeIn(cdp, '정이펙트 이메일', 'jung@example.com');
  await typeIn(cdp, '정이펙트 특이사항', '2027년 1월 합류');
  const row = await cdp.eval("(() => { const v = l => document.querySelector(`[aria-label=\"정이펙트 ${l}\"]`).value; return [v('소속팀'), v('이메일'), v('특이사항')].join('|'); })()");
  check('더한 작업자: 소속팀 · 이메일 · 특이사항 저장', row === 'FX|jung@example.com|2027년 1월 합류', row);

  // 참여 끄기 · 지우기
  await cdp.eval("document.querySelector('input[aria-label=\"정이펙트 참여\"]').click()");
  await sleep(500);
  check('참여 스위치를 끄면 흐리게 · "빠짐"', await cdp.eval("(() => { const r = [...document.querySelectorAll('table.people-table tr.row')].find(r => r.querySelector('input').value === '정이펙트'); return r.classList.contains('off') && r.querySelector('.switch-text').textContent === '빠짐'; })()"));
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
