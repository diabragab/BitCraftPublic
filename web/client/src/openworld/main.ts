import '../style.css';
import './world.css';
import * as THREE from 'three';
import { loadModels } from '../assets';
import { audio, type Sfx } from '../audio';
import { Bolt, CharacterView, createEnemyView } from '../entities';
import { Input } from '../input';
import { CLASS_IDS, CLASSES, type ClassId } from '../map';
import { renderPortraits } from '../portraits';
import {
  ITEMS, MAX_LEVEL, RECIPES, RESOURCES, SKILL_IDS, SKILLS, STRUCTURE_IDS, STRUCTURES, levelFromXp, xpForLevel,
  type ItemId, type StructureId,
} from './content';
import { WorldRenderer } from './render';
import { Dissolver, addXray } from './shaders';
import { OpenWorld, type Enemy, type WorldEvent } from './sim';
import { WORLD_HALF, WorldGen } from './terrain';

const SEED = 20261020; // everyone gets the same island
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const smooth = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

const MODELS = [
  ...CLASS_IDS.map((c) => `characters/${c}`),
  'characters/skeleton_minion', 'characters/skeleton_warrior', 'characters/skeleton_rogue', 'characters/skeleton_mage',
  'weapons/skeleton_blade', 'weapons/skeleton_axe', 'weapons/skeleton_staff', 'weapons/skeleton_shield_small_a',
  'nature/tree_single_A', 'nature/tree_single_B', 'nature/tree_single_A_cut', 'nature/tree_single_B_cut',
  'nature/rock_single_A', 'nature/rock_single_B', 'nature/rock_single_C', 'nature/rock_single_D', 'nature/rock_single_E',
  'village/building_home_A_blue', 'village/building_home_B_blue', 'village/building_blacksmith_blue', 'village/building_well_blue',
  'village/building_market_blue', 'village/building_tavern_blue', 'village/building_windmill_blue', 'village/building_tower_A_blue',
  'village/building_destroyed', 'village/fence_wood_straight', 'village/wall_straight', 'village/tent', 'village/resource_lumber',
  'village/resource_stone', 'village/crate_A_big', 'village/barrel', 'village/flag_blue', 'village/weaponrack', 'village/sack',
  'village/wheelbarrow', 'dungeon/table_medium_decorated_A', 'dungeon/chest_gold', 'dungeon/pillar', 'dungeon/rubble_half',
  'dungeon/banner_patternA_red', 'dungeon/barrel_small_stack',
];

const prefs = (() => {
  const mobile = matchMedia('(pointer: coarse)').matches;
  try {
    return { shadows: !mobile, stats: false, music: 0.5, sfx: 0.8, grass: true, ...JSON.parse(localStorage.getItem('hearthwild.prefs') ?? '{}') };
  } catch {
    return { shadows: !mobile, stats: false, music: 0.5, sfx: 0.8, grass: true };
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem('hearthwild.prefs', JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
};

function show(screen: 'loading' | 'start' | 'game') {
  for (const s of ['loading', 'start']) $(`screen-${s}`).classList.toggle('visible', s === screen);
  $('hud').classList.toggle('hidden', screen !== 'game');
  if (screen !== 'game') for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden');
  document.body.dataset.screen = screen;
}

/** Island overview image (one pixel per 2 m), drawn once and reused by the map and minimap. */
function renderIslandImage(gen: WorldGen): HTMLCanvasElement {
  const size = 384;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const colors: Record<string, [number, number, number]> = {
    sand: [227, 208, 143], grass: [125, 187, 76], forest: [78, 148, 64], rock: [143, 135, 123], snow: [238, 242, 246],
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i / size) * WORLD_HALF * 2 - WORLD_HALF;
      const z = (j / size) * WORLD_HALF * 2 - WORLD_HALF;
      const h = gen.height(x, z);
      const k = (j * size + i) * 4;
      if (h < -0.2) {
        const d = Math.max(0, Math.min(1, -h / 9));
        img.data.set([63 - 30 * d, 134 - 50 * d, 201 - 40 * d, 255], k);
      } else {
        const col = colors[gen.biome(x, z, h)] ?? colors.grass;
        const shade = 0.85 + Math.min(0.3, h / 120);
        img.data.set([col[0] * shade, col[1] * shade, col[2] * shade, 255], k);
      }
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

async function boot() {
  show('loading');
  try {
    await loadModels(MODELS, (f, label) => {
      $('loading-bar').style.width = `${Math.round(f * 100)}%`;
      $('loading-text').textContent = `Loading ${label.split('/').pop()?.replace(/_/g, ' ')}…`;
    });
  } catch (e) {
    $('loading-text').textContent = `Could not load the game files: ${(e as Error).message}. Reload to try again.`;
    return;
  }
  // class portraits come from a throwaway renderer so the game canvas keeps a single context
  const portraitRenderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true });
  portraitRenderer.outputColorSpace = THREE.SRGBColorSpace;
  const portraits = renderPortraits(portraitRenderer);
  portraitRenderer.dispose();
  portraitRenderer.forceContextLoss();

  setupStartScreen(portraits);
}

function setupStartScreen(portraits: Record<string, string>) {
  show('start');
  const saved = OpenWorld.load();
  let chosen: ClassId = (saved?.player.cls as ClassId) ?? 'knight';
  const list = $('class-list');
  list.innerHTML = '';
  for (const id of CLASS_IDS) {
    const c = CLASSES[id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'class-card';
    card.dataset.class = id;
    card.innerHTML = `<img alt="" src="${portraits[id]}"><b></b><small></small>`;
    card.querySelector('b')!.textContent = c.label;
    card.querySelector('small')!.textContent = c.blurb + (c.ranged ? ' (ranged)' : '');
    card.addEventListener('click', () => select(id));
    list.appendChild(card);
  }
  function select(id: ClassId) {
    chosen = id;
    for (const c of list.querySelectorAll<HTMLElement>('.class-card')) c.classList.toggle('selected', c.dataset.class === id);
  }
  select(chosen);

  let confirmReplace = false;
  if (saved) {
    $('continue-box').hidden = false;
    $('continue-name').textContent = `${saved.player.name} the ${CLASSES[saved.player.cls as ClassId]?.label ?? 'Hero'}`;
    const total = SKILL_IDS.reduce((s, k) => s + levelFromXp(saved.player.xp[k] ?? 0), 0);
    $('continue-detail').textContent = `Total skill level ${total} · ${saved.player.gold} gold · ${saved.structures.length} buildings`;
    $('btn-continue').onclick = () => startGame(saved.player.name, saved.player.cls as ClassId, saved, portraits);
    $('btn-new').textContent = 'Start over with a new hero';
  }
  $<HTMLFormElement>('new-form').onsubmit = (e) => {
    e.preventDefault();
    const name = $<HTMLInputElement>('hero-name').value.trim();
    if (!/^[\p{L}\p{N} _'-]{2,16}$/u.test(name)) {
      $('start-error').textContent = 'Pick a name of 2-16 letters or numbers.';
      return;
    }
    if (saved && !confirmReplace) {
      confirmReplace = true;
      $('start-error').textContent = `This replaces ${saved.player.name} and everything they built. Press again to confirm.`;
      $('btn-new').textContent = 'Yes, start over';
      return;
    }
    OpenWorld.clearSave();
    startGame(name, chosen, null, portraits);
  };
}

function startGame(name: string, cls: ClassId, saved: ReturnType<typeof OpenWorld.load>, portraits: Record<string, string>) {
  // called from the Play / Continue click, which is the user gesture browsers require for sound
  audio.setVolumes(prefs.music, prefs.sfx);
  audio.start();
  const world = new OpenWorld(SEED, name, cls, saved);
  const canvas = $<HTMLCanvasElement>('scene');
  const r = new WorldRenderer(canvas, world);
  r.setShadows(prefs.shadows);
  r.setGrass(prefs.grass);
  const input = new Input(canvas);
  input.enabled = true;
  const islandImage = renderIslandImage(world.gen);

  // ---- characters
  const clsDef = CLASSES[cls];
  const hero = new CharacterView(cls, { attackClip: clsDef.attackClip, label: name, plateClass: 'me' });
  const gatherClip = cls === 'barbarian' ? '2H_Melee_Attack_Chop' : '1H_Melee_Attack_Chop';
  r.scene.add(hero.root);
  addXray(hero.root); // the hero shows through trees and buildings
  const enemyViews = new Map<number, { view: CharacterView; seen: { attack: number; hit: number }; diedAt?: number; dissolver?: Dissolver }>();
  const bolts: Bolt[] = [];
  const addEnemyView = (e: Enemy) => {
    const view = createEnemyView(e.kind);
    (view.plate.querySelector('.label') as HTMLElement).textContent = `Lv ${e.level} ${e.kind[0].toUpperCase()}${e.kind.slice(1)}`;
    view.target.set(e.x, world.gen.height(e.x, e.z), e.z);
    view.snap();
    r.scene.add(view.root);
    enemyViews.set(e.id, { view, seen: { attack: e.attackSeq, hit: e.hitSeq } });
  };
  for (const e of world.enemies.values()) addEnemyView(e);

  // ---- HUD helpers
  const feed = (text: string) => {
    const li = document.createElement('li');
    li.textContent = text;
    $('feed').appendChild(li);
    while ($('feed').children.length > 5) $('feed').firstChild?.remove();
    setTimeout(() => li.remove(), 6000);
  };
  let toastTimer = 0;
  const toast = (text: string, kind: 'error' | 'info' = 'info') => {
    if (kind === 'error') audio.play('error');
    const t = $('toast');
    t.textContent = text;
    t.className = `show ${kind === 'info' ? 'info' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (t.className = ''), 2600);
  };
  const floatText = (x: number, z: number, text: string, cls2: string) => {
    const p = new THREE.Vector3(x, world.gen.height(x, z) + 2.4, z).project(r.camera);
    if (p.z > 1) return;
    const el = document.createElement('div');
    el.className = `dmg ${cls2}`;
    el.textContent = text;
    el.style.left = `${((p.x + 1) / 2) * window.innerWidth + (Math.random() * 20 - 10)}px`;
    el.style.top = `${((1 - p.y) / 2) * window.innerHeight}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 900);
  };

  // sounds fade out over 30 m from the hero
  const sfxAt = (name: Sfx, x: number, z: number, delay = 0) => {
    const v = 1 - Math.hypot(x - world.player.x, z - world.player.z) / 30;
    if (delay) setTimeout(() => audio.play(name, v), delay);
    else audio.play(name, v);
  };
  const FLOAT_SFX: Record<string, Sfx> = { '': 'hit', crit: 'crit', player: 'hurt', heal: 'potion', gain: 'pickup' };
  world.onEvent = (e: WorldEvent) => {
    switch (e.type) {
      case 'float':
        floatText(e.x, e.z, e.text, e.style);
        sfxAt(FLOAT_SFX[e.style], e.x, e.z);
        break;
      case 'sound': sfxAt(e.name, e.x, e.z); break;
      case 'feed': feed(e.text); break;
      case 'toast': toast(e.text); break;
      case 'level':
        toast(`${SKILLS[e.skill].name} reached level ${e.level}!`);
        feed(`${SKILLS[e.skill].icon} ${SKILLS[e.skill].name} level ${e.level}`);
        hero.play('Cheer');
        audio.play('levelup');
        break;
      case 'resources': r.rebuildResources(); break;
      case 'structures': r.buildStructures(); break;
      case 'enemy-added': addEnemyView(e.enemy); break;
      case 'enemy-removed': {
        const ev = enemyViews.get(e.id);
        ev?.dissolver?.restore();
        ev?.view.dispose();
        enemyViews.delete(e.id);
        break;
      }
      case 'gather-hit':
        hero.play(gatherClip);
        // the tool lands about a third of a second into the swing
        sfxAt(e.node.kind === 'tree' ? 'chop' : 'mine', e.node.x, e.node.z, 350);
        break;
      case 'player-attack':
        hero.play(clsDef.attackClip);
        audio.play(clsDef.ranged ? 'zap' : 'swing');
        if (clsDef.ranged) spawnBolt(hero.root.position, e.facing, clsDef.range, '#7fd4ff');
        break;
      case 'enemy-attack': sfxAt(e.enemy.kind === 'mage' ? 'zap' : 'enemy-swing', e.enemy.x, e.enemy.z); break;
      case 'death':
        hero.setAlive(false);
        audio.play('death');
        break;
      case 'respawn':
        hero.setAlive(true);
        audio.play('respawn');
        break;
    }
  };
  const spawnBolt = (from: THREE.Vector3, facing: number, range: number, color: string) => {
    const b = new Bolt(from, new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), range, color);
    r.scene.add(b.mesh);
    bolts.push(b);
  };

  // ---- input
  let lastSent = { dx: 0, dz: 0 };
  const sendMove = () => {
    const m = input.move();
    const dx = Math.round(m.x * 100) / 100;
    const dz = Math.round(m.z * 100) / 100;
    if (dx !== lastSent.dx || dz !== lastSent.dz) {
      lastSent = { dx, dz };
      world.setInput(dx, dz);
    }
  };
  input.onMoveChange = sendMove;

  let build: { type: StructureId; rot: number; x: number; z: number; ok: boolean } | null = null;
  const aimFacing = () => {
    const p = world.player;
    if (input.lastDevice === 'mouse' && input.aimNdc) {
      const hit = r.pick(input.aimNdc);
      if (hit && Math.hypot(hit.x - p.x, hit.z - p.z) > 0.3) return Math.atan2(hit.x - p.x, hit.z - p.z);
    }
    let best: { d: number; f: number } | null = null;
    for (const e of world.enemies.values()) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d < (clsDef.ranged ? 10 : 3.5) && (!best || d < best.d)) best = { d, f: Math.atan2(e.x - p.x, e.z - p.z) };
    }
    return best?.f ?? p.facing;
  };
  const doAttack = () => {
    const err = world.attack(aimFacing());
    if (err && err !== 'cooldown') toast(err, 'error');
  };
  const doInteract = () => {
    const err = world.interact();
    if (err) toast(err, 'error');
  };
  const doPotion = () => {
    const err = world.usePotion();
    if (err) toast(err, 'error');
  };
  const placeBuild = () => {
    if (!build) return;
    const err = world.build(build.type, build.x, build.z, build.rot);
    if (err) return toast(err, 'error');
    const def = STRUCTURES[build.type];
    toast(`Built ${def.name.toLowerCase()}`);
    // walls and fences are usually placed in a row
    if (!def.box || world.canBuild(build.type)) endBuild();
  };
  input.onAction = () => {
    if (build) {
      if (input.wantsAttack()) placeBuild();
      input.wantsPotion();
      return;
    }
    if (input.wantsAttack()) doAttack();
    if (input.wantsPotion()) doPotion();
  };
  const endBuild = () => {
    build = null;
    r.setGhost(null);
    $('build-bar').hidden = true;
  };
  const startBuild = (type: StructureId) => {
    closePanels();
    build = { type, rot: 0, x: 0, z: 0, ok: false };
    r.setGhost(type);
    $('build-bar').hidden = false;
    $('build-text').textContent = `Placing: ${STRUCTURES[type].name}`;
  };
  $('btn-place').onclick = placeBuild;
  $('btn-rotate').onclick = () => build && (build.rot += Math.PI / 4);
  $('btn-cancel-build').onclick = endBuild;
  $('btn-action').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    doInteract();
  });

  // ---- panels
  const panels = ['inventory', 'crafting', 'build', 'skills', 'map', 'menu'] as const;
  type Panel = (typeof panels)[number];
  const closePanels = () => panels.forEach((p) => $(`panel-${p}`).classList.add('hidden'));
  const openPanel = (p: Panel) => {
    const el = $(`panel-${p}`);
    const wasOpen = !el.classList.contains('hidden');
    closePanels();
    if (wasOpen) return;
    renderPanel(p);
    el.classList.remove('hidden');
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-panel]')) b.onclick = () => openPanel(b.dataset.panel as Panel);
  for (const b of document.querySelectorAll('.modal .close')) b.addEventListener('click', closePanels);
  for (const m of document.querySelectorAll('.modal')) m.addEventListener('click', (e) => e.target === m && closePanels());

  const req = (item: ItemId, need: number) => {
    const have = world.count(item);
    return `<span class="req ${have >= need ? 'ok' : 'no'}">${ITEMS[item].icon} ${have}/${need} ${ITEMS[item].name}</span>`;
  };
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  function renderPanel(p: Panel) {
    if (p === 'inventory') {
      const el = $('inv-slots');
      el.innerHTML = '';
      const items = (Object.keys(ITEMS) as ItemId[]).filter((i) => world.count(i) > 0);
      for (let i = 0; i < Math.max(15, items.length); i++) {
        const id = items[i];
        const d = document.createElement('div');
        d.className = 'slot';
        if (id) {
          d.title = `${ITEMS[id].name}: ${ITEMS[id].desc}`;
          d.innerHTML = `${ITEMS[id].icon}<b>${world.count(id)}</b>`;
          d.onclick = () => ($('inv-detail').textContent = `${ITEMS[id].name}: ${ITEMS[id].desc}`);
        }
        el.appendChild(d);
      }
    }
    if (p === 'crafting') {
      const st = world.stationsNear(world.player.x, world.player.z);
      $('craft-stations').textContent = st.size
        ? `Nearby: ${[...st].map((s) => (s === 'forge' ? '⚒ forge' : '🛠 workbench')).join(', ')}`
        : 'No crafting station nearby. The village has a workbench and a forge, or build your own.';
      const el = $('craft-list');
      el.innerHTML = '';
      for (const rec of RECIPES) {
        const problem = world.canCraft(rec);
        const row = document.createElement('div');
        row.className = `entry ${problem ? 'locked' : ''}`;
        const needs = [rec.station ? `${rec.station === 'forge' ? '⚒ Forge' : '🛠 Workbench'}` : '', rec.skill ? `${SKILLS[rec.skill.id].name} ${rec.skill.level}` : '']
          .filter(Boolean).join(' · ');
        row.innerHTML = `<div class="ico">${ITEMS[rec.output].icon}</div><div class="body"><b>${esc(ITEMS[rec.output].name)}${rec.count > 1 ? ` ×${rec.count}` : ''}</b>
          <small>${esc(ITEMS[rec.output].desc)}${needs ? ` Needs: ${esc(needs)}.` : ''}</small>
          <div class="reqs">${Object.entries(rec.inputs).map(([i, n]) => req(i as ItemId, n ?? 0)).join('')}</div></div>`;
        const btn = document.createElement('button');
        btn.className = 'primary';
        btn.textContent = 'Craft';
        btn.disabled = !!problem;
        btn.title = problem ?? '';
        btn.onclick = () => {
          const err = world.craft(rec.id);
          if (err) toast(err, 'error');
          renderPanel('crafting');
        };
        row.appendChild(btn);
        el.appendChild(row);
      }
    }
    if (p === 'build') {
      const el = $('build-list');
      el.innerHTML = '';
      for (const id of STRUCTURE_IDS) {
        const def = STRUCTURES[id];
        const problem = world.canBuild(id);
        const row = document.createElement('div');
        row.className = `entry ${problem ? 'locked' : ''}`;
        row.innerHTML = `<div class="ico">${def.icon}</div><div class="body"><b>${esc(def.name)}</b><small>${esc(def.desc)}${def.skill ? ` Needs ${SKILLS[def.skill.id].name} ${def.skill.level}.` : ''}</small>
          <div class="reqs">${Object.entries(def.cost).map(([i, n]) => req(i as ItemId, n ?? 0)).join('')}</div></div>`;
        const btn = document.createElement('button');
        btn.className = 'primary';
        btn.textContent = 'Place';
        btn.disabled = !!problem;
        btn.title = problem ?? '';
        btn.onclick = () => startBuild(id);
        row.appendChild(btn);
        el.appendChild(row);
      }
    }
    if (p === 'skills') {
      const el = $('skills-list');
      el.innerHTML = '';
      for (const id of SKILL_IDS) {
        const xp = world.player.xp[id];
        const lvl = levelFromXp(xp);
        const from = xpForLevel(lvl);
        const to = xpForLevel(lvl + 1);
        const frac = lvl >= MAX_LEVEL ? 1 : (xp - from) / (to - from);
        const row = document.createElement('div');
        row.className = 'skill';
        row.innerHTML = `<div class="ico">${SKILLS[id].icon}</div><div><b>${SKILLS[id].name}</b> <small class="muted">${esc(SKILLS[id].desc)}</small>
          <div class="bar"><div style="width:${Math.round(frac * 100)}%"></div></div><small class="muted">${xp - from} / ${to - from} XP to next level</small></div>
          <div class="lvl">${lvl}</div>`;
        el.appendChild(row);
      }
    }
    if (p === 'map') drawMap($<HTMLCanvasElement>('world-map'), 1);
  }

  const toMap = (x: number, z: number, size: number) => [((x + WORLD_HALF) / (WORLD_HALF * 2)) * size, ((z + WORLD_HALF) / (WORLD_HALF * 2)) * size];
  function drawMap(c: HTMLCanvasElement, zoom: number) {
    const g = c.getContext('2d')!;
    const p = world.player;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.width, c.height);
    g.save();
    if (zoom > 1) {
      // minimap: centred on the player
      const [px, pz] = toMap(p.x, p.z, c.width * zoom);
      g.translate(c.width / 2 - px, c.height / 2 - pz);
    }
    const size = c.width * zoom;
    g.drawImage(islandImage, 0, 0, size, size);
    g.font = `${zoom > 1 ? 14 : 16}px system-ui`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const [vx, vz] = toMap(0, 0, size);
    g.fillText('🏘', vx, vz);
    g.fillStyle = '#fff';
    for (const ruin of world.gen.ruins) {
      const [rx, rz] = toMap(ruin.x, ruin.z, size);
      g.fillText('💀', rx, rz);
      if (zoom === 1) {
        g.font = 'bold 11px system-ui';
        g.fillText(String(ruin.level), rx + 9, rz + 8);
        g.font = '16px system-ui';
      }
    }
    if (p.home) {
      const [hx, hz] = toMap(p.home.x, p.home.z, size);
      g.fillText('🏠', hx, hz);
    }
    if (zoom > 1) {
      g.fillStyle = '#e0544a';
      for (const e of world.enemies.values()) {
        if (!e.alive) continue;
        const [ex, ez] = toMap(e.x, e.z, size);
        g.fillRect(ex - 1.5, ez - 1.5, 3, 3);
      }
    }
    const [mx, mz] = toMap(p.x, p.z, size);
    g.translate(mx, mz);
    g.rotate(-p.facing + Math.PI);
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.beginPath();
    g.moveTo(0, -7);
    g.lineTo(5, 5);
    g.lineTo(-5, 5);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  // ---- keys
  input.onKey = (k) => {
    if (document.body.dataset.screen !== 'game') return;
    if (k === 'escape') {
      if (build) return endBuild();
      const open = [...document.querySelectorAll('.modal:not(.hidden)')];
      if (open.length) closePanels();
      else openPanel('menu');
      return;
    }
    if (k === 'e') doInteract();
    if (k === 'r' && build) build.rot += Math.PI / 4;
    const map: Record<string, Panel> = { i: 'inventory', c: 'crafting', b: 'build', k: 'skills', m: 'map' };
    if (map[k]) openPanel(map[k]);
  };

  // ---- menu
  const shadows = $<HTMLInputElement>('opt-shadows');
  shadows.checked = prefs.shadows;
  shadows.onchange = () => {
    prefs.shadows = shadows.checked;
    r.setShadows(prefs.shadows);
    savePrefs();
  };
  for (const kind of ['music', 'sfx'] as const) {
    const slider = $<HTMLInputElement>(`opt-${kind}`);
    slider.value = String(Math.round(prefs[kind] * 100));
    slider.oninput = () => {
      prefs[kind] = Number(slider.value) / 100;
      audio.setVolumes(prefs.music, prefs.sfx);
      savePrefs();
    };
  }
  document.addEventListener('click', (e) => (e.target as Element | null)?.closest?.('button') && audio.play('click'));
  const grass = $<HTMLInputElement>('opt-grass');
  grass.checked = prefs.grass;
  grass.onchange = () => {
    prefs.grass = grass.checked;
    r.setGrass(prefs.grass);
    savePrefs();
  };
  const stats = $<HTMLInputElement>('opt-stats');
  stats.checked = prefs.stats;
  $('fps').classList.toggle('hidden', !prefs.stats);
  stats.onchange = () => {
    prefs.stats = stats.checked;
    $('fps').classList.toggle('hidden', !prefs.stats);
    savePrefs();
  };
  $('btn-save').onclick = () => {
    world.save();
    toast('Saved');
  };
  $('btn-title').onclick = () => {
    world.stop();
    location.reload();
  };
  $('btn-delete').onclick = () => ($('delete-confirm').hidden = false);
  $('btn-delete-no').onclick = () => ($('delete-confirm').hidden = true);
  $('btn-delete-yes').onclick = () => {
    world.stop();
    OpenWorld.clearSave();
    location.reload();
  };
  const saveOnHide = () => world.save();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveOnHide());
  window.addEventListener('pagehide', saveOnHide);

  // ---- loop
  show('game');
  $('hud-class').style.backgroundImage = `url(${portraits[cls]})`;
  $('hud-name').textContent = `${name} · ${clsDef.label}`;
  world.start();
  const camTarget = new THREE.Vector3(world.player.x, 3, world.player.z);
  let zoom = 1;
  window.addEventListener('wheel', (e) => (zoom = THREE.MathUtils.clamp(zoom + Math.sign(e.deltaY) * 0.1, 0.6, 1.6)), { passive: true });
  window.addEventListener('resize', () => r.resize());
  hero.target.set(world.player.x, world.gen.height(world.player.x, world.player.z), world.player.z);
  hero.snap();
  let hudTimer = 0;
  let mapTimer = 0;
  let chestTimer = 0;
  let stepTimer = 0;
  let frames = 0;
  let fpsTime = 0;
  const timer = new THREE.Timer();
  timer.connect(document);
  const w = () => window.innerWidth;
  const h = () => window.innerHeight;

  r.renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);
    const p = world.player;
    sendMove();
    if (input.wantsAttack() && !build) doAttack();
    if (input.wantsPotion()) doPotion();
    r.updateChunks();

    // hero
    hero.target.set(p.x, world.gen.height(p.x, p.z), p.z);
    hero.targetFacing = p.facing;
    hero.moving = p.moving;
    hero.setHealth(p.hp, world.maxHp());
    hero.update(dt);
    stepTimer = p.moving && p.alive ? stepTimer + dt : 0.25;
    if (stepTimer > 0.32) {
      stepTimer = 0;
      audio.play('step');
    }

    // enemies (far ones are hidden and not animated)
    for (const [id, ev] of enemyViews) {
      const e = world.enemies.get(id);
      if (!e) continue;
      const far = Math.hypot(e.x - p.x, e.z - p.z) > 75;
      ev.view.root.visible = !far;
      if (far) {
        ev.view.plate.style.visibility = 'hidden';
        continue;
      }
      ev.view.target.set(e.x, world.gen.height(e.x, e.z), e.z);
      ev.view.targetFacing = e.facing;
      ev.view.moving = e.moving;
      ev.view.setHealth(e.hp, e.maxHp);
      ev.view.setAlive(e.alive);
      // the fallen burn away into embers, and come back whole when they respawn
      if (!e.alive) {
        ev.diedAt ??= performance.now();
        const t = (performance.now() - ev.diedAt - 900) / 1300;
        if (t > 0) {
          ev.dissolver ??= new Dissolver(ev.view.root);
          ev.dissolver.set(Math.min(1, t));
        }
      } else if (ev.diedAt !== undefined) {
        ev.dissolver?.restore();
        ev.dissolver = undefined;
        ev.diedAt = undefined;
      }
      if (e.attackSeq !== ev.seen.attack) {
        ev.view.play(ev.view.attackClip);
        if (e.kind === 'mage') spawnBolt(ev.view.root.position, e.facing, 8, '#b06cff');
      } else if (e.hitSeq !== ev.seen.hit && e.alive) ev.view.play('Hit_A');
      ev.seen = { attack: e.attackSeq, hit: e.hitSeq };
      ev.view.update(dt);
    }
    for (const b of [...bolts]) if (!b.update(dt)) {
      b.mesh.removeFromParent();
      bolts.splice(bolts.indexOf(b), 1);
    }

    // build ghost
    if (build) {
      let gx = p.x + Math.sin(p.facing) * 4;
      let gz = p.z + Math.cos(p.facing) * 4;
      if (input.lastDevice === 'mouse' && input.aimNdc) {
        const hit = r.pick(input.aimNdc);
        if (hit) [gx, gz] = [hit.x, hit.z];
      }
      build.x = Math.round(gx * 2) / 2;
      build.z = Math.round(gz * 2) / 2;
      const problem = world.canBuild(build.type) ?? world.placementProblem(build.type, build.x, build.z);
      build.ok = !problem;
      r.moveGhost(build.x, build.z, build.rot, build.ok);
      $('build-text').textContent = `${STRUCTURES[build.type].name}${problem ? ` — ${problem}` : ''}`;
      $<HTMLButtonElement>('btn-place').disabled = !build.ok;
    }

    // camera
    camTarget.lerp(hero.root.position, smooth(6, dt));
    const portrait = w() < h();
    const dist = (portrait ? 1.25 : 1) * zoom;
    r.camera.position.set(camTarget.x, camTarget.y + 15 * dist, camTarget.z + 11 * dist);
    r.camera.lookAt(camTarget.x, camTarget.y + 0.8, camTarget.z);
    r.updateDayNight(camTarget);
    r.render();
    hero.placePlate(r.camera, w(), h());
    for (const ev of enemyViews.values()) if (ev.view.root.visible) ev.view.placePlate(r.camera, w(), h());

    // HUD
    const cd = Math.min(1, (Date.now() - p.lastAttack) / clsDef.cooldown);
    $('hud-cd-fill').style.width = `${cd * 100}%`;
    hudTimer += dt;
    if (hudTimer > 0.1) {
      hudTimer = 0;
      const max = world.maxHp();
      $('hud-hp-fill').style.width = `${(p.hp / max) * 100}%`;
      $('hud-hp-text').textContent = `${Math.ceil(p.hp)} / ${max}`;
      $('hud-gold').textContent = String(p.gold);
      $('hud-potions-touch').textContent = String(world.count('potion'));
      const t = world.dayTime();
      const mins = Math.floor(t * 24 * 60);
      $('hud-clock').textContent = `${world.isNight() ? '☾' : '☀'} ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      const target = p.alive && !build ? world.interactTarget() : null;
      r.highlight(target);
      const prompt = $('action-prompt');
      if (p.gather) {
        prompt.hidden = false;
        const node = world.nodesNear(p.x, p.z, 5).find((n) => n.id === p.gather!.id);
        $('action-text').textContent = node ? `${RESOURCES[node.kind].name === 'Tree' ? 'Chopping' : 'Mining'}…` : 'Working…';
      } else if (target) {
        prompt.hidden = false;
        const key = matchMedia('(pointer: coarse)').matches ? '✋' : 'E';
        $('action-text').textContent = target.type === 'chest'
          ? `${key} — Open chest`
          : `${key} — ${target.node.kind === 'tree' ? 'Chop' : 'Mine'} ${RESOURCES[target.node.kind].name.toLowerCase()} (${ITEMS[RESOURCES[target.node.kind].item].name})`;
      } else prompt.hidden = true;
      // music: night changes the key, nearby fighting brings in the drums
      const fighting = [...world.enemies.values()].some((e) => e.alive && e.engaged && Math.hypot(e.x - p.x, e.z - p.z) < 25);
      audio.setMood(world.isNight(), fighting);
      const respawn = $('respawn');
      respawn.classList.toggle('hidden', p.alive);
      if (!p.alive) $('respawn-time').textContent = String(Math.max(0, Math.ceil((p.respawnAt - Date.now()) / 1000)));
    }
    if (p.gather) {
      const g = p.gather;
      $('gather-fill').style.width = `${Math.min(100, (1 - (g.endsAt - Date.now()) / g.duration) * 100)}%`;
    } else $('gather-fill').style.width = '0';
    mapTimer += dt;
    if (mapTimer > 0.2) {
      mapTimer = 0;
      drawMap($<HTMLCanvasElement>('minimap'), 6);
    }
    chestTimer += dt;
    if (chestTimer > 1) {
      chestTimer = 0;
      r.updateChests();
    }
    frames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      if (prefs.stats) $('fps').textContent = `${Math.round(frames / fpsTime)} fps · ${r.drawCalls()} draws`;
      frames = 0;
      fpsTime = 0;
    }
  });

  // test/debug hook: read-only view of the state
  (window as unknown as { __world: unknown }).__world = {
    world,
    renderer: r,
    audio,
    snapshot: () => ({
      x: world.player.x, z: world.player.z, hp: world.player.hp, alive: world.player.alive, gold: world.player.gold,
      inv: { ...world.player.inv }, xp: { ...world.player.xp }, gathering: !!world.player.gather, structures: world.structures.length,
      target: world.interactTarget()?.type ?? null, chunks: r.pendingChunks(), drawCalls: r.drawCalls(),
    }),
  };
}

void boot();
