// 브라우저 빌드 설정: 앱(web/app)과 측정 페이지(web/bench)
// 앱은 설치형 앱(PWA): 빌드할 때 만들어진 파일 목록으로 서비스 워커와 manifest를 같이 만든다(추가 패키지 없음).
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const r = p => fileURLToPath(new URL(p, import.meta.url));

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b5bd6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="14" width="15" height="15" rx="3"/><rect x="35" y="14" width="15" height="15" rx="3"/><rect x="14" y="35" width="15" height="15" rx="3"/><path d="M42.5 35v15M35 42.5h15"/></g></svg>`;

function swSource(cache, precache) {
  return `// ARP 서비스 워커(빌드할 때 생성). 한 번 열면 인터넷 없이도 앱이 뜬다. 데이터는 항상 사용자 파일에 있다.
const CACHE = ${JSON.stringify(cache)};
const PRECACHE = ${JSON.stringify(precache)};
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
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
        const page = await caches.match('./index.html');
        if (page) return page;
      }
      throw error;
    }
  })());
});
`;
}

function pwa() {
  return {
    name: 'arp-pwa',
    apply: 'build',
    generateBundle(_, bundle) {
      // 앱이 쓰는 파일만 미리 담는다(측정 페이지 제외). 경로는 app/sw.js 기준
      const files = Object.keys(bundle).filter(f => !f.endsWith('.map') && !f.startsWith('bench/') && !/bench-[\w-]+\.js$/.test(f));
      const precache = ['./index.html', './icon.svg', './manifest.webmanifest', ...files.filter(f => f !== 'app/index.html').map(f => `../${f}`)];
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
          start_url: './index.html',
          scope: './',
          display: 'standalone',
          background_color: '#f6f6f7',
          theme_color: '#5b5bd6',
          icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        }, null, 2),
      });
    },
  };
}

export default defineConfig({
  root: r('./web'),
  base: './',
  // 예시·측정용 샘플 파일(samples/out/*.arp)을 그대로 내보낸다
  publicDir: r('./samples/out'),
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  plugins: [pwa()],
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
});
