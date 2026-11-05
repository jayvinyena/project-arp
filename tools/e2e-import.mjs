// 옛 시트 가져오기 시험(크롬, 화면 없음): 예시 .xlsx → 보고서 → 런칭·업데이트 계획 화면이 계산된다
//   node tools/e2e-import.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { withBrowser, sleep, ROOT } from './lib/cdp.mjs';

const OUT = `${ROOT}samples/out/shots`;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };
async function shot(cdp, name, width = 1440) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(250);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}

await withBrowser(async (cdp, base) => {
  await cdp.send('Page.navigate', { url: `${base}/app/index.html` });
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  const btn = await cdp.eval("[...document.querySelectorAll('.welcome-card button')].map(b => b.textContent).join(' | ')");
  check('시작 화면에 가져오기 버튼', btn.includes('기존 시트(.xlsx) 가져오기'), btn);

  await cdp.send('Page.navigate', { url: `${base}/app/index.html?importSample=legacy-sample` });
  await cdp.waitUntil("document.querySelector('.dialog[aria-label=\"가져오기 보고서\"]')", 15000);
  const text = await cdp.eval("document.querySelector('.dialog').textContent");
  check('보고서: 기간·개수·바꾼 것·가져오지 않은 시트', text.includes('2026-11 ~ 2027-06') && text.includes('우선순위 등급') && text.includes('04_Pipeline_Template'), text.slice(0, 60));
  check('보고서: 바로 계산할 수 있어요', text.includes('바로 계산할 수 있어요'));
  await shot(cdp, 'import-report');
  await shot(cdp, 'import-report-390', 390);

  await cdp.eval("[...document.querySelectorAll('.dialog button')].find(b => b.textContent.includes('나중에 저장')).click()");
  await cdp.waitUntil("document.querySelectorAll('.mode-card').length === 3", 10000);
  const name = await cdp.eval("document.querySelector('.project-chip .name')?.textContent");
  check('런칭 물량 설계가 열리고 프로젝트 이름은 파일 이름', name === 'legacy-sample', name);
  const launch = await cdp.eval("document.querySelector('.page-head h1')?.textContent");
  check('런칭 = 옛 "런칭 기준안"', launch === '런칭 기준안', launch);
  const save = await cdp.eval("document.querySelector('.save-state')?.textContent ?? ''");
  check('저장 전이라 "저장 안 된 변경"', save.includes('저장 안 된 변경'), save);

  await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes('업데이트 계획')).click()");
  await cdp.waitUntil("document.querySelectorAll('button.tl-item').length > 0", 10000);
  const names = await cdp.eval("[...document.querySelectorAll('table.grid.list tbody tr')].map(r => r.querySelector('button.link')?.textContent)");
  check('업데이트 4개가 옛 배정 순서(등급 → 출시일)로', names.join(',') === '2027 시즌1,런칭 기준안,설날 이벤트,2027 시즌2', names.join(', '));

  // 운영 시트 흉내(실제 규모 · 보조 시트·칸 · 엑셀 날짜 · 출시 완료·취소 · 인력 앞 시작)
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?importSample=operating-sheet&nosw` });
  await cdp.waitUntil("document.querySelector('.dialog[aria-label=\"가져오기 보고서\"]')", 20000);
  const op = await cdp.eval("document.querySelector('.dialog').textContent");
  check('운영 시트: 기간 2026-11 ~ 2028-10 · 바로 계산', op.includes('2026-11 ~ 2028-10') && op.includes('바로 계산할 수 있어요'), op.slice(0, 60));
  check('운영 시트: 옛 도구와 달라지는 이유(인력 앞 시작 · 출시 완료·취소)를 알린다', op.includes('인력 첫 달(2026-11)보다 먼저') && op.includes('CBT 빌드'));
  check('운영 시트: 보조 시트 8개는 가져오지 않음(이유)', ['사용 안내', '33_Update_Allocation_Snapshot', '98_Input_Hub_Baseline', '90_Change_History'].every(x => op.includes(x)));
  await shot(cdp, 'import-operating');
  await cdp.eval("[...document.querySelectorAll('.dialog button')].find(b => b.textContent.includes('나중에 저장')).click()");
  await cdp.waitUntil("document.querySelectorAll('.mode-card').length === 3", 10000);
  check('운영 시트: 런칭 = "정식 런칭"(출시 완료된 CBT가 아님)', (await cdp.eval("document.querySelector('.page-head h1')?.textContent")) === '정식 런칭');
  await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes('업데이트 계획')).click()");
  await cdp.waitUntil("document.querySelectorAll('button.tl-item').length > 0", 10000);
  const bars = await cdp.eval("document.querySelectorAll('button.tl-item').length");
  check('운영 시트: 타임라인에 계산 대상 11개', bars === 11, `${bars}개`);
  await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes('마감 맞추기')).click()");
  await cdp.waitUntil("document.querySelector('.banner[role=status]') && !document.querySelector('.stack.busy')", 20000);
  const steps = await cdp.eval("document.querySelectorAll('.advice-steps li').length");
  check('운영 시트: 마감 맞추기 제안이 나온다', steps > 0, `${steps}걸음`);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
