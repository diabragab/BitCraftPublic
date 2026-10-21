import '../style.css';
import './world.css';
import * as THREE from 'three/webgpu';
import { WebGLRenderer } from 'three';
import { loadModels } from '../assets';
import { audio, type Sfx } from '../audio';
import { Bolt, CharacterView, createEnemyView } from '../entities';
import { Input } from '../input';
import { CLASS_IDS, CLASSES, type ClassId } from '../map';
import { renderPortraits } from '../portraits';
import {
  BAG_SIZE, CLASS_SKILLS, ENEMY_KINDS, GEAR, ITEMS, MAX_LEVEL, PET_IDS, PETS, RARITIES, RECIPES, RESOURCES, SKILL_IDS, SKILLS, SLOT_IDS, SLOTS,
  STATS, STRUCTURE_IDS, STRUCTURES, armorFactor, formatStat, levelFromXp, petXpForLevel, rankScale, xpForLevel,
  type Effect, type ItemId, type Mods, type PetSpecies, type SkillDef, type StatId, type StructureId,
} from './content';
import { gearIcon, skillIcon, slotIcon } from './icons';
import { PetView } from './petview';
import { WorldRenderer } from './render';
import { addXray, flashMaterial } from './shaders';
import { Spells } from './spells';
import type { Element as FxElement } from './content';

/** Basic-attack chains: three swings, the last one is the finisher. */
const COMBO_CLIPS: Record<ClassId, string[]> = {
  knight: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Horizontal', '1H_Melee_Attack_Chop'],
  barbarian: ['2H_Melee_Attack_Chop', '2H_Melee_Attack_Slice', '2H_Melee_Attack_Chop'],
  rogue: ['Dualwield_Melee_Attack_Stab', 'Dualwield_Melee_Attack_Slice', 'Dualwield_Melee_Attack_Stab'],
  mage: ['Spellcast_Shoot', 'Spellcast_Shoot', 'Spellcast_Shoot'],
};
const CLASS_ELEMENT: Record<ClassId, FxElement> = { knight: 'steel', barbarian: 'blood', rogue: 'shadow', mage: 'arcane' };
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
    return { shadows: !mobile, stats: false, music: 0.5, sfx: 0.8, grass: true, bloom: !mobile, shake: true, ...JSON.parse(localStorage.getItem('hearthwild.prefs') ?? '{}') };
  } catch {
    return { shadows: !mobile, stats: false, music: 0.5, sfx: 0.8, grass: true, bloom: !mobile, shake: true };
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
  // class portraits come from a throwaway classic renderer (the game itself runs on
  // WebGPURenderer); it is gone before the game canvas starts
  const portraitRenderer = new WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true });
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
    $('btn-continue').onclick = () => void startGame(saved.player.name, saved.player.cls as ClassId, saved, portraits);
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
    void startGame(name, chosen, null, portraits);
  };
}

async function startGame(name: string, cls: ClassId, saved: ReturnType<typeof OpenWorld.load>, portraits: Record<string, string>) {
  // called from the Play / Continue click, which is the user gesture browsers require for sound
  audio.setVolumes(prefs.music, prefs.sfx);
  audio.start();
  const world = new OpenWorld(SEED, name, cls, saved);
  const canvas = $<HTMLCanvasElement>('scene');
  const r = new WorldRenderer(canvas, world);
  r.setShadows(prefs.shadows);
  r.setGrass(prefs.grass);
  // start the GPU and compile every spell effect behind the loading bar
  show('loading');
  const loading = (f: number, text: string) => {
    $('loading-bar').style.width = `${Math.round(f * 100)}%`;
    $('loading-text').textContent = text;
  };
  loading(0, 'Preparing spell effects…');
  try {
    await r.init({ bloom: prefs.bloom, shake: prefs.shake }, (f) => loading(f * 0.85, 'Preparing spell effects…'));
  } catch (e) {
    $('loading-text').textContent = `Could not start the graphics: ${(e as Error).message}. Reload to try again.`;
    return;
  }
  const spells = new Spells(r.fx, (x, z) => world.gen.height(x, z));
  const input = new Input(canvas);
  input.enabled = true;
  const islandImage = renderIslandImage(world.gen);

  // ---- characters
  const clsDef = CLASSES[cls];
  const hero = new CharacterView(cls, { attackClip: clsDef.attackClip, label: name, plateClass: 'me' });
  const gatherClip = cls === 'barbarian' ? '2H_Melee_Attack_Chop' : '1H_Melee_Attack_Chop';
  r.scene.add(hero.root);
  addXray(hero.root); // the hero shows through trees and buildings
  /** Where the hero's spells start: a point at chest height that moves with the hero. */
  const heroChest = Spells.anchor(hero.root);
  interface EnemyView {
    view: CharacterView;
    seen: { attack: number; hit: number };
    diedAt?: number;
    dissolving?: boolean;
    /** Meshes whose `userData.flash` lights the shared flash material (shaders.ts). */
    meshes: THREE.Mesh[];
    flash: number;
  }
  const enemyViews = new Map<number, EnemyView>();
  /** An enemy model whose meshes use the shared hit-flash materials. */
  const enemyModel = (kind: string) => {
    const view = createEnemyView(kind);
    view.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.material = flashMaterial(m.material as THREE.Material);
      m.userData.flash = 0;
    });
    return view;
  };
  const bolts: Bolt[] = [];
  const addEnemyView = (e: Enemy) => {
    const view = enemyModel(e.kind);
    (view.plate.querySelector('.label') as HTMLElement).textContent = `Lv ${e.level} ${e.kind[0].toUpperCase()}${e.kind.slice(1)}`;
    view.target.set(e.x, world.gen.height(e.x, e.z), e.z);
    view.snap();
    r.scene.add(view.root);
    const meshes: THREE.Mesh[] = [];
    view.root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    enemyViews.set(e.id, { view, seen: { attack: e.attackSeq, hit: e.hitSeq }, meshes, flash: 0 });
  };
  for (const e of world.enemies.values()) addEnemyView(e);
  // status looks are built once per kind of model: compile them now, not on the first burn
  {
    const kinds = new Map<string, THREE.Object3D>();
    for (const [id, ev] of enemyViews) {
      const kind = world.enemies.get(id)?.kind;
      if (kind && !kinds.has(kind)) kinds.set(kind, ev.view.root);
    }
    // kinds that only turn up later (night wanderers) get a throwaway model
    const spare: CharacterView[] = [];
    for (const kind of Object.keys(ENEMY_KINDS)) {
      if (kinds.has(kind)) continue;
      const v = enemyModel(kind);
      v.plate.remove();
      spare.push(v);
      kinds.set(kind, v.root);
    }
    const models = [...kinds.values()];
    for (let i = 0; i < models.length; i++) {
      loading(0.85 + (0.15 * i) / (models.length + 1), 'Preparing enemies…');
      await spells.prewarmStatuses(models[i], ['burn', 'freeze', 'stun', 'dissolve', 'appear']);
    }
    for (const v of spare) v.dispose();
    loading(1, 'Preparing your hero…');
    await spells.prewarmStatuses(hero.root, ['shield']);
  }

  // ---- pet
  let petView: PetView | null = null;
  /** The pet's chest-height anchor, where its spells start. */
  let petChest: THREE.Object3D | null = null;
  const petLabel = (sp: PetSpecies) => `${PETS[sp].name} · Lv ${world.petLevel(world.pets.get(sp)!)}`;
  const showPet = () => {
    const pet = world.pet();
    if (petView && (!pet || petView.species !== pet.species)) {
      petView.dispose();
      petView = null;
      petChest = null;
    }
    if (pet && !petView) {
      petView = new PetView(pet.species, petLabel(pet.species));
      petView.target.set(pet.x, world.gen.height(pet.x, pet.z), pet.z);
      petView.snap();
      r.scene.add(petView.root);
      petChest = Spells.anchor(petView.root, 0.8);
    }
  };
  showPet();
  const ALL_SKILLS = new Map<string, SkillDef>(
    [...Object.values(CLASS_SKILLS).flat(), ...PET_IDS.flatMap((sp) => PETS[sp].skills)].map((d) => [d.id, d]),
  );

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
  // impact feedback: camera shake and a brief freeze ("hit-stop") of animations and effects on
  // big hits. rollshade shakes the camera on its own hits (its `feel`); these are ours.
  let hitStop = 0;
  const impact = (strength: number, stop = 0) => {
    if (prefs.shake && strength > 0) r.fx.shake(strength);
    if (stop > 0) r.fx.hitStop(stop);
    hitStop = Math.max(hitStop, stop);
  };
  /** Freezes on a spell's first hit, but only when it lands near a living enemy. */
  const landed = (point: THREE.Vector3, stop: number) => {
    if ([...world.enemies.values()].some((e) => e.alive && Math.hypot(e.x - point.x, e.z - point.z) < 3)) impact(0, Math.min(stop, 0.12));
  };
  const nearestEnemy = (x: number, z: number) => {
    let best: Enemy | null = null;
    for (const e of world.enemies.values()) if (e.alive && (!best || Math.hypot(e.x - x, e.z - z) < Math.hypot(best.x - x, best.z - z))) best = e;
    return best;
  };
  const FLOAT_SFX: Record<string, Sfx> = { '': 'hit', crit: 'crit', player: 'hurt', heal: 'potion', gain: 'pickup', pet: 'hit', shield: 'equip' };
  world.onEvent = (e: WorldEvent) => {
    switch (e.type) {
      case 'float':
        floatText(e.x, e.z, e.text, e.style);
        if (e.style !== 'pet') sfxAt(FLOAT_SFX[e.style], e.x, e.z);
        if (e.style === 'crit') impact(0.15, 0.05);
        if (e.style === 'player') impact(0.2);
        if (e.style === 'shield' && e.text !== 'Dodged') {
          const from = nearestEnemy(e.x, e.z);
          if (from) spells.shieldHit(from);
        }
        break;
      case 'dodge': {
        hero.play('Dodge_Forward');
        spells.dodge(CLASS_ELEMENT[cls], heroChest, e.x, e.z, e.facing);
        audio.play('dash');
        break;
      }
      case 'skill': {
        const def = ALL_SKILLS.get(e.id);
        if (e.who === 'player' && e.clip) hero.play(e.clip);
        const mine = e.who === 'player';
        const caster = mine ? heroChest : petChest ?? heroChest;
        const target = e.tx !== undefined && e.tz !== undefined ? { x: e.tx, z: e.tz } : null;
        let move: ReturnType<Spells['skill']> = null;
        if (e.kind === 'chain') spells.chain(e.element, caster, e.points ?? []);
        else move = spells.skill(e.id, e.element, caster, target, e.facing, e.radius, { x: e.x, z: e.z }, heroChest);
        if (mine) move?.on('hit', (hit) => hit.index === 0 && landed(hit.point, hit.hitStop));
        // the cast's own sound; the blast of a bolt sounds when it lands
        switch (e.kind) {
          case 'nova': sfxAt(e.element === 'frost' ? 'frost' : 'nova', e.x, e.z); break;
          case 'cone': sfxAt('slash', e.x, e.z); break;
          case 'bolt':
            sfxAt(e.element === 'fire' ? 'fireball' : 'zap', e.x, e.z);
            move?.on('hit', (hit) => hit.index === 0 && sfxAt('explosion', hit.point.x, hit.point.z));
            break;
          case 'dash': sfxAt('dash', e.tx ?? e.x, e.tz ?? e.z); break;
          case 'meteor': sfxAt('fireball', e.x, e.z); break;
          case 'chain': sfxAt('lightning', e.x, e.z); break;
          case 'buff': sfxAt(def?.effect.kind === 'buff' && def.effect.shield ? 'shield' : 'buff', e.x, e.z); break;
          case 'heal': sfxAt('heal', e.x, e.z); break;
          case 'taunt': sfxAt('taunt', e.x, e.z); break;
        }
        break;
      }
      case 'skill-impact':
        // the meteor's first strike: rollshade draws it, this is the sound and the freeze
        sfxAt('explosion', e.x, e.z);
        impact(0, 0.1);
        break;
      case 'pet-summon': {
        showPet();
        const pet = world.pet();
        if (pet && petChest) spells.burst(PETS[pet.species].element, petChest);
        break;
      }
      case 'pet-dismiss':
        petView?.dispose();
        petView = null;
        petChest = null;
        break;
      case 'pet-attack':
        if (PETS[e.species].look === 'sprite') {
          if (petChest) spells.shot(PETS[e.species].element, petChest, spells.at(e.tx, e.tz), 0.5);
          sfxAt('pet-zap', e.x, e.z);
        } else sfxAt('swing', e.x, e.z);
        break;
      case 'pet-down': toast('Your pet was knocked out'); break;
      case 'pet-up': {
        const pet = world.pet();
        if (pet && petChest) spells.burst(PETS[pet.species].element, petChest);
        toast('Your pet is back on its feet');
        break;
      }
      case 'pet-level':
        toast(`${PETS[e.species].name} reached level ${e.level}: new pet skill point`);
        audio.play('levelup');
        petView?.setLabel(petLabel(e.species));
        break;
      case 'gear': if (e.how === 'drop') sfxAt('pickup', world.player.x, world.player.z); break;
      case 'sound': sfxAt(e.name, e.x, e.z); break;
      case 'feed': feed(e.text); break;
      case 'toast': toast(e.text); break;
      case 'level':
        toast(e.skill === 'combat' ? `Combat level ${e.level}: new skill point (Skills, K)` : `${SKILLS[e.skill].name} reached level ${e.level}!`);
        feed(`${SKILLS[e.skill].icon} ${SKILLS[e.skill].name} level ${e.level}`);
        hero.play('Cheer');
        audio.play('levelup');
        break;
      case 'resources': r.rebuildResources(); break;
      case 'structures': r.buildStructures(); break;
      case 'enemy-added': addEnemyView(e.enemy); break;
      case 'enemy-removed': {
        const ev = enemyViews.get(e.id);
        enemyViews.delete(e.id);
        if (!ev) break;
        // night wanderers leave the world as they fall: burn them away, then let go of the view
        if (ev.view.root.parent && ev.view.root.visible && !ev.dissolving) {
          ev.dissolving = true;
          ev.view.plate.style.visibility = 'hidden';
          spells.dissolve(ev.view.root, () => ev.view.dispose());
        } else {
          spells.clear(ev.view.root);
          ev.view.dispose();
        }
        break;
      }
      case 'gather-hit':
        hero.play(gatherClip);
        // the tool lands about a third of a second into the swing
        sfxAt(e.node.kind === 'tree' ? 'chop' : 'mine', e.node.x, e.node.z, 350);
        break;
      case 'player-attack': {
        const finisher = e.combo === 2;
        hero.play(COMBO_CLIPS[cls][e.combo] ?? clsDef.attackClip);
        audio.play(clsDef.ranged ? 'zap' : finisher ? 'slash' : 'swing');
        const p = world.player;
        if (clsDef.ranged) {
          spawnBolt(hero.root.position, e.facing, clsDef.range, '#7fd4ff');
          if (finisher) spells.shot('arcane', heroChest, spells.at(p.x + Math.sin(e.facing) * clsDef.range, p.z + Math.cos(e.facing) * clsDef.range), 0.9);
        } else {
          spells.swing(finisher ? 'holy' : CLASS_ELEMENT[cls], heroChest, e.facing, Math.min(2, clsDef.range), finisher);
        }
        if (finisher) impact(0.25, 0.06);
        break;
      }
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
  const castSkill = (i: number) => {
    if (build || document.querySelector('.modal:not(.hidden)')) return;
    const err = world.useSkill(i, aimFacing());
    if (err && err !== 'cooldown') toast(err, 'error');
  };
  /** Rolls the way you are steering, or the way you face when standing still. */
  const doDodge = () => {
    if (build || document.querySelector('.modal:not(.hidden)')) return;
    const m = input.move();
    const facing = Math.hypot(m.x, m.z) > 0.1 ? Math.atan2(m.x, m.z) : world.player.facing;
    const err = world.dodge(facing);
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
    $('hotbar').hidden = false;
  };
  const startBuild = (type: StructureId) => {
    closePanels();
    build = { type, rot: 0, x: 0, z: 0, ok: false };
    r.setGhost(type);
    $('build-bar').hidden = false;
    $('hotbar').hidden = true;
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
  const panels = ['inventory', 'crafting', 'build', 'skills', 'gear', 'pets', 'map', 'menu'] as const;
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
        const out = rec.gear
          ? { icon: gearIcon(rec.gear, 0, 40), name: GEAR[rec.gear].name,
            desc: `${SLOTS[GEAR[rec.gear].slot].name} gear: ${statLine(GEAR[rec.gear].base)}. Higher crafting can make finer pieces.` }
          : { icon: ITEMS[rec.output!].icon, name: ITEMS[rec.output!].name, desc: ITEMS[rec.output!].desc };
        row.innerHTML = `<div class="ico">${out.icon}</div><div class="body"><b>${esc(out.name)}${rec.count > 1 ? ` ×${rec.count}` : ''}</b>
          <small>${esc(out.desc)}${needs ? ` Needs: ${esc(needs)}.` : ''}</small>
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
      const points = world.skillPoints();
      $('skill-points').textContent = points > 0 ? `${points} point${points > 1 ? 's' : ''} to spend` : 'no points to spend';
      const list = $('ability-list');
      list.innerHTML = '';
      world.classSkills().forEach((def, i) => {
        const rank = world.skillRank(def.id);
        const problem = world.canLearn(def.id);
        list.appendChild(skillRow(def, rank, `Key ${i + 1}`, 'player', problem, () => {
          const err = world.learnSkill(def.id);
          if (err) toast(err, 'error');
          drawHotbar();
          renderPanel('skills');
        }, `combat level ${def.unlock}`));
      });
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
    if (p === 'gear') renderGear();
    if (p === 'pets') renderPets();
    if (p === 'map') drawMap($<HTMLCanvasElement>('world-map'), 1);
  }

  // ---- shared panel helpers
  const statLine = (m: Mods) => Object.entries(m).map(([id, v]) => formatStat(id as StatId, v ?? 0)).join(', ');
  const pctText = (v: number) => `${Math.round(v * 1000) / 10}%`;
  function effectText(fx: Effect, rank: number, who: 'player' | 'pet') {
    const k = rankScale(rank || 1);
    const of = (m: number) => `${Math.round(m * k * 100)}% ${who === 'player' ? 'of your' : 'of its'} damage`;
    const extra = (o: { stun?: number; slow?: number; burn?: number }) =>
      `${o.stun ? `, stuns ${o.stun / 1000} s` : ''}${o.slow ? `, slows ${o.slow / 1000} s` : ''}${o.burn ? `, burns ${o.burn / 1000} s` : ''}`;
    switch (fx.kind) {
      case 'nova': return `${of(fx.mult)} within ${fx.radius} m${fx.at === 'target' ? ' of its target' : ''}${extra(fx)}`;
      case 'cone': return `${of(fx.mult)} in front, ${fx.range} m${extra(fx)}${fx.execute ? `, double below ${fx.execute * 100}% health` : ''}`;
      case 'bolt': return `${of(fx.mult)}, explodes over ${fx.blast} m${extra(fx)}`;
      case 'dash': return `${fx.distance} m dash, ${of(fx.mult)} to everything passed${fx.blast ? ` and within ${fx.blast} m of the landing` : ''}`;
      case 'meteor': return `${of(fx.mult)} within ${fx.radius} m after ${fx.delay / 1000} s${extra(fx)}`;
      case 'chain': return `${of(fx.mult)}, jumps to ${fx.jumps} more enemies${extra(fx)}`;
      case 'buff': {
        const mods: Mods = {};
        for (const [id, v] of Object.entries(fx.mods)) mods[id as StatId] = (v ?? 0) * k;
        const parts = [statLine(mods), fx.shield ? `absorbs ${Math.round(fx.shield * k)} damage` : ''].filter(Boolean).join(', ');
        return `${parts} for ${fx.duration / 1000} s${fx.party ? ' (you and your pet)' : ''}`;
      }
      case 'heal': return `heals ${Math.round(fx.pct * k * 100)}% of your health${fx.party ? ' and the pet\'s' : ''}`;
      case 'taunt': return `enemies within ${fx.radius} m attack it for ${((fx.duration * k) / 1000).toFixed(1)} s`;
    }
  }
  function skillRow(def: SkillDef, rank: number, tag: string, who: 'player' | 'pet', problem: string | null, learn: () => void, unlockText: string) {
    const row = document.createElement('div');
    row.className = `entry ability ${rank ? '' : 'locked'}`;
    const pips = Array.from({ length: def.maxRank }, (_, i) => (i < rank ? '●' : '<i>●</i>')).join('');
    row.innerHTML = `<div class="ico">${skillIcon(def.glyph, def.element, 44, !rank)}</div><div class="body"><b>${esc(def.name)} <span class="pips">${pips}</span></b>
      <small>${esc(def.desc)} ${esc(effectText(def.effect, rank, who))}. Cooldown ${def.cooldown / 1000} s.${tag ? ` ${esc(tag)}.` : ''}</small>
      ${!rank ? `<small>Unlocks at ${esc(unlockText)}.</small>` : ''}</div>`;
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = rank ? (rank >= def.maxRank ? 'Max' : 'Upgrade') : 'Learn';
    btn.disabled = !!problem;
    btn.title = problem ?? '';
    btn.onclick = learn;
    row.appendChild(btn);
    return row;
  }

  // ---- character and gear panel
  let selectedGear: string | null = null;
  function renderGear() {
    const slots = $('equip-slots');
    slots.innerHTML = '';
    for (const slot of SLOT_IDS) {
      const uid = world.player.equipped[slot];
      const item = uid ? world.player.gear.find((g) => g.uid === uid) : undefined;
      const b = document.createElement('button');
      b.className = `equip-slot ${item && item.uid === selectedGear ? 'selected' : ''}`;
      b.title = item ? GEAR[item.base].name : `${SLOTS[slot].name}: empty`;
      b.innerHTML = `${item ? gearIcon(item.base, item.rarity, 52) : slotIcon(SLOTS[slot].glyph, 52)}<span>${SLOTS[slot].name}</span>`;
      b.onclick = () => {
        selectedGear = item?.uid ?? null;
        renderGear();
      };
      slots.appendChild(b);
    }
    const st = world.stats();
    const rows: [string, string][] = [
      ['Max health', String(world.maxHp())],
      ['Damage per hit', String(Math.round(world.attackDamage(st)))],
      ['Attacks per second', (1000 / world.attackCooldown(st)).toFixed(2)],
      ['Critical chance', pctText(world.critChance(st))],
      ['Armor', `${Math.round(st.armor ?? 0)} (−${Math.round((1 - armorFactor(st.armor ?? 0)) * 100)}% damage)`],
      ['Move speed', `${world.moveSpeed(st).toFixed(1)} m/s`],
      ['Health per second', (st.regen ?? 0).toFixed(1)],
      ['Life steal', pctText(st.lifesteal ?? 0)],
      ['Skill power', pctText(st.power ?? 0)],
      ['Pet power', pctText(st.petPower ?? 0)],
    ];
    $('stat-list').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const bag = world.player.gear.filter((g) => !world.isEquipped(g.uid))
      .sort((a, b) => SLOT_IDS.indexOf(GEAR[a.base].slot) - SLOT_IDS.indexOf(GEAR[b.base].slot) || b.rarity - a.rarity || b.ilvl - a.ilvl);
    $('bag-count').textContent = `${bag.length} / ${BAG_SIZE}`;
    const grid = $('gear-bag');
    grid.innerHTML = '';
    for (const item of bag) {
      const b = document.createElement('button');
      b.className = item.uid === selectedGear ? 'selected' : '';
      b.title = `${RARITIES[item.rarity].name} ${GEAR[item.base].name}`;
      b.innerHTML = gearIcon(item.base, item.rarity, 48);
      b.onclick = () => {
        selectedGear = item.uid;
        renderGear();
      };
      grid.appendChild(b);
    }
    for (let i = bag.length; i < BAG_SIZE; i++) grid.insertAdjacentHTML('beforeend', '<div class="empty"></div>');
    renderGearDetail();
  }
  function renderGearDetail() {
    const box = $('gear-detail');
    const item = selectedGear ? world.player.gear.find((g) => g.uid === selectedGear) : undefined;
    if (!item) {
      box.innerHTML = '<p class="muted small">Pick a piece of gear to see it. Skeletons drop gear and ruin chests always hold some; better pieces have extra stats.</p>';
      return;
    }
    const def = GEAR[item.base];
    const worn = world.isEquipped(item.uid);
    const current = world.equippedItems().find((g) => GEAR[g.base].slot === def.slot && g.uid !== item.uid);
    const ids = new Set([...Object.keys(item.stats), ...Object.keys(current?.stats ?? {})]) as Set<StatId>;
    const lines = [...ids].map((id) => {
      const v = item.stats[id] ?? 0;
      const delta = current ? v - (current.stats[id] ?? 0) : 0;
      const cmp = current && Math.abs(delta) > 1e-6
        ? ` <span class="${delta > 0 ? 'up' : 'down'}">(${delta > 0 ? '+' : '−'}${STATS[id].pct ? pctText(Math.abs(delta)) : Math.round(Math.abs(delta) * 10) / 10})</span>`
        : '';
      return v ? `<li>${esc(formatStat(id, v))}${cmp}</li>` : `<li class="muted">${esc(STATS[id].name)} —${cmp}</li>`;
    });
    box.innerHTML = `<div class="head">${gearIcon(item.base, item.rarity, 56)}<div><b style="color:${RARITIES[item.rarity].css}">${esc(def.name)}</b>
      <div class="muted small">${RARITIES[item.rarity].name} ${SLOTS[def.slot].name.toLowerCase()} · item level ${item.ilvl}${worn ? ' · equipped' : ''}</div></div></div>
      <ul>${lines.join('')}</ul>${current && !worn ? '<p class="muted small">Compared with what you wear now.</p>' : ''}<div class="row"></div>`;
    const row = box.querySelector('.row')!;
    const act = (label: string, cls: string, fn: () => string | null) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.onclick = () => {
        const err = fn();
        if (err) toast(err, 'error');
        renderGear();
      };
      row.appendChild(b);
    };
    if (worn) act('Unequip', 'ghost', () => world.unequip(def.slot));
    else act('Equip', 'primary', () => world.equip(item.uid));
    act(`Salvage (+${world.gearValue(item)} gold)`, 'ghost danger', () => {
      const err = world.salvage(item.uid);
      if (!err) selectedGear = null;
      return err;
    });
  }

  // ---- pets panel
  let openPet: PetSpecies | null = world.activePet;
  function renderPets() {
    const list = $('pet-list');
    list.innerHTML = '';
    for (const sp of PET_IDS) {
      const def = PETS[sp];
      const pet = world.pets.get(sp);
      const card = document.createElement('div');
      card.className = `pet-card ${world.activePet === sp ? 'active' : ''}`;
      let info: string;
      if (pet) {
        const lvl = world.petLevel(pet);
        const from = petXpForLevel(lvl);
        const to = petXpForLevel(lvl + 1);
        const down = pet.hp <= 0 ? ` · knocked out, back in ${Math.max(0, Math.ceil((pet.downUntil - Date.now()) / 1000))} s` : '';
        info = `<small>Level ${lvl} · ${Math.ceil(pet.hp)} / ${world.petMaxHp(pet)} health${down}</small>
          <div class="bar xp"><div style="width:${Math.round(((pet.xp - from) / Math.max(1, to - from)) * 100)}%"></div></div>
          <small>Aura ${esc(def.aura.name)}: ${esc(statLine(world.petAura(pet)))} for you while it is out.</small>`;
      } else {
        info = `<small>Bond it with a ${ITEMS[def.charm].icon} ${esc(ITEMS[def.charm].name.toLowerCase())} (you have ${world.count(def.charm)}). Craft one at a ${
          RECIPES.find((r) => r.output === def.charm)?.station ?? 'workbench'}.</small><small>Aura ${esc(def.aura.name)}: ${esc(statLine(def.aura.base))}, growing with its level.</small>`;
      }
      card.innerHTML = `<div class="top">${skillIcon(def.glyph, def.element, 56, !pet)}<div class="body"><b>${esc(def.name)} <span class="muted">${def.role}</span></b>
        <small>${esc(def.desc)}</small>${info}</div><div class="actions"></div></div>`;
      const actions = card.querySelector('.actions')!;
      const button = (label: string, cls: string, fn: () => string | null, disabled = false) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = label;
        b.disabled = disabled;
        b.onclick = () => {
          const err = fn();
          if (err) toast(err, 'error');
          renderPets();
        };
        actions.appendChild(b);
      };
      if (!pet) button('Bond', 'primary', () => world.bondPet(sp), world.count(def.charm) <= 0);
      else {
        if (world.activePet === sp) button('Dismiss', 'ghost', () => world.summonPet(null));
        else button('Summon', 'primary', () => world.summonPet(sp));
        const pts = world.petSkillPoints(pet);
        button(`Skills${pts > 0 ? ` (${pts})` : ''}`, 'ghost', () => {
          openPet = openPet === sp ? null : sp;
          return null;
        });
      }
      if (pet && openPet === sp) {
        const skills = document.createElement('div');
        skills.className = 'skills';
        for (const sk of def.skills) {
          skills.appendChild(skillRow(sk, pet.skills[sk.id] ?? 0, '', 'pet', world.canLearnPetSkill(sp, sk.id), () => {
            const err = world.learnPetSkill(sp, sk.id);
            if (err) toast(err, 'error');
            renderPets();
          }, `pet level ${sk.unlock}`));
        }
        card.appendChild(skills);
      }
      list.appendChild(card);
    }
  }

  // ---- hotbar
  const hotButtons = [...document.querySelectorAll<HTMLButtonElement>('#hotbar .hot:not(.dodge)')];
  const dodgeButton = $<HTMLButtonElement>('btn-dodge');
  dodgeButton.innerHTML = `${skillIcon('dash', CLASS_ELEMENT[cls], 46)}<span class="key">⇧</span><span class="cd"></span>`;
  dodgeButton.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    doDodge();
  });
  function drawHotbar() {
    world.classSkills().forEach((def, i) => {
      const b = hotButtons[i];
      const rank = world.skillRank(def.id);
      b.innerHTML = `${skillIcon(def.glyph, def.element, 58, !rank)}<span class="key">${i + 1}</span>${rank ? `<span class="rank">${rank}</span>` : ''}<span class="cd"></span>`;
      b.title = `${def.name}${rank ? ` (rank ${rank})` : ': not learned yet'}. ${def.desc}`;
      b.setAttribute('aria-label', b.title);
      b.classList.toggle('locked', !rank);
    });
  }
  hotButtons.forEach((b, i) => b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    castSkill(i);
  }));
  drawHotbar();
  function updateHotbar(now: number) {
    world.classSkills().forEach((def, i) => {
      const left = world.cooldownLeft(def.id, now);
      const cd = hotButtons[i].querySelector<HTMLElement>('.cd');
      if (!cd) return;
      cd.style.setProperty('--cd', String(left / def.cooldown));
      cd.textContent = left > 0 ? String(Math.ceil(left / 1000)) : '';
      hotButtons[i].classList.toggle('ready', !!world.skillRank(def.id) && left === 0);
    });
    const left = world.dodgeCooldownLeft(now);
    const cd = dodgeButton.querySelector<HTMLElement>('.cd');
    if (cd) {
      cd.style.setProperty('--cd', String(left / 1200));
      cd.textContent = '';
    }
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
    if (k >= '1' && k <= '4') castSkill(Number(k) - 1);
    if (k === 'shift') doDodge();
    if (k === 'r' && build) build.rot += Math.PI / 4;
    const map: Record<string, Panel> = { i: 'inventory', c: 'crafting', b: 'build', g: 'gear', k: 'skills', p: 'pets', m: 'map' };
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
  const bloom = $<HTMLInputElement>('opt-bloom');
  bloom.checked = prefs.bloom;
  bloom.onchange = () => {
    prefs.bloom = bloom.checked;
    r.setBloom(prefs.bloom);
    savePrefs();
  };
  const shakeOpt = $<HTMLInputElement>('opt-shake');
  shakeOpt.checked = prefs.shake;
  shakeOpt.onchange = () => {
    prefs.shake = shakeOpt.checked;
    r.fx.feel = prefs.shake;
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
    // hit-stop: animations nearly freeze for a few frames, and so do rollshade's effects
    const animDt = hitStop > 0 || r.fx.hitStopping ? dt * 0.08 : dt;
    hitStop = Math.max(0, hitStop - dt);
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
    hero.update(animDt);
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
      // the fallen burn away (rollshade's dissolve) after the death animation, and fade back
      // in when they respawn
      if (!e.alive) {
        ev.diedAt ??= performance.now();
        if (!ev.dissolving && performance.now() - ev.diedAt > 900) {
          ev.dissolving = true;
          const root = ev.view.root;
          spells.dissolve(root, () => root.removeFromParent());
        }
      } else if (ev.diedAt !== undefined) {
        ev.diedAt = undefined;
        ev.dissolving = false;
        if (!ev.view.root.parent) r.scene.add(ev.view.root);
        spells.appear(ev.view.root);
      }
      if (e.attackSeq !== ev.seen.attack) {
        ev.view.play(ev.view.attackClip);
        if (e.kind === 'mage') spawnBolt(ev.view.root.position, e.facing, 8, '#b06cff');
      } else if (e.hitSeq !== ev.seen.hit && e.alive) ev.view.play('Hit_A');
      if (e.hitSeq !== ev.seen.hit) ev.flash = 1;
      if (ev.flash > 0 || ev.meshes[0]?.userData.flash) {
        ev.flash = Math.max(0, ev.flash - dt * 7);
        for (const m of ev.meshes) m.userData.flash = ev.flash; // HDR white, so the flash blooms
      }
      ev.seen = { attack: e.attackSeq, hit: e.hitSeq };
      ev.view.update(animDt);
    }
    // pet
    const pet = world.pet();
    if (petView && pet) {
      petView.target.set(pet.x, world.gen.height(pet.x, pet.z), pet.z);
      petView.facing = pet.facing;
      petView.moving = pet.moving;
      petView.setHealth(pet.hp, world.petMaxHp(pet));
      petView.update(animDt, pet.hp > 0, pet.attackSeq, pet.hitSeq);
    }
    // statuses follow the sim: burning, slowed (ice up to the knees) and stunned enemies, the
    // hero's shield and the aura of the newest buff
    const nowMs = Date.now();
    for (const [id, ev] of enemyViews) {
      const e = world.enemies.get(id);
      if (!e || !e.alive || !ev.view.root.visible || ev.dissolving) spells.clear(ev.view.root);
      else spells.reconcile(ev.view.root, { burn: !!e.burn, freeze: e.slowUntil > nowMs, stun: e.stunUntil > nowMs });
    }
    const shield = p.alive && p.shield && p.shield.until > nowMs ? p.shield.amount / Math.max(1, p.shield.max) : 0;
    spells.heroShield(hero.root, shield, 'arcane');
    spells.heroAura(hero.root, p.alive ? p.buffs.filter((b) => b.until > nowMs).at(-1)?.element ?? null : null);
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
    // (camera shake is applied by rollshade inside render, and undone after it)
    r.camera.position.set(camTarget.x, camTarget.y + 15 * dist, camTarget.z + 11 * dist);
    r.camera.lookAt(camTarget.x, camTarget.y + 0.8, camTarget.z);
    r.updateDayNight(camTarget);
    r.render(dt);
    hero.placePlate(r.camera, w(), h());
    petView?.placePlate(r.camera, w(), h());
    for (const ev of enemyViews.values()) if (ev.view.root.visible) ev.view.placePlate(r.camera, w(), h());

    // HUD
    const cd = Math.min(1, (Date.now() - p.lastAttack) / world.attackCooldown());
    $('hud-cd-fill').style.width = `${cd * 100}%`;
    hudTimer += dt;
    if (hudTimer > 0.1) {
      hudTimer = 0;
      const max = world.maxHp();
      $('hud-hp-fill').style.width = `${(p.hp / max) * 100}%`;
      $('hud-shield-fill').style.width = `${Math.min(100, ((p.shield?.amount ?? 0) / max) * 100)}%`;
      const now = Date.now();
      $('hud-buffs').innerHTML = p.buffs.filter((b) => b.until > now)
        .map((b) => `<span class="buff" title="${esc(b.name)}">${skillIcon(b.glyph, b.element, 22)}<b>${Math.ceil((b.until - now) / 1000)}</b></span>`).join('');
      updateHotbar(now);
      const pet = world.pet();
      $('hud-pet').hidden = !pet;
      if (pet) {
        const def = PETS[pet.species];
        const icon = $('hud-pet-icon');
        if (icon.dataset.species !== pet.species) {
          icon.dataset.species = pet.species;
          icon.innerHTML = skillIcon(def.glyph, def.element, 24);
        }
        $('hud-pet-name').textContent = pet.hp > 0 ? `${def.name} · Lv ${world.petLevel(pet)}` : `${def.name} · back in ${Math.max(0, Math.ceil((pet.downUntil - now) / 1000))} s`;
        $('hud-pet-fill').style.width = `${(pet.hp / world.petMaxHp(pet)) * 100}%`;
        petView?.setLabel(petLabel(pet.species));
      }
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
    spells,
    backend: r.backend(),
    pet: () => petView,
    snapshot: () => ({
      x: world.player.x, z: world.player.z, hp: world.player.hp, alive: world.player.alive, gold: world.player.gold,
      inv: { ...world.player.inv }, xp: { ...world.player.xp }, gathering: !!world.player.gather, structures: world.structures.length,
      target: world.interactTarget()?.type ?? null, chunks: r.pendingChunks(), drawCalls: r.drawCalls(),
      skills: { ...world.player.skills }, points: world.skillPoints(), gear: world.player.gear.length,
      equipped: { ...world.player.equipped }, maxHp: world.maxHp(), damage: world.attackDamage(),
      pet: world.pet() ? { species: world.pet()!.species, level: world.petLevel(world.pet()!), hp: world.pet()!.hp, x: world.pet()!.x, z: world.pet()!.z, xp: world.pet()!.xp } : null,
    }),
  };
}

void boot();
