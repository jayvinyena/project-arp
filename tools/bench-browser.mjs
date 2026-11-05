// 브라우저 측정 자동 실행: 빌드 → 미리보기 서버 → 크롬(화면 없음)으로 측정 페이지를 열어 결과를 읽는다.
//   node tools/bench-browser.mjs [--runs 3] [--chrome "C:/.../chrome.exe"]
// 크롬 개발자 프로토콜(CDP)을 Node 내장 WebSocket으로 직접 쓴다(추가 패키지 없음).
// 매 회차: 캐시 끈 처음 열기(콜드) 1번 + 같은 탭 다시 열기(웜) 1번, CPU 보통·4배 느리게 두 조건.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const RUNS = Number(arg('--runs', 3));
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = 4317;
const DEBUG_PORT = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → ${code}`))));
  });
}

async function waitFor(url, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* 아직 */ }
    await sleep(200);
  }
  throw new Error(`응답 없음: ${url}`);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    };
  }
  open() { return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { this.ws.close(); }
}

async function measure(cdp, url, { cold, cpuRate }) {
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: cold });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  await cdp.send('Page.navigate', { url });
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    await sleep(300);
    const r = await cdp.send('Runtime.evaluate', { expression: 'window.__bench ? JSON.stringify(window.__bench) : ""', returnByValue: true });
    if (r.result.value) {
      const bench = JSON.parse(r.result.value);
      if (bench.error) throw new Error(bench.error);
      return bench;
    }
  }
  throw new Error('측정 시간 초과');
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn']);
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'arp-bench-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    const url = `http://localhost:${PORT}/bench/index.html`;
    await waitFor(url);
    await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = targets.find(t => t.type === 'page');
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');

    const conditions = [
      { label: 'CPU 보통 · 처음 열기', cold: true, cpuRate: 1 },
      { label: 'CPU 보통 · 다시 열기', cold: false, cpuRate: 1 },
      { label: 'CPU 4배 느리게 · 처음 열기', cold: true, cpuRate: 4 },
      { label: 'CPU 4배 느리게 · 다시 열기', cold: false, cpuRate: 4 },
    ];
    const results = [];
    for (const c of conditions) {
      const runs = [];
      for (let i = 0; i < RUNS; i += 1) runs.push(await measure(cdp, url, c));
      results.push({ ...c, runs });
    }
    cdp.close();

    // 요약: 데이터별 중앙값
    const summary = results.map(c => ({
      condition: c.label,
      moduleAndWasmInitMs: median(c.runs.map(r => r.moduleAndWasmInitMs)),
      datasets: c.runs[0].datasets.map((d, di) => {
        const pick = f => median(c.runs.map(r => f(r.datasets[di])));
        return {
          name: d.name, stages: d.stages, fileKB: d.fileKB,
          firstScreenMs: di === 0 ? pick(x => x.firstScreenMs) : null,
          openToScreenMs: pick(x => x.openToScreenMs),
          firstCalcMs: pick(x => x.firstCalc.totalMs),
          engineMs: pick(x => x.firstCalc.engineMs),
          recalcMedianMs: pick(x => x.recalc.medianMs),
          recalcMaxMs: pick(x => x.recalc.maxMs),
          saveExportMs: pick(x => x.saveExportMs),
          compare3Ms: pick(x => x.compare3Ms),
        };
      }),
    }));
    const report = { at: new Date().toISOString(), runsPerCondition: RUNS, userAgent: results[0].runs[0].userAgent, sqlite: results[0].runs[0].sqlite, summary, raw: results };
    writeFileSync(`${ROOT}samples/out/bench-browser.json`, JSON.stringify(report, null, 2));

    console.log(`\n브라우저 측정 (${report.sqlite}, 조건마다 ${RUNS}회 중앙값, 단위 ms)`);
    for (const c of summary) {
      console.log(`\n■ ${c.condition} · 모듈·WASM 준비 ${c.moduleAndWasmInitMs}`);
      console.log('  데이터          스테이지  첫 화면  열기→화면  첫 계산  (엔진)  재계산 중앙  재계산 최대  저장 내보내기  시나리오3 비교');
      for (const d of c.datasets) {
        console.log(`  ${d.name.padEnd(14)} ${String(d.stages).padStart(8)} ${String(d.firstScreenMs ?? '-').padStart(8)} ${String(d.openToScreenMs).padStart(10)} ${String(d.firstCalcMs).padStart(8)} ${String(d.engineMs).padStart(7)} ${String(d.recalcMedianMs).padStart(11)} ${String(d.recalcMaxMs).padStart(11)} ${String(d.saveExportMs).padStart(12)} ${String(d.compare3Ms).padStart(14)}`);
      }
    }
    console.log('\n원자료: samples/out/bench-browser.json');
  } finally {
    chrome.kill();
    server.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 크롬이 아직 잡고 있으면 남긴다 */ }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
