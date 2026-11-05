// Cloudflare Pages처럼 동작하는 작은 정적 서버(배포 시험용, 의존 패키지 없음)
//   - /x/index.html → 308 /x/ ,  /x.html → 308 /x ,  /dir → 308 /dir/ (쿼리는 그대로)
//   - /x 는 x.html, /dir/ 은 dir/index.html
//   - 없는 주소: 404.html이 있으면 그것(404), 없으면 맨 위 index.html(200, 한 페이지 앱으로 봄)
//   - _headers 파일의 규칙(경로 패턴 + 헤더)을 붙인다
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.arp': 'application/octet-stream',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function parseHeaders(root) {
  const p = join(root, '_headers');
  if (!existsSync(p)) return [];
  const rules = [];
  let cur = null;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: [] }; rules.push(cur); continue; }
    const i = line.indexOf(':');
    if (cur && i > 0) cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return rules.map(r => ({ ...r, re: new RegExp(`^${r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) }));
}

const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function startPagesServer(root, port) {
  const rules = parseHeaders(root);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    const redirect = to => { res.writeHead(308, { Location: to + url.search }); res.end(); };
    if (path.endsWith('/index.html')) return redirect(path.slice(0, -'index.html'.length));
    if (path.endsWith('.html')) return redirect(path.slice(0, -'.html'.length));
    let file = join(root, path);
    let status = 200;
    if (isDir(file)) {
      if (!path.endsWith('/')) return redirect(`${path}/`);
      file = join(file, 'index.html');
    } else if (!isFile(file) && isFile(`${file}.html`)) file = `${file}.html`;
    if (!isFile(file)) {
      if (isFile(join(root, '404.html'))) { file = join(root, '404.html'); status = 404; } else if (isFile(join(root, 'index.html'))) file = join(root, 'index.html');
      else { res.writeHead(404); res.end('Not found'); return; }
    }
    const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' };
    for (const r of rules) if (r.re.test(path)) for (const [k, v] of r.headers) headers[k] = v;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}
