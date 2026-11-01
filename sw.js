/* Service worker: guarda o app e as etiquetas para funcionar sem internet. */
const VERSION = 'v1.0.3';
const SHELL = `shell-${VERSION}`;
const DATA = 'etiquetas-pdf-v1';
const SHELL_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/usb.js', 'js/printjob.js', 'js/pdftools.js', 'js/escpr.js', 'js/escp2.js',
  'vendor/pdf-lib.min.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'catalog/catalog.json',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' evita pegar arquivos antigos do cache HTTP do navegador ao atualizar
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url);
  // catálogo e app: rede primeiro para catalog.json (atualizações), cache primeiro para o resto
  if (url.pathname.endsWith('catalog.json') || req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(SHELL).then((ca) => ca.put(req, c)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok && (url.pathname.includes('/catalog/'))) { const c = r.clone(); caches.open(DATA).then((ca) => ca.put(req, c)); }
    return r;
  })));
});

// a página pede para baixar todas as etiquetas em segundo plano
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'precache') return;
  const files = e.data.files || [];
  e.waitUntil((async () => {
    const cache = await caches.open(DATA);
    let done = 0;
    const tell = async () => { for (const c of await self.clients.matchAll()) c.postMessage({ type: 'precache', done, total: files.length }); };
    const queue = [...files];
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        try { if (!(await cache.match(f))) { const r = await fetch(f); if (r.ok) await cache.put(f, r); } } catch {}
        done++; if (done % 5 === 0 || done === files.length) await tell();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await tell();
  })());
});
