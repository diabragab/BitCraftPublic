// Browser test for the open-world single-player page (npm run build:offline). Serves
// artifact.html like a page host (claude.ai) does: wrapped in a bare document, under a strict
// content-security policy. Plays the core loop: chop trees, craft planks, build, save, reload.
// Usage: node tests/e2e-world.mjs
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(web, 'client', 'dist-offline');
const out = join(web, 'test-results');
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:";
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>${readFileSync(join(root, 'artifact.html'), 'utf8')}</body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  res.setHeader('content-security-policy', CSP);
  if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (path === '/favicon.ico') return res.writeHead(204).end(); // the host page supplies the tab icon
  const file = normalize(join(root, decodeURIComponent(path)));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''} (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    failed++;
    console.log(`  ✖ ${name} — ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = (p) => p.evaluate(() => window.__world.snapshot());
function watch(p) {
  const problems = [];
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()} @ ${m.location()?.url ?? ''}`));
  return problems;
}
async function cspProbe(ctx) {
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

/** Nearest standing tree that is not inside the village. */
const nearestTree = (p) =>
  p.evaluate(() => {
    const w = window.__world.world;
    const pl = w.player;
    const trees = w.nodesNear(pl.x, pl.z, 120).filter((n) => n.kind === 'tree' && !w.isDepleted(n.id));
    trees.sort((a, b) => Math.hypot(a.x - pl.x, a.z - pl.z) - Math.hypot(b.x - pl.x, b.z - pl.z));
    return trees[0] ? { id: trees[0].id, x: trees[0].x, z: trees[0].z } : null;
  });

/** Walks with the keyboard until `done()` is true, side-stepping when something blocks the way. */
async function walkTo(p, tx, tz, done, timeoutMs = 150000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  let side = 0;
  while (Date.now() < end) {
    const s = await snap(p);
    if (await done(s)) return s;
    const dx = tx - s.x;
    const dz = tz - s.z;
    let keys = [];
    if (Math.abs(dx) > 0.6) keys.push(dx > 0 ? 'd' : 'a');
    if (Math.abs(dz) > 0.6) keys.push(dz > 0 ? 's' : 'w');
    if (last && Math.hypot(last.x - s.x, last.z - s.z) < 0.15) side = (side + 1) % 4;
    if (side) keys = [['a', 'w', 'd', 's'][side]];
    last = s;
    for (const k of keys) await p.keyboard.down(k);
    await sleep(Math.min(600, 120 + Math.hypot(dx, dz) * 80));
    for (const k of keys) await p.keyboard.up(k);
    if (side && Math.random() < 0.5) side = 0;
  }
  throw new Error(`could not reach (${tx.toFixed(1)}, ${tz.toFixed(1)})`);
}

async function chopTree(p) {
  const tree = await nearestTree(p);
  assert(tree, 'no tree within 120 m of the player');
  const before = (await snap(p)).inv.wood ?? 0;
  await walkTo(p, tree.x, tree.z, () =>
    p.evaluate((id) => {
      const t = window.__world.world.interactTarget();
      return t?.type === 'node' && t.node.id === id;
    }, tree.id),
  );
  await p.keyboard.press('e');
  const end = Date.now() + 60000;
  let s;
  while (Date.now() < end) {
    s = await snap(p);
    if ((s.inv.wood ?? 0) >= before + 3) return s;
    if (!s.gathering) await p.keyboard.press('e'); // e.g. nudged by a frame-late key release
    await sleep(500);
  }
  throw new Error(`tree not felled: wood ${s.inv.wood}`);
}

console.log(`Open-world page test against ${BASE}`);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await cspProbe(desktop);
const pg = await desktop.newPage();
const problems = watch(pg);

await step('page loads under the strict policy and shows the start screen', async () => {
  await pg.goto(BASE + '/');
  await pg.waitForSelector('#screen-start.visible', { timeout: 180000 });
  assert(await pg.isHidden('#continue-box'), 'no saved hero yet');
  const csp = await pg.evaluate(() => window.__csp);
  assert(csp.length === 0 && problems.length === 0, [...csp, ...problems].join('\n'));
});

await step('start a new hero and enter the island', async () => {
  await pg.fill('#hero-name', 'Tester');
  await pg.$eval('.class-card[data-class=knight]', (b) => b.click());
  await pg.$eval('#new-form', (f) => f.requestSubmit());
  await pg.waitForSelector('#hud:not(.hidden)', { timeout: 60000 });
  const s = await snap(pg);
  const ruins = await pg.evaluate(() => window.__world.world.gen.ruins.length);
  assert(s.alive && s.hp === 140, JSON.stringify(s));
  assert(ruins >= 6, `only ${ruins} ruins generated`);
  return `${ruins} ruins, ${await pg.evaluate(() => window.__world.world.enemies.size)} skeletons`;
});

await step('walk to a tree and chop it (+3 wood, woodcutting XP)', async () => {
  const s = await chopTree(pg);
  assert(s.xp.woodcutting > 0, 'no woodcutting XP');
  await pg.screenshot({ path: join(out, 'world-chop.png') });
  return `wood=${s.inv.wood}, woodcutting xp=${s.xp.woodcutting}, at (${s.x.toFixed(0)}, ${s.z.toFixed(0)})`;
});

await step('chop a second tree', async () => {
  const s = await chopTree(pg);
  return `wood=${s.inv.wood}`;
});

await step('craft two planks from the crafting panel', async () => {
  await pg.keyboard.press('c');
  await pg.waitForSelector('#panel-crafting:not(.hidden)');
  for (let i = 0; i < 2; i++) await pg.$eval('#craft-list .entry:first-child button', (b) => b.click());
  const s = await snap(pg);
  assert(s.inv.plank === 2, `planks=${s.inv.plank}`);
  await pg.keyboard.press('Escape');
  return `planks=${s.inv.plank}, wood left=${s.inv.wood}`;
});

await step('build a wooden fence through the build panel', async () => {
  await pg.keyboard.press('b');
  await pg.waitForSelector('#panel-build:not(.hidden)');
  const idx = await pg.$$eval('#build-list .entry b', (bs) => bs.findIndex((b) => b.textContent === 'Wooden fence'));
  await pg.$eval(`#build-list .entry:nth-child(${idx + 1}) button`, (b) => b.click());
  await pg.waitForSelector('#build-bar:not([hidden])');
  // turn around until the spot in front of the hero is free
  for (const k of ['s', 'a', 'd', 'w', 's', 'a']) {
    await sleep(800);
    if (await pg.$eval('#btn-place', (b) => !b.disabled)) break;
    await pg.keyboard.down(k);
    await sleep(250);
    await pg.keyboard.up(k);
  }
  const reason = await pg.textContent('#build-text');
  assert(await pg.$eval('#btn-place', (b) => !b.disabled), `cannot place: ${reason}`);
  await pg.$eval('#btn-place', (b) => b.click());
  const s = await snap(pg);
  assert(s.structures === 1 && (s.inv.plank ?? 0) === 0, JSON.stringify(s));
  await pg.screenshot({ path: join(out, 'world-build.png') });
  return `construction xp=${s.xp.construction}`;
});

await step('progress survives a reload (continue)', async () => {
  const before = await snap(pg);
  await pg.evaluate(() => window.__world.world.save());
  await pg.reload();
  await pg.waitForSelector('#screen-start.visible', { timeout: 180000 });
  assert(await pg.isVisible('#continue-box'), 'continue box shown');
  await pg.$eval('#btn-continue', (b) => b.click());
  await pg.waitForSelector('#hud:not(.hidden)');
  const s = await snap(pg);
  assert(s.structures === 1, `structures=${s.structures}`);
  assert(s.xp.woodcutting === before.xp.woodcutting && (s.inv.wood ?? 0) === (before.inv.wood ?? 0), 'inventory/xp kept');
  assert(Math.hypot(s.x - before.x, s.z - before.z) < 2, 'position kept');
  return `wood=${s.inv.wood}, structures=${s.structures}`;
});

await step('no errors or CSP violations on desktop', async () => {
  const csp = await pg.evaluate(() => window.__csp);
  assert(csp.length === 0 && problems.length === 0, [...csp, ...problems].join('\n'));
});
await desktop.close();

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await cspProbe(mobile);
const mp = await mobile.newPage();
const mproblems = watch(mp);
await step('phone: joystick moves the hero, the ✋ button gathers', async () => {
  await mp.goto(BASE + '/');
  await mp.waitForSelector('#screen-start.visible', { timeout: 180000 });
  await mp.fill('#hero-name', 'Phone');
  await mp.$eval('.class-card[data-class=rogue]', (b) => b.click());
  await mp.$eval('#new-form', (f) => f.requestSubmit());
  await mp.waitForSelector('#hud:not(.hidden)');
  const start = await snap(mp);
  const cdp = await mobile.newCDPSession(mp);
  const box = await mp.locator('#joystick').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', cx, cy);
  await touch('touchMove', cx, cy + 60); // south
  await sleep(1200);
  await touch('touchEnd');
  const moved = await snap(mp);
  assert(moved.z > start.z + 1.5, `joystick did not move the hero: ${start.z} → ${moved.z}`);
  // walk to a tree with the keyboard helper (touch emulation still has a keyboard), then tap ✋
  const tree = await nearestTree(mp);
  await walkTo(mp, tree.x, tree.z, () =>
    mp.evaluate((id) => window.__world.world.interactTarget()?.node?.id === id, tree.id),
  );
  await mp.locator('#btn-action').tap();
  const end = Date.now() + 15000;
  let s;
  while (Date.now() < end && !(s = await snap(mp)).gathering && !(s.inv.wood > 0)) await sleep(300);
  assert(s.gathering || s.inv.wood > 0, 'tapping ✋ did not start gathering');
  await mp.screenshot({ path: join(out, 'world-mobile.png') });
  const csp = await mp.evaluate(() => window.__csp);
  assert(csp.length === 0 && mproblems.length === 0, [...csp, ...mproblems].join('\n'));
  return `moved ${(moved.z - start.z).toFixed(1)} m, gathering started`;
});

await browser.close();
server.close();
console.log(`\n${passed}/${passed + failed} steps passed.`);
process.exit(failed ? 1 : 0);
