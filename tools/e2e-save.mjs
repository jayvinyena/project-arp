// 저장 흐름 시험(크롬, 화면 없음): 브라우저 개인 저장소(OPFS)의 파일 핸들로
//   열기 → 편집 중 표시 저장 → 고치기 → 2초 뒤 자동 저장 → 다시 열면 고친 값 → 다른 곳에서 바뀌면 충돌로 저장 거부 → 다른 사람 편집 중이면 읽기 전용
//   node tools/e2e-save.mjs [--no-build]
import { withBrowser, sleep } from './lib/cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const saveText = "(document.querySelector('.save-state')?.textContent ?? '')";
const ready = "document.querySelectorAll('table.grid tbody tr.row').length > 0";

async function setQty(cdp, label, value) {
  await cdp.eval(`(() => { const i = document.querySelector('input[aria-label="${label}"]'); i.value = '${value}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await cdp.eval(`document.querySelector('input[aria-label="${label}"]').dispatchEvent(new FocusEvent('blur'))`);
}

await withBrowser(async (cdp, base) => {
  const app = `${base}/app/index.html`;
  // 이름을 정해 둔다(편집 중 표시에 쓰임)
  await cdp.send('Page.navigate', { url: app });
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await cdp.eval("localStorage.setItem('arp.editor', '검사자')");

  // 1. OPFS 파일로 열기 → 편집 중 표시를 쓰고 저장
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&page=launch&opfs=1` });
  await cdp.waitUntil(ready);
  await cdp.waitUntil(`${saveText}.includes('저장됨')`, 10000);
  check('열 때 편집 중 표시를 파일에 저장', true, await cdp.eval(saveText));

  // 2. 고치기 → 저장 대기 → 2초 뒤 자동 저장
  await setQty(cdp, '배경 맵 기본안', 5);
  let dirtyOk = true;
  try { await cdp.waitUntil(`${saveText}.includes('저장 대기')`, 3000); } catch { dirtyOk = false; }
  check('수정하면 저장 대기', dirtyOk, await cdp.eval(saveText));
  const t0 = Date.now();
  await cdp.waitUntil(`${saveText}.includes('저장됨')`, 8000);
  const waited = Date.now() - t0;
  check('약 2초 뒤 자동 저장', waited >= 1000 && waited < 5000, `${waited}ms`);

  // 3. 다시 열면(파일 그대로) 고친 값이 남아 있다
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&page=launch&opfs=1&keep=1` });
  await cdp.waitUntil(ready);
  const kept = await cdp.eval(`document.querySelector('input[aria-label="배경 맵 기본안"]').value`);
  check('다시 열면 고친 값(5)이 남아 있다', kept === '5', `값 ${kept}`);

  // 4. 다른 곳에서 파일이 바뀌면 덮어쓰지 않는다
  await cdp.waitUntil(`${saveText}.includes('저장됨')`, 8000);
  await cdp.eval(`(async () => {
    const dir = await navigator.storage.getDirectory();
    const h = await dir.getFileHandle('normal.arp');
    const bytes = await (await h.getFile()).arrayBuffer();
    await new Promise(r => setTimeout(r, 50));
    const w = await h.createWritable(); await w.write(bytes); await w.close(); // 같은 내용이라도 수정 시각이 바뀐다
  })()`);
  await setQty(cdp, '배경 맵 기본안', 6);
  await cdp.waitUntil(`${saveText}.includes('충돌')`, 8000);
  check('다른 곳에서 바뀌면 저장 거부(충돌)', await cdp.eval("Boolean(document.querySelector('.banner.bad'))"));
  check('충돌이면 "다른 이름으로 저장"으로 빠져나갈 수 있다', await cdp.eval("[...document.querySelectorAll('.banner.bad button')].some(b => b.textContent.includes('다른 이름으로 저장'))"));

  // 5. 다른 사람이 편집 중이면 읽기 전용
  await cdp.eval("localStorage.setItem('arp.editor', '다른 사람')");
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&page=launch&opfs=1&keep=1` });
  await cdp.waitUntil(ready);
  await sleep(500);
  const ro = await cdp.eval("document.querySelector('.banner.warn')?.textContent ?? ''");
  const disabled = await cdp.eval(`document.querySelector('input[aria-label="배경 맵 기본안"]').disabled`);
  check('다른 사람이 편집 중이면 읽기 전용', ro.includes('검사자') && disabled, ro.slice(0, 40));

  // 6. 같은 이름이라도 다른 PC(브라우저)에서 편집 중이면 읽기 전용, 원래 PC면 고칠 수 있다
  const device = await cdp.eval("localStorage.getItem('arp.device')");
  await cdp.eval("localStorage.setItem('arp.editor', '검사자'); localStorage.setItem('arp.device', 'other-pc')");
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&page=launch&opfs=1&keep=1` });
  await cdp.waitUntil(ready);
  await sleep(500);
  check('같은 이름 · 다른 PC면 읽기 전용', await cdp.eval(`document.querySelector('input[aria-label="배경 맵 기본안"]').disabled`));
  await cdp.eval(`localStorage.setItem('arp.device', ${JSON.stringify(device)})`);
  await cdp.send('Page.navigate', { url: `${app}?sample=normal&page=launch&opfs=1&keep=1` });
  await cdp.waitUntil(ready);
  await sleep(500);
  check('같은 이름 · 같은 PC면 고칠 수 있다', !(await cdp.eval(`document.querySelector('input[aria-label="배경 맵 기본안"]').disabled`)));
}, { build: !process.argv.includes('--no-build') });

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
