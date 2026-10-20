// Open-world rules for the single-player build: movement and collision, gathering,
// crafting, building, combat, enemy AI, day/night, regrowth and saving. It owns the
// game state; the renderer only reads it and listens to events. Written to be portable
// to a SpacetimeDB module later (state is plain data, time comes from the caller).
import { CLASSES, type ClassId } from '../map';
import {
  ENEMY_KINDS, ITEMS, RECIPES, RESOURCES, SKILL_IDS, STRUCTURES, TOOL_SPEED, levelFromXp,
  type EnemyKind, type ItemId, type Recipe, type SkillId, type StationId, type StructureId,
} from './content';
import { mulberry32 } from './noise';
import { CHUNK, VILLAGE_RADIUS, WORLD_HALF, WorldGen, type Placed, type ResourceNode } from './terrain';

export const SAVE_KEY = 'kaykit-world.save.v1';
const TICK_MS = 50;
const DAY_MS = 8 * 60_000; // one full day/night cycle
const PLAYER_RADIUS = 0.45;
const ENEMY_RADIUS = 0.55;
const RESPAWN_MS = 5_000;
const CHEST_COOLDOWN_MS = 10 * 60_000;
const INTERACT_RANGE = 2.6;

export interface Structure {
  id: string;
  type: StructureId;
  x: number;
  z: number;
  rot: number;
}

export interface PlayerState {
  name: string;
  cls: ClassId;
  x: number;
  z: number;
  facing: number;
  moving: boolean;
  hp: number;
  alive: boolean;
  respawnAt: number;
  lastAttack: number;
  lastHurt: number;
  gold: number;
  inv: Partial<Record<ItemId, number>>;
  xp: Record<SkillId, number>;
  home: { x: number; z: number } | null;
  /** Ongoing gathering: which node, when the current hit completes and how long a hit takes. */
  gather: { id: string; endsAt: number; duration: number } | null;
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  level: number;
  ruin: string | null;
  spawnX: number;
  spawnZ: number;
  x: number;
  z: number;
  facing: number;
  moving: boolean;
  hp: number;
  maxHp: number;
  alive: boolean;
  respawnAt: number;
  lastAttack: number;
  engaged: boolean;
  attackSeq: number;
  hitSeq: number;
}

export type WorldEvent =
  | { type: 'float'; x: number; z: number; text: string; style: '' | 'crit' | 'player' | 'heal' | 'gain' }
  | { type: 'feed'; text: string }
  | { type: 'toast'; text: string }
  | { type: 'level'; skill: SkillId; level: number }
  | { type: 'resources' }
  | { type: 'structures' }
  | { type: 'enemy-added'; enemy: Enemy }
  | { type: 'enemy-removed'; id: number }
  | { type: 'gather-hit'; node: ResourceNode }
  | { type: 'player-attack'; facing: number }
  | { type: 'enemy-attack'; enemy: Enemy }
  | { type: 'death' }
  | { type: 'respawn' };

interface SaveData {
  v: 1;
  seed: number;
  player: Omit<PlayerState, 'gather' | 'moving' | 'lastAttack' | 'lastHurt'>;
  nodes: Record<string, { hits: number; regrowAt: number }>;
  structures: Structure[];
  chests: Record<string, number>;
  dayOffset: number;
}

const facingTo = (dx: number, dz: number) => Math.atan2(dx, dz);
function angleDiff(a: number, b: number) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class OpenWorld {
  readonly gen: WorldGen;
  player: PlayerState;
  enemies = new Map<number, Enemy>();
  structures: Structure[] = [];
  /** Hits taken by resource nodes; a node is depleted while regrowAt is in the future. */
  nodes = new Map<string, { hits: number; regrowAt: number }>();
  chests = new Map<string, number>();
  private chunkCache = new Map<string, ResourceNode[]>();
  private nextEnemyId = 1;
  private input = { dx: 0, dz: 0 };
  private inputLog: { t: number; dx: number; dz: number }[] = [];
  private lastTick = performance.now();
  private timer: number | undefined;
  private lastSave = 0;
  private lastNightSpawn = 0;
  private dayOffset = 0;
  private rnd = mulberry32(Date.now() & 0xffffffff);
  onEvent: (e: WorldEvent) => void = () => {};

  constructor(seed: number, name: string, cls: ClassId, saved?: SaveData | null) {
    this.gen = new WorldGen(seed);
    const skills = Object.fromEntries(SKILL_IDS.map((s) => [s, 0])) as Record<SkillId, number>;
    this.player = {
      name, cls, x: 0, z: 7, facing: Math.PI, moving: false, hp: CLASSES[cls].hp, alive: true, respawnAt: 0,
      lastAttack: 0, lastHurt: 0, gold: 0, inv: { potion: 1 }, xp: skills, home: null, gather: null,
    };
    this.dayOffset = 0.3 * DAY_MS - (Date.now() % DAY_MS); // a new game starts in the morning
    if (saved && saved.seed === seed) {
      this.player = { ...this.player, ...saved.player, xp: { ...skills, ...saved.player.xp }, gather: null, cls };
      this.nodes = new Map(Object.entries(saved.nodes));
      this.structures = saved.structures;
      this.chests = new Map(Object.entries(saved.chests));
      this.dayOffset = saved.dayOffset;
    }
    this.player.name = name;
    this.player.hp = Math.min(this.player.hp, this.maxHp());
    for (const ruin of this.gen.ruins) {
      for (const s of ruin.spawns) this.addEnemy(s.kind, ruin.level, s.x, s.z, ruin.id);
    }
  }

  static load(): SaveData | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? (JSON.parse(raw) as SaveData) : null;
    } catch {
      return null;
    }
  }

  static clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  }

  save() {
    const { gather: _g, moving: _m, lastAttack: _a, lastHurt: _h, ...player } = this.player;
    const data: SaveData = {
      v: 1, seed: this.gen.seed, player, nodes: Object.fromEntries(this.nodes), structures: this.structures,
      chests: Object.fromEntries(this.chests), dayOffset: this.dayOffset,
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      /* storage full or blocked: progress just isn't kept */
    }
  }

  start() {
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    this.save();
  }

  // ---------------------------------------------------------------- queries

  /** Fraction of the day in [0, 1): 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  dayTime(now = Date.now()) {
    return ((((now + this.dayOffset) % DAY_MS) + DAY_MS) % DAY_MS) / DAY_MS;
  }
  isNight(now = Date.now()) {
    const t = this.dayTime(now);
    return t < 0.22 || t > 0.78;
  }

  level(skill: SkillId) {
    return levelFromXp(this.player.xp[skill]);
  }

  maxHp() {
    return CLASSES[this.player.cls].hp + 3 * (this.level('combat') - 1);
  }

  count(item: ItemId) {
    return this.player.inv[item] ?? 0;
  }

  nodesInChunk(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    let list = this.chunkCache.get(key);
    if (!list) {
      list = this.gen.chunkResources(cx, cz);
      this.chunkCache.set(key, list);
    }
    return list;
  }

  nodesNear(x: number, z: number, r: number): ResourceNode[] {
    const out: ResourceNode[] = [];
    for (let cx = Math.floor((x - r) / CHUNK); cx <= Math.floor((x + r) / CHUNK); cx++) {
      for (let cz = Math.floor((z - r) / CHUNK); cz <= Math.floor((z + r) / CHUNK); cz++) {
        for (const n of this.nodesInChunk(cx, cz)) if ((n.x - x) ** 2 + (n.z - z) ** 2 <= r * r) out.push(n);
      }
    }
    return out;
  }

  isDepleted(id: string, now = Date.now()) {
    const s = this.nodes.get(id);
    return !!s && s.regrowAt > now;
  }

  nodeRadius(n: ResourceNode) {
    return RESOURCES[n.kind].radius * (n.kind === 'tree' ? n.scale / 3 : n.scale / 6);
  }

  /** Static placed objects (village + ruins) that collide. */
  private staticColliders(): Placed[] {
    if (!this._static) this._static = [...this.gen.village, ...this.gen.ruins.flatMap((r) => r.props)].filter((p) => p.radius > 0);
    return this._static;
  }
  private _static: Placed[] | null = null;

  blocked(x: number, z: number, r: number): boolean {
    if (Math.abs(x) > WORLD_HALF - 2 || Math.abs(z) > WORLD_HALF - 2) return true;
    if (this.gen.height(x, z) < -0.6) return true; // deep water
    for (const p of this.staticColliders()) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.radius + r) ** 2) return true;
    for (const s of this.structures) {
      const def = STRUCTURES[s.type];
      if (def.box) {
        // point vs rotated rectangle, expanded by r
        const c = Math.cos(-s.rot);
        const sn = Math.sin(-s.rot);
        const lx = (x - s.x) * c - (z - s.z) * sn;
        const lz = (x - s.x) * sn + (z - s.z) * c;
        if (Math.abs(lx) < def.box[0] + r && Math.abs(lz) < def.box[1] + r) return true;
      } else if (def.radius > 0 && (s.x - x) ** 2 + (s.z - z) ** 2 < (def.radius + r) ** 2) return true;
    }
    const now = Date.now();
    for (const n of this.nodesNear(x, z, r + 2.5)) {
      if (this.isDepleted(n.id, now)) continue;
      if ((n.x - x) ** 2 + (n.z - z) ** 2 < (this.nodeRadius(n) + r) ** 2) return true;
    }
    return false;
  }

  slide(x: number, z: number, dx: number, dz: number, r: number): [number, number] {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.3));
    for (let i = 0; i < steps; i++) {
      if (!this.blocked(x + dx / steps, z, r)) x += dx / steps;
      if (!this.blocked(x, z + dz / steps, r)) z += dz / steps;
    }
    return [x, z];
  }

  steer(x: number, z: number, tx: number, tz: number, step: number, r: number): [number, number] {
    const dist = Math.hypot(tx - x, tz - z);
    if (dist < 1e-4) return [x, z];
    const dx = (tx - x) / dist;
    const dz = (tz - z) / dist;
    const direct = this.slide(x, z, dx * step, dz * step, r);
    const moved = (p: [number, number]) => Math.hypot(p[0] - x, p[1] - z);
    if (moved(direct) >= step * 0.6) return direct;
    let best = direct;
    let bestD = Infinity;
    for (const a of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
      const s = Math.sin(a);
      const c = Math.cos(a);
      const p = this.slide(x, z, (dx * c - dz * s) * step, (dx * s + dz * c) * step, r);
      const d = (p[0] - tx) ** 2 + (p[1] - tz) ** 2;
      if (moved(p) >= step * 0.6 && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  inVillage(x: number, z: number) {
    return Math.hypot(x, z) < VILLAGE_RADIUS;
  }

  /** Crafting stations within reach (village workbench/forge count). */
  stationsNear(x: number, z: number): Set<StationId> {
    const out = new Set<StationId>();
    for (const p of this.gen.village) if (p.station && Math.hypot(p.x - x, p.z - z) < 8) out.add(p.station);
    for (const s of this.structures) {
      const st = STRUCTURES[s.type].station;
      if (st && Math.hypot(s.x - x, s.z - z) < 7) out.add(st);
    }
    return out;
  }

  /** What pressing the action key would do right now. */
  interactTarget(): { type: 'node'; node: ResourceNode } | { type: 'chest'; ruin: string; x: number; z: number } | null {
    const p = this.player;
    const now = Date.now();
    for (const r of this.gen.ruins) {
      if (Math.hypot(r.chest.x - p.x, r.chest.z - p.z) < INTERACT_RANGE && (this.chests.get(r.id) ?? 0) <= now) {
        return { type: 'chest', ruin: r.id, x: r.chest.x, z: r.chest.z };
      }
    }
    let best: ResourceNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodesNear(p.x, p.z, INTERACT_RANGE + 1.5)) {
      if (this.isDepleted(n.id, now)) continue;
      const d = Math.hypot(n.x - p.x, n.z - p.z) - this.nodeRadius(n);
      if (d < INTERACT_RANGE - 1 && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best ? { type: 'node', node: best } : null;
  }

  gatherSeconds(node: ResourceNode) {
    const def = RESOURCES[node.kind];
    let mult = 1;
    for (const [item, t] of Object.entries(TOOL_SPEED)) if (t && t.skill === def.skill && this.count(item as ItemId) > 0) mult = Math.max(mult, t.mult);
    return def.seconds / (mult * (1 + 0.04 * (this.level(def.skill) - 1)));
  }

  canCraft(r: Recipe): string | null {
    if (r.skill && this.level(r.skill.id) < r.skill.level) return `Needs ${r.skill.id} level ${r.skill.level}`;
    if (r.station && !this.stationsNear(this.player.x, this.player.z).has(r.station)) return `Needs a ${r.station} nearby`;
    for (const [item, n] of Object.entries(r.inputs)) if (this.count(item as ItemId) < (n ?? 0)) return 'Missing materials';
    return null;
  }

  canBuild(type: StructureId): string | null {
    const def = STRUCTURES[type];
    if (def.skill && this.level(def.skill.id) < def.skill.level) return `Needs ${def.skill.id} level ${def.skill.level}`;
    for (const [item, n] of Object.entries(def.cost)) if (this.count(item as ItemId) < (n ?? 0)) return 'Missing materials';
    return null;
  }

  placementProblem(type: StructureId, x: number, z: number): string | null {
    const def = STRUCTURES[type];
    const p = this.player;
    if (Math.hypot(x - p.x, z - p.z) > 10) return 'Too far away';
    if (this.inVillage(x, z)) return "Can't build inside the village";
    if (this.gen.height(x, z) < 0.3) return "Can't build in water";
    const r = def.box ? 0.4 : Math.max(0.5, def.radius);
    if (this.blocked(x, z, r)) return 'Something is in the way';
    if (Math.hypot(x - p.x, z - p.z) < r + PLAYER_RADIUS) return 'Step back first';
    return null;
  }

  // ---------------------------------------------------------------- actions (called by the UI)

  setInput(dx: number, dz: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    const len = Math.hypot(dx, dz);
    this.inputLog.push({ t: performance.now(), ...(len > 1 ? { dx: dx / len, dz: dz / len } : { dx, dz }) });
  }

  interact(): string | null {
    const p = this.player;
    if (!p.alive) return 'You are dead';
    const target = this.interactTarget();
    if (!target) return 'Nothing to use here';
    if (target.type === 'chest') return this.openChest(target.ruin);
    const def = RESOURCES[target.node.kind];
    if (def.needs && !def.needs.some((i) => this.count(i) > 0)) return `You need a ${ITEMS[def.needs[0]].name.toLowerCase()} to mine iron`;
    const duration = this.gatherSeconds(target.node) * 1000;
    p.gather = { id: target.node.id, endsAt: Date.now() + duration, duration };
    p.facing = facingTo(target.node.x - p.x, target.node.z - p.z);
    this.onEvent({ type: 'gather-hit', node: target.node });
    return null;
  }

  attack(facing: number): string | null {
    const p = this.player;
    if (!p.alive) return 'You are dead';
    const cls = CLASSES[p.cls];
    const now = Date.now();
    if (now - p.lastAttack < cls.cooldown) return 'cooldown';
    p.lastAttack = now;
    p.facing = facing;
    p.gather = null;
    this.onEvent({ type: 'player-attack', facing });
    const lvl = this.level('combat');
    const base = (cls.damage + (this.count('iron_sword') > 0 ? 12 : 0)) * (1 + 0.04 * (lvl - 1));
    const hits = [...this.enemies.values()].filter((e) => {
      if (!e.alive) return false;
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      if (cls.ranged) {
        const along = dx * Math.sin(facing) + dz * Math.cos(facing);
        return along > 0 && along <= cls.range && Math.abs(dx * Math.cos(facing) - dz * Math.sin(facing)) <= 1;
      }
      const dist = Math.hypot(dx, dz);
      return dist <= cls.range + ENEMY_RADIUS && (dist < 0.6 || Math.abs(angleDiff(facingTo(dx, dz), facing)) <= cls.arc);
    });
    if (cls.ranged) hits.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)).splice(1);
    for (const e of hits) {
      const crit = this.rnd() < 0.12;
      const dmg = Math.round(base * (crit ? 2 : 1));
      e.hp -= dmg;
      e.hitSeq++;
      e.engaged = true;
      this.onEvent({ type: 'float', x: e.x, z: e.z, text: `${dmg}${crit ? '!' : ''}`, style: crit ? 'crit' : '' });
      if (e.hp <= 0) this.killEnemy(e);
    }
    return null;
  }

  usePotion(): string | null {
    const p = this.player;
    if (!p.alive) return 'You are dead';
    if (this.count('potion') <= 0) return 'No potions left';
    if (p.hp >= this.maxHp()) return 'Already at full health';
    this.take({ potion: 1 });
    const healed = Math.min(50, this.maxHp() - p.hp);
    p.hp += healed;
    this.onEvent({ type: 'float', x: p.x, z: p.z, text: `+${healed}`, style: 'heal' });
    return null;
  }

  craft(id: string): string | null {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return 'Unknown recipe';
    const problem = this.canCraft(r);
    if (problem) return problem;
    this.take(r.inputs);
    this.give(r.output, r.count);
    this.addXp('crafting', r.xp);
    this.onEvent({ type: 'toast', text: `Crafted ${ITEMS[r.output].name}` });
    return null;
  }

  build(type: StructureId, x: number, z: number, rot: number): string | null {
    const def = STRUCTURES[type];
    const problem = this.canBuild(type) ?? this.placementProblem(type, x, z);
    if (problem) return problem;
    this.take(def.cost);
    this.structures.push({ id: `s${Date.now().toString(36)}${Math.floor(this.rnd() * 1e6).toString(36)}`, type, x, z, rot });
    if (def.respawn) this.player.home = { x, z };
    this.addXp('construction', def.xp);
    this.onEvent({ type: 'structures' });
    this.onEvent({ type: 'feed', text: `Built a ${def.name.toLowerCase()}${def.respawn ? ' (new respawn point)' : ''}` });
    this.save();
    return null;
  }

  // ---------------------------------------------------------------- internals

  private give(item: ItemId, n: number) {
    this.player.inv[item] = this.count(item) + n;
  }

  private take(items: Partial<Record<ItemId, number>>) {
    for (const [item, n] of Object.entries(items)) this.player.inv[item as ItemId] = this.count(item as ItemId) - (n ?? 0);
  }

  private addXp(skill: SkillId, xp: number) {
    const before = this.level(skill);
    this.player.xp[skill] += xp;
    const after = this.level(skill);
    if (after > before) this.onEvent({ type: 'level', skill, level: after });
  }

  private openChest(ruinId: string): string | null {
    const ruin = this.gen.ruins.find((r) => r.id === ruinId)!;
    const guards = [...this.enemies.values()].filter((e) => e.ruin === ruinId && e.alive && Math.hypot(e.x - ruin.x, e.z - ruin.z) < 14);
    if (guards.length) return `Defeat the ${guards.length} skeleton${guards.length > 1 ? 's' : ''} guarding this chest first`;
    this.chests.set(ruinId, Date.now() + CHEST_COOLDOWN_MS);
    const gold = 15 * ruin.level + Math.floor(this.rnd() * 10);
    this.player.gold += gold;
    const loot: Partial<Record<ItemId, number>> = { potion: 1, iron_ore: 1 + Math.floor(this.rnd() * 2) };
    if (ruin.level >= 2) loot.iron_ingot = 1;
    for (const [item, n] of Object.entries(loot)) this.give(item as ItemId, n ?? 0);
    const text = `Chest: +${gold} gold, ${Object.entries(loot).map(([i, n]) => `${n} ${ITEMS[i as ItemId].name.toLowerCase()}`).join(', ')}`;
    this.onEvent({ type: 'feed', text });
    this.onEvent({ type: 'float', x: ruin.chest.x, z: ruin.chest.z, text: `+${gold} gold`, style: 'gain' });
    this.save();
    return null;
  }

  private addEnemy(kind: EnemyKind, level: number, x: number, z: number, ruin: string | null) {
    const st = ENEMY_KINDS[kind];
    const maxHp = Math.round(st.maxHp * (1 + 0.5 * (level - 1)));
    const e: Enemy = {
      id: this.nextEnemyId++, kind, level, ruin, spawnX: x, spawnZ: z, x, z, facing: this.rnd() * 6.28, moving: false,
      hp: maxHp, maxHp, alive: true, respawnAt: 0, lastAttack: 0, engaged: false, attackSeq: 0, hitSeq: 0,
    };
    this.enemies.set(e.id, e);
    this.onEvent({ type: 'enemy-added', enemy: e });
    return e;
  }

  private killEnemy(e: Enemy) {
    const st = ENEMY_KINDS[e.kind];
    e.hp = 0;
    e.alive = false;
    e.moving = false;
    e.engaged = false;
    e.respawnAt = Date.now() + 45_000;
    const gold = st.gold * e.level;
    const bones = 1 + Math.floor(this.rnd() * 2);
    this.player.gold += gold;
    this.give('bone', bones);
    let extra = '';
    if (this.rnd() < 0.12) {
      this.give('potion', 1);
      extra = ', a health potion';
    }
    this.addXp('combat', st.xp * e.level);
    this.onEvent({ type: 'feed', text: `Defeated a level ${e.level} skeleton ${e.kind}: +${gold} gold, ${bones} bone${bones > 1 ? 's' : ''}${extra}` });
    if (!e.ruin) {
      // night wanderers do not come back
      this.enemies.delete(e.id);
      setTimeout(() => this.onEvent({ type: 'enemy-removed', id: e.id }), 2500);
    }
  }

  private hurtPlayer(dmg: number, source: string, now: number) {
    const p = this.player;
    if (!p.alive) return;
    p.hp -= dmg;
    p.lastHurt = now;
    p.gather = null;
    this.onEvent({ type: 'float', x: p.x, z: p.z, text: `-${dmg}`, style: 'player' });
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      p.moving = false;
      p.respawnAt = now + RESPAWN_MS;
      const lost = Math.floor(p.gold * 0.1);
      p.gold -= lost;
      this.input = { dx: 0, dz: 0 };
      this.inputLog = [];
      this.onEvent({ type: 'death' });
      this.onEvent({ type: 'feed', text: `You were slain by a skeleton ${source}${lost ? ` and dropped ${lost} gold` : ''}` });
    }
  }

  private tick() {
    // Replay elapsed time (up to 1 s) in steps of at most 50 ms, switching input exactly when
    // it changed, so movement does not depend on the frame rate.
    const end = performance.now();
    const now = Date.now();
    let t = Math.max(this.lastTick, end - 1000);
    while (t < end) {
      while (this.inputLog.length && this.inputLog[0].t <= t) this.input = this.inputLog.shift()!;
      const stepEnd = Math.min(end, t + TICK_MS, this.inputLog[0]?.t ?? Infinity);
      const dt = (stepEnd - t) / 1000;
      this.tickPlayer(dt, now);
      this.tickEnemies(dt, now);
      t = stepEnd;
    }
    while (this.inputLog.length) this.input = this.inputLog.shift()!;
    this.lastTick = end;
    this.tickGather(now);
    this.tickWorld(now);
    if (now - this.lastSave > 10_000) {
      this.lastSave = now;
      this.save();
    }
  }

  private tickPlayer(dt: number, now: number) {
    const p = this.player;
    if (!p.alive) {
      if (now >= p.respawnAt) {
        const spot = p.home ?? { x: 0, z: 7 };
        const [x, z] = this.freeSpotNear(spot.x, spot.z + 2.5);
        Object.assign(p, { x, z, alive: true, hp: this.maxHp() });
        this.onEvent({ type: 'respawn' });
      }
      return;
    }
    // regeneration: slow out of combat, faster in the village or next to your campfire
    if (now - p.lastHurt > 6000 && p.hp < this.maxHp()) {
      const nearFire = this.structures.some((s) => s.type === 'campfire' && Math.hypot(s.x - p.x, s.z - p.z) < 6);
      const rate = nearFire ? 5 : this.inVillage(p.x, p.z) ? 3 : 0.8;
      p.hp = Math.min(this.maxHp(), p.hp + rate * dt);
    }
    const { dx, dz } = this.input;
    if (dx === 0 && dz === 0) {
      p.moving = false;
      return;
    }
    p.gather = null;
    const speed = CLASSES[p.cls].speed;
    const [nx, nz] = this.slide(p.x, p.z, dx * speed * dt, dz * speed * dt, PLAYER_RADIUS);
    p.moving = Math.abs(nx - p.x) > 1e-4 || Math.abs(nz - p.z) > 1e-4;
    p.x = nx;
    p.z = nz;
    p.facing = facingTo(dx, dz);
  }

  private freeSpotNear(x: number, z: number): [number, number] {
    for (let r = 0; r < 12; r += 1.5) {
      for (let a = 0; a < 6.28; a += 0.8) {
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (!this.blocked(px, pz, PLAYER_RADIUS)) return [px, pz];
      }
    }
    return [0, 7];
  }

  private tickGather(now: number) {
    const p = this.player;
    const g = p.gather;
    if (!g || now < g.endsAt) return;
    const node = this.nodesNear(p.x, p.z, INTERACT_RANGE + 2).find((n) => n.id === g.id);
    if (!node || this.isDepleted(node.id, now)) {
      p.gather = null;
      return;
    }
    const def = RESOURCES[node.kind];
    const state = this.nodes.get(node.id) ?? { hits: 0, regrowAt: 0 };
    state.hits = state.regrowAt && state.regrowAt <= now ? 1 : state.hits + 1;
    state.regrowAt = 0;
    this.give(def.item, 1);
    this.addXp(def.skill, def.xp);
    this.onEvent({ type: 'float', x: node.x, z: node.z, text: `+1 ${ITEMS[def.item].name}`, style: 'gain' });
    if (state.hits >= def.hits) {
      state.regrowAt = now + def.regrowMs;
      state.hits = 0;
      this.nodes.set(node.id, state);
      p.gather = null;
      this.onEvent({ type: 'resources' });
      return;
    }
    this.nodes.set(node.id, state);
    // keep working on the same node
    p.gather = { id: node.id, endsAt: now + g.duration, duration: g.duration };
    this.onEvent({ type: 'gather-hit', node });
  }

  private tickWorld(now: number) {
    // regrowth
    let changed = false;
    for (const [id, s] of this.nodes) {
      if (s.regrowAt && s.regrowAt <= now) {
        this.nodes.delete(id);
        changed = true;
      }
    }
    if (changed) this.onEvent({ type: 'resources' });
    // ruin enemies respawn; night wanderers appear outside the village
    for (const e of this.enemies.values()) {
      if (!e.alive && e.ruin && now >= e.respawnAt && Math.hypot(e.spawnX - this.player.x, e.spawnZ - this.player.z) > 30) {
        Object.assign(e, { alive: true, hp: e.maxHp, x: e.spawnX, z: e.spawnZ, engaged: false });
      }
    }
    const p = this.player;
    const wanderers = [...this.enemies.values()].filter((e) => !e.ruin);
    if (this.isNight(now) && p.alive && !this.inVillage(p.x, p.z) && wanderers.length < 3 && now - this.lastNightSpawn > 15_000) {
      this.lastNightSpawn = now;
      const a = this.rnd() * Math.PI * 2;
      const x = p.x + Math.cos(a) * 24;
      const z = p.z + Math.sin(a) * 24;
      if (!this.blocked(x, z, ENEMY_RADIUS) && !this.inVillage(x, z) && this.gen.height(x, z) > 0.5) {
        const level = 1 + Math.floor(Math.hypot(x, z) / 140);
        const e = this.addEnemy(this.rnd() < 0.7 ? 'minion' : 'rogue', level, x, z, null);
        e.engaged = true;
        this.onEvent({ type: 'feed', text: 'Something stirs in the dark…' });
      }
    }
    for (const e of wanderers) {
      if (!this.isNight(now) || Math.hypot(e.x - p.x, e.z - p.z) > 90) {
        this.enemies.delete(e.id);
        this.onEvent({ type: 'enemy-removed', id: e.id });
      }
    }
  }

  private tickEnemies(dt: number, now: number) {
    const p = this.player;
    const target = p.alive && !this.inVillage(p.x, p.z) ? p : null;
    for (const e of this.enemies.values()) {
      if (!e.alive) continue;
      const st = ENEMY_KINDS[e.kind];
      // skip far-away enemies entirely (they are idle at home)
      const dPlayer = Math.hypot(p.x - e.x, p.z - e.z);
      if (dPlayer > 80 && !e.engaged) continue;
      const leash = e.ruin ? Math.hypot(p.x - e.spawnX, p.z - e.spawnZ) < 26 : true;
      if (target && leash && (e.engaged || dPlayer < st.aggro)) {
        e.engaged = true;
        const dx = p.x - e.x;
        const dz = p.z - e.z;
        e.facing = facingTo(dx, dz);
        if (dPlayer > st.range) {
          const [nx, nz] = this.steer(e.x, e.z, p.x, p.z, Math.min(st.speed * dt, dPlayer - st.range * 0.8), ENEMY_RADIUS);
          e.moving = Math.abs(nx - e.x) > 1e-4 || Math.abs(nz - e.z) > 1e-4;
          e.x = nx;
          e.z = nz;
        } else {
          e.moving = false;
          if (now - e.lastAttack >= st.cooldown) {
            e.lastAttack = now;
            e.attackSeq++;
            this.onEvent({ type: 'enemy-attack', enemy: e });
            this.hurtPlayer(Math.round(st.damage * (1 + 0.35 * (e.level - 1))), e.kind, now);
          }
        }
      } else {
        e.engaged = false;
        const hx = e.ruin ? e.spawnX : e.x;
        const hz = e.ruin ? e.spawnZ : e.z;
        const dist = Math.hypot(hx - e.x, hz - e.z);
        if (dist > 0.4) {
          const [nx, nz] = this.steer(e.x, e.z, hx, hz, Math.min(st.speed * 0.6 * dt, dist), ENEMY_RADIUS);
          e.moving = true;
          e.facing = facingTo(hx - e.x, hz - e.z);
          e.x = nx;
          e.z = nz;
        } else {
          e.moving = false;
          e.hp = e.maxHp;
        }
      }
    }
  }
}
