#!/usr/bin/env node
/* Build (and optionally deploy) one client's POS + customer apps.

  node make_client.js new <slug>                 make clients/<slug>/client.json to fill in
  node make_client.js build <slug>               build into dist/<slug>/
  node make_client.js build <slug> --deploy      build, then deploy to that client's Firebase project
  node make_client.js build <slug> --out .       write config.js, manifests and icons next to this script (for testing)

clients/<slug>/client.json holds the shop name, Firebase config and colors.
Optional: put logo.png in clients/<slug>/ and set "logo": "logo.png" to use it for the app icons
(a square PNG, at least 512x512, works best). Without a logo, a coffee cup icon is drawn.
Optional: "logoScale": 0.8 makes the logo fill 80% of the icon, and colors.iconBg sets the icon background.

Needs: Node.js and sharp (npm install sharp). Deploying also needs firebase-tools
(npm i -g firebase-tools, then firebase login).
*/
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let sharp;
try { sharp = require('sharp'); } catch (e) { die('The "sharp" package is missing. Run: npm install sharp'); }

const ROOT = __dirname;
const APP_FILES = ['index.html', 'order.html', 'pwa.js', 'sw.js', 'firestore.rules'];
const DEFAULT_COLORS = { dark: '#2a1d16', brand: '#6f4e37', accent: '#a47148', active: '#6b4a36', iconBg: '' };
const CREAM = '#f6efe6';
const TEMPLATE = {
  name: 'Shop Name',
  posName: 'Shop Name POS',
  orderName: 'Shop Name',
  firebase: { apiKey: 'PASTE', authDomain: 'PASTE', projectId: 'PASTE', storageBucket: 'PASTE', messagingSenderId: 'PASTE', appId: 'PASTE' },
  colors: DEFAULT_COLORS,
  logo: ''
};

function die(msg) { console.error('Error: ' + msg); process.exit(1); }
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');

function loadClient(slug) {
  const p = path.join(ROOT, 'clients', slug, 'client.json');
  if (!fs.existsSync(p)) die(`${p} not found. Run: node make_client.js new ${slug}`);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (e) { die(`${p} is not valid JSON: ${e.message}`); }
  cfg.colors = Object.assign({}, DEFAULT_COLORS, cfg.colors || {});
  for (const k of ['name', 'posName', 'orderName']) if (!cfg[k]) die(`"${k}" is empty in ${p}`);
  const fb = cfg.firebase || {};
  if (!fb.projectId || String(fb.apiKey || '').startsWith('PASTE')) console.log('Warning: the Firebase config in client.json is not filled in yet.');
  return { cfg, folder: path.dirname(p) };
}

/* ---------------- icons ----------------
   Everything important stays inside the middle 80%, so Android can round or crop the icon. */
function cupSvg(c, pos) {
  const dy = pos ? -30 : 15, f = CREAM, t = n => n + dy;
  const steam = [206, 256].map(sx =>
    `<polyline points="${sx},${t(205)} ${sx},${t(185)} ${sx + 11},${t(168)} ${sx},${t(150)}" fill="none" stroke="${f}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  return `<path d="M156,${t(236)} H336 V${t(306)} a60,60 0 0 1 -60,60 H216 a60,60 0 0 1 -60,-60 Z" fill="${f}"/>
<path d="M352,${t(262)} A42,38 0 0 1 352,${t(338)}" fill="none" stroke="${f}" stroke-width="16"/>
<rect x="128" y="${t(388)}" width="236" height="18" rx="9" fill="${f}"/>${steam}`;
}
function pillSvg(c) { // "POS" drawn with lines, so no font is needed
  const st = `fill="none" stroke="${CREAM}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"`;
  return `<rect x="196" y="396" width="120" height="44" rx="22" fill="${c.accent}"/>
<g transform="translate(224,406)" ${st}>
<path d="M2,24 V0 H8 A6,6 0 0 1 8,12 H2"/>
<ellipse cx="32" cy="12" rx="7.5" ry="12"/>
<path d="M62,5 C62,-1 50,-1 50,6 C50,12 62,12 62,18 C62,25 50,25 50,19"/>
</g>`;
}
const svg = (inner, size) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${inner}</svg>`);

async function drawIcon(size, cfg, folder, pos, transparent) {
  const c = cfg.colors, bg = c.iconBg || c.dark;
  const layers = [];
  const clear = !!(transparent && cfg.logo); // logo only: no background box, no POS pill (used for the "any" icons)
  if (cfg.logo) {
    const lp = path.join(folder, cfg.logo);
    if (!fs.existsSync(lp)) die(`Logo file not found: ${lp}`);
    const scale = clear ? 1 : Number(cfg.logoScale);
    const box = Math.round((scale > 0 ? scale : (pos ? 250 : 300) / 512) * size);
    const buf = await sharp(lp).resize(box, box, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const off = Math.round((size - box) / 2) + (scale > 0 ? 0 : Math.round((pos ? -20 : 0) / 512 * size));
    layers.push({ input: buf, left: Math.round((size - box) / 2), top: off });
  } else {
    layers.push({ input: svg(cupSvg(c, pos), size), left: 0, top: 0 });
  }
  if (pos && !clear) layers.push({ input: svg(pillSvg(c), size), left: 0, top: 0 });
  if (clear) return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: bg } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
async function makeIcons(cfg, folder, out) {
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  for (const [app, pos] of [['pos', true], ['order', false]])
    for (const size of [192, 512]) {
      fs.writeFileSync(path.join(out, 'icons', `${app}-${size}.png`), await drawIcon(size, cfg, folder, pos));
      fs.writeFileSync(path.join(out, 'icons', `${app}-any-${size}.png`), await drawIcon(size, cfg, folder, pos, true)); // circle only, transparent
    }
}

/* ---------------- manifests, config, firebase files ---------------- */
function manifest(app, cfg) {
  const pos = app === 'pos', name = pos ? cfg.posName : cfg.orderName, page = pos ? 'index.html' : 'order.html';
  const icons = [];
  for (const purpose of ['any', 'maskable'])
    for (const s of [192, 512]) icons.push({ src: `icons/${app}-${purpose === 'any' ? 'any-' : ''}${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose });
  return {
    id: './' + page, name, short_name: name.slice(0, 12).trim(), start_url: './' + page, scope: './',
    display: 'standalone', orientation: pos ? 'any' : 'portrait',
    background_color: pos ? '#f0e8dc' : '#f6f1ea', theme_color: cfg.colors.dark, icons
  };
}
function writeConfigJs(cfg, out) {
  const colors = Object.assign({}, cfg.colors); delete colors.iconBg;
  const shop = { name: cfg.name, posName: cfg.posName, orderName: cfg.orderName, colors };
  fs.writeFileSync(path.join(out, 'config.js'),
    '// Generated by make_client from clients/<shop>/client.json. Edit client.json, then build again.\n' +
    'const FIREBASE_CONFIG = ' + JSON.stringify(cfg.firebase, null, 2) + ';\n' +
    'const SHOP_CONFIG = ' + JSON.stringify(shop, null, 2) + ';\n', 'utf8');
}
function writeFirebaseFiles(cfg, out) {
  writeJson(path.join(out, 'firebase.json'), {
    hosting: {
      public: '.',
      ignore: ['firebase.json', '**/.*', '**/node_modules/**', 'firestore.rules'],
      headers: [{ source: '**/*.@(html|js|json)', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }]
    },
    firestore: { rules: 'firestore.rules' }
  });
  writeJson(path.join(out, '.firebaserc'), { projects: { default: cfg.firebase.projectId } });
}

async function build(slug, out, deploy) {
  const { cfg, folder } = loadClient(slug);
  out = path.resolve(out);
  fs.mkdirSync(out, { recursive: true });
  const standalone = out !== ROOT;
  if (standalone) {
    const missing = APP_FILES.filter(f => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) die(`These files are missing from ${ROOT}: ${missing.join(', ')}. Put them in the same folder as make_client.js.`);
    for (const f of APP_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
  }
  writeConfigJs(cfg, out);
  await makeIcons(cfg, folder, out);
  for (const app of ['pos', 'order']) writeJson(path.join(out, `manifest-${app}.json`), manifest(app, cfg));
  if (standalone) writeFirebaseFiles(cfg, out);
  console.log(`Built "${cfg.name}" into ${out}`);
  if (!deploy) return;
  if (!standalone) die('--deploy needs a dist folder, not --out .');
  if (spawnSync('firebase', ['--version'], { shell: true, stdio: 'ignore' }).status !== 0)
    die('firebase-tools not found. Run: npm i -g firebase-tools   then: firebase login');
  const r = spawnSync('firebase', ['deploy', '--only', 'hosting,firestore:rules', '--project', cfg.firebase.projectId], { cwd: out, shell: true, stdio: 'inherit' });
  if (r.status !== 0) die('Deploy failed. See the messages above.');
  const id = cfg.firebase.projectId;
  console.log(`Deployed. POS: https://${id}.web.app/   Customer: https://${id}.web.app/order.html`);
}

async function main() {
  const a = process.argv.slice(2);
  if (a.length < 2 || !['new', 'build'].includes(a[0])) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\s?/, ''));
    process.exit(1);
  }
  const slug = a[1];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) die('Use lowercase letters, numbers and dashes for the client name, for example: auntie-linda');
  if (a[0] === 'new') {
    const p = path.join(ROOT, 'clients', slug, 'client.json');
    if (fs.existsSync(p)) die(`${p} already exists`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJson(p, TEMPLATE);
    console.log(`Created ${p}. Fill it in, then run: node make_client.js build ${slug}`);
    return;
  }
  let out = path.join(ROOT, 'dist', slug);
  const i = a.indexOf('--out');
  if (i >= 0) { if (!a[i + 1]) die('--out needs a folder'); out = a[i + 1]; }
  await build(slug, out, a.includes('--deploy'));
}
main().catch(e => die(e.message || String(e)));
