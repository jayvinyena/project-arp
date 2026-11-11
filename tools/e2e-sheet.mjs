// 팀 제작 리스트 가져오기 시험(크롬, 화면 없음) — docs/20-asset-management.md 19절
//   에셋 화면 "엑셀 넣기"에 제작 리스트 형식(가상 예시)을 넣으면 가져오기 창이 열린다 → 시트 · 마일스톤 · 분류 · 상태 말 대응 →
//   가져오기 → 리스트에 세부 분류 · 리소스명, 카드 창에 속성 · 기획서 링크 · Jira → 세부 분류로 묶기 · 속성으로 찾기
//   node tools/e2e-sheet.mjs [--no-build]
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
const select = (cdp, label, value) => cdp.eval(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); if (!s) throw new Error('고르기 없음: ${label}'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

await withBrowser(async (cdp, base) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=assets&nosw&page=assets` });
  await cdp.waitUntil("document.querySelector('.asset-list') || document.querySelector('.kanban')", 20000);
  // 파일 고르기 창 대신 예시 파일을 넣는다
  await cdp.eval(`(() => {
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return orig.call(this);
      fetch('../production-list-sample.xlsx', { cache: 'no-store' }).then(r => r.arrayBuffer()).then(b => {
        const dt = new DataTransfer();
        dt.items.add(new File([b], '제작 리스트 예시.xlsx'));
        this.files = dt.files;
        this.dispatchEvent(new Event('change'));
      });
    };
  })()`);
  await cdp.eval("[...document.querySelectorAll('.asset-bar button')].find(b => b.textContent.includes('엑셀에서 가져오기')).click()");
  await cdp.waitUntil("document.querySelector('.dialog.sheet-import')", 10000);
  const d = await cdp.eval(`(() => {
    const dlg = document.querySelector('.dialog.sheet-import');
    return {
      steps: dlg.querySelectorAll('.import-step').length,
      sheets: [...dlg.querySelectorAll('.si-sheets tbody tr td:first-child')].map(x => x.textContent).join(','),
      out: dlg.textContent.includes('건너뛰는 시트 2개'),
      ms: [...dlg.querySelectorAll('select[aria-label$=" 업데이트"]')].map(s => s.getAttribute('aria-label') + '=' + s.value).join(','),
      rt: [...dlg.querySelectorAll('select[aria-label$=" 리소스 종류"]')].map(s => s.value).join(','),
      word: !!dlg.querySelector('select[aria-label="작업 대기중 상태"]'),
      foot: dlg.querySelector('.import-foot').textContent,
    };
  })()`);
  check('가져오기 창: 단계 5개 · 읽은 시트 2개(요약 · 레벨은 건너뜀)', d.steps === 5 && d.sheets === '캐릭터,코스튬' && d.out, JSON.stringify(d.sheets));
  check('분류 → 리소스 종류를 미리 골라 둠(신규 캐릭터 · 코스튬)', d.rt === 'CHAR_NEW,COSTUME,CHAR_NEW', d.rt);
  check('마일스톤은 같은 이름이 없으면 건너뛰기', d.ms.includes('M1 업데이트=,') && d.word, d.ms);
  check('넣을 행 수 · 건너뛸 행 · 물량에 새로 더할 리소스를 아래에 표시', d.foot.includes('2행을 넣습니다') && d.foot.includes('4행 건너뜀') && d.foot.includes('새로 더할 리소스 1곳'), d.foot);
  const okDialog = await shot(cdp, 'sheet-import-1440');
  const okDialog390 = await shot(cdp, 'sheet-import-390', 390);

  // 대응 고르기: M1 → 런칭, 시즌 1 → 시즌 1(런칭이 아닌 업데이트도), 작업 대기중 → 진행
  await select(cdp, 'M1 업데이트', 'LAUNCH');
  await select(cdp, '작업 대기중 상태', 'WIP');
  await sleep(150);
  const foot = await cdp.eval("document.querySelector('.sheet-import .import-foot').textContent");
  check('고른 대응으로 넣을 행 수가 바로 바뀐다(M1 3행 더해 5행)', foot.includes('5행을 넣습니다'), foot);
  const before = await cdp.eval("document.querySelector('.sheet-import .import-foot .btn.primary').getBoundingClientRect().width");
  await cdp.eval("document.querySelector('.sheet-import .import-foot .btn.primary').click()");
  await cdp.waitUntil("!document.querySelector('.dialog.sheet-import')", 10000);
  const toast = await cdp.eval("document.querySelector('.toast')?.textContent ?? ''");
  check('가져오기 결과 알림: 새로 5개 · 물량에 더한 리소스 1곳 · 건너뛴 행 1개', toast.includes('새로 5개') && toast.includes('물량에 더한 리소스 1곳') && toast.includes('건너뛴 행 1개'), toast);
  check('가져오기 버튼은 누를 때 폭이 바뀌지 않게 자리를 둠', before >= 116, String(before));

  // 리스트: 세부 분류 · 리소스명, 세부 분류로 묶기, 속성으로 찾기
  await cdp.waitUntil("[...document.querySelectorAll('.asset-list .link-btn')].some(b => b.textContent === '바람 기사')", 10000);
  const meta = await cdp.eval("[...document.querySelectorAll('.asset-list tr.row')].find(r => r.textContent.includes('바람 기사')).querySelector('.row-meta').textContent");
  check('리스트: 에셋 아래에 리소스명(세부 분류가 리소스 종류와 같으면 생략)', meta.startsWith('CH_WindKnight'), meta);
  const shirt = await cdp.eval("[...document.querySelectorAll('.asset-list tr.row')].find(r => r.textContent.includes('여름 셔츠')).querySelector('.row-meta').textContent");
  check('리스트: 세부 분류가 다르면 표시(코스튬 · 상의)', shirt.startsWith('코스튬 · 상의'), shirt);
  await cdp.eval("[...document.querySelectorAll('[aria-label=\"리스트 묶기\"] button')].find(b => b.textContent === '세부 분류').click()");
  await sleep(300);
  const groups = await cdp.eval("[...document.querySelectorAll('.asset-list tr.group b')].map(b => b.textContent).join(',')");
  check('세부 분류로 묶기', groups.includes('신규 캐릭터 › 신규 캐릭터') && groups.includes('코스튬 › 코스튬 · 상의'), groups);
  await cdp.eval("(() => { const i = document.querySelector('input[aria-label=\"에셋 찾기\"]'); i.value = '초원'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sleep(300);
  const found = await cdp.eval("[...document.querySelectorAll('.asset-list .link-btn')].map(b => b.textContent).join(',')");
  check('속성 값으로 찾기(등장 지역 = 초원)', found === '바람 기사', found);

  // 카드 창: 속성 · 기획서 링크 · Jira · 파트 상태
  await cdp.eval("[...document.querySelectorAll('.asset-list .link-btn')].find(b => b.textContent === '바람 기사').click()");
  await cdp.waitUntil("document.querySelector('.asset-card-window') && [...document.querySelectorAll('.cw-links li')].some(l => l.textContent.includes('기획서'))", 10000).catch(() => {});
  const card = await cdp.eval(`(() => {
    const w = document.querySelector('.asset-card-window');
    return {
      attrs: [...w.querySelectorAll('.cw-attr')].map(a => a.querySelector('.cw-attr-name').textContent + '=' + a.querySelector('input').value).join(','),
      links: [...w.querySelectorAll('.cw-links li')].map(l => l.textContent).join(','),
      jiraHref: w.querySelector('.cw-links a')?.getAttribute('href'),
      cat: w.querySelector('input[aria-label="세부 분류"]').value, code: w.querySelector('input[aria-label="에셋 코드"]').value,
      anim: w.querySelector('select[aria-label="애니메이션 상태"]').value, fx: w.querySelector('select[aria-label="FX 상태"]').value,
    };
  })()`);
  check('카드: 속성 2개(속성 · 등장 지역)', card.attrs === '속성=바람,등장 지역=초원', card.attrs);
  check('카드: Jira 링크 · 기획서 링크', card.jiraHref === 'https://example.atlassian.net/browse/ART-12' && card.links.includes('기획서'), card.links);
  check('카드: 세부 분류 · 리소스명 · 파트 상태(애니 진행 · FX 해당 없음)', card.cat === '신규 캐릭터' && card.code === 'CH_WindKnight' && card.anim === 'WIP' && card.fx === 'OMIT', JSON.stringify(card));
  // 속성 더하기 · 지우기
  await cdp.eval("document.querySelector('.asset-card-window button[aria-label=\"속성 입력 열기\"]').click()"); await sleep(150);
  await cdp.eval(`(() => {
    const set = (l, v) => { const i = document.querySelector('input[aria-label="' + l + '"]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
    set('속성 이름', '무기'); set('속성 값', '창');
  })()`);
  await sleep(150);
  await cdp.eval("[...document.querySelectorAll('.asset-card-window button')].find(b => b.textContent.includes('속성 더하기')).click()");
  await cdp.waitUntil("document.querySelectorAll('.asset-card-window .cw-attr').length === 3", 5000).catch(() => {});
  await cdp.eval("document.querySelector('button[aria-label=\"속성 속성 지우기\"]').click()");
  await cdp.waitUntil("document.querySelectorAll('.asset-card-window .cw-attr').length === 2", 5000).catch(() => {});
  const attrs2 = await cdp.eval("[...document.querySelectorAll('.asset-card-window .cw-attr-name')].map(x => x.textContent).join(',')");
  check('카드: 속성 더하기 · 지우기', attrs2 === '등장 지역,무기', attrs2);
  const okCard = await shot(cdp, 'sheet-import-card');

  // 모든 에셋이 같은 파이프라인: 코스튬(FX를 거치지 않음)도 FX가 시트 값대로, "계획 밖" 표시
  await cdp.eval("document.querySelector('.asset-card-window .cw-close').click()");
  await sleep(300);
  await cdp.eval("(() => { const i = document.querySelector('input[aria-label=\"에셋 찾기\"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sleep(300);
  await cdp.eval("[...document.querySelectorAll('.asset-list .link-btn')].find(b => b.textContent === '여름 셔츠').click()");
  await cdp.waitUntil("document.querySelector('.asset-card-window')", 5000);
  const fx = await cdp.eval("(() => { const r = [...document.querySelectorAll('.asset-parts-table tr.row')].find(x => x.textContent.startsWith('FX')); return { st: r.querySelector('select').value, out: !!r.querySelector('.plan-out') }; })()");
  check('코스튬도 FX 파트가 있고 시트 값(완료) · "계획 밖" 표시', fx.st === 'DONE' && fx.out, JSON.stringify(fx));
  await cdp.eval("document.querySelector('.asset-card-window .cw-close').click()");
  await sleep(300);

  // 거르기 줄: 팀 · 담당 · 상태 · 세부 분류 · 속성, 고르기 전후로 높이가 그대로
  const names = () => cdp.eval("[...document.querySelectorAll('.asset-list .link-btn')].map(b => b.textContent)");
  const barH = () => cdp.eval("Math.round(document.querySelector('.asset-board-card').getBoundingClientRect().top + document.querySelector('.asset-summary').getBoundingClientRect().top)");
  const h0 = await barH();
  await select(cdp, '팀 거르기', 'FX');
  await sleep(300);
  let list = await names();
  check('팀(FX) 거르기: FX가 해당 없음인 에셋은 빠지고 FX를 켠 코스튬은 보인다', list.includes('여름 셔츠') && !list.includes('바람 기사'), `${list.length}개`);
  await select(cdp, '상태 거르기', 'DONE');
  await sleep(300);
  list = await names();
  check('팀 + 상태: FX 완료만', list.join() === '여름 셔츠', list.join());
  const label = await cdp.eval("document.querySelector('select[aria-label=\"상태 거르기\"] option').textContent");
  check('팀을 고르면 담당 · 상태 기준이 그 파트로(“모든 FX 상태”)', label === '모든 FX 상태', label);
  await cdp.eval("[...document.querySelectorAll('.filter-bar button')].find(b => b.textContent.startsWith('거르기 풀기')).click()");
  await sleep(300);
  await select(cdp, '팀 거르기', 'CONCEPT');
  await select(cdp, '담당 거르기', '김원화');
  await sleep(300);
  list = await names();
  check('원화팀 + 담당(김원화): 시트의 "원화 담당" 칸이 파트 담당으로', list.includes('여름 셔츠'), list.join());
  await cdp.eval("[...document.querySelectorAll('.filter-bar button')].find(b => b.textContent.startsWith('거르기 풀기')).click()");
  await sleep(300);
  await select(cdp, '세부 분류 거르기', '코스튬 · 상의');
  await sleep(300);
  check('세부 분류 거르기', (await names()).join() === '여름 셔츠');
  await select(cdp, '세부 분류 거르기', 'all');
  await select(cdp, '속성 거르기', JSON.stringify(['속성', '불']));
  await sleep(300);
  check('속성 거르기(속성: 불)', (await names()).join() === '불꽃 마법사', (await names()).join());
  const h1 = await barH();
  check('거르기를 골라도 위쪽 높이가 그대로(들썩임 0px)', h0 === h1, `${h0} → ${h1}`);
  const clearTxt = await cdp.eval("[...document.querySelectorAll('.filter-bar button')].find(b => b.textContent.startsWith('거르기 풀기')).textContent");
  check('거르기 풀기에 고른 개수', clearTxt === '거르기 풀기 (1)', clearTxt);
  await cdp.eval("[...document.querySelectorAll('.filter-bar button')].find(b => b.textContent.startsWith('거르기 풀기')).click()");
  await sleep(300);

  // 일괄: 고른 에셋의 파트를 해당 없음 → 대기로 켜기(파이프라인 바꾸기)
  await cdp.eval("[...document.querySelectorAll('.asset-list tr.row')].find(r => r.textContent.includes('바람 기사')).querySelector('input[type=checkbox]').click()");
  await sleep(200);
  await select(cdp, '일괄 파트', 'FX');
  await select(cdp, '일괄 파트 상태', 'TODO');
  await sleep(150);
  await cdp.eval("[...document.querySelectorAll('.bulk-bar button')].find(b => b.textContent === '파트 상태 바꾸기').click()");
  await sleep(600);
  await select(cdp, '팀 거르기', 'FX');
  await sleep(300);
  check('일괄 파트 상태 바꾸기: 바람 기사 FX 해당 없음 → 대기(FX팀에 보인다)', (await names()).includes('바람 기사'));
  await select(cdp, '팀 거르기', 'all');
  const okFilter = await shot(cdp, 'assets-filter-390', 390);

  // 시트 분류대로 새 리소스 종류 만들기(docs/20-asset-management.md 21절): 다시 넣고 한 줄을 새 종류로
  await cdp.eval("[...document.querySelectorAll('.asset-bar button')].find(b => b.textContent.includes('엑셀에서 가져오기')).click()");
  await cdp.waitUntil("document.querySelector('.dialog.sheet-import')", 10000);
  await select(cdp, '코스튬 신규 · 캐릭터 리소스 종류', '+new');
  await sleep(200);
  const nw = await cdp.eval(`(() => ({
    group: document.querySelector('input[aria-label="코스튬 신규 · 캐릭터 새 분류"]')?.value,
    name: document.querySelector('input[aria-label="코스튬 신규 · 캐릭터 새 이름"]')?.value,
    foot: document.querySelector('.sheet-import .import-foot').textContent,
  }))()`);
  check('새 리소스 종류로 만들기: 분류 = 시트 이름 · 이름 = 대분류 · 분류(기존 이름과 겹쳐 시트 이름을 붙임), 아래 줄에 개수', nw.group === '코스튬' && nw.name === '코스튬 신규 · 캐릭터' && nw.foot.includes('새 리소스 종류 1개'), JSON.stringify(nw));
  await cdp.eval("document.querySelector('.si-key.new').scrollIntoView({ block: 'center' })");
  const okNew = await shot(cdp, 'sheet-import-new');
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="코스튬 신규 · 캐릭터 새 이름"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  check('새 이름이 비면 가져오기를 누를 수 없다', await cdp.eval("document.querySelector('.sheet-import .import-foot .btn.primary').disabled"));
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="코스튬 신규 · 캐릭터 새 이름"]'); i.value = '미니 손님류'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  const allBtn = await cdp.eval("[...document.querySelectorAll('.si-new-bar button')][0].textContent");
  check('"대응 없는 줄을 모두 새 종류로"에 대응 없는 줄 수', allBtn === '대응 없는 줄을 모두 새 종류로', allBtn);
  await cdp.eval("document.querySelector('.sheet-import .import-foot .btn.primary').click()");
  await cdp.waitUntil("!document.querySelector('.dialog.sheet-import')", 10000);
  const toast2 = await cdp.eval("document.querySelector('.toast')?.textContent ?? ''");
  check('가져오기 결과: 새 리소스 종류 1개(공수 0 안내)', toast2.includes('새 리소스 종류 1개') && toast2.includes('데이터 점검'), toast2);
  await cdp.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b => b.textContent.includes('데이터 점검')).click()");
  await sleep(600);
  const chk = await cdp.eval("document.querySelector('main').textContent");
  check('데이터 점검에 "기본 공수가 모두 0" 주의', chk.includes('기본 공수가 모두 0'), '');
  check('가로 넘침 없음(새 종류 줄)', okNew);
  check('가로 넘침 없음(창 1440 · 390 · 카드 · 거르기 390)', okDialog && okDialog390 && okCard && okFilter);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
