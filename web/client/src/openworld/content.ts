// Game content for the open world: items, recipes, buildable structures, skills,
// resource nodes and enemies. Plain data so balance changes stay in one place.

export type ItemId =
  | 'wood' | 'stone' | 'iron_ore' | 'plank' | 'iron_ingot' | 'bone' | 'potion'
  | 'stone_axe' | 'stone_pickaxe' | 'iron_axe' | 'iron_pickaxe' | 'iron_sword';

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
  iron_sword: { name: 'Iron sword', icon: '🗡', desc: '+12 attack damage.' },
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
  output: ItemId;
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
  { id: 'iron_sword', output: 'iron_sword', count: 1, inputs: { plank: 1, iron_ingot: 3 }, station: 'forge', skill: { id: 'crafting', level: 4 }, xp: 40 },
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
