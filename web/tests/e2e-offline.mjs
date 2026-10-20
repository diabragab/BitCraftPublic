// Browser test for the single-player arena page (npm run build:offline), served under a strict
// content-security policy like claude.ai's (no eval, no fetch of blob: URLs). Usage: node tests/e2e-offline.mjs
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
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' };

// The arena page of the single-player build (artifact.html is the open world; see e2e-world.mjs).
const page = readFileSync(join(root, 'index.html'), 'utf8');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  res.setHeader('content-security-policy', CSP);
  if (path === '/' || path === '/index.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (path === '/favicon.ico') return res.writeHead(204).end(); // the host page supplies the tab icon
  const file = normalize(join(root, decodeURIComponent(path)));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const results = [];
async function step(name, fn) {
  try {
    const detail = await fn();
    results.push(name);
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  ✖ ${name} — ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = (p) => p.evaluate(() => window.__arena.game.snapshot());
async function waitFor(p, pred, timeout, what) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await snap(p);
    if (pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}; last=${JSON.stringify(last?.me)}`);
}
function watch(p) {
  const problems = [];
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()} @ ${m.location()?.url ?? ''}`));
  p.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.url()}`));
  return problems;
}
async function addCspProbe(context) {
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

console.log(`Single-player page test against ${BASE} (CSP: ${CSP})`);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await addCspProbe(desktop);
const pg = await desktop.newPage();
const problems = watch(pg);

await step('page loads under the strict policy and shows the hero-name prompt', async () => {
  await pg.goto(BASE + '/');
  await pg.waitForSelector('#screen-login.visible', { timeout: 120000 });
  assert(await pg.isHidden('#password'), 'password field should be hidden in single-player');
  assert((await pg.textContent('#login-submit')).trim() === 'Play', 'button says Play');
  assert((await pg.textContent('#server-status')).includes('browser'), 'status explains single-player');
  const csp = await pg.evaluate(() => window.__csp);
  assert(csp.length === 0, `CSP violations: ${csp.join(', ')}`);
  assert(problems.length === 0, problems.join('\n'));
  await pg.screenshot({ path: join(out, 'offline-login.png') });
});

await step('enter a name, pick Knight, the world and skeletons are there', async () => {
  await pg.fill('#username', 'Tester');
  await pg.$eval('#login-form', (f) => f.requestSubmit());
  await pg.waitForSelector('#screen-select.visible');
  await pg.$eval('.class-card[data-class=knight]', (b) => b.click());
  await pg.$eval('#enter-button', (b) => b.click());
  await pg.waitForSelector('#hud:not(.hidden)');
  const s = await waitFor(pg, (x) => x.me?.alive, 5000, 'hero');
  assert(s.enemies.length === 14 && s.pickups === 10, `enemies=${s.enemies.length} pickups=${s.pickups}`);
  assert((await pg.textContent('#conn-pill')).includes('Single-player'), 'status pill');
  return `spawned at (${s.me.x}, ${s.me.z})`;
});

await step('movement and wall collision are simulated in the browser', async () => {
  const before = await snap(pg);
  await pg.keyboard.down('w');
  await sleep(1500);
  await pg.keyboard.up('w');
  const after = await waitFor(pg, (s) => s.me.z < before.me.z - 2, 4000, 'moving north');
  return `z ${before.me.z.toFixed(1)} → ${after.me.z.toFixed(1)}`;
});

await step('combat: kill a skeleton, gold is awarded', async () => {
  await pg.keyboard.down('d');
  await sleep(1000);
  await pg.keyboard.up('d');
  const t0 = Date.now();
  let s = await snap(pg);
  let lastPos = null;
  let lastStepped = false;
  while (Date.now() - t0 < 45000) {
    await pg.keyboard.press(' ');
    await sleep(350);
    s = await snap(pg);
    if (s.me.kills > 0) break;
    const e = s.enemies.filter((x) => x.alive).sort((a, b) => Math.hypot(a.x - s.me.x, a.z - s.me.z) - Math.hypot(b.x - s.me.x, b.z - s.me.z))[0];
    const d = e && Math.hypot(e.x - s.me.x, e.z - s.me.z);
    if (e && d > 2.0 && d < 14) {
      const major = Math.abs(e.x - s.me.x) > Math.abs(e.z - s.me.z);
      const blocked = lastPos && Math.hypot(lastPos.x - s.me.x, lastPos.z - s.me.z) < 0.2 && lastStepped;
      const k = major !== !!blocked ? (e.x > s.me.x ? 'd' : 'a') : e.z > s.me.z ? 's' : 'w';
      lastPos = { x: s.me.x, z: s.me.z };
      lastStepped = true;
      await pg.keyboard.down(k);
      await sleep(300);
      await pg.keyboard.up(k);
    } else {
      lastStepped = false;
    }
  }
  assert(s.me.kills > 0 && s.me.gold > 0, `no kill: ${JSON.stringify(s.me)}`);
  await pg.screenshot({ path: join(out, 'offline-combat.png') });
  return `kills=${s.me.kills} gold=${s.me.gold} hp=${s.me.hp}`;
});

await step('progress is remembered after a reload', async () => {
  const kills = (await snap(pg)).me.kills;
  await pg.reload();
  await pg.waitForSelector('#screen-select.visible', { timeout: 120000 });
  await pg.waitForSelector('.class-card.selected[data-class=knight]', { timeout: 5000 });
  await pg.$eval('#enter-button', (b) => b.click());
  await pg.waitForSelector('#hud:not(.hidden)');
  const s = await waitFor(pg, (x) => x.me?.alive, 5000, 'hero after reload');
  assert(s.me.kills === kills && s.me.username === 'Tester', `kills ${s.me.kills} vs ${kills}`);
  return `name and ${kills} kill(s) kept`;
});

await step('no errors or CSP violations during desktop play', async () => {
  const csp = await pg.evaluate(() => window.__csp);
  assert(csp.length === 0, `CSP violations: ${csp.join(', ')}`);
  assert(problems.length === 0, problems.join('\n'));
});
await desktop.close();

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await addCspProbe(mobile);
const mp = await mobile.newPage();
const mproblems = watch(mp);
await step('phone: joystick moves the hero and the attack button attacks', async () => {
  await mp.goto(BASE + '/');
  await mp.waitForSelector('#screen-login.visible', { timeout: 120000 });
  await mp.fill('#username', 'Phone');
  await mp.$eval('#login-form', (f) => f.requestSubmit());
  await mp.waitForSelector('#screen-select.visible');
  await mp.$eval('.class-card[data-class=rogue]', (b) => b.click());
  await mp.$eval('#enter-button', (b) => b.click());
  await mp.waitForSelector('#hud:not(.hidden)');
  const before = await waitFor(mp, (x) => x.me?.alive, 5000, 'hero');
  const box = await mp.locator('#joystick').boundingBox();
  const cdp = await mobile.newCDPSession(mp);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await touch('touchStart', cx, cy);
  await touch('touchMove', cx, cy - 60);
  await sleep(1200);
  await touch('touchEnd');
  const moved = await waitFor(mp, (s) => s.me.z < before.me.z - 1.5, 4000, 'joystick movement');
  await mp.locator('#btn-attack').tap();
  const attacked = await waitFor(mp, (s) => s.me.attackSeq > moved.me.attackSeq, 4000, 'attack');
  await mp.screenshot({ path: join(out, 'offline-mobile.png') });
  const csp = await mp.evaluate(() => window.__csp);
  assert(csp.length === 0 && mproblems.length === 0, [...csp, ...mproblems].join('\n'));
  return `z ${before.me.z.toFixed(1)} → ${moved.me.z.toFixed(1)}, attack_seq ${attacked.me.attackSeq}`;
});

await browser.close();
server.close();
console.log(`\n${results.length}/${results.length + failed} steps passed.`);
process.exit(failed ? 1 : 0);
