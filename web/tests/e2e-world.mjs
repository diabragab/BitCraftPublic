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

async function chopTree(p, onTarget) {
  const tree = await nearestTree(p);
  assert(tree, 'no tree within 120 m of the player');
  const before = (await snap(p)).inv.wood ?? 0;
  await walkTo(p, tree.x, tree.z, () =>
    p.evaluate((id) => {
      const t = window.__world.world.interactTarget();
      return t?.type === 'node' && t.node.id === id;
    }, tree.id),
  );
  // the HUD refreshes the highlight on its next frame, and software-rendered frames are slow
  if (onTarget) for (let i = 0; i < 10; i++) if (await onTarget()) break; else await sleep(500);
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
  // a real (trusted) click: browsers only allow sound after a user gesture
  await pg.click('#btn-new', { timeout: 60000 });
  await pg.waitForSelector('#hud:not(.hidden)', { timeout: 60000 });
  const s = await snap(pg);
  const ruins = await pg.evaluate(() => window.__world.world.gen.ruins.length);
  assert(s.alive && s.hp === 140, JSON.stringify(s));
  assert(ruins >= 6, `only ${ruins} ruins generated`);
  return `${ruins} ruins, ${await pg.evaluate(() => window.__world.world.enemies.size)} skeletons`;
});

await step('sound: the Play click starts the audio and the music plays', async () => {
  const a0 = await pg.evaluate(() => ({ running: window.__world.audio.running, ...window.__world.audio.stats }));
  assert(a0.started && a0.running, `audio not running: ${JSON.stringify(a0)}`);
  await sleep(3000);
  const a1 = await pg.evaluate(() => window.__world.audio.stats);
  assert(a1.notes > a0.notes, `no music notes scheduled (${a0.notes} → ${a1.notes})`);
  return `AudioContext running, ${a1.notes} music notes scheduled, ${a1.sfx} effects so far`;
});

await step('walk to a tree and chop it (+3 wood, woodcutting XP, outline, chop sounds)', async () => {
  const sfx0 = await pg.evaluate(() => window.__world.audio.stats.sfx);
  let outlined = 0;
  const s = await chopTree(pg, async () => {
    outlined = Math.max(outlined, await pg.evaluate(() => window.__world.renderer.outline.group.children.length));
    return outlined > 0;
  });
  assert(s.xp.woodcutting > 0, 'no woodcutting XP');
  assert(outlined > 0, 'the targeted tree was not outlined');
  const sfx = (await pg.evaluate(() => window.__world.audio.stats.sfx)) - sfx0;
  assert(sfx >= 3, `only ${sfx} sound effects while walking and chopping`);
  await pg.screenshot({ path: join(out, 'world-chop.png') });
  return `wood=${s.inv.wood}, woodcutting xp=${s.xp.woodcutting}, outline parts=${outlined}, ${sfx} sound effects`;
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
  // the button reflects the last rendered frame; at software-rendering frame rates the hero may
  // have drifted since, and the game then refuses the spot. Try again on the next frame.
  let s;
  for (let i = 0; i < 4; i++) {
    if (await pg.$eval('#btn-place', (b) => !b.disabled)) await pg.$eval('#btn-place', (b) => b.click());
    await sleep(1200);
    if ((s = await snap(pg)).structures === 1) break;
  }
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
  await pg.click('#btn-continue', { timeout: 60000 });
  await pg.waitForSelector('#hud:not(.hidden)');
  const s = await snap(pg);
  assert(s.structures === 1, `structures=${s.structures}`);
  assert(s.xp.woodcutting === before.xp.woodcutting && (s.inv.wood ?? 0) === (before.inv.wood ?? 0), 'inventory/xp kept');
  assert(Math.hypot(s.x - before.x, s.z - before.z) < 2, 'position kept');
  return `wood=${s.inv.wood}, structures=${s.structures}`;
});

/** Compiles every material in the scene and returns the custom shader keys that were built. */
const shaderKeys = (p) =>
  p.evaluate(() => {
    const r = window.__world.renderer;
    r.renderer.compile(r.scene, r.camera);
    r.render();
    const keys = new Set();
    for (const prog of r.renderer.info.programs) {
      for (const k of ['wind', 'grass', 'crystal', 'outline', 'dissolve']) if (prog.cacheKey.includes(k)) keys.add(k);
      // hand-written shader materials are keyed by a hash of their source, so match their names
      const named = /^hearthwild-(water|fire)$/.exec(prog.name);
      if (named) keys.add(named[1]);
    }
    return [...keys].sort();
  });

await step('shader effects compile: water, wind, grass, fire, ore glow', async () => {
  // a campfire for the fire shader, next to the fence
  const fire = await pg.evaluate(() => {
    const w = window.__world.world;
    w.player.inv.wood = (w.player.inv.wood ?? 0) + 5;
    w.player.inv.stone = (w.player.inv.stone ?? 0) + 3;
    for (let a = 0; a < 16; a++) {
      const x = w.player.x + Math.sin(a) * 4;
      const z = w.player.z + Math.cos(a) * 4;
      if (!w.placementProblem('campfire', x, z)) return w.build('campfire', x, z, 0) ?? 'built';
    }
    return 'no free spot';
  });
  assert(fire === 'built', `campfire: ${fire}`);
  const grass = await pg.evaluate(() => window.__world.renderer.grass?.count ?? 0);
  assert(grass > 100, `only ${grass} grass tufts around the player`);
  let keys = await shaderKeys(pg);
  for (const k of ['fire', 'grass', 'water', 'wind']) assert(keys.includes(k), `${k} shader not built (built: ${keys})`);
  await pg.screenshot({ path: join(out, 'world-shaders.png') });
  // iron only grows on mountains: move the hero next to the nearest vein to see the ore glow
  const iron = await pg.evaluate(() => {
    const w = window.__world.world;
    const n = w.nodesNear(w.player.x, w.player.z, 400).find((x) => x.kind === 'iron' && !w.isDepleted(x.id));
    if (!n) return null;
    w.player.x = n.x + 2.5;
    w.player.z = n.z + 2.5;
    return { x: n.x, z: n.z };
  });
  assert(iron, 'no iron vein within 400 m');
  const end = Date.now() + 60000;
  while (Date.now() < end && !(keys = await shaderKeys(pg)).includes('crystal')) await sleep(1000);
  assert(keys.includes('crystal'), `ore glow not built (built: ${keys})`);
  await pg.screenshot({ path: join(out, 'world-iron.png') });
  return `${grass} grass tufts; built: ${keys.join(', ')}`;
});

await step('a slain skeleton burns away (dissolve shader) with its death sound', async () => {
  const sfx0 = await pg.evaluate(() => window.__world.audio.stats.sfx);
  // stage a kill next to the hero through the simulation's own methods
  await pg.evaluate(() => {
    const w = window.__world.world;
    w.addEnemy('minion', 1, w.player.x + 3, w.player.z + 3, w.gen.ruins[0].id);
    const e = [...w.enemies.values()].at(-1);
    w.killEnemy(e);
  });
  const end = Date.now() + 30000;
  let dissolving = false;
  while (Date.now() < end && !dissolving) {
    await sleep(1000);
    dissolving = (await shaderKeys(pg)).includes('dissolve');
  }
  assert(dissolving, 'no dissolve material on the fallen skeleton');
  await pg.screenshot({ path: join(out, 'world-dissolve.png') });
  const sfx = (await pg.evaluate(() => window.__world.audio.stats.sfx)) - sfx0;
  assert(sfx >= 1, 'no sound for the kill');
  return `dissolve shader active, ${sfx} sound effect(s)`;
});

/** Test setup only: moves the hero, alive and healed, next to a village station (crafting needs one nearby). */
async function toStation(p, station) {
  // earlier steps fight near a ruin; wait out a respawn so it cannot move the hero afterwards
  const end = Date.now() + 15000;
  while (Date.now() < end && !(await snap(p)).alive) await sleep(500);
  await p.evaluate((station) => {
    const w = window.__world.world;
    const s = w.gen.village.find((v) => v.station === station);
    w.player.x = s.x + 3;
    w.player.z = s.z + 3;
    w.player.hp = w.maxHp();
  }, station);
}
/** Test setup only: waits out a respawn, then puts the hero, healed, at (x, z) facing north. */
async function readyHero(p, x, z) {
  const end = Date.now() + 15000;
  while (Date.now() < end && !(await snap(p)).alive) await sleep(500);
  await p.evaluate(({ x, z }) => {
    const w = window.__world.world;
    w.player.x = x;
    w.player.z = z;
    w.player.facing = 0;
    w.player.hp = w.maxHp();
  }, { x, z });
}
/** Test setup only: a skeleton a few metres in front of the hero, facing it. */
const spawnFoe = (p, kind = 'minion', level = 1, d = 2.2) =>
  p.evaluate(({ kind, level, d }) => {
    const w = window.__world.world;
    const pl = w.player;
    // tied to a ruin: free-roaming skeletons only exist at night
    const e = w.addEnemy(kind, level, pl.x + Math.sin(pl.facing) * d, pl.z + Math.cos(pl.facing) * d, w.gen.ruins[0].id);
    e.engaged = true;
    return e.id;
  }, { kind, level, d });
const enemyState = (p, id) => p.evaluate((id) => {
  const e = window.__world.world.enemies.get(id);
  return e ? { hp: e.hp, maxHp: e.maxHp, alive: e.alive, stunned: e.stunUntil > Date.now() } : null;
}, id);

await step('combat skills: the first skill point learns Shield Bash, key 1 stuns and damages a skeleton', async () => {
  // outside the village so the skeleton fights back; the previous steps fought next to a ruin
  await readyHero(pg, 60, 40);
  await sleep(1500);
  const points = (await snap(pg)).points;
  assert(points >= 1, `no skill point at combat level 1 (${points})`);
  await pg.keyboard.press('k');
  await pg.waitForSelector('#panel-skills:not(.hidden)');
  await pg.$eval('#ability-list .entry:first-child button', (b) => b.click());
  assert((await snap(pg)).skills.shield_bash === 1, 'Shield Bash not learned');
  await pg.keyboard.press('Escape');
  const id = await spawnFoe(pg, 'warrior', 1, 2);
  await sleep(800);
  const before = await enemyState(pg, id);
  const sfx0 = await pg.evaluate(() => window.__world.audio.stats.sfx);
  await pg.keyboard.press('1');
  await sleep(600);
  const after = await enemyState(pg, id);
  assert(after && after.hp < before.hp, `skill did no damage: ${before.hp} → ${after?.hp}`);
  assert(after.stunned || !after.alive, 'skeleton not stunned');
  // the HUD shows the cooldown on its next frame (software rendering is slow)
  let cd = '';
  for (let i = 0; i < 10 && !cd; i++) {
    cd = await pg.$eval('#hotbar .hot[data-slot="0"] .cd', (el) => el.textContent);
    if (!cd) await sleep(400);
  }
  assert(cd !== '', 'hotbar shows no cooldown');
  const sfx = (await pg.evaluate(() => window.__world.audio.stats.sfx)) - sfx0;
  await pg.screenshot({ path: join(out, 'world-skill.png') });
  await pg.evaluate((id) => {
    const w = window.__world.world;
    const e = w.enemies.get(id);
    if (e?.alive) w.killEnemy(e); // clean up so it cannot steal the aim in later steps
  }, id);
  return `hp ${before.hp} → ${after.hp}, stunned, cooldown ${cd}s on the hotbar, ${sfx} sound effects`;
});

await step('action: Shift rolls the hero forward and makes it untouchable for a moment', async () => {
  const before = await snap(pg);
  await pg.keyboard.press('Shift');
  const inv = await pg.evaluate(() => window.__world.world.player.invulnUntil - Date.now());
  await sleep(1000);
  const after = await snap(pg);
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  assert(inv > 0, 'no invulnerability window');
  assert(moved > 3, `rolled only ${moved.toFixed(2)} m`);
  const cd = await pg.evaluate(() => window.__world.world.dodgeCooldownLeft());
  return `rolled ${moved.toFixed(1)} m, untouchable for ${inv} ms, cooldown ${cd} ms left`;
});

await step('action: three quick attacks chain into a finisher that knocks the skeleton back', async () => {
  const id = await spawnFoe(pg, 'warrior', 2, 2);
  await sleep(1200);
  // Three attacks in one call: with software rendering a frame blocks the page for about a
  // second, longer than the combo window, so key presses here cannot be spaced like a player's.
  // (Space-bar attacks through the real input path are covered by the pet step.)
  const r = await pg.evaluate((id) => {
    const w = window.__world.world;
    const e = w.enemies.get(id);
    const p = w.player;
    const face = () => Math.atan2(e.x - p.x, e.z - p.z);
    const out = [];
    for (let i = 0; i < 3; i++) {
      const d0 = Math.hypot(e.x - p.x, e.z - p.z);
      p.lastAttack = 0; // test only: skip the cooldown wait
      w.attack(face());
      out.push({ combo: p.combo, before: d0, after: Math.hypot(e.x - p.x, e.z - p.z), alive: e.alive });
    }
    return out;
  }, id);
  const fin = r[2];
  assert(r.map((x) => x.combo).join() === '0,1,2', `combo steps ${r.map((x) => x.combo)}`);
  assert(!fin.alive || fin.after - fin.before > 0.7, `not knocked back: ${fin.before.toFixed(2)} → ${fin.after.toFixed(2)} m`);
  assert(r[0].after - r[0].before < 0.3, 'a normal hit should not knock back');
  await sleep(800);
  await pg.screenshot({ path: join(out, 'world-combo.png') });
  await pg.evaluate((id) => {
    const w = window.__world.world;
    const e = w.enemies.get(id);
    if (e?.alive) w.killEnemy(e);
  }, id);
  return `combo 0 → 1 → 2; the finisher pushed it from ${fin.before.toFixed(1)} m to ${fin.after.toFixed(1)} m`;
});

await step('gear: craft a bone blade at the workbench, equip it, damage goes up', async () => {
  await toStation(pg, 'workbench');
  await pg.evaluate(() => {
    const inv = window.__world.world.player.inv;
    inv.bone = (inv.bone ?? 0) + 6;
    inv.plank = (inv.plank ?? 0) + 1;
  });
  const dmg0 = (await snap(pg)).damage;
  await pg.keyboard.press('c');
  await pg.waitForSelector('#panel-crafting:not(.hidden)');
  const idx = await pg.$$eval('#craft-list .entry b', (bs) => bs.findIndex((b) => b.textContent.startsWith('Bone blade')));
  assert(idx >= 0, 'no bone blade recipe');
  await pg.$eval(`#craft-list .entry:nth-child(${idx + 1}) button`, (b) => b.click());
  await pg.keyboard.press('Escape');
  assert((await snap(pg)).gear >= 1, 'no gear crafted');
  await pg.keyboard.press('g');
  await pg.waitForSelector('#panel-gear:not(.hidden)');
  await pg.$eval('#gear-bag button', (b) => b.click());
  await pg.$eval('#gear-detail .row button.primary', (b) => b.click());
  const s = await snap(pg);
  assert(s.equipped.weapon, 'nothing equipped');
  assert(s.damage > dmg0, `damage did not go up: ${dmg0} → ${s.damage}`);
  await pg.screenshot({ path: join(out, 'world-gear.png') });
  await pg.keyboard.press('Escape');
  return `damage per hit ${Math.round(dmg0)} → ${Math.round(s.damage)}`;
});

await step('pets: bond a Skeleton Squire; it follows, fights, gains XP and learns Taunt', async () => {
  await toStation(pg, 'workbench');
  await pg.evaluate(() => {
    const inv = window.__world.world.player.inv;
    inv.bone = (inv.bone ?? 0) + 8;
    inv.plank = (inv.plank ?? 0) + 2;
  });
  await pg.keyboard.press('c');
  await pg.waitForSelector('#panel-crafting:not(.hidden)');
  const idx = await pg.$$eval('#craft-list .entry b', (bs) => bs.findIndex((b) => b.textContent.startsWith('Bound skull')));
  await pg.$eval(`#craft-list .entry:nth-child(${idx + 1}) button`, (b) => b.click());
  await pg.keyboard.press('Escape');
  assert((await snap(pg)).inv.bone_charm === 1, 'bound skull not crafted');
  await pg.keyboard.press('p');
  await pg.waitForSelector('#panel-pets:not(.hidden)');
  await pg.$eval('#pet-list .pet-card:first-child .actions button.primary', (b) => b.click());
  let s = await snap(pg);
  assert(s.pet?.species === 'squire', `no pet: ${JSON.stringify(s.pet)}`);
  await pg.keyboard.press('Escape');
  // it follows: walk away and check it keeps up
  await pg.evaluate(() => {
    const w = window.__world.world;
    w.player.x = 60;
    w.player.z = 40;
  });
  const end = Date.now() + 20000;
  while (Date.now() < end && Math.hypot((s = await snap(pg)).pet.x - s.x, s.pet.z - s.z) > 4) await sleep(500);
  assert(Math.hypot(s.pet.x - s.x, s.pet.z - s.z) <= 4, 'pet did not follow');
  // it fights: a skeleton in front of you, attacked by you and the pet
  const id = await spawnFoe(pg, 'warrior', 1, 2.5);
  const xp0 = s.pet.xp;
  const until = Date.now() + 40000;
  let petHits = 0;
  while (Date.now() < until && (await enemyState(pg, id))?.alive) {
    petHits = await pg.evaluate(() => window.__world.world.pet()?.attackSeq ?? 0);
    await pg.keyboard.press(' ');
    await sleep(400);
  }
  assert(!(await enemyState(pg, id))?.alive, 'skeleton survived');
  assert(petHits > 0, 'the pet never attacked');
  s = await snap(pg);
  assert(s.pet.xp > xp0, 'pet gained no XP from the kill');
  // its first skill point learns Taunt from the pets panel
  await pg.keyboard.press('p');
  await pg.waitForSelector('#panel-pets:not(.hidden)');
  await pg.$$eval('#pet-list .pet-card:first-child .actions button', (bs) => bs.find((b) => b.textContent.startsWith('Skills')).click());
  await pg.$eval('#pet-list .pet-card:first-child .skills .entry:first-child button', (b) => b.click());
  const taunt = await pg.evaluate(() => window.__world.world.pet().skills.taunt ?? 0);
  assert(taunt === 1, 'Taunt not learned');
  await pg.screenshot({ path: join(out, 'world-pets.png') });
  await pg.keyboard.press('Escape');
  return `pet attacked ${petHits}×, pet XP ${xp0} → ${s.pet.xp}, Taunt learned`;
});

await step('HDR: the scene renders through a half-float target with bloom', async () => {
  const r = await pg.evaluate(() => {
    const rr = window.__world.renderer;
    return { bloom: rr.bloomEnabled && rr.bloom.enabled, type: rr.composer.renderTarget1.texture.type, passes: rr.composer.passes.length };
  });
  assert(r.bloom && r.type === 1016 && r.passes === 3, JSON.stringify(r)); // 1016 = THREE.HalfFloatType
  return 'half-float target, render + bloom + tone-mapping passes';
});

await step('skills, gear and pet survive a reload', async () => {
  const before = await snap(pg);
  await pg.evaluate(() => window.__world.world.save());
  await pg.reload();
  await pg.waitForSelector('#screen-start.visible', { timeout: 180000 });
  await pg.click('#btn-continue', { timeout: 60000 });
  await pg.waitForSelector('#hud:not(.hidden)');
  const s = await snap(pg);
  assert(s.skills.shield_bash === 1, 'skill rank lost');
  assert(s.equipped.weapon === before.equipped.weapon, 'equipped weapon lost');
  assert(s.pet?.species === 'squire' && s.pet.xp === before.pet.xp, `pet lost: ${JSON.stringify(s.pet)}`);
  const taunt = await pg.evaluate(() => window.__world.world.pet().skills.taunt ?? 0);
  assert(taunt === 1, 'pet skill lost');
  return `skills ${JSON.stringify(s.skills)}, weapon kept, ${s.pet.species} with ${s.pet.xp} XP and Taunt`;
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
await step('phone: joystick moves the hero, the ✋ button gathers, a skill button casts', async () => {
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
  // skill buttons: learn the first skill, tap its button
  await mp.evaluate(() => window.__world.world.learnSkill(window.__world.world.classSkills()[0].id));
  await sleep(500);
  await mp.locator('#hotbar .hot[data-slot="0"]').tap();
  await sleep(500);
  const cdLeft = await mp.evaluate(() => window.__world.world.cooldownLeft(window.__world.world.classSkills()[0].id));
  assert(cdLeft > 0, 'tapping the skill button did not cast it');
  await mp.screenshot({ path: join(out, 'world-mobile.png') });
  const csp = await mp.evaluate(() => window.__csp);
  assert(csp.length === 0 && mproblems.length === 0, [...csp, ...mproblems].join('\n'));
  return `moved ${(moved.z - start.z).toFixed(1)} m, gathering started, skill button cast Shadowstep`;
});

await browser.close();
server.close();
console.log(`\n${passed}/${passed + failed} steps passed.`);
process.exit(failed ? 1 : 0);
