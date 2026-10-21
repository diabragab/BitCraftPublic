// Game content for the open world: items, recipes, buildable structures, skills,
// resource nodes, enemies, gear, combat skills and pets. Plain data so balance changes
// stay in one place.
import type { ClassId } from '../map';

export type ItemId =
  | 'wood' | 'stone' | 'iron_ore' | 'plank' | 'iron_ingot' | 'bone' | 'potion'
  | 'stone_axe' | 'stone_pickaxe' | 'iron_axe' | 'iron_pickaxe' | 'iron_sword'
  | 'bone_charm' | 'moss_seed' | 'ember_heart' | 'storm_shard';

export const ITEMS: Record<ItemId, { name: string; icon: string; desc: string }> = {
  wood: { name: 'Wood', icon: '🪵', desc: 'Chopped from trees.' },
  stone: { name: 'Stone', icon: '🪨', desc: 'Mined from rocks.' },
  iron_ore: { name: 'Iron ore', icon: '⛏', desc: 'Mined from iron veins in the highlands. Needs a pickaxe.' },
  plank: { name: 'Plank', icon: '🟫', desc: 'Sawn wood for building.' },
  iron_ingot: { name: 'Iron ingot', icon: '🔩', desc: 'Smelted at a forge.' },
  bone: { name: 'Bone', icon: '🦴', desc: 'Dropped by skeletons.' },
  potion: { name: 'Health potion', icon: '🧪', desc: 'Restores 50 health (Q).' },
  stone_axe: { name: 'Stone axe', icon: '🪓', desc: 'Chop trees 1.5× faster.' },
  stone_pickaxe: { name: 'Stone pickaxe', icon: '⛏️', desc: 'Mine 1.5× faster. Lets you mine iron.' },
  iron_axe: { name: 'Iron axe', icon: '🪓', desc: 'Chop trees 2.2× faster.' },
  iron_pickaxe: { name: 'Iron pickaxe', icon: '⛏️', desc: 'Mine 2.2× faster.' },
  iron_sword: { name: 'Iron sword', icon: '🗡', desc: 'Old saves only: becomes an equippable sword.' },
  bone_charm: { name: 'Bound skull', icon: '💀', desc: 'Bonds a Skeleton Squire to you (Pets panel).' },
  moss_seed: { name: 'Moss seed', icon: '🌱', desc: 'Grows into a Moss Sprite (Pets panel).' },
  ember_heart: { name: 'Ember heart', icon: '🔥', desc: 'Kindles an Ember Sprite (Pets panel).' },
  storm_shard: { name: 'Storm shard', icon: '⚡', desc: 'Awakens a Storm Sprite (Pets panel).' },
};

export type SkillId = 'woodcutting' | 'mining' | 'combat' | 'crafting' | 'construction';
export const SKILLS: Record<SkillId, { name: string; icon: string; desc: string }> = {
  woodcutting: { name: 'Woodcutting', icon: '🪓', desc: 'Faster chopping (+4% per level).' },
  mining: { name: 'Mining', icon: '⛏', desc: 'Faster mining (+4% per level).' },
  combat: { name: 'Combat', icon: '⚔', desc: '+4% damage and +3 max health per level.' },
  crafting: { name: 'Crafting', icon: '🔨', desc: 'Unlocks iron tools and weapons.' },
  construction: { name: 'Construction', icon: '🏠', desc: 'Unlocks bigger buildings.' },
};
export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];
export const MAX_LEVEL = 50;
/** Total XP needed to reach `level` (level 1 = 0 XP). */
export const xpForLevel = (level: number) => Math.round(25 * (level - 1) ** 2);
export const levelFromXp = (xp: number) => Math.min(MAX_LEVEL, Math.floor(Math.sqrt(xp / 25)) + 1);

export type StationId = 'workbench' | 'forge';
export interface Recipe {
  id: string;
  /** Stackable output, or `gear` for a piece of equipment (rolled when crafted). */
  output?: ItemId;
  gear?: GearBaseId;
  count: number;
  inputs: Partial<Record<ItemId, number>>;
  station?: StationId;
  skill?: { id: SkillId; level: number };
  xp: number;
}
export const RECIPES: Recipe[] = [
  { id: 'plank', output: 'plank', count: 1, inputs: { wood: 2 }, xp: 4 },
  { id: 'stone_axe', output: 'stone_axe', count: 1, inputs: { wood: 3, stone: 2 }, xp: 12 },
  { id: 'stone_pickaxe', output: 'stone_pickaxe', count: 1, inputs: { wood: 3, stone: 3 }, xp: 12 },
  { id: 'potion', output: 'potion', count: 1, inputs: { bone: 3, wood: 1 }, station: 'workbench', xp: 10 },
  { id: 'iron_ingot', output: 'iron_ingot', count: 1, inputs: { iron_ore: 2 }, station: 'forge', xp: 10 },
  { id: 'iron_axe', output: 'iron_axe', count: 1, inputs: { plank: 2, iron_ingot: 2 }, station: 'workbench', skill: { id: 'crafting', level: 3 }, xp: 30 },
  { id: 'iron_pickaxe', output: 'iron_pickaxe', count: 1, inputs: { plank: 2, iron_ingot: 3 }, station: 'workbench', skill: { id: 'crafting', level: 3 }, xp: 30 },
  { id: 'bone_charm', output: 'bone_charm', count: 1, inputs: { bone: 8, plank: 2 }, station: 'workbench', xp: 20 },
  { id: 'moss_seed', output: 'moss_seed', count: 1, inputs: { wood: 10, potion: 2 }, station: 'workbench', xp: 25 },
  { id: 'ember_heart', output: 'ember_heart', count: 1, inputs: { bone: 6, iron_ore: 3, wood: 6 }, station: 'forge', skill: { id: 'crafting', level: 2 }, xp: 30 },
  { id: 'storm_shard', output: 'storm_shard', count: 1, inputs: { iron_ingot: 3, bone: 8 }, station: 'forge', skill: { id: 'crafting', level: 4 }, xp: 45 },
  { id: 'bone_blade', gear: 'bone_blade', count: 1, inputs: { bone: 6, plank: 1 }, station: 'workbench', xp: 20 },
  { id: 'bark_boots', gear: 'bark_boots', count: 1, inputs: { wood: 8, plank: 2 }, station: 'workbench', xp: 20 },
  { id: 'bone_mail', gear: 'bone_mail', count: 1, inputs: { bone: 12, plank: 2 }, station: 'workbench', skill: { id: 'crafting', level: 2 }, xp: 30 },
  { id: 'bone_ring', gear: 'bone_ring', count: 1, inputs: { bone: 10, iron_ingot: 1 }, station: 'workbench', skill: { id: 'crafting', level: 2 }, xp: 30 },
  { id: 'iron_helm', gear: 'iron_helm', count: 1, inputs: { iron_ingot: 3 }, station: 'forge', skill: { id: 'crafting', level: 3 }, xp: 30 },
  { id: 'iron_greaves', gear: 'iron_greaves', count: 1, inputs: { iron_ingot: 3 }, station: 'forge', skill: { id: 'crafting', level: 3 }, xp: 30 },
  { id: 'iron_sword', gear: 'iron_sword', count: 1, inputs: { plank: 1, iron_ingot: 3 }, station: 'forge', skill: { id: 'crafting', level: 4 }, xp: 40 },
  { id: 'iron_plate', gear: 'iron_plate', count: 1, inputs: { iron_ingot: 6, plank: 2 }, station: 'forge', skill: { id: 'crafting', level: 5 }, xp: 60 },
];

export type StructureId = 'campfire' | 'tent' | 'workbench' | 'forge' | 'house' | 'fence' | 'wall';
export interface StructureDef {
  name: string;
  icon: string;
  desc: string;
  cost: Partial<Record<ItemId, number>>;
  skill?: { id: SkillId; level: number };
  model: string;
  scale: number;
  /** Collision radius in metres (0 = walk-through). */
  radius: number;
  /** Rectangular collider (half extents in metres, before rotation) for walls and fences. */
  box?: [number, number];
  /** Extra local offset applied before scaling (some hex-pack props are not centred). */
  offsetX?: number;
  respawn?: boolean;
  station?: StationId;
  xp: number;
}
export const STRUCTURES: Record<StructureId, StructureDef> = {
  campfire: { name: 'Campfire', icon: '🔥', desc: 'Heals you nearby and becomes your respawn point.', cost: { wood: 5, stone: 3 },
    model: 'village/resource_lumber', scale: 4, radius: 0.9, respawn: true, xp: 15 },
  tent: { name: 'Tent', icon: '⛺', desc: 'A respawn point you can place anywhere.', cost: { wood: 4, plank: 4 },
    model: 'village/tent', scale: 6, radius: 1.4, respawn: true, xp: 20 },
  workbench: { name: 'Workbench', icon: '🛠', desc: 'Crafting station for tools and potions.', cost: { plank: 6, stone: 2 },
    model: 'dungeon/table_medium_decorated_A', scale: 1, radius: 1.1, station: 'workbench', xp: 25 },
  forge: { name: 'Forge', icon: '⚒', desc: 'Smelts iron and forges weapons.', cost: { stone: 14, wood: 6, iron_ore: 2 },
    skill: { id: 'construction', level: 2 }, model: 'village/building_blacksmith_blue', scale: 4.5, radius: 2.8, station: 'forge', xp: 60 },
  house: { name: 'House', icon: '🏠', desc: 'Your home and respawn point.', cost: { plank: 20, stone: 12 },
    skill: { id: 'construction', level: 3 }, model: 'village/building_home_A_blue', scale: 6, radius: 2.6, respawn: true, xp: 120 },
  fence: { name: 'Wooden fence', icon: '🚧', desc: 'Keeps the skeletons out.', cost: { plank: 2 },
    model: 'village/fence_wood_straight', scale: 3, radius: 0, box: [0.25, 1.75], offsetX: 1, xp: 5 },
  wall: { name: 'Stone wall', icon: '🧱', desc: 'A sturdy wall segment.', cost: { stone: 6 }, skill: { id: 'construction', level: 2 },
    model: 'village/wall_straight', scale: 3, radius: 0, box: [3, 1.1], xp: 10 },
};
export const STRUCTURE_IDS = Object.keys(STRUCTURES) as StructureId[];

export type ResourceKind = 'tree' | 'rock' | 'iron';
export const RESOURCES: Record<ResourceKind, {
  name: string; item: ItemId; skill: SkillId; hits: number; seconds: number; xp: number; regrowMs: number;
  needs?: ItemId[]; radius: number;
}> = {
  tree: { name: 'Tree', item: 'wood', skill: 'woodcutting', hits: 3, seconds: 1.6, xp: 8, regrowMs: 120_000, radius: 0.55 },
  rock: { name: 'Rock', item: 'stone', skill: 'mining', hits: 3, seconds: 2.0, xp: 9, regrowMs: 150_000, radius: 0.9 },
  iron: { name: 'Iron vein', item: 'iron_ore', skill: 'mining', hits: 2, seconds: 2.6, xp: 18, regrowMs: 240_000,
    needs: ['stone_pickaxe', 'iron_pickaxe'], radius: 0.9 },
};

export const TOOL_SPEED: Partial<Record<ItemId, { skill: SkillId; mult: number }>> = {
  stone_axe: { skill: 'woodcutting', mult: 1.5 },
  iron_axe: { skill: 'woodcutting', mult: 2.2 },
  stone_pickaxe: { skill: 'mining', mult: 1.5 },
  iron_pickaxe: { skill: 'mining', mult: 2.2 },
};

export const ENEMY_KINDS = {
  minion: { maxHp: 60, speed: 3.6, damage: 8, range: 1.8, cooldown: 1100, aggro: 10, gold: 4, xp: 12 },
  rogue: { maxHp: 55, speed: 4.6, damage: 7, range: 1.8, cooldown: 800, aggro: 12, gold: 6, xp: 15 },
  warrior: { maxHp: 120, speed: 3.2, damage: 13, range: 2.0, cooldown: 1400, aggro: 10, gold: 9, xp: 25 },
  mage: { maxHp: 50, speed: 3.0, damage: 10, range: 8.0, cooldown: 1800, aggro: 13, gold: 8, xp: 20 },
} as const;
export type EnemyKind = keyof typeof ENEMY_KINDS;

// ---------------------------------------------------------------- stats

/** Everything gear, buffs and pet auras can change. Percent stats are fractions (0.05 = 5%). */
export type StatId = 'dmg' | 'dmgPct' | 'hp' | 'armor' | 'crit' | 'haste' | 'move' | 'regen' | 'lifesteal' | 'power' | 'petPower';
export type Mods = Partial<Record<StatId, number>>;
export const STATS: Record<StatId, { name: string; pct?: boolean }> = {
  dmg: { name: 'Damage' },
  dmgPct: { name: 'Damage', pct: true },
  hp: { name: 'Max health' },
  armor: { name: 'Armor' },
  crit: { name: 'Critical chance', pct: true },
  haste: { name: 'Attack speed', pct: true },
  move: { name: 'Move speed', pct: true },
  regen: { name: 'Health per second' },
  lifesteal: { name: 'Life steal', pct: true },
  power: { name: 'Skill power', pct: true },
  petPower: { name: 'Pet power', pct: true },
};
export const STAT_IDS = Object.keys(STATS) as StatId[];
export function formatStat(id: StatId, v: number) {
  const sign = v < 0 ? '−' : '+';
  const a = Math.abs(v);
  return STATS[id].pct ? `${sign}${Math.round(a * 1000) / 10}% ${STATS[id].name.toLowerCase()}` : `${sign}${Math.round(a * 10) / 10} ${STATS[id].name.toLowerCase()}`;
}
/** Damage taken is multiplied by this (armor has diminishing returns, capped at 75% reduction). */
export const armorFactor = (armor: number) => 1 - Math.min(0.75, Math.max(0, armor) / (Math.max(0, armor) + 60));

// ---------------------------------------------------------------- icons

/** Glyphs drawn by icons.ts. */
export type Glyph =
  | 'sword' | 'axe' | 'dagger' | 'staff' | 'shield' | 'helm' | 'chest' | 'boots' | 'ring' | 'amulet' | 'shout' | 'cross'
  | 'burst' | 'swirl' | 'flame' | 'snow' | 'bubble' | 'meteor' | 'dash' | 'leap' | 'drop' | 'eye' | 'knives' | 'skull'
  | 'bolt' | 'leaf' | 'chain' | 'paw' | 'totem' | 'sun' | 'quake' | 'thorns';
/** Element colours: CSS for the UI and linear HDR (values above 1 glow under bloom) for effects. */
export type Element = 'steel' | 'holy' | 'blood' | 'fire' | 'frost' | 'arcane' | 'shadow' | 'nature' | 'storm' | 'bone';
export const ELEMENTS: Record<Element, { css: [string, string]; hdr: [number, number, number] }> = {
  steel: { css: ['#c9d3e0', '#4d5b70'], hdr: [1.4, 1.9, 3.2] },
  holy: { css: ['#ffe9a3', '#b8862b'], hdr: [4.0, 3.2, 1.4] },
  blood: { css: ['#ff8a80', '#8e1b1b'], hdr: [4.0, 0.5, 0.4] },
  fire: { css: ['#ffc46b', '#c2410c'], hdr: [5.0, 1.8, 0.4] },
  frost: { css: ['#bfefff', '#2a6fb0'], hdr: [1.2, 3.0, 5.0] },
  arcane: { css: ['#e3b8ff', '#6d28d9'], hdr: [3.0, 1.2, 5.0] },
  shadow: { css: ['#b7a6d9', '#2e1f47'], hdr: [1.8, 0.9, 3.2] },
  nature: { css: ['#c5f59a', '#2f7d32'], hdr: [1.4, 4.2, 1.0] },
  storm: { css: ['#d2f4ff', '#3b5bdb'], hdr: [2.2, 3.4, 6.0] },
  bone: { css: ['#f1ead8', '#7c6f5a'], hdr: [1.9, 2.3, 3.4] },
};

// ---------------------------------------------------------------- gear

export type Slot = 'weapon' | 'head' | 'chest' | 'feet' | 'trinket';
export const SLOTS: Record<Slot, { name: string; glyph: Glyph }> = {
  weapon: { name: 'Weapon', glyph: 'sword' },
  head: { name: 'Head', glyph: 'helm' },
  chest: { name: 'Body', glyph: 'chest' },
  feet: { name: 'Feet', glyph: 'boots' },
  trinket: { name: 'Trinket', glyph: 'ring' },
};
export const SLOT_IDS = Object.keys(SLOTS) as Slot[];

export type GearBaseId =
  | 'iron_sword' | 'bone_blade' | 'war_axe' | 'rune_staff' | 'twin_daggers'
  | 'leather_cap' | 'iron_helm' | 'mage_hood'
  | 'bone_mail' | 'iron_plate' | 'ranger_coat'
  | 'bark_boots' | 'iron_greaves'
  | 'bone_ring' | 'ember_amulet' | 'jade_pendant' | 'storm_ring' | 'beast_totem';
export const GEAR: Record<GearBaseId, { name: string; slot: Slot; glyph: Glyph; element: Element; base: Mods }> = {
  iron_sword: { name: 'Iron sword', slot: 'weapon', glyph: 'sword', element: 'steel', base: { dmg: 12 } },
  bone_blade: { name: 'Bone blade', slot: 'weapon', glyph: 'sword', element: 'bone', base: { dmg: 8, crit: 0.03 } },
  war_axe: { name: 'War axe', slot: 'weapon', glyph: 'axe', element: 'blood', base: { dmg: 18, haste: -0.05 } },
  rune_staff: { name: 'Rune staff', slot: 'weapon', glyph: 'staff', element: 'arcane', base: { dmg: 10, power: 0.1 } },
  twin_daggers: { name: 'Twin daggers', slot: 'weapon', glyph: 'dagger', element: 'shadow', base: { dmg: 7, haste: 0.08, crit: 0.04 } },
  leather_cap: { name: 'Leather cap', slot: 'head', glyph: 'helm', element: 'nature', base: { armor: 4, hp: 5 } },
  iron_helm: { name: 'Iron helm', slot: 'head', glyph: 'helm', element: 'steel', base: { armor: 10, hp: 10 } },
  mage_hood: { name: 'Mage hood', slot: 'head', glyph: 'helm', element: 'arcane', base: { armor: 3, power: 0.06 } },
  bone_mail: { name: 'Bone mail', slot: 'chest', glyph: 'chest', element: 'bone', base: { armor: 8, hp: 12 } },
  iron_plate: { name: 'Iron plate', slot: 'chest', glyph: 'chest', element: 'steel', base: { armor: 18, hp: 25, move: -0.04 } },
  ranger_coat: { name: 'Ranger coat', slot: 'chest', glyph: 'chest', element: 'nature', base: { armor: 8, move: 0.04, crit: 0.02 } },
  bark_boots: { name: 'Bark boots', slot: 'feet', glyph: 'boots', element: 'nature', base: { move: 0.05, armor: 2 } },
  iron_greaves: { name: 'Iron greaves', slot: 'feet', glyph: 'boots', element: 'steel', base: { armor: 7, move: 0.02 } },
  bone_ring: { name: 'Bone ring', slot: 'trinket', glyph: 'ring', element: 'bone', base: { lifesteal: 0.03 } },
  ember_amulet: { name: 'Ember amulet', slot: 'trinket', glyph: 'amulet', element: 'fire', base: { dmgPct: 0.06 } },
  jade_pendant: { name: 'Jade pendant', slot: 'trinket', glyph: 'amulet', element: 'nature', base: { regen: 1.5 } },
  storm_ring: { name: 'Storm ring', slot: 'trinket', glyph: 'ring', element: 'storm', base: { haste: 0.06 } },
  beast_totem: { name: 'Beast totem', slot: 'trinket', glyph: 'totem', element: 'nature', base: { petPower: 0.15 } },
};
export const GEAR_IDS = Object.keys(GEAR) as GearBaseId[];

export const RARITIES = [
  { name: 'Common', css: '#b8bcc4', mult: 1, affixes: 0 },
  { name: 'Uncommon', css: '#5fd068', mult: 1.15, affixes: 1 },
  { name: 'Rare', css: '#4ea8ff', mult: 1.35, affixes: 2 },
  { name: 'Epic', css: '#b779ff', mult: 1.6, affixes: 3 },
  { name: 'Legendary', css: '#ff9d3b', mult: 2, affixes: 4 },
] as const;
/** Bonus stats a better piece can roll on top of its base (value at item level 1). */
export const AFFIXES: Mods = { hp: 12, armor: 5, crit: 0.03, haste: 0.04, move: 0.03, regen: 0.8, lifesteal: 0.02, power: 0.06, petPower: 0.08, dmgPct: 0.04 };
export const BAG_SIZE = 24;

export interface GearItem {
  uid: string;
  base: GearBaseId;
  rarity: number;
  ilvl: number;
  stats: Mods;
}

// ---------------------------------------------------------------- combat skills (player and pets)

export type Effect =
  /** Damage around the caster (or around its target with `at: 'target'`). */
  | { kind: 'nova'; radius: number; mult: number; at?: 'target'; stun?: number; slow?: number; burn?: number }
  /** Damage in front of the caster. `execute` doubles damage on enemies below that health fraction. */
  | { kind: 'cone'; range: number; arc: number; mult: number; stun?: number; execute?: number }
  /** A projectile that hits the first enemy in line and explodes. */
  | { kind: 'bolt'; range: number; mult: number; blast: number; burn?: number }
  /** A quick move forward that damages what it passes (and optionally where it lands). */
  | { kind: 'dash'; distance: number; mult: number; blast?: number }
  /** A strike that lands after a delay at a point ahead of the caster (or at its target). */
  | { kind: 'meteor'; range: number; delay: number; radius: number; mult: number; stun?: number }
  /** Lightning that jumps between nearby enemies. */
  | { kind: 'chain'; range: number; jumps: number; mult: number; slow?: number }
  | { kind: 'buff'; mods: Mods; duration: number; shield?: number; party?: boolean }
  | { kind: 'heal'; pct: number; party?: boolean }
  /** Forces nearby enemies to attack the pet. */
  | { kind: 'taunt'; radius: number; duration: number };

export interface SkillDef {
  id: string;
  name: string;
  glyph: Glyph;
  element: Element;
  desc: string;
  /** Combat level (player) or pet level needed to learn it. */
  unlock: number;
  maxRank: number;
  cooldown: number;
  /** Hero animation. */
  clip?: string;
  effect: Effect;
}
/** Damage, healing, shields and buff strength grow 15% per rank after the first. */
export const rankScale = (rank: number) => 1 + 0.15 * (Math.max(1, rank) - 1);

export const CLASS_SKILLS: Record<ClassId, SkillDef[]> = {
  knight: [
    { id: 'shield_bash', name: 'Shield Bash', glyph: 'shield', element: 'steel', unlock: 1, maxRank: 5, cooldown: 6000, clip: 'Block',
      desc: 'Slam enemies in front of you and stun them.', effect: { kind: 'cone', range: 3, arc: 1.0, mult: 1.4, stun: 1500 } },
    { id: 'rally', name: 'Rallying Cry', glyph: 'shout', element: 'holy', unlock: 3, maxRank: 5, cooldown: 20000, clip: 'Cheer',
      desc: 'You and your pet hit harder and take less damage.', effect: { kind: 'buff', mods: { dmgPct: 0.2, armor: 20 }, duration: 8000, party: true } },
    { id: 'holy_light', name: 'Holy Light', glyph: 'cross', element: 'holy', unlock: 6, maxRank: 5, cooldown: 22000, clip: 'Spellcast_Raise',
      desc: 'Heal yourself and your pet.', effect: { kind: 'heal', pct: 0.3, party: true } },
    { id: 'judgement', name: 'Judgement', glyph: 'sun', element: 'holy', unlock: 10, maxRank: 5, cooldown: 16000, clip: 'Jump_Full_Short',
      desc: 'Leap and smite everything around you, stunning it.', effect: { kind: 'nova', radius: 4.5, mult: 2.2, stun: 1200 } },
  ],
  barbarian: [
    { id: 'cleave', name: 'Cleave', glyph: 'axe', element: 'steel', unlock: 1, maxRank: 5, cooldown: 5000, clip: '2H_Melee_Attack_Slice',
      desc: 'A wide swing that hits everything in front of you.', effect: { kind: 'cone', range: 3.4, arc: 1.6, mult: 1.6 } },
    { id: 'leap', name: 'Leap', glyph: 'leap', element: 'steel', unlock: 3, maxRank: 5, cooldown: 10000, clip: 'Jump_Full_Short',
      desc: 'Jump forward and crash down on your enemies.', effect: { kind: 'dash', distance: 7, mult: 1.3, blast: 3 } },
    { id: 'bloodrage', name: 'Bloodrage', glyph: 'drop', element: 'blood', unlock: 6, maxRank: 5, cooldown: 24000, clip: 'Cheer',
      desc: 'Fly into a rage: more damage, and your hits heal you.', effect: { kind: 'buff', mods: { dmgPct: 0.35, lifesteal: 0.15 }, duration: 8000 } },
    { id: 'whirlwind', name: 'Whirlwind', glyph: 'swirl', element: 'steel', unlock: 10, maxRank: 5, cooldown: 14000, clip: '2H_Melee_Attack_Spin',
      desc: 'Spin with your axe out, hitting everything around you.', effect: { kind: 'nova', radius: 3.8, mult: 2.4 } },
  ],
  mage: [
    { id: 'fireball', name: 'Fireball', glyph: 'flame', element: 'fire', unlock: 1, maxRank: 5, cooldown: 4000, clip: 'Spellcast_Shoot',
      desc: 'Hurl a ball of fire that explodes and sets enemies burning.', effect: { kind: 'bolt', range: 14, mult: 1.8, blast: 2.6, burn: 3000 } },
    { id: 'frost_nova', name: 'Frost Nova', glyph: 'snow', element: 'frost', unlock: 3, maxRank: 5, cooldown: 11000, clip: 'Spellcast_Raise',
      desc: 'A burst of ice that damages and slows enemies around you.', effect: { kind: 'nova', radius: 5, mult: 0.8, slow: 4000 } },
    { id: 'arcane_shield', name: 'Arcane Shield', glyph: 'bubble', element: 'arcane', unlock: 6, maxRank: 5, cooldown: 20000, clip: 'Spellcast_Long',
      desc: 'A bubble that absorbs damage.', effect: { kind: 'buff', mods: {}, duration: 10000, shield: 45 } },
    { id: 'meteor', name: 'Meteor', glyph: 'meteor', element: 'fire', unlock: 10, maxRank: 5, cooldown: 20000, clip: 'Spellcast_Long',
      desc: 'Call down a meteor in front of you.', effect: { kind: 'meteor', range: 9, delay: 900, radius: 4, mult: 3.2, stun: 800 } },
  ],
  rogue: [
    { id: 'shadowstep', name: 'Shadowstep', glyph: 'dash', element: 'shadow', unlock: 1, maxRank: 5, cooldown: 7000, clip: 'Dodge_Forward',
      desc: 'Dart forward through your enemies, cutting them.', effect: { kind: 'dash', distance: 6, mult: 1.2 } },
    { id: 'fan_of_knives', name: 'Fan of Knives', glyph: 'knives', element: 'steel', unlock: 3, maxRank: 5, cooldown: 8000, clip: 'Dualwield_Melee_Attack_Slice',
      desc: 'Throw knives in every direction.', effect: { kind: 'nova', radius: 4, mult: 1.1 } },
    { id: 'evasion', name: 'Evasion', glyph: 'eye', element: 'shadow', unlock: 6, maxRank: 5, cooldown: 20000, clip: 'Dodge_Forward',
      desc: 'Faster attacks, more critical hits and quicker feet.', effect: { kind: 'buff', mods: { haste: 0.4, crit: 0.25, move: 0.2 }, duration: 6000 } },
    { id: 'assassinate', name: 'Assassinate', glyph: 'dagger', element: 'blood', unlock: 10, maxRank: 5, cooldown: 16000, clip: 'Dualwield_Melee_Attack_Stab',
      desc: 'A deadly stab. Double damage on enemies below 30% health.', effect: { kind: 'cone', range: 2.6, arc: 0.6, mult: 4, execute: 0.3 } },
  ],
};

// ---------------------------------------------------------------- pets

export type PetSpecies = 'squire' | 'ember' | 'moss' | 'storm';
export interface PetDef {
  name: string;
  glyph: Glyph;
  element: Element;
  role: string;
  desc: string;
  charm: ItemId;
  /** 'skeleton' uses the KayKit skeleton minion; sprites are glowing procedural spirits. */
  look: 'skeleton' | 'sprite';
  hp: number;
  hpPerLevel: number;
  damage: number;
  damagePerLevel: number;
  /** The pet's own armor (damage it takes is reduced like yours). */
  armor: number;
  range: number;
  cooldown: number;
  speed: number;
  /** Passive bonus for you while the pet is with you: base + perLevel × (level − 1). */
  aura: { name: string; base: Mods; perLevel: Mods };
  skills: SkillDef[];
}
export const PET_MAX_LEVEL = 30;
export const petXpForLevel = (level: number) => Math.round(30 * (level - 1) ** 2);
export const petLevelFromXp = (xp: number) => Math.min(PET_MAX_LEVEL, Math.floor(Math.sqrt(xp / 30)) + 1);
export const PET_DOWN_MS = 30_000;

export const PETS: Record<PetSpecies, PetDef> = {
  squire: {
    name: 'Skeleton Squire', glyph: 'skull', element: 'bone', role: 'Tank', charm: 'bone_charm', look: 'skeleton',
    desc: 'A loyal skeleton that draws enemies away from you.',
    hp: 110, hpPerLevel: 14, damage: 7, damagePerLevel: 1.6, armor: 30, range: 1.9, cooldown: 1100, speed: 5.8,
    aura: { name: 'Bone Ward', base: { armor: 6 }, perLevel: { armor: 1.2 } },
    skills: [
      { id: 'taunt', name: 'Taunt', glyph: 'shout', element: 'bone', unlock: 1, maxRank: 3, cooldown: 12000,
        desc: 'Nearby enemies attack the squire instead of you.', effect: { kind: 'taunt', radius: 6, duration: 4000 } },
      { id: 'bone_bash', name: 'Bone Bash', glyph: 'shield', element: 'bone', unlock: 3, maxRank: 3, cooldown: 8000,
        desc: 'Bashes enemies in front of it and stuns them.', effect: { kind: 'cone', range: 2.6, arc: 1.0, mult: 1.6, stun: 1200 } },
      { id: 'bone_armor', name: 'Bone Armor', glyph: 'chest', element: 'bone', unlock: 6, maxRank: 3, cooldown: 18000,
        desc: 'Wraps you both in bone: more armor.', effect: { kind: 'buff', mods: { armor: 25 }, duration: 8000, party: true } },
      { id: 'grave_quake', name: 'Grave Quake', glyph: 'quake', element: 'bone', unlock: 10, maxRank: 3, cooldown: 16000,
        desc: 'Shakes the ground, damaging and stunning enemies around it.', effect: { kind: 'nova', radius: 4, mult: 2, stun: 1000 } },
    ],
  },
  ember: {
    name: 'Ember Sprite', glyph: 'flame', element: 'fire', role: 'Damage', charm: 'ember_heart', look: 'sprite',
    desc: 'A spirit of living fire that burns your enemies from range.',
    hp: 70, hpPerLevel: 9, damage: 9, damagePerLevel: 2.2, armor: 0, range: 7, cooldown: 1300, speed: 6.2,
    aura: { name: 'Kindle', base: { dmgPct: 0.05 }, perLevel: { dmgPct: 0.01 } },
    skills: [
      { id: 'flame_burst', name: 'Flame Burst', glyph: 'burst', element: 'fire', unlock: 1, maxRank: 3, cooldown: 7000,
        desc: 'A fire bolt that explodes and sets enemies burning.', effect: { kind: 'bolt', range: 9, mult: 1.6, blast: 2.2, burn: 3000 } },
      { id: 'inferno', name: 'Inferno', glyph: 'flame', element: 'fire', unlock: 3, maxRank: 3, cooldown: 12000,
        desc: 'Engulfs its target and everything near it in flames.', effect: { kind: 'nova', at: 'target', radius: 3, mult: 1.8, burn: 4000 } },
      { id: 'warmth', name: 'Warmth', glyph: 'sun', element: 'fire', unlock: 6, maxRank: 3, cooldown: 20000,
        desc: 'You both hit harder and faster.', effect: { kind: 'buff', mods: { dmgPct: 0.15, haste: 0.1 }, duration: 8000, party: true } },
      { id: 'cinder_rain', name: 'Cinder Rain', glyph: 'meteor', element: 'fire', unlock: 10, maxRank: 3, cooldown: 22000,
        desc: 'Calls down a shower of cinders on its target.', effect: { kind: 'meteor', range: 9, delay: 800, radius: 4, mult: 3 } },
    ],
  },
  moss: {
    name: 'Moss Sprite', glyph: 'leaf', element: 'nature', role: 'Healer', charm: 'moss_seed', look: 'sprite',
    desc: 'A gentle forest spirit that keeps you on your feet.',
    hp: 80, hpPerLevel: 10, damage: 5, damagePerLevel: 1.2, armor: 8, range: 6, cooldown: 1500, speed: 6.2,
    aura: { name: 'Verdant', base: { regen: 1 }, perLevel: { regen: 0.2 } },
    skills: [
      { id: 'mend', name: 'Mend', glyph: 'cross', element: 'nature', unlock: 1, maxRank: 3, cooldown: 9000,
        desc: 'Heals you when you are hurt.', effect: { kind: 'heal', pct: 0.15 } },
      { id: 'thorn_snare', name: 'Thorn Snare', glyph: 'thorns', element: 'nature', unlock: 3, maxRank: 3, cooldown: 10000,
        desc: 'Thorns burst around its target, slowing enemies.', effect: { kind: 'nova', at: 'target', radius: 3, mult: 1, slow: 4000 } },
      { id: 'barkskin', name: 'Barkskin', glyph: 'shield', element: 'nature', unlock: 6, maxRank: 3, cooldown: 20000,
        desc: 'Bark armor and fast healing for you both.', effect: { kind: 'buff', mods: { armor: 30, regen: 3 }, duration: 8000, party: true } },
      { id: 'bloom', name: 'Bloom', glyph: 'leaf', element: 'nature', unlock: 10, maxRank: 3, cooldown: 24000,
        desc: 'A great heal for you and itself.', effect: { kind: 'heal', pct: 0.35, party: true } },
    ],
  },
  storm: {
    name: 'Storm Sprite', glyph: 'bolt', element: 'storm', role: 'Speed', charm: 'storm_shard', look: 'sprite',
    desc: 'A crackling spirit that strikes fast and makes you faster.',
    hp: 75, hpPerLevel: 9, damage: 6, damagePerLevel: 1.6, armor: 0, range: 6, cooldown: 700, speed: 6.8,
    aura: { name: 'Static Charge', base: { haste: 0.05, move: 0.05 }, perLevel: { haste: 0.006 } },
    skills: [
      { id: 'chain_lightning', name: 'Chain Lightning', glyph: 'chain', element: 'storm', unlock: 1, maxRank: 3, cooldown: 6000,
        desc: 'Lightning that jumps between up to four enemies.', effect: { kind: 'chain', range: 7, jumps: 3, mult: 1.3 } },
      { id: 'static_field', name: 'Static Field', glyph: 'swirl', element: 'storm', unlock: 3, maxRank: 3, cooldown: 12000,
        desc: 'A crackling field that damages and slows.', effect: { kind: 'nova', at: 'target', radius: 3.5, mult: 0.9, slow: 3000 } },
      { id: 'overcharge', name: 'Overcharge', glyph: 'bolt', element: 'storm', unlock: 6, maxRank: 3, cooldown: 20000,
        desc: 'More critical hits and faster attacks for you both.', effect: { kind: 'buff', mods: { crit: 0.15, haste: 0.15 }, duration: 7000, party: true } },
      { id: 'thunderclap', name: 'Thunderclap', glyph: 'burst', element: 'storm', unlock: 10, maxRank: 3, cooldown: 18000,
        desc: 'A thunderclap that damages and stuns around its target.', effect: { kind: 'nova', at: 'target', radius: 4, mult: 2.2, stun: 1500 } },
    ],
  },
};
export const PET_IDS = Object.keys(PETS) as PetSpecies[];
