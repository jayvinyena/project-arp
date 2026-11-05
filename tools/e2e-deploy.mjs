// 배포 시험(크롬, 화면 없음): Cloudflare Pages처럼 동작하는 서버(tools/lib/pages-server.mjs)에서
//   맨 위 주소 → 앱, 예시 열기, 서비스 워커로 오프라인 열기, 응답 헤더, 설치 정보(manifest)
//   node tools/e2e-deploy.mjs [--no-build]
import { withBrowser, sleep } from './lib/cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`); };

await withBrowser(async (cdp, base) => {
  // 1. 맨 위 주소
  await cdp.send('Page.navigate', { url: `${base}/` });
  let rootOk = false;
  try { await cdp.waitUntil("document.querySelector('.welcome-card')", 10000); rootOk = true; } catch { /* 실패 */ }
  check('맨 위 주소(/)로 열면 앱이 뜬다', rootOk, await cdp.eval('location.pathname'));

  // 2. 예시 파일 열기(주소 정리 뒤에도 쿼리 유지)
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal&nosw` });
  let sampleOk = false;
  try { await cdp.waitUntil("document.querySelector('table.grid.vol')", 15000); sampleOk = true; } catch { /* 실패 */ }
  check('/app/index.html?sample=… → 주소가 /app/로 바뀌어도 예시가 열린다', sampleOk, await cdp.eval('location.pathname + location.search'));

  // 3. 응답 헤더
  const head = async path => cdp.eval(`fetch(${JSON.stringify(path)}, { cache: 'no-store' }).then(r => ({ status: r.status, redirected: r.redirected, cc: r.headers.get('cache-control') }))`);
  const sw = await head('/app/sw.js');
  check('서비스 워커는 매번 새로 확인(no-cache)', sw.status === 200 && /no-cache/.test(sw.cc ?? ''), JSON.stringify(sw));
  const asset = await cdp.eval("fetch([...document.scripts].find(s => s.src.includes('/assets/')).src).then(r => r.headers.get('cache-control'))");
  check('assets는 오래 담아 둠(immutable)', /immutable/.test(asset ?? ''), asset);

  // 4. 설치 정보: 시작 주소가 옮겨지지 않고 바로 열린다
  const start = await cdp.eval(`fetch('/app/manifest.webmanifest').then(r => r.json()).then(m => fetch(new URL(m.start_url, location.origin + '/app/manifest.webmanifest'))).then(r => ({ status: r.status, redirected: r.redirected }))`);
  check('manifest 시작 주소가 바로 열린다(옮기기 없음)', start.status === 200 && !start.redirected, JSON.stringify(start));

  // 5. 오프라인
  await cdp.send('Page.navigate', { url: `${base}/app/` });
  await cdp.waitUntil("document.querySelector('.welcome-card')");
  await cdp.eval('navigator.serviceWorker.ready.then(() => true)');
  await cdp.waitUntil('navigator.serviceWorker.controller || (location.reload(), false)', 15000).catch(() => {});
  await cdp.waitUntil("document.querySelector('.welcome-card') && navigator.serviceWorker.controller", 15000);
  const cached = await cdp.eval("caches.keys().then(ks => Promise.all(ks.map(k => caches.open(k).then(c => c.keys())))).then(a => a.flat().length)");
  check('서비스 워커가 앱 파일을 담았다', cached > 5, `${cached}개`);
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  for (const path of ['/app/', '/app/?sample=x', '/app/index.html']) {
    await cdp.send('Page.navigate', { url: `${base}${path}` });
    let ok = false;
    try { await cdp.waitUntil("document.querySelector('.welcome-card')", 10000); ok = true; } catch { /* 실패 */ }
    check(`인터넷이 끊겨도 ${path} 가 뜬다`, ok);
  }
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(100);

  // 6. 서비스 워커가 켜진 채 옮겨지는 주소로 열기(온라인)
  await cdp.send('Page.navigate', { url: `${base}/app/index.html?sample=normal` });
  let swOnline = false;
  try { await cdp.waitUntil("document.querySelector('table.grid.vol') && navigator.serviceWorker.controller", 15000); swOnline = true; } catch { /* 실패 */ }
  check('서비스 워커가 켜진 채 /app/index.html?sample=… 로 열어도 예시가 열린다', swOnline, await cdp.eval('location.pathname + location.search'));
}, { build: !process.argv.includes('--no-build'), server: 'pages', port: 4318 });

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
