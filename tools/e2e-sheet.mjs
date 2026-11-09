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
  await cdp.eval("[...document.querySelectorAll('.asset-bar button')].find(b => b.textContent.includes('엑셀 넣기')).click()");
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
      cat: w.querySelector('input[aria-label="세부 분류"]').value, code: w.querySelector('input[aria-label="리소스명"]').value,
      anim: w.querySelector('select[aria-label="애니메이션 상태"]').value, fx: w.querySelector('select[aria-label="FX 상태"]').value,
    };
  })()`);
  check('카드: 속성 2개(속성 · 등장 지역)', card.attrs === '속성=바람,등장 지역=초원', card.attrs);
  check('카드: Jira 링크 · 기획서 링크', card.jiraHref === 'https://example.atlassian.net/browse/ART-12' && card.links.includes('기획서'), card.links);
  check('카드: 세부 분류 · 리소스명 · 파트 상태(애니 진행 · FX 해당 없음)', card.cat === '신규 캐릭터' && card.code === 'CH_WindKnight' && card.anim === 'WIP' && card.fx === 'OMIT', JSON.stringify(card));
  // 속성 더하기 · 지우기
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
  check('가로 넘침 없음(창 1440 · 390 · 카드)', okDialog && okDialog390 && okCard);
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
