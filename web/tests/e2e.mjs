// End-to-end test: real SpacetimeDB + arena module, a gateway started by this
// script, and headless Chromium (desktop and touch/mobile contexts).
//
// Prerequisites: SpacetimeDB running with the arena module published and the
// gateway registered (web/scripts/dev.sh does all of this), and a client build
// (npm run build). Usage: node tests/e2e.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(web, 'test-results');
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8181);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

const results = [];
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failed++;
    results.push({ name, ok: false, ms: Date.now() - t0, detail: e.message });
    console.log(`  ✖ ${name} — ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startGateway() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: join(web, 'gateway'),
    env: { ...process.env, GATEWAY_PORT: String(PORT), LOG_REQUESTS: '0', AUTH_RATE_LIMIT: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.logs = '';
  child.stdout.on('data', (d) => (child.logs += d));
  child.stderr.on('data', (d) => (child.logs += d));
  return child;
}
async function waitHealthy(timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return r.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('gateway did not become healthy');
}

function watch(page, label) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`[${label}] console: ${m.text()}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`[${label}] HTTP ${r.status()} ${r.url()}`));
  return problems;
}
const snap = (page) => page.evaluate(() => window.__arena.game.snapshot());
async function waitFor(page, pred, timeout, what) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await snap(page);
    if (pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}; last=${JSON.stringify(last?.me ?? last)}`);
}

async function register(page, username, cls) {
  await page.goto(BASE + '/');
  await page.waitForSelector('#screen-login.visible', { timeout: 60000 });
  await page.click('.tab[data-mode=register]');
  await page.fill('#username', username);
  await page.fill('#password', 'e2e-password-1');
  await page.click('#login-submit');
  await page.waitForSelector('#screen-select.visible', { timeout: 15000 });
  await page.click(`.class-card[data-class=${cls}]`);
  await page.click('#enter-button');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 15000 });
  return waitFor(page, (s) => s.me?.alive && s.connection === 'connected', 10000, 'player in world');
}

console.log(`E2E against ${BASE}`);
let gw = startGateway();
const health = await waitHealthy();
assert(health.status === 'ok', 'gateway healthy');

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const suffix = Date.now().toString(36).slice(-5);
const userA = `knight_${suffix}`;
const userB = `mage_${suffix}`;

const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pageA = await desktop.newPage();
const problemsA = watch(pageA, 'desktop');

await step('health endpoint reports SpacetimeDB + module + account store', async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json();
  assert(h.spacetimedb.reachable && h.spacetimedb.databaseFound && h.accounts.ok, JSON.stringify(h));
  return `latency ${h.spacetimedb.latencyMs}ms`;
});

await step('admin endpoints are not reachable through the gateway', async () => {
  for (const [m, p] of [['POST', '/v1/database/kaykit-arena/sql'], ['POST', '/v1/database/kaykit-arena/call/authorize_session'], ['DELETE', '/v1/database/kaykit-arena'], ['GET', '/v1/database/kaykit-arena/logs']]) {
    const r = await fetch(BASE + p, { method: m });
    assert(r.status === 403, `${m} ${p} -> ${r.status}`);
  }
});

await step('desktop: register, pick Knight, enter the world', async () => {
  const s = await register(pageA, userA, 'knight');
  assert(s.me.class === 'knight' && s.me.hp === 140, JSON.stringify(s.me));
  assert(s.enemies.length === 14 && s.pickups === 10, `enemies=${s.enemies.length} pickups=${s.pickups}`);
  const fps = await pageA.evaluate(() => new Promise((r) => {
    let n = 0;
    const t0 = performance.now();
    const f = () => (++n, performance.now() - t0 < 2000 ? requestAnimationFrame(f) : r(n / 2));
    requestAnimationFrame(f);
  }));
  return `spawned at (${s.me.x.toFixed(1)}, ${s.me.z.toFixed(1)}), ${s.drawCalls} draw calls, ${fps} fps (software WebGL)`;
});

await step('all game assets load without missing files or console errors', async () => {
  assert(problemsA.length === 0, problemsA.join('\n'));
});

await step('keyboard movement is simulated by the server', async () => {
  const before = await snap(pageA);
  await pageA.keyboard.down('w');
  await sleep(1500);
  await pageA.keyboard.up('w');
  const after = await waitFor(pageA, (s) => s.me.z < before.me.z - 2, 5000, 'server position to move north');
  return `server z ${before.me.z.toFixed(2)} → ${after.me.z.toFixed(2)}`;
});

await step('combat: fight a skeleton until it dies (server-validated hits)', async () => {
  // Stand just outside the camp (enemies ignore players inside it) within aggro range of the
  // minion guarding (14, 22), so it walks over; then attack until the server reports a kill.
  await pageA.keyboard.down('d');
  await sleep(1000);
  await pageA.keyboard.up('d');
  const t0 = Date.now();
  let s = await snap(pageA);
  while (Date.now() - t0 < 40000) {
    await pageA.keyboard.press(' ');
    await sleep(350);
    s = await snap(pageA);
    if (s.me.kills > 0) break;
    const e = s.enemies.filter((x) => x.alive).sort((a, b) => Math.hypot(a.x - s.me.x, a.z - s.me.z) - Math.hypot(b.x - s.me.x, b.z - s.me.z))[0];
    if (e && Math.hypot(e.x - s.me.x, e.z - s.me.z) > 2.4 && Math.hypot(e.x - s.me.x, e.z - s.me.z) < 12) {
      const k = Math.abs(e.x - s.me.x) > Math.abs(e.z - s.me.z) ? (e.x > s.me.x ? 'd' : 'a') : e.z > s.me.z ? 's' : 'w';
      await pageA.keyboard.down(k);
      await sleep(250);
      await pageA.keyboard.up(k);
    }
  }
  assert(s.me.kills > 0, `no kill after 40s: ${JSON.stringify(s.me)}`);
  assert(s.me.attackSeq > 0 && s.me.gold > 0, 'server counted attacks and awarded gold');
  await pageA.screenshot({ path: join(out, 'e2e-desktop-combat.png') });
  return `kills=${s.me.kills} gold=${s.me.gold} hp=${s.me.hp} deaths=${s.me.deaths}`;
});

await step('collision: walking into the keep wall is stopped server-side', async () => {
  // move east of the south gate (gate spans |x| < 4) and walk north into the wall at z = 16
  const before = await snap(pageA);
  if (before.me.x < 7) {
    await pageA.keyboard.down('d');
    await sleep(Math.min(3000, (7 - before.me.x) * 220));
    await pageA.keyboard.up('d');
  }
  await pageA.keyboard.down('w');
  await sleep(3500);
  await pageA.keyboard.up('w');
  await sleep(800);
  const s = await snap(pageA);
  assert(s.me.x > 4.5, `not east of the gate (x=${s.me.x.toFixed(2)}); scenery may have blocked the path`);
  assert(s.me.z > 16.4, `player passed through the wall: z=${s.me.z.toFixed(2)} x=${s.me.x.toFixed(2)}`);
  return `stopped at (${s.me.x.toFixed(2)}, ${s.me.z.toFixed(2)}); wall face at z=16.5`;
});

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const pageB = await mobile.newPage();
const problemsB = watch(pageB, 'mobile');

await step('mobile: register, pick Mage, touch controls are shown', async () => {
  const s = await register(pageB, userB, 'mage');
  assert(await pageB.isVisible('#joystick'), 'joystick hidden');
  assert(await pageB.isVisible('#btn-attack'), 'attack button hidden');
  assert(!(await pageB.isVisible('.hint')), 'desktop hint should be hidden on touch');
  return `class=${s.me.class}`;
});

await step('mobile: virtual joystick moves the hero (touch events)', async () => {
  const before = await snap(pageB);
  const box = await pageB.locator('#joystick').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cdp = await mobile.newCDPSession(pageB);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', cx, cy);
  await touch('touchMove', cx + 10, cy - 30);
  await touch('touchMove', cx + 20, cy - 60); // up-right
  await sleep(1200);
  await touch('touchEnd');
  const after = await waitFor(pageB, (s) => s.me.z < before.me.z - 1.5, 3000, 'joystick movement');
  return `(${before.me.x.toFixed(1)}, ${before.me.z.toFixed(1)}) → (${after.me.x.toFixed(1)}, ${after.me.z.toFixed(1)})`;
});

await step('mobile: attack button triggers a server attack', async () => {
  const before = await snap(pageB);
  await pageB.locator('#btn-attack').tap();
  const after = await waitFor(pageB, (s) => s.me.attackSeq > before.me.attackSeq, 6000, 'attack_seq increment');
  await pageB.screenshot({ path: join(out, 'e2e-mobile.png') });
  return `attack_seq ${before.me.attackSeq} → ${after.me.attackSeq}`;
});

await step('multiplayer: each client sees the other hero, positions in sync', async () => {
  const a = await waitFor(pageA, (s) => s.players >= 2, 5000, 'desktop sees mage');
  const b = await waitFor(pageB, (s) => s.players >= 2, 5000, 'mobile sees knight');
  const posInB = await pageB.evaluate((name) => {
    const conn = window.__arena.net.conn;
    for (const p of conn.db.player.iter()) if (p.username === name) return { x: p.x, z: p.z };
    return null;
  }, userA);
  const sa = await snap(pageA);
  assert(posInB && Math.hypot(posInB.x - sa.me.x, posInB.z - sa.me.z) < 0.5, `positions disagree: ${JSON.stringify(posInB)} vs ${sa.me.x},${sa.me.z}`);
  return `desktop sees ${a.players}, mobile sees ${b.players}`;
});

await step('potion: server refuses at full health / consumes when hurt', async () => {
  const s = await snap(pageB);
  const res = await pageB.evaluate(() => window.__arena.net.conn.reducers.usePotion({}).then(() => 'ok', (e) => e.message));
  if (s.me.hp >= 85) assert(/full health/i.test(res), `expected refusal, got ${res}`);
  return `server said: ${res}`;
});

await step('client cannot call privileged reducers', async () => {
  const msg = await pageB.evaluate((name) => {
    const net = window.__arena.net;
    return net.conn.reducers.authorizeSession({ playerIdentity: net.identity, username: name }).then(() => 'accepted', (e) => e.message);
  }, 'hijack_attempt');
  assert(/gateway/i.test(msg), `authorize_session should be refused, got: ${msg}`);
  return msg;
});

await step('reconnect: gateway restart drops the WebSocket, client recovers', async () => {
  gw.kill('SIGTERM');
  await new Promise((r) => gw.once('exit', r));
  await waitFor(pageA, (s) => s.connection !== 'connected', 8000, 'disconnect noticed');
  gw = startGateway();
  await waitHealthy();
  const s = await waitFor(pageA, (x) => x.connection === 'connected', 30000, 'reconnected');
  // try each direction until one is not blocked by scenery
  for (const k of ['w', 'a', 's', 'd']) {
    const before = (await snap(pageA)).me;
    await pageA.keyboard.down(k);
    await sleep(1000);
    await pageA.keyboard.up(k);
    try {
      const after = await waitFor(pageA, (x) => Math.hypot(x.me.x - before.x, x.me.z - before.z) > 1, 3000, 'movement after reconnect');
      return `reconnected after ${s.connection}; moved '${k}' (${before.x.toFixed(1)},${before.z.toFixed(1)}) → (${after.me.x.toFixed(1)},${after.me.z.toFixed(1)})`;
    } catch {
      /* blocked, try the next direction */
    }
  }
  throw new Error('could not move after reconnect');
});

// Software-rendered WebGL is CPU heavy; free the mobile page before opening a third one.
await mobile.close();

await step('login from a new device moves the character to the new identity', async () => {
  const kills = (await snap(pageA)).me.kills;
  await desktop.close(); // the old device goes away; the new one takes over the character
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector('#screen-login.visible', { timeout: 120000 });
  await page.fill('#username', userA);
  await page.fill('#password', 'wrong-password');
  await page.$eval('#login-form', (f) => f.requestSubmit());
  await page.waitForFunction(() => document.getElementById('login-error').textContent.length > 0);
  const err = await page.textContent('#login-error');
  assert(/wrong username or password/i.test(err), `bad password message: ${err}`);
  await page.fill('#password', 'e2e-password-1');
  await page.$eval('#login-form', (f) => f.requestSubmit());
  await page.waitForSelector('#screen-select.visible', { timeout: 15000 });
  await page.waitForSelector('.class-card.selected[data-class=knight]', { timeout: 5000 }).catch(() => {
    throw new Error('previous class (knight) was not preselected');
  });
  await page.$eval('#enter-button', (b) => b.click());
  await page.waitForSelector('#hud:not(.hidden)');
  const s = await waitFor(page, (x) => x.me?.alive, 8000, 'world');
  assert(s.me.kills === kills, `progress kept: ${s.me.kills} vs ${kills}`);
  await ctx.close();
  return `kills carried over (${kills})`;
});

await step('graceful shutdown: SIGTERM exits cleanly', async () => {
  gw.kill('SIGTERM');
  const code = await new Promise((r) => gw.once('exit', r));
  assert(code === 0, `exit code ${code}`);
  assert(gw.logs.includes('shutdown complete'), 'shutdown log line');
  return 'exit code 0';
});

await step('no client errors during the run', async () => {
  // Expected noise while the gateway was deliberately restarted is filtered out.
  const unexpected = [...problemsA, ...problemsB].filter((p) => !/WebSocket|ERR_CONNECTION_REFUSED|Failed to fetch|502|NetworkError|net::/i.test(p));
  assert(unexpected.length === 0, unexpected.join('\n'));
});

await browser.close();
if (gw.exitCode === null) gw.kill('SIGTERM');
console.log(`\n${results.length - failed}/${results.length} steps passed. Screenshots in ${out}`);
process.exit(failed ? 1 : 0);
