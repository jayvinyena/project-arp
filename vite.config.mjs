// 브라우저 빌드 설정: 앱(web/app)과 측정 페이지(web/bench)
// 앱은 설치형 앱(PWA): 빌드할 때 만들어진 파일 목록으로 서비스 워커와 manifest를 같이 만든다(추가 패키지 없음).
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const r = p => fileURLToPath(new URL(p, import.meta.url));

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b5bd6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="14" width="15" height="15" rx="3"/><rect x="35" y="14" width="15" height="15" rx="3"/><rect x="14" y="35" width="15" height="15" rx="3"/><path d="M42.5 35v15M35 42.5h15"/></g></svg>`;

function swSource(cache, precache) {
  return `// ARP 서비스 워커(빌드할 때 생성). 한 번 열면 인터넷 없이도 앱이 뜬다. 데이터는 항상 사용자 파일에 있다.
const CACHE = ${JSON.stringify(cache)};
const PRECACHE = ${JSON.stringify(precache)};
// 정적 호스팅이 주소를 옮기면(예: index.html → ./) 옮겨진 응답이 된다. 그대로 담으면 화면 이동에 쓸 수 없어 새 응답으로 담는다
const clean = r => (r.redirected ? new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers }) : r);
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(PRECACHE.map(u => fetch(u, { cache: 'reload' }).then(r => {
      if (!r.ok) throw new Error(u + ' ' + r.status);
      return c.put(u, clean(r));
    }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('arp-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const navigate = req.mode === 'navigate';
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: navigate });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (error) {
      if (navigate) {
        const page = await caches.match('./');
        if (page) return page;
      }
      throw error;
    }
  })());
});
`;
}

const ROOT_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ARP</title>
<meta http-equiv="refresh" content="0; url=./app/"><script>location.replace('./app/' + location.search + location.hash)</script></head>
<body><a href="./app/">ARP 열기</a></body></html>
`;
const HEADERS = `/app/sw.js
  Cache-Control: no-cache
/app/
  Cache-Control: no-cache
/app/manifest.webmanifest
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`;

function pwa() {
  return {
    name: 'arp-pwa',
    apply: 'build',
    generateBundle(_, bundle) {
      // 앱이 쓰는 파일만 미리 담는다(측정 페이지·예시 파일 제외). 경로는 app/sw.js 기준
      const files = Object.keys(bundle).filter(f => !f.endsWith('.map') && !f.startsWith('bench/') && !/bench-[\w-]+\.js$/.test(f) && !/\.(arp|xlsx)$/i.test(f));
      // 첫 페이지는 ./ 로 담는다(호스팅이 index.html을 ./ 로 옮겨도 같은 주소)
      const precache = ['./', './icon.svg', './manifest.webmanifest', ...files.filter(f => f !== 'app/index.html').map(f => `../${f}`)];
      const cache = `arp-${createHash('sha256').update(files.sort().join('|')).digest('hex').slice(0, 12)}`;
      this.emitFile({ type: 'asset', fileName: 'app/sw.js', source: swSource(cache, precache) });
      this.emitFile({ type: 'asset', fileName: 'app/icon.svg', source: ICON_SVG });
      this.emitFile({
        type: 'asset',
        fileName: 'app/manifest.webmanifest',
        source: JSON.stringify({
          name: '아트 리소스 플래너',
          short_name: 'ARP',
          description: '런칭과 업데이트에 필요한 아트 물량을 설계해요',
          lang: 'ko',
          start_url: './',
          scope: './',
          display: 'standalone',
          background_color: '#f6f6f7',
          theme_color: '#5b5bd6',
          icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        }, null, 2),
      });
      // 맨 위 주소(/)로 열면 앱으로 보낸다
      this.emitFile({ type: 'asset', fileName: 'index.html', source: ROOT_HTML });
      // Cloudflare Pages 응답 헤더: 서비스 워커는 매번 확인, 해시 붙은 파일은 오래 담기
      this.emitFile({ type: 'asset', fileName: '_headers', source: HEADERS });
    },
  };
}

// 예시·측정용 샘플: samples/out 맨 위의 .arp·.xlsx만 배포에 넣는다.
// 같은 폴더에 검사·시험이 쓰는 하위 폴더(test-*, shots, downloads)와 측정 기록(.json)이 있어 폴더째 복사하지 않는다.
function samples() {
  return {
    name: 'arp-samples',
    apply: 'build',
    generateBundle() {
      const dir = r('./samples/out');
      for (const f of readdirSync(dir)) {
        if (!/\.(arp|xlsx)$/i.test(f) || !statSync(`${dir}/${f}`).isFile()) continue;
        this.emitFile({ type: 'asset', fileName: f, source: readFileSync(`${dir}/${f}`) });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  root: r('./web'),
  base: './',
  // 개발 서버는 샘플 폴더를 그대로 쓴다. 빌드는 samples()가 예시 파일만 넣는다
  publicDir: command === 'serve' ? r('./samples/out') : false,
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  plugins: [samples(), pwa()],
  build: {
    outDir: r('./dist-web'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        app: r('./web/app/index.html'),
        bench: r('./web/bench/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  // sqlite-wasm은 미리 묶지 않는다(패키지 안내)
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
}));
