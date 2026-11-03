/* Shared PWA loader for index.html (POS) and order.html (customer).
   Loaded with: <script src="pwa.js" data-app="pos"></script>  (or data-app="order")
   Reads SHOP_CONFIG from config.js, applies the shop colors, and registers the service worker. */
(function () {
  var cur = document.currentScript;
  var app = (cur && cur.dataset.app) || 'pos';
  var C = typeof SHOP_CONFIG !== 'undefined' ? SHOP_CONFIG : {};
  var col = C.colors || {};
  var root = document.documentElement.style;

  // shop colors (the CSS in both pages reads these variables)
  if (col.dark) root.setProperty('--dark', col.dark);
  if (col.brand) root.setProperty('--brand', col.brand);
  if (col.accent && app === 'pos') root.setProperty('--brand2', col.accent);
  if (col.active) root.setProperty('--sideon', col.active);

  function meta(name, value) {
    var m = document.querySelector('meta[name="' + name + '"]');
    if (!m) { m = document.createElement('meta'); m.name = name; document.head.appendChild(m); }
    m.content = value;
  }
  meta('theme-color', col.dark || '#2a1d16');
  meta('apple-mobile-web-app-title', (app === 'pos' ? C.posName : C.orderName) || C.name || 'Shop');

  // service worker (needs https, or localhost for testing)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
