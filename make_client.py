#!/usr/bin/env python3
"""Build (and optionally deploy) one client's POS + customer apps.

  python3 make_client.py new <slug>                 make clients/<slug>/client.json to fill in
  python3 make_client.py build <slug>               build into dist/<slug>/
  python3 make_client.py build <slug> --deploy      build, then deploy to that client's Firebase project
  python3 make_client.py build <slug> --out .       write config.js, manifests and icons next to this script (for testing)

clients/<slug>/client.json holds the shop name, Firebase config and colors.
Optional: put logo.png in clients/<slug>/ and set "logo": "logo.png" to use it for the app icons
(a square PNG, at least 512x512, works best). Without a logo, a coffee cup icon is drawn.
Optional: "logoScale": 0.8 makes the logo fill 80% of the icon, and colors.iconBg sets the icon background.

Needs: Python 3 and Pillow (pip install pillow). Deploying also needs firebase-tools
(npm i -g firebase-tools, then firebase login).
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
APP_FILES = ['index.html', 'order.html', 'pwa.js', 'sw.js', 'firestore.rules']
DEFAULT_COLORS = {'dark': '#2a1d16', 'brand': '#6f4e37', 'accent': '#a47148', 'active': '#6b4a36', 'iconBg': ''}
CREAM = '#f6efe6'

TEMPLATE = {
    'name': 'Shop Name',
    'posName': 'Shop Name POS',
    'orderName': 'Shop Name',
    'firebase': {
        'apiKey': 'PASTE', 'authDomain': 'PASTE', 'projectId': 'PASTE',
        'storageBucket': 'PASTE', 'messagingSenderId': 'PASTE', 'appId': 'PASTE'
    },
    'colors': DEFAULT_COLORS,
    'logo': ''
}


def die(msg):
    print('Error: ' + msg)
    sys.exit(1)


def load_client(slug):
    p = ROOT / 'clients' / slug / 'client.json'
    if not p.exists():
        die(f'{p} not found. Run: python3 make_client.py new {slug}')
    cfg = json.loads(p.read_text(encoding='utf-8'))
    cfg['colors'] = {**DEFAULT_COLORS, **cfg.get('colors', {})}
    for k in ('name', 'posName', 'orderName'):
        if not cfg.get(k):
            die(f'"{k}" is empty in {p}')
    fb = cfg.get('firebase') or {}
    if not fb.get('projectId') or str(fb.get('apiKey', '')).startswith('PASTE'):
        print('Warning: the Firebase config in client.json is not filled in yet.')
    return cfg, p.parent


# ---------------- icons ----------------
def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def draw_icon(size, cfg, folder, pos):
    """Everything important stays inside the middle 80%, so Android can round or crop the icon."""
    S = 1024  # drawn big, then shrunk for smooth edges
    k = S / 512
    c = cfg['colors']
    bg = hex_rgb(c['iconBg'] or c['dark'])
    img = Image.new('RGB', (S, S), bg)
    d = ImageDraw.Draw(img)
    logo = cfg.get('logo')
    dy = -30 if pos else 15
    if logo:
        lp = folder / logo
        if not lp.exists():
            die(f'Logo file not found: {lp}')
        lg = Image.open(lp).convert('RGBA')
        scale = cfg.get('logoScale')  # e.g. 0.8 = logo fills 80% of the icon (good for round logos)
        box = int(float(scale) * S) if scale else int((250 if pos else 300) * k)
        lg.thumbnail((box, box), Image.LANCZOS)
        x = (S - lg.width) // 2
        y = int((S - lg.height) / 2 + (0 if scale else (-20 * k if pos else 0)))
        img.paste(lg, (x, y), lg)
    else:
        fg = hex_rgb(CREAM)

        def R(x0, y0, x1, y1):
            return [x0 * k, (y0 + dy) * k, x1 * k, (y1 + dy) * k]
        d.rounded_rectangle(R(156, 236, 336, 366), radius=60 * k, fill=fg)      # cup
        d.rectangle(R(156, 236, 336, 300), fill=fg)
        d.arc(R(310, 262, 394, 338), -90, 90, fill=fg, width=int(16 * k))      # handle
        d.rounded_rectangle(R(128, 388, 364, 406), radius=9 * k, fill=fg)      # saucer
        for sx in (206, 256):                                                    # steam
            pts = [(sx, 205), (sx, 185), (sx + 11, 168), (sx, 150)]
            d.line([(x * k, (y + dy) * k) for x, y in pts], fill=fg, width=int(10 * k), joint='curve')
    if pos:  # small POS pill so the two apps look different on the home screen
        accent = hex_rgb(c['accent'])
        d.rounded_rectangle([196 * k, 396 * k, 316 * k, 440 * k], radius=22 * k, fill=accent)
        try:
            font = ImageFont.load_default(size=int(34 * k))
        except TypeError:
            font = ImageFont.load_default()
        bb = d.textbbox((0, 0), 'POS', font=font)
        d.text((256 * k - (bb[0] + bb[2]) / 2, 418 * k - (bb[1] + bb[3]) / 2), 'POS', font=font, fill=hex_rgb(CREAM))
    return img.resize((size, size), Image.LANCZOS)


def make_icons(cfg, folder, out):
    (out / 'icons').mkdir(parents=True, exist_ok=True)
    for app, pos in (('pos', True), ('order', False)):
        for size in (192, 512):
            draw_icon(size, cfg, folder, pos).save(out / 'icons' / f'{app}-{size}.png', optimize=True)


# ---------------- manifests, config, firebase files ----------------
def manifest(app, cfg):
    pos = app == 'pos'
    name = cfg['posName'] if pos else cfg['orderName']
    page = 'index.html' if pos else 'order.html'
    icons = []
    for purpose in ('any', 'maskable'):
        for s in (192, 512):
            icons.append({'src': f'icons/{app}-{s}.png', 'sizes': f'{s}x{s}', 'type': 'image/png', 'purpose': purpose})
    return {
        'id': './' + page,
        'name': name,
        'short_name': name[:12].strip(),
        'start_url': './' + page,
        'scope': './',
        'display': 'standalone',
        'orientation': 'any' if pos else 'portrait',
        'background_color': '#f0e8dc' if pos else '#f6f1ea',
        'theme_color': cfg['colors']['dark'],
        'icons': icons
    }


def write_config_js(cfg, out):
    shop = {k: cfg[k] for k in ('name', 'posName', 'orderName')}
    shop['colors'] = {k: v for k, v in cfg['colors'].items() if k != 'iconBg'}
    text = ('// Generated by make_client.py from clients/<shop>/client.json. Edit client.json, then build again.\n'
            'const FIREBASE_CONFIG = ' + json.dumps(cfg['firebase'], indent=2) + ';\n'
            'const SHOP_CONFIG = ' + json.dumps(shop, indent=2) + ';\n')
    (out / 'config.js').write_text(text, encoding='utf-8')


def write_firebase_files(cfg, out):
    fb = {
        'hosting': {
            'public': '.',
            'ignore': ['firebase.json', '**/.*', '**/node_modules/**', 'firestore.rules'],
            'headers': [{'source': '**/*.@(html|js|json)',
                         'headers': [{'key': 'Cache-Control', 'value': 'no-cache'}]}]
        },
        'firestore': {'rules': 'firestore.rules'}
    }
    (out / 'firebase.json').write_text(json.dumps(fb, indent=2) + '\n', encoding='utf-8')
    (out / '.firebaserc').write_text(json.dumps({'projects': {'default': cfg['firebase']['projectId']}}, indent=2) + '\n', encoding='utf-8')


def build(slug, out, deploy):
    cfg, folder = load_client(slug)
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    standalone = out != ROOT
    if standalone:
        for f in APP_FILES:
            shutil.copy2(ROOT / f, out / f)
    write_config_js(cfg, out)
    make_icons(cfg, folder, out)
    for app in ('pos', 'order'):
        (out / f'manifest-{app}.json').write_text(json.dumps(manifest(app, cfg), indent=2) + '\n', encoding='utf-8')
    if standalone:
        write_firebase_files(cfg, out)
    print(f'Built "{cfg["name"]}" into {out}')
    if not deploy:
        return
    if not standalone:
        die('--deploy needs a dist folder, not --out .')
    fb = shutil.which('firebase')
    if not fb:
        die('firebase-tools not found. Run: npm i -g firebase-tools   then: firebase login')
    # deploys the site and this project's Firestore rules
    subprocess.run([fb, 'deploy', '--only', 'hosting,firestore:rules', '--project', cfg['firebase']['projectId']], cwd=out, check=True)
    print(f'Deployed. POS: https://{cfg["firebase"]["projectId"]}.web.app/   Customer: https://{cfg["firebase"]["projectId"]}.web.app/order.html')


def main():
    a = sys.argv[1:]
    if len(a) < 2 or a[0] not in ('new', 'build'):
        print(__doc__)
        sys.exit(1)
    slug = a[1]
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', slug):
        die('Use lowercase letters, numbers and dashes for the client name, for example: auntie-linda')
    if a[0] == 'new':
        p = ROOT / 'clients' / slug / 'client.json'
        if p.exists():
            die(f'{p} already exists')
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(TEMPLATE, indent=2) + '\n', encoding='utf-8')
        print(f'Created {p}. Fill it in, then run: python3 make_client.py build {slug}')
        return
    out = ROOT / 'dist' / slug
    if '--out' in a:
        i = a.index('--out')
        if i + 1 >= len(a):
            die('--out needs a folder')
        out = Path(a[i + 1])
    build(slug, out, '--deploy' in a)


if __name__ == '__main__':
    main()
