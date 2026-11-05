// 크롬(화면 없음) + 미리보기 서버를 띄우고 크롬 개발자 프로토콜(CDP)로 조작한다. 추가 패키지 없이 Node 내장 WebSocket을 쓴다.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME_DEFAULT = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → ${code}`))));
  });
}

export async function waitFor(url, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* 아직 */ }
    await sleep(200);
  }
  throw new Error(`응답 없음: ${url}`);
}

export class Cdp {
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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async waitUntil(expression, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await this.eval(`Boolean(${expression})`)) return;
      await sleep(150);
    }
    throw new Error(`기다림 시간 초과: ${expression}`);
  }
  close() { this.ws.close(); }
}

/** 빌드 → 미리보기 서버 → 크롬. fn(cdp, baseUrl) 실행 뒤 모두 끈다 */
export async function withBrowser(fn, { port = 4317, debugPort = 9333, chrome = CHROME_DEFAULT, build = true } = {}) {
  if (build) {
    // 앱이 내보내는 예시 파일(samples/out/*.arp)도 최신으로
    await run(process.execPath, ['tools/build-samples.mjs'], { stdio: 'ignore' });
    await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn']);
  }
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'arp-cdp-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    await waitFor(`http://localhost:${port}/app/index.html`);
    await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const cdp = new Cdp(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    try {
      return await fn(cdp, `http://localhost:${port}`);
    } finally {
      cdp.close();
    }
  } finally {
    browser.kill();
    server.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 크롬이 잡고 있으면 남긴다 */ }
  }
}
