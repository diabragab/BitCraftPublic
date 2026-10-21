// Open-world rules for the single-player build: movement and collision, gathering,
// crafting, building, combat skills, gear, pets, enemy AI, day/night, regrowth and saving.
// It owns the game state; the renderer only reads it and listens to events. Written to be
// portable to a SpacetimeDB module later (state is plain data, time comes from the caller).
import { CLASSES, type ClassId } from '../map';
import {
  AFFIXES, BAG_SIZE, CLASS_SKILLS, ENEMY_KINDS, GEAR, GEAR_IDS, ITEMS, PET_DOWN_MS, PETS, RARITIES, RECIPES, RESOURCES,
  SKILL_IDS, SLOT_IDS, STATS, STRUCTURES, TOOL_SPEED, armorFactor, levelFromXp, petLevelFromXp, rankScale,
  type Effect, type Element, type EnemyKind, type GearBaseId, type GearItem, type Glyph, type ItemId, type Mods,
  type PetSpecies, type Recipe, type SkillDef, type SkillId, type Slot, type StationId, type StatId, type StructureId,
} from './content';
import { mulberry32 } from './noise';
import { CHUNK, VILLAGE_RADIUS, WORLD_HALF, WorldGen, type Placed, type ResourceNode } from './terrain';

export const SAVE_KEY = 'kaykit-world.save.v1';
const TICK_MS = 50;
const DAY_MS = 8 * 60_000; // one full day/night cycle
const PLAYER_RADIUS = 0.45;
const ENEMY_RADIUS = 0.55;
const PET_RADIUS = 0.4;
const RESPAWN_MS = 5_000;
const CHEST_COOLDOWN_MS = 10 * 60_000;
const INTERACT_RANGE = 2.6;
const DODGE_MS = 280; // the roll itself
const DODGE_SPEED = 16; // m/s while rolling (about 4.5 m)
const DODGE_COOLDOWN = 1200;
const COMBO_WINDOW = 1300; // basic attacks this close together chain into a combo

export interface Structure {
  id: string;
  type: StructureId;
  x: number;
  z: number;
  rot: number;
}

export interface Buff {
  id: string;
  name: string;
  glyph: Glyph;
  element: Element;
  until: number;
  mods: Mods;
  /** Party buffs also strengthen your pet. */
  party: boolean;
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
  /** Combat skill ranks by skill id (missing = not learned). */
  skills: Record<string, number>;
  /** Every piece of gear you own; `equipped` points at the ones you wear. */
  gear: GearItem[];
  equipped: Partial<Record<Slot, string>>;
  // runtime only (not saved)
  buffs: Buff[];
  shield: { amount: number; max: number; until: number } | null;
  skillReady: Record<string, number>;
  lastTarget: number | null;
  /** Dodge roll: direction and end time; hits are ignored until `invulnUntil`. */
  roll: { dx: number; dz: number; until: number } | null;
  invulnUntil: number;
  dodgeReady: number;
  /** 0, 1, 2 within a chain of quick attacks; the third is the finisher. */
  combo: number;
  lastComboAt: number;
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
  stunUntil: number;
  slowUntil: number;
  /** Taunted enemies attack the pet. */
  tauntUntil: number;
  /** Enemies the pet hit recently may turn on it. */
  petAggroUntil: number;
  burn: { dps: number; until: number; next: number; src: 'player' | 'pet' } | null;
}

export interface Pet {
  species: PetSpecies;
  xp: number;
  skills: Record<string, number>;
  hp: number;
  /** Knocked out until then (hp is 0). */
  downUntil: number;
  // runtime only
  x: number;
  z: number;
  facing: number;
  moving: boolean;
  lastAttack: number;
  lastHurt: number;
  lastSkill: number;
  skillReady: Record<string, number>;
  targetId: number | null;
  attackSeq: number;
  hitSeq: number;
}

export type FloatStyle = '' | 'crit' | 'player' | 'heal' | 'gain' | 'pet' | 'shield';

export type WorldEvent =
  | { type: 'float'; x: number; z: number; text: string; style: FloatStyle }
  | { type: 'feed'; text: string }
  | { type: 'toast'; text: string }
  /** One-shot sound cues the rules know about (positions let the audio fade distant sounds). */
  | { type: 'sound'; name: 'craft' | 'build' | 'loot' | 'enemy-death' | 'equip' | 'learn' | 'summon'; x: number; z: number }
  | { type: 'level'; skill: SkillId; level: number }
  | { type: 'resources' }
  | { type: 'structures' }
  | { type: 'enemy-added'; enemy: Enemy }
  | { type: 'enemy-removed'; id: number }
  | { type: 'gather-hit'; node: ResourceNode }
  | { type: 'player-attack'; facing: number; combo: number }
  | { type: 'dodge'; x: number; z: number; facing: number }
  | { type: 'enemy-attack'; enemy: Enemy; target: 'player' | 'pet' }
  /** A combat skill went off: the renderer draws it, the audio plays it, the hero animates. */
  | {
    type: 'skill'; who: 'player' | 'pet'; id: string; kind: Effect['kind']; element: Element; clip?: string;
    x: number; z: number; facing: number; radius?: number; tx?: number; tz?: number; points?: [number, number][]; delay?: number;
  }
  | { type: 'skill-impact'; element: Element; x: number; z: number; radius: number }
  | { type: 'pet-summon'; species: PetSpecies }
  | { type: 'pet-dismiss' }
  | { type: 'pet-down' }
  | { type: 'pet-up' }
  | { type: 'pet-attack'; species: PetSpecies; x: number; z: number; tx: number; tz: number }
  | { type: 'pet-level'; species: PetSpecies; level: number }
  | { type: 'gear'; item: GearItem; how: 'drop' | 'craft' | 'chest' }
  | { type: 'death' }
  | { type: 'respawn' };

type RuntimeKeys = 'gather' | 'moving' | 'lastAttack' | 'lastHurt' | 'buffs' | 'shield' | 'skillReady' | 'lastTarget'
  | 'roll' | 'invulnUntil' | 'dodgeReady' | 'combo' | 'lastComboAt';
type SavedPet = Pick<Pet, 'species' | 'xp' | 'skills' | 'hp' | 'downUntil'>;

interface SaveData {
  v: 1;
  seed: number;
  player: Omit<PlayerState, RuntimeKeys>;
  nodes: Record<string, { hits: number; regrowAt: number }>;
  structures: Structure[];
  chests: Record<string, number>;
  dayOffset: number;
  pets?: SavedPet[];
  activePet?: PetSpecies | null;
}

interface Caster {
  who: 'player' | 'pet';
  x: number;
  z: number;
  facing: number;
  damage: number;
  target?: Enemy | null;
}

interface HitOpts {
  stun?: number;
  slow?: number;
  burn?: number;
  canCrit?: boolean;
  /** Push the enemy this many metres away from `from`. */
  knock?: number;
  from?: { x: number; z: number };
}

const facingTo = (dx: number, dz: number) => Math.atan2(dx, dz);
function angleDiff(a: number, b: number) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

export class OpenWorld {
  readonly gen: WorldGen;
  player: PlayerState;
  enemies = new Map<number, Enemy>();
  structures: Structure[] = [];
  /** Hits taken by resource nodes; a node is depleted while regrowAt is in the future. */
  nodes = new Map<string, { hits: number; regrowAt: number }>();
  chests = new Map<string, number>();
  pets = new Map<PetSpecies, Pet>();
  activePet: PetSpecies | null = null;
  private chunkCache = new Map<string, ResourceNode[]>();
  private nextEnemyId = 1;
  private nextUid = 1;
  private input = { dx: 0, dz: 0 };
  private inputLog: { t: number; dx: number; dz: number }[] = [];
  private lastTick = performance.now();
  private timer: number | undefined;
  private lastSave = 0;
  private lastNightSpawn = 0;
  private dayOffset = 0;
  private pending: { at: number; run: () => void }[] = [];
  private rnd = mulberry32(Date.now() & 0xffffffff);
  onEvent: (e: WorldEvent) => void = () => {};

  constructor(seed: number, name: string, cls: ClassId, saved?: SaveData | null) {
    this.gen = new WorldGen(seed);
    const skills = Object.fromEntries(SKILL_IDS.map((s) => [s, 0])) as Record<SkillId, number>;
    this.player = {
      name, cls, x: 0, z: 7, facing: Math.PI, moving: false, hp: CLASSES[cls].hp, alive: true, respawnAt: 0,
      lastAttack: 0, lastHurt: 0, gold: 0, inv: { potion: 1 }, xp: skills, home: null, gather: null,
      skills: {}, gear: [], equipped: {}, buffs: [], shield: null, skillReady: {}, lastTarget: null,
      roll: null, invulnUntil: 0, dodgeReady: 0, combo: 0, lastComboAt: 0,
    };
    this.dayOffset = 0.3 * DAY_MS - (Date.now() % DAY_MS); // a new game starts in the morning
    if (saved && saved.seed === seed) {
      this.player = {
        ...this.player, ...saved.player, xp: { ...skills, ...saved.player.xp }, gather: null, cls,
        skills: { ...(saved.player.skills ?? {}) }, gear: saved.player.gear ?? [], equipped: { ...(saved.player.equipped ?? {}) },
      };
      this.nodes = new Map(Object.entries(saved.nodes));
      this.structures = saved.structures;
      this.chests = new Map(Object.entries(saved.chests));
      this.dayOffset = saved.dayOffset;
      for (const sp of saved.pets ?? []) if (PETS[sp.species]) this.pets.set(sp.species, this.makePet(sp));
      this.activePet = saved.activePet && this.pets.has(saved.activePet) ? saved.activePet : null;
      // saves from before gear existed kept the sword as an inventory item
      if (this.count('iron_sword') > 0) {
        const sword = this.rollGear('iron_sword', 1, 0);
        this.player.gear.push(sword);
        this.player.equipped.weapon ??= sword.uid;
        this.player.inv.iron_sword = 0;
      }
    }
    this.player.name = name;
    this.player.hp = Math.min(this.player.hp, this.maxHp());
    const pet = this.pet();
    if (pet) this.placePetNearPlayer(pet);
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
    const {
      gather: _g, moving: _m, lastAttack: _a, lastHurt: _h, buffs: _b, shield: _s, skillReady: _r, lastTarget: _t,
      roll: _o, invulnUntil: _i, dodgeReady: _d, combo: _c, lastComboAt: _l, ...player
    } = this.player;
    const data: SaveData = {
      v: 1, seed: this.gen.seed, player, nodes: Object.fromEntries(this.nodes), structures: this.structures,
      chests: Object.fromEntries(this.chests), dayOffset: this.dayOffset,
      pets: [...this.pets.values()].map(({ species, xp, skills, hp, downUntil }) => ({ species, xp, skills, hp, downUntil })),
      activePet: this.activePet,
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

  /** Your gear, active buffs and your pet's aura, added up. */
  stats(now = Date.now()): Mods {
    const out: Mods = {};
    const add = (m: Mods) => {
      for (const [id, v] of Object.entries(m)) out[id as StatId] = (out[id as StatId] ?? 0) + (v ?? 0);
    };
    for (const g of this.equippedItems()) add(g.stats);
    for (const b of this.player.buffs) if (b.until > now) add(b.mods);
    const pet = this.pet();
    if (pet && pet.hp > 0) add(this.petAura(pet));
    return out;
  }

  maxHp() {
    return Math.round(CLASSES[this.player.cls].hp + 3 * (this.level('combat') - 1) + (this.stats().hp ?? 0));
  }

  /** Damage of a normal attack before critical hits. */
  attackDamage(st = this.stats()) {
    const cls = CLASSES[this.player.cls];
    return (cls.damage + (st.dmg ?? 0)) * (1 + 0.04 * (this.level('combat') - 1)) * (1 + (st.dmgPct ?? 0));
  }

  attackCooldown(st = this.stats()) {
    return CLASSES[this.player.cls].cooldown / (1 + clamp(st.haste ?? 0, -0.5, 2));
  }

  moveSpeed(st = this.stats()) {
    return CLASSES[this.player.cls].speed * (1 + clamp(st.move ?? 0, -0.5, 1));
  }

  critChance(st = this.stats()) {
    return clamp(0.12 + (st.crit ?? 0), 0, 0.9);
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
    const d = Math.hypot(tx - x, tz - z);
    if (d < 1e-4) return [x, z];
    const dx = (tx - x) / d;
    const dz = (tz - z) / d;
    const direct = this.slide(x, z, dx * step, dz * step, r);
    const moved = (p: [number, number]) => Math.hypot(p[0] - x, p[1] - z);
    if (moved(direct) >= step * 0.6) return direct;
    let best = direct;
    let bestD = Infinity;
    for (const a of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
      const s = Math.sin(a);
      const c = Math.cos(a);
      const p = this.slide(x, z, (dx * c - dz * s) * step, (dx * s + dz * c) * step, r);
      const dd = (p[0] - tx) ** 2 + (p[1] - tz) ** 2;
      if (moved(p) >= step * 0.6 && dd < bestD) {
        best = p;
        bestD = dd;
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
    if (r.gear && this.bagCount() >= BAG_SIZE) return 'Your gear bag is full';
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

  // ---------------------------------------------------------------- gear queries

  equippedItems(): GearItem[] {
    const out: GearItem[] = [];
    for (const slot of SLOT_IDS) {
      const uid = this.player.equipped[slot];
      const item = uid ? this.player.gear.find((g) => g.uid === uid) : undefined;
      if (item) out.push(item);
    }
    return out;
  }

  isEquipped(uid: string) {
    return Object.values(this.player.equipped).includes(uid);
  }

  /** Gear in the bag (not worn). */
  bagCount() {
    return this.player.gear.filter((g) => !this.isEquipped(g.uid)).length;
  }

  gearValue(item: GearItem) {
    return Math.round(4 * (item.rarity + 1) ** 2 * item.ilvl);
  }

  // ---------------------------------------------------------------- combat skill queries

  classSkills(): SkillDef[] {
    return CLASS_SKILLS[this.player.cls];
  }

  skillRank(id: string) {
    return this.player.skills[id] ?? 0;
  }

  /** One point per combat level. */
  skillPoints() {
    return this.level('combat') - this.classSkills().reduce((s, d) => s + this.skillRank(d.id), 0);
  }

  canLearn(id: string): string | null {
    const def = this.classSkills().find((d) => d.id === id);
    if (!def) return 'Unknown skill';
    const rank = this.skillRank(id);
    if (rank >= def.maxRank) return 'Already at the highest rank';
    if (this.level('combat') < def.unlock) return `Needs combat level ${def.unlock}`;
    if (this.skillPoints() <= 0) return 'No skill points (gain combat levels)';
    return null;
  }

  /** Milliseconds until a skill is ready again. */
  cooldownLeft(id: string, now = Date.now()) {
    return Math.max(0, (this.player.skillReady[id] ?? 0) - now);
  }

  // ---------------------------------------------------------------- pet queries

  pet(): Pet | null {
    return this.activePet ? this.pets.get(this.activePet) ?? null : null;
  }

  petLevel(pet: Pet) {
    return petLevelFromXp(pet.xp);
  }

  petMaxHp(pet: Pet) {
    const def = PETS[pet.species];
    return Math.round(def.hp + def.hpPerLevel * (this.petLevel(pet) - 1));
  }

  petAura(pet: Pet): Mods {
    const def = PETS[pet.species];
    const lvl = this.petLevel(pet) - 1;
    const out: Mods = { ...def.aura.base };
    for (const [id, v] of Object.entries(def.aura.perLevel)) out[id as StatId] = (out[id as StatId] ?? 0) + (v ?? 0) * lvl;
    return out;
  }

  /** Buff values that also apply to the pet (party buffs). */
  private partyMods(now: number): Mods {
    const out: Mods = {};
    for (const b of this.player.buffs) {
      if (!b.party || b.until <= now) continue;
      for (const [id, v] of Object.entries(b.mods)) out[id as StatId] = (out[id as StatId] ?? 0) + (v ?? 0);
    }
    return out;
  }

  petDamage(pet: Pet, now = Date.now()) {
    const def = PETS[pet.species];
    const party = this.partyMods(now);
    return (def.damage + def.damagePerLevel * (this.petLevel(pet) - 1)) * (1 + (this.stats(now).petPower ?? 0)) * (1 + (party.dmgPct ?? 0));
  }

  petAttackCooldown(pet: Pet, now = Date.now()) {
    return PETS[pet.species].cooldown / (1 + clamp(this.partyMods(now).haste ?? 0, 0, 2));
  }

  petSkillPoints(pet: Pet) {
    return this.petLevel(pet) - PETS[pet.species].skills.reduce((s, d) => s + (pet.skills[d.id] ?? 0), 0);
  }

  canLearnPetSkill(species: PetSpecies, id: string): string | null {
    const pet = this.pets.get(species);
    if (!pet) return 'You do not have this pet';
    const def = PETS[species].skills.find((d) => d.id === id);
    if (!def) return 'Unknown skill';
    if ((pet.skills[id] ?? 0) >= def.maxRank) return 'Already at the highest rank';
    if (this.petLevel(pet) < def.unlock) return `Needs pet level ${def.unlock}`;
    if (this.petSkillPoints(pet) <= 0) return 'No pet skill points (level the pet up)';
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
    const st = this.stats(now);
    if (now - p.lastAttack < this.attackCooldown(st)) return 'cooldown';
    p.lastAttack = now;
    p.facing = facing;
    p.gather = null;
    p.combo = now - p.lastComboAt < COMBO_WINDOW ? (p.combo + 1) % 3 : 0;
    p.lastComboAt = now;
    const finisher = p.combo === 2;
    this.onEvent({ type: 'player-attack', facing, combo: p.combo });
    // the third hit of a chain lands harder, reaches wider and knocks enemies back
    const base = this.attackDamage(st) * (finisher ? 1.6 : 1);
    const arc = cls.arc * (finisher ? 1.35 : 1);
    const hits = [...this.enemies.values()].filter((e) => {
      if (!e.alive) return false;
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      if (cls.ranged) {
        const along = dx * Math.sin(facing) + dz * Math.cos(facing);
        return along > 0 && along <= cls.range && Math.abs(dx * Math.cos(facing) - dz * Math.sin(facing)) <= 1;
      }
      const d = Math.hypot(dx, dz);
      return d <= cls.range + ENEMY_RADIUS && (d < 0.6 || Math.abs(angleDiff(facingTo(dx, dz), facing)) <= arc);
    });
    if (cls.ranged) hits.sort((a, b) => dist(a, p) - dist(b, p)).splice(1);
    if (hits[0]) p.lastTarget = hits[0].id;
    for (const e of hits) this.hitEnemy(e, base, 'player', finisher ? { knock: 1.2, from: p } : {});
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

  /** A quick roll: moves you about 4.5 m and makes you untouchable for a moment. */
  dodge(facing: number): string | null {
    const p = this.player;
    if (!p.alive) return 'You are dead';
    const now = Date.now();
    if (now < p.dodgeReady) return 'cooldown';
    p.dodgeReady = now + DODGE_COOLDOWN;
    p.invulnUntil = now + DODGE_MS + 150;
    p.roll = { dx: Math.sin(facing), dz: Math.cos(facing), until: now + DODGE_MS };
    p.facing = facing;
    p.gather = null;
    this.onEvent({ type: 'dodge', x: p.x, z: p.z, facing });
    return null;
  }

  dodgeCooldownLeft(now = Date.now()) {
    return Math.max(0, this.player.dodgeReady - now);
  }

  craft(id: string): string | null {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return 'Unknown recipe';
    const problem = this.canCraft(r);
    if (problem) return problem;
    this.take(r.inputs);
    this.addXp('crafting', r.xp);
    if (r.gear) {
      // better crafters sometimes turn out finer pieces
      const lvl = this.level('crafting');
      const roll = this.rnd();
      const rarity = roll < Math.min(0.15, 0.01 * lvl) ? 2 : roll < Math.min(0.5, 0.05 * lvl) ? 1 : 0;
      const item = this.rollGear(r.gear, 1 + Math.floor(lvl / 4), rarity);
      this.player.gear.push(item);
      this.onEvent({ type: 'gear', item, how: 'craft' });
      this.onEvent({ type: 'toast', text: `Crafted ${RARITIES[item.rarity].name.toLowerCase()} ${GEAR[item.base].name.toLowerCase()}` });
    } else if (r.output) {
      this.give(r.output, r.count);
      this.onEvent({ type: 'toast', text: `Crafted ${ITEMS[r.output].name}` });
    }
    this.onEvent({ type: 'sound', name: 'craft', x: this.player.x, z: this.player.z });
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
    this.onEvent({ type: 'sound', name: 'build', x, z });
    this.onEvent({ type: 'feed', text: `Built a ${def.name.toLowerCase()}${def.respawn ? ' (new respawn point)' : ''}` });
    this.save();
    return null;
  }

  // ---- gear

  equip(uid: string): string | null {
    const item = this.player.gear.find((g) => g.uid === uid);
    if (!item) return 'No such item';
    const slot = GEAR[item.base].slot;
    this.player.equipped[slot] = uid;
    this.player.hp = Math.min(this.player.hp, this.maxHp());
    this.onEvent({ type: 'sound', name: 'equip', x: this.player.x, z: this.player.z });
    return null;
  }

  unequip(slot: Slot): string | null {
    if (!this.player.equipped[slot]) return 'Nothing equipped there';
    if (this.bagCount() >= BAG_SIZE) return 'Your gear bag is full';
    delete this.player.equipped[slot];
    this.player.hp = Math.min(this.player.hp, this.maxHp());
    this.onEvent({ type: 'sound', name: 'equip', x: this.player.x, z: this.player.z });
    return null;
  }

  /** Breaks a piece down for gold. */
  salvage(uid: string): string | null {
    const i = this.player.gear.findIndex((g) => g.uid === uid);
    if (i < 0) return 'No such item';
    const item = this.player.gear[i];
    for (const slot of SLOT_IDS) if (this.player.equipped[slot] === uid) delete this.player.equipped[slot];
    this.player.gear.splice(i, 1);
    const gold = this.gearValue(item);
    this.player.gold += gold;
    this.player.hp = Math.min(this.player.hp, this.maxHp());
    this.onEvent({ type: 'float', x: this.player.x, z: this.player.z, text: `+${gold} gold`, style: 'gain' });
    return null;
  }

  // ---- combat skills

  learnSkill(id: string): string | null {
    const problem = this.canLearn(id);
    if (problem) return problem;
    this.player.skills[id] = this.skillRank(id) + 1;
    this.onEvent({ type: 'sound', name: 'learn', x: this.player.x, z: this.player.z });
    return null;
  }

  /** Casts the class skill in hotbar slot `index` (0-3) towards `facing`. */
  useSkill(index: number, facing: number): string | null {
    const def = this.classSkills()[index];
    if (!def) return 'No skill in that slot';
    const rank = this.skillRank(def.id);
    if (!rank) return `${def.name} is not learned yet (open Skills)`;
    const p = this.player;
    if (!p.alive) return 'You are dead';
    const now = Date.now();
    if (this.cooldownLeft(def.id, now) > 0) return 'cooldown';
    p.skillReady[def.id] = now + def.cooldown;
    p.facing = facing;
    p.gather = null;
    const st = this.stats(now);
    const near = [...this.enemies.values()].filter((e) => e.alive && dist(e, p) < 12).sort((a, b) => dist(a, p) - dist(b, p))[0];
    this.cast({ who: 'player', x: p.x, z: p.z, facing, damage: this.attackDamage(st) * (1 + (st.power ?? 0)), target: near }, def, rank, now);
    return null;
  }

  // ---- pets

  /** Uses a charm to bond a new pet. */
  bondPet(species: PetSpecies): string | null {
    const def = PETS[species];
    if (this.pets.has(species)) return `You already have a ${def.name}`;
    if (this.count(def.charm) <= 0) return `You need a ${ITEMS[def.charm].name.toLowerCase()} (craft it)`;
    this.take({ [def.charm]: 1 });
    const pet = this.makePet({ species, xp: 0, skills: {}, hp: 0, downUntil: 0 });
    pet.hp = this.petMaxHp(pet);
    this.pets.set(species, pet);
    this.onEvent({ type: 'feed', text: `${def.name} bonded with you` });
    this.summonPet(species);
    this.save();
    return null;
  }

  summonPet(species: PetSpecies | null): string | null {
    if (species === null) {
      if (!this.activePet) return 'No pet is out';
      this.activePet = null;
      this.onEvent({ type: 'pet-dismiss' });
      return null;
    }
    const pet = this.pets.get(species);
    if (!pet) return 'You do not have this pet';
    if (this.activePet === species) return null;
    if (this.activePet) this.onEvent({ type: 'pet-dismiss' });
    this.activePet = species;
    pet.targetId = null;
    this.placePetNearPlayer(pet);
    this.onEvent({ type: 'pet-summon', species });
    this.onEvent({ type: 'sound', name: 'summon', x: pet.x, z: pet.z });
    return null;
  }

  learnPetSkill(species: PetSpecies, id: string): string | null {
    const problem = this.canLearnPetSkill(species, id);
    if (problem) return problem;
    const pet = this.pets.get(species)!;
    pet.skills[id] = (pet.skills[id] ?? 0) + 1;
    this.onEvent({ type: 'sound', name: 'learn', x: this.player.x, z: this.player.z });
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

  private uid(prefix: string) {
    return `${prefix}${Date.now().toString(36)}${(this.nextUid++).toString(36)}`;
  }

  /** A piece of gear: base stats × rarity × item level, plus random bonus stats for better rarities. */
  rollGear(base: GearBaseId, ilvl: number, rarity: number): GearItem {
    const def = GEAR[base];
    const r = RARITIES[clamp(rarity, 0, RARITIES.length - 1)];
    const lvl = 1 + 0.12 * (ilvl - 1);
    const round = (id: StatId, v: number) => (STATS[id].pct ? Math.round(v * 200) / 200 : Math.round(v * 10) / 10);
    const stats: Mods = {};
    for (const [id, v] of Object.entries(def.base)) {
      // drawbacks (negative stats) do not grow with quality
      stats[id as StatId] = round(id as StatId, (v ?? 0) < 0 ? (v ?? 0) : (v ?? 0) * r.mult * lvl);
    }
    const pool = (Object.keys(AFFIXES) as StatId[]).filter((id) => !(id in def.base));
    for (let i = 0; i < r.affixes && pool.length; i++) {
      const id = pool.splice(Math.floor(this.rnd() * pool.length), 1)[0];
      stats[id] = round(id, (AFFIXES[id] ?? 0) * lvl * (0.7 + 0.6 * this.rnd()) * (rarity >= 4 ? 1.4 : 1));
    }
    return { uid: this.uid('g'), base, rarity: clamp(rarity, 0, RARITIES.length - 1), ilvl, stats };
  }

  private rollRarity(luck: number, min = 0) {
    const w = [60, 28 + luck * 2, 9 + luck * 1.5, 2.5 + luck * 0.8, 0.5 + luck * 0.3];
    let roll = this.rnd() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) {
      roll -= w[i];
      if (roll <= 0) return Math.max(min, i);
    }
    return Math.max(min, 0);
  }

  private dropGear(ilvl: number, luck: number, how: 'drop' | 'chest', minRarity = 0) {
    const base = GEAR_IDS[Math.floor(this.rnd() * GEAR_IDS.length)];
    const item = this.rollGear(base, ilvl, this.rollRarity(luck, minRarity));
    if (this.bagCount() >= BAG_SIZE) {
      const gold = this.gearValue(item);
      this.player.gold += gold;
      this.onEvent({ type: 'feed', text: `Bag full: ${GEAR[base].name.toLowerCase()} sold for ${gold} gold` });
      return;
    }
    this.player.gear.push(item);
    this.onEvent({ type: 'gear', item, how });
    this.onEvent({ type: 'feed', text: `Found ${RARITIES[item.rarity].name.toLowerCase()} ${GEAR[base].name.toLowerCase()} (item level ${ilvl})` });
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
    this.onEvent({ type: 'sound', name: 'loot', x: ruin.chest.x, z: ruin.chest.z });
    this.dropGear(ruin.level + 1, ruin.level + 1.5, 'chest', 1);
    this.save();
    return null;
  }

  private addEnemy(kind: EnemyKind, level: number, x: number, z: number, ruin: string | null) {
    const st = ENEMY_KINDS[kind];
    const maxHp = Math.round(st.maxHp * (1 + 0.5 * (level - 1)));
    const e: Enemy = {
      id: this.nextEnemyId++, kind, level, ruin, spawnX: x, spawnZ: z, x, z, facing: this.rnd() * 6.28, moving: false,
      hp: maxHp, maxHp, alive: true, respawnAt: 0, lastAttack: 0, engaged: false, attackSeq: 0, hitSeq: 0,
      stunUntil: 0, slowUntil: 0, tauntUntil: 0, petAggroUntil: 0, burn: null,
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
    e.burn = null;
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
    const pet = this.pet();
    if (pet && pet.hp > 0 && dist(pet, e) < 40) this.addPetXp(pet, Math.round(st.xp * e.level * 0.8));
    this.onEvent({ type: 'sound', name: 'enemy-death', x: e.x, z: e.z });
    this.onEvent({ type: 'feed', text: `Defeated a level ${e.level} skeleton ${e.kind}: +${gold} gold, ${bones} bone${bones > 1 ? 's' : ''}${extra}` });
    if (this.rnd() < 0.07 + 0.02 * e.level) this.dropGear(e.level, e.level * 0.5, 'drop');
    if (!e.ruin) {
      // night wanderers do not come back
      this.enemies.delete(e.id);
      setTimeout(() => this.onEvent({ type: 'enemy-removed', id: e.id }), 2500);
    }
  }

  /** Every hit on an enemy goes through here: crits, life steal, status effects, kills. */
  private hitEnemy(e: Enemy, amount: number, src: 'player' | 'pet', o: HitOpts = {}) {
    if (!e.alive) return;
    const now = Date.now();
    const st = src === 'player' ? this.stats(now) : null;
    const crit = !!st && o.canCrit !== false && this.rnd() < this.critChance(st);
    const dmg = Math.max(1, Math.round(amount * (crit ? 2 : 1)));
    e.hp -= dmg;
    e.hitSeq++;
    e.engaged = true;
    if (src === 'pet') e.petAggroUntil = now + 6000;
    if (o.stun) e.stunUntil = Math.max(e.stunUntil, now + o.stun);
    if (o.slow) e.slowUntil = Math.max(e.slowUntil, now + o.slow);
    if (o.burn) e.burn = { dps: Math.max(1, Math.round(amount * 0.2)), until: now + o.burn, next: now + 1000, src };
    if (o.knock && o.from) {
      const d = Math.max(0.01, dist(e, o.from));
      [e.x, e.z] = this.slide(e.x, e.z, ((e.x - o.from.x) / d) * o.knock, ((e.z - o.from.z) / d) * o.knock, ENEMY_RADIUS);
    }
    this.onEvent({ type: 'float', x: e.x, z: e.z, text: `${dmg}${crit ? '!' : ''}`, style: crit ? 'crit' : src === 'pet' ? 'pet' : '' });
    const steal = st?.lifesteal ?? 0;
    if (steal > 0 && this.player.alive) this.player.hp = Math.min(this.maxHp(), this.player.hp + dmg * steal);
    if (e.hp <= 0) this.killEnemy(e);
  }

  private enemiesNear(x: number, z: number, r: number) {
    return [...this.enemies.values()].filter((e) => e.alive && Math.hypot(e.x - x, e.z - z) <= r + ENEMY_RADIUS);
  }

  /** Runs a skill's effect. Shared by your class skills and your pet's skills. */
  private cast(c: Caster, def: SkillDef, rank: number, now: number) {
    const fx = def.effect;
    const k = rankScale(rank);
    const dmg = c.damage * k;
    const p = this.player;
    const base = { type: 'skill' as const, who: c.who, id: def.id, kind: fx.kind, element: def.element, clip: def.clip, x: c.x, z: c.z, facing: c.facing };
    switch (fx.kind) {
      case 'nova': {
        const at = fx.at === 'target' && c.target ? c.target : c;
        for (const e of this.enemiesNear(at.x, at.z, fx.radius)) this.hitEnemy(e, dmg * fx.mult, c.who, { stun: fx.stun, slow: fx.slow, burn: fx.burn, knock: 1.4, from: at });
        this.onEvent({ ...base, x: at.x, z: at.z, radius: fx.radius });
        break;
      }
      case 'cone': {
        for (const e of this.enemiesNear(c.x, c.z, fx.range)) {
          const d = dist(e, c);
          if (d > 0.6 && Math.abs(angleDiff(facingTo(e.x - c.x, e.z - c.z), c.facing)) > fx.arc) continue;
          const exec = fx.execute && e.hp / e.maxHp < fx.execute ? 2 : 1;
          this.hitEnemy(e, dmg * fx.mult * exec, c.who, { stun: fx.stun, knock: 1.1, from: c });
        }
        this.onEvent({ ...base, radius: fx.range });
        break;
      }
      case 'bolt': {
        const sx = Math.sin(c.facing);
        const cz = Math.cos(c.facing);
        let first: Enemy | null = null;
        let firstAlong = Infinity;
        for (const e of this.enemies.values()) {
          if (!e.alive) continue;
          const along = (e.x - c.x) * sx + (e.z - c.z) * cz;
          const across = Math.abs((e.x - c.x) * cz - (e.z - c.z) * sx);
          if (along > 0 && along <= fx.range && across <= 1.1 && along < firstAlong) {
            first = e;
            firstAlong = along;
          }
        }
        const tx = first ? first.x : c.x + sx * fx.range;
        const tz = first ? first.z : c.z + cz * fx.range;
        if (first) for (const e of this.enemiesNear(tx, tz, fx.blast)) this.hitEnemy(e, dmg * fx.mult, c.who, { burn: fx.burn, knock: 0.7, from: { x: tx, z: tz } });
        this.onEvent({ ...base, tx, tz, radius: fx.blast });
        break;
      }
      case 'dash': {
        if (c.who !== 'player') break;
        const sx = Math.sin(c.facing);
        const cz = Math.cos(c.facing);
        const passed = new Set<Enemy>();
        let x = p.x;
        let z = p.z;
        for (let travelled = 0; travelled < fx.distance; travelled += 0.3) {
          const [nx, nz] = this.slide(x, z, sx * 0.3, cz * 0.3, PLAYER_RADIUS);
          if (Math.hypot(nx - x, nz - z) < 0.05) break;
          x = nx;
          z = nz;
          for (const e of this.enemiesNear(x, z, 1.4)) passed.add(e);
        }
        if (fx.blast) for (const e of this.enemiesNear(x, z, fx.blast)) passed.add(e);
        p.x = x;
        p.z = z;
        for (const e of passed) this.hitEnemy(e, dmg * fx.mult, 'player', { knock: 1, from: { x, z } });
        this.onEvent({ ...base, tx: x, tz: z, radius: fx.blast ?? 1.4 });
        break;
      }
      case 'meteor': {
        const tx = c.target && dist(c.target, c) <= fx.range ? c.target.x : c.x + Math.sin(c.facing) * fx.range;
        const tz = c.target && dist(c.target, c) <= fx.range ? c.target.z : c.z + Math.cos(c.facing) * fx.range;
        this.pending.push({
          at: now + fx.delay,
          run: () => {
            for (const e of this.enemiesNear(tx, tz, fx.radius)) this.hitEnemy(e, dmg * fx.mult, c.who, { stun: fx.stun, knock: 2, from: { x: tx, z: tz } });
            this.onEvent({ type: 'skill-impact', element: def.element, x: tx, z: tz, radius: fx.radius });
          },
        });
        this.onEvent({ ...base, tx, tz, radius: fx.radius, delay: fx.delay });
        break;
      }
      case 'chain': {
        const points: [number, number][] = [[c.x, c.z]];
        const hit = new Set<Enemy>();
        let from: { x: number; z: number } = c;
        let next: Enemy | null = c.target && c.target.alive && dist(c.target, c) <= fx.range ? c.target : null;
        for (let i = 0; i <= fx.jumps; i++) {
          if (!next) {
            const pool = [...this.enemies.values()].filter((e) => e.alive && !hit.has(e) && dist(e, from) <= (i === 0 ? fx.range : 5));
            next = pool.sort((a, b) => dist(a, from) - dist(b, from))[0] ?? null;
          }
          if (!next) break;
          hit.add(next);
          points.push([next.x, next.z]);
          this.hitEnemy(next, dmg * fx.mult * 0.85 ** i, c.who, { slow: fx.slow });
          from = next;
          next = null;
        }
        this.onEvent({ ...base, points });
        break;
      }
      case 'buff': {
        const mods: Mods = {};
        for (const [id, v] of Object.entries(fx.mods)) mods[id as StatId] = (v ?? 0) * k;
        p.buffs = p.buffs.filter((b) => b.id !== def.id);
        p.buffs.push({ id: def.id, name: def.name, glyph: def.glyph, element: def.element, until: now + fx.duration, mods, party: !!fx.party });
        if (fx.shield) {
          const amount = Math.round(fx.shield * k * (1 + (this.stats(now).power ?? 0)));
          p.shield = { amount, max: amount, until: now + fx.duration };
        }
        this.onEvent({ ...base, x: p.x, z: p.z, radius: 2 });
        break;
      }
      case 'heal': {
        const amount = Math.round(this.maxHp() * fx.pct * k);
        if (p.alive) {
          const healed = Math.min(amount, this.maxHp() - p.hp);
          p.hp += healed;
          this.onEvent({ type: 'float', x: p.x, z: p.z, text: `+${Math.round(healed)}`, style: 'heal' });
        }
        const pet = this.pet();
        if (fx.party && pet && pet.hp > 0) pet.hp = Math.min(this.petMaxHp(pet), pet.hp + this.petMaxHp(pet) * fx.pct * k);
        this.onEvent({ ...base, x: p.x, z: p.z, radius: 2 });
        break;
      }
      case 'taunt': {
        for (const e of this.enemiesNear(c.x, c.z, fx.radius)) {
          e.tauntUntil = now + fx.duration * k;
          e.engaged = true;
        }
        this.onEvent({ ...base, radius: fx.radius });
        break;
      }
    }
  }

  private hurtPlayer(dmg: number, source: string, now: number) {
    const p = this.player;
    if (!p.alive) return;
    if (p.invulnUntil > now) {
      this.onEvent({ type: 'float', x: p.x, z: p.z, text: 'Dodged', style: 'shield' });
      return;
    }
    let taken = Math.max(1, Math.round(dmg * armorFactor(this.stats(now).armor ?? 0)));
    if (p.shield && p.shield.until > now && p.shield.amount > 0) {
      const absorbed = Math.min(p.shield.amount, taken);
      p.shield.amount -= absorbed;
      taken -= absorbed;
      this.onEvent({ type: 'float', x: p.x, z: p.z, text: `(${absorbed})`, style: 'shield' });
      if (taken <= 0) return;
    }
    p.hp -= taken;
    p.lastHurt = now;
    p.gather = null;
    this.onEvent({ type: 'float', x: p.x, z: p.z, text: `-${taken}`, style: 'player' });
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      p.moving = false;
      p.respawnAt = now + RESPAWN_MS;
      p.buffs = [];
      p.shield = null;
      p.roll = null;
      const lost = Math.floor(p.gold * 0.1);
      p.gold -= lost;
      this.input = { dx: 0, dz: 0 };
      this.inputLog = [];
      this.onEvent({ type: 'death' });
      this.onEvent({ type: 'feed', text: `You were slain by a skeleton ${source}${lost ? ` and dropped ${lost} gold` : ''}` });
    }
  }

  // ---- pets (internals)

  private makePet(s: SavedPet): Pet {
    return {
      species: s.species, xp: s.xp, skills: { ...s.skills }, hp: s.hp, downUntil: s.downUntil,
      x: this.player.x, z: this.player.z, facing: 0, moving: false, lastAttack: 0, lastHurt: 0, lastSkill: 0,
      skillReady: {}, targetId: null, attackSeq: 0, hitSeq: 0,
    };
  }

  private placePetNearPlayer(pet: Pet) {
    const p = this.player;
    const a = p.facing + Math.PI * 0.75;
    pet.x = p.x + Math.sin(a) * 1.8;
    pet.z = p.z + Math.cos(a) * 1.8;
    if (PETS[pet.species].look === 'skeleton' && this.blocked(pet.x, pet.z, PET_RADIUS)) [pet.x, pet.z] = this.freeSpotNear(p.x, p.z);
    pet.facing = p.facing;
  }

  private addPetXp(pet: Pet, xp: number) {
    const before = this.petLevel(pet);
    pet.xp += xp;
    const after = this.petLevel(pet);
    if (after > before) {
      pet.hp = this.petMaxHp(pet);
      this.onEvent({ type: 'pet-level', species: pet.species, level: after });
      this.onEvent({ type: 'feed', text: `${PETS[pet.species].name} reached level ${after}` });
    }
  }

  private hurtPet(pet: Pet, dmg: number, now: number) {
    if (pet.hp <= 0) return;
    const armor = PETS[pet.species].armor + (this.partyMods(now).armor ?? 0);
    const taken = Math.max(1, Math.round(dmg * armorFactor(armor)));
    pet.hp -= taken;
    pet.lastHurt = now;
    pet.hitSeq++;
    this.onEvent({ type: 'float', x: pet.x, z: pet.z, text: `-${taken}`, style: 'pet' });
    if (pet.hp <= 0) {
      pet.hp = 0;
      pet.downUntil = now + PET_DOWN_MS;
      pet.targetId = null;
      for (const e of this.enemies.values()) e.tauntUntil = 0;
      this.onEvent({ type: 'pet-down' });
      this.onEvent({ type: 'feed', text: `${PETS[pet.species].name} was knocked out. It will be back in ${PET_DOWN_MS / 1000} s` });
    }
  }

  /** The enemy your pet should fight: what you are fighting, else whatever is after you. */
  private pickPetTarget(pet: Pet): Enemy | null {
    const p = this.player;
    const last = p.lastTarget ? this.enemies.get(p.lastTarget) : undefined;
    if (last?.alive && dist(last, p) < 12) return last;
    let best: Enemy | null = null;
    let bestD = Infinity;
    for (const e of this.enemies.values()) {
      if (!e.alive || !e.engaged) continue;
      const d = Math.min(dist(e, p), dist(e, pet));
      if (d < 10 && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  private tickPet(dt: number, now: number) {
    const pet = this.pet();
    if (!pet) return;
    const p = this.player;
    const def = PETS[pet.species];
    if (pet.hp <= 0) {
      if (now >= pet.downUntil) {
        pet.hp = Math.round(this.petMaxHp(pet) * 0.5);
        pet.downUntil = 0;
        this.placePetNearPlayer(pet);
        this.onEvent({ type: 'pet-up' });
      }
      return;
    }
    if (now - pet.lastHurt > 5000) pet.hp = Math.min(this.petMaxHp(pet), pet.hp + this.petMaxHp(pet) * 0.03 * dt);
    if (!p.alive) {
      pet.moving = false;
      pet.targetId = null;
      return;
    }
    if (dist(pet, p) > 28) {
      this.placePetNearPlayer(pet);
      pet.targetId = null;
    }
    let target = pet.targetId !== null ? this.enemies.get(pet.targetId) ?? null : null;
    if (!target?.alive || dist(target, p) > 16) target = this.pickPetTarget(pet);
    pet.targetId = target?.id ?? null;
    if (now - pet.lastSkill > 1200) this.petSkills(pet, target, now);
    const flying = def.look === 'sprite';
    const move = (tx: number, tz: number, step: number) => {
      const [nx, nz] = flying
        ? (() => {
          const d = Math.hypot(tx - pet.x, tz - pet.z);
          return [pet.x + ((tx - pet.x) / d) * step, pet.z + ((tz - pet.z) / d) * step] as [number, number];
        })()
        : this.steer(pet.x, pet.z, tx, tz, step, PET_RADIUS);
      pet.moving = Math.abs(nx - pet.x) > 1e-4 || Math.abs(nz - pet.z) > 1e-4;
      if (pet.moving) pet.facing = facingTo(nx - pet.x, nz - pet.z);
      pet.x = nx;
      pet.z = nz;
    };
    if (target) {
      const d = dist(target, pet);
      if (d > def.range) {
        move(target.x, target.z, Math.min(def.speed * dt, d - def.range * 0.8));
      } else {
        pet.moving = false;
        pet.facing = facingTo(target.x - pet.x, target.z - pet.z);
        if (now - pet.lastAttack >= this.petAttackCooldown(pet, now)) {
          pet.lastAttack = now;
          pet.attackSeq++;
          this.onEvent({ type: 'pet-attack', species: pet.species, x: pet.x, z: pet.z, tx: target.x, tz: target.z });
          this.hitEnemy(target, this.petDamage(pet, now), 'pet');
        }
      }
    } else {
      // heel: behind and to the side of you
      const ax = p.x - Math.sin(p.facing) * 1.8 + Math.cos(p.facing) * 1.1;
      const az = p.z - Math.cos(p.facing) * 1.8 - Math.sin(p.facing) * 1.1;
      const d = Math.hypot(ax - pet.x, az - pet.z);
      if (d > 0.8) move(ax, az, Math.min(def.speed * (d > 6 ? 1.5 : 1) * dt, d));
      else pet.moving = false;
    }
  }

  /** Pets use their learned skills on their own when the moment is right. */
  private petSkills(pet: Pet, target: Enemy | null, now: number) {
    const p = this.player;
    for (const sk of PETS[pet.species].skills) {
      const rank = pet.skills[sk.id] ?? 0;
      if (!rank || (pet.skillReady[sk.id] ?? 0) > now) continue;
      const fx = sk.effect;
      const td = target ? dist(target, pet) : Infinity;
      let ok = false;
      switch (fx.kind) {
        case 'heal': ok = p.hp < this.maxHp() * (fx.party ? 0.6 : 0.7) || (!!fx.party && pet.hp < this.petMaxHp(pet) * 0.5); break;
        case 'buff': ok = !!target; break;
        case 'taunt': ok = !!target && this.enemiesNear(pet.x, pet.z, fx.radius).some((e) => e.engaged); break;
        case 'nova': ok = !!target && td < (fx.at === 'target' ? 9 : fx.radius); break;
        case 'cone': ok = !!target && td < fx.range; break;
        case 'bolt': case 'chain': case 'meteor': ok = !!target && td < fx.range; break;
        case 'dash': ok = false; break;
      }
      if (!ok) continue;
      pet.skillReady[sk.id] = now + sk.cooldown;
      pet.lastSkill = now;
      if (target) pet.facing = facingTo(target.x - pet.x, target.z - pet.z);
      this.cast({ who: 'pet', x: pet.x, z: pet.z, facing: pet.facing, damage: this.petDamage(pet, now), target }, sk, rank, now);
      return;
    }
  }

  // ---- the clock

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
      this.tickPet(dt, now);
      this.tickEnemies(dt, now);
      t = stepEnd;
    }
    while (this.inputLog.length) this.input = this.inputLog.shift()!;
    this.lastTick = end;
    if (this.pending.length) {
      const due = this.pending.filter((x) => x.at <= now);
      this.pending = this.pending.filter((x) => x.at > now);
      for (const x of due) x.run();
    }
    const p = this.player;
    p.buffs = p.buffs.filter((b) => b.until > now);
    if (p.shield && (p.shield.until <= now || p.shield.amount <= 0)) p.shield = null;
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
        const pet = this.pet();
        if (pet && pet.hp > 0) this.placePetNearPlayer(pet);
        this.onEvent({ type: 'respawn' });
      }
      return;
    }
    const st = this.stats(now);
    const max = this.maxHp();
    // regeneration: slow out of combat, faster in the village or next to your campfire; gear and pets add more
    if (p.hp < max) {
      let rate = st.regen ?? 0;
      if (now - p.lastHurt > 6000) {
        const nearFire = this.structures.some((s) => s.type === 'campfire' && Math.hypot(s.x - p.x, s.z - p.z) < 6);
        rate += nearFire ? 5 : this.inVillage(p.x, p.z) ? 3 : 0.8;
      }
      p.hp = Math.min(max, p.hp + rate * dt);
    }
    if (p.roll) {
      if (now < p.roll.until) {
        [p.x, p.z] = this.slide(p.x, p.z, p.roll.dx * DODGE_SPEED * dt, p.roll.dz * DODGE_SPEED * dt, PLAYER_RADIUS);
        p.moving = true;
        return;
      }
      p.roll = null;
    }
    const { dx, dz } = this.input;
    if (dx === 0 && dz === 0) {
      p.moving = false;
      return;
    }
    p.gather = null;
    const speed = this.moveSpeed(st);
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
        Object.assign(e, { alive: true, hp: e.maxHp, x: e.spawnX, z: e.spawnZ, engaged: false, stunUntil: 0, slowUntil: 0, tauntUntil: 0, petAggroUntil: 0, burn: null });
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
    const playerOk = p.alive && !this.inVillage(p.x, p.z);
    const pet = this.pet();
    const petOk = !!pet && pet.hp > 0 && !this.inVillage(pet.x, pet.z);
    for (const e of this.enemies.values()) {
      if (!e.alive) continue;
      // burning
      if (e.burn) {
        if (now >= e.burn.next) {
          e.burn.next += 1000;
          this.hitEnemy(e, e.burn.dps, e.burn.src, { canCrit: false });
          if (!e.alive) continue;
        }
        if (e.burn && now >= e.burn.until) e.burn = null;
      }
      const st = ENEMY_KINDS[e.kind];
      // skip far-away enemies entirely (they are idle at home)
      const dPlayer = Math.hypot(p.x - e.x, p.z - e.z);
      if (dPlayer > 80 && !e.engaged) continue;
      if (e.stunUntil > now) {
        e.moving = false;
        continue;
      }
      // who to fight: a taunt or a recent pet hit turns them on the pet
      const dPet = petOk ? dist(pet!, e) : Infinity;
      let targetPet = false;
      if (petOk && (e.tauntUntil > now || (e.petAggroUntil > now && (!playerOk || dPet <= dPlayer + 1)))) targetPet = true;
      else if (!playerOk && petOk && e.engaged && dPet < 12) targetPet = true;
      const tgt = targetPet ? pet! : playerOk ? p : null;
      const dTarget = tgt ? dist(tgt, e) : Infinity;
      const leash = e.ruin && tgt ? Math.hypot(tgt.x - e.spawnX, tgt.z - e.spawnZ) < 26 : true;
      if (tgt && leash && (e.engaged || dTarget < st.aggro)) {
        e.engaged = true;
        e.facing = facingTo(tgt.x - e.x, tgt.z - e.z);
        if (dTarget > st.range) {
          const speed = st.speed * (e.slowUntil > now ? 0.5 : 1);
          const [nx, nz] = this.steer(e.x, e.z, tgt.x, tgt.z, Math.min(speed * dt, dTarget - st.range * 0.8), ENEMY_RADIUS);
          e.moving = Math.abs(nx - e.x) > 1e-4 || Math.abs(nz - e.z) > 1e-4;
          e.x = nx;
          e.z = nz;
        } else {
          e.moving = false;
          if (now - e.lastAttack >= st.cooldown) {
            e.lastAttack = now;
            e.attackSeq++;
            this.onEvent({ type: 'enemy-attack', enemy: e, target: targetPet ? 'pet' : 'player' });
            const dmg = Math.round(st.damage * (1 + 0.35 * (e.level - 1)));
            if (targetPet) this.hurtPet(pet!, dmg, now);
            else this.hurtPlayer(dmg, e.kind, now);
          }
        }
      } else {
        e.engaged = false;
        const hx = e.ruin ? e.spawnX : e.x;
        const hz = e.ruin ? e.spawnZ : e.z;
        const d = Math.hypot(hx - e.x, hz - e.z);
        if (d > 0.4) {
          const [nx, nz] = this.steer(e.x, e.z, hx, hz, Math.min(st.speed * 0.6 * dt, d), ENEMY_RADIUS);
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
