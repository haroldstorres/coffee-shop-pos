/* Service worker shared by the POS and the customer page.
   - The app files are fetched from the network first, so updates show up right away.
     If the network is slow or offline, the saved copy opens instead.
   - Firebase and QR libraries are saved after the first load.
   - Firestore / Auth traffic is never touched here, so orders and stock always go straight to Firebase.
   Change VER whenever you want to force every device to drop its saved copies. */
const VER = 'v1';
const SHELL = 'shell-' + VER;
const LIBS = 'libs-' + VER;
const LIB_HOSTS = ['www.gstatic.com', 'cdnjs.cloudflare.com'];
const PRECACHE = [
  './', 'index.html', 'order.html', 'config.js', 'pwa.js',
  'manifest-pos.json', 'manifest-order.json',
  'icons/pos-192.png', 'icons/pos-512.png', 'icons/order-192.png', 'icons/order-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== LIBS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function offlineFallback(req, cache) {
  if (req.mode === 'navigate') {
    const page = new URL(req.url).pathname.endsWith('order.html') ? 'order.html' : 'index.html';
    return cache.match(page).then(r => r || Response.error());
  }
  return Response.error();
}

function networkFirst(req) {
  return caches.open(SHELL).then(cache => {
    const net = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    const slow = new Promise((_, reject) => setTimeout(reject, 5000)); // slow network: use the saved copy
    return Promise.race([net, slow]).catch(() =>
      cache.match(req, { ignoreSearch: true }).then(hit => hit || net.catch(() => offlineFallback(req, cache)))
    );
  });
}

function staleWhileRevalidate(req) {
  return caches.open(LIBS).then(cache =>
    cache.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => hit || Response.error());
      return hit || net;
    })
  );
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  } else if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req));
  }
  // everything else (firestore.googleapis.com, identitytoolkit, etc.) goes straight to the network
});
