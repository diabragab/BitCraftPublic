// Generates shared/map.json: the single source of truth for the arena layout.
// The SpacetimeDB module embeds it (collision, spawn points) and the client
// renders it, so server-side collision always matches what players see.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let seed = 1337;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const round = (v) => Math.round(v * 100) / 100;

const HALF = 34; // playable area is [-HALF, HALF] on both axes
const KEEP = 16; // the walled keep spans [-KEEP, KEEP]
const props = [];
const colliders = [];

const box = (minX, minZ, maxX, maxZ) => colliders.push({ type: 'box', minX, minZ, maxX, maxZ });
const circle = (x, z, r) => colliders.push({ type: 'circle', x: round(x), z: round(z), r });
const prop = (model, x, z, rotY = 0, scale = 1) => props.push({ model, x: round(x), z: round(z), rotY: round(rotY), scale });

// Keep floor (dungeon tiles are 4x4m)
for (let x = -KEEP + 2; x < KEEP; x += 4) {
  for (let z = -KEEP + 2; z < KEEP; z += 4) {
    const r = rand();
    prop(r < 0.12 ? 'dungeon/floor_tile_large_rocks' : r < 0.25 ? 'dungeon/floor_dirt_large' : 'dungeon/floor_tile_large', x, z);
  }
}

// Keep walls: 4m segments with an 8m gate in the middle of each side
const sides = [
  { axis: 'x', fixed: -KEEP, rot: 0 },
  { axis: 'x', fixed: KEEP, rot: Math.PI },
  { axis: 'z', fixed: -KEEP, rot: Math.PI / 2 },
  { axis: 'z', fixed: KEEP, rot: -Math.PI / 2 },
];
for (const side of sides) {
  for (let c = -KEEP + 2; c < KEEP; c += 4) {
    if (Math.abs(c) < 4) continue; // gate
    const variant = rand() < 0.2 ? 'dungeon/wall_cracked' : 'dungeon/wall';
    if (side.axis === 'x') {
      prop(variant, c, side.fixed, side.rot);
      box(c - 2, side.fixed - 0.5, c + 2, side.fixed + 0.5);
    } else {
      prop(variant, side.fixed, c, side.rot);
      box(side.fixed - 0.5, c - 2, side.fixed + 0.5, c + 2);
    }
  }
  // gate pillars + torches
  for (const s of [-4, 4]) {
    const [x, z] = side.axis === 'x' ? [s, side.fixed] : [side.fixed, s];
    prop('dungeon/pillar', x, z);
    circle(x, z, 0.8);
    prop('dungeon/torch_lit', x + (side.axis === 'z' ? (side.fixed < 0 ? 1 : -1) : 0), z + (side.axis === 'x' ? (side.fixed < 0 ? 1 : -1) : 0));
  }
}
for (const [x, z] of [[-KEEP, -KEEP], [KEEP, -KEEP], [-KEEP, KEEP], [KEEP, KEEP]]) {
  prop('dungeon/pillar', x, z);
  circle(x, z, 0.8);
}

// Banners on inner walls
for (const [x, z, rot] of [[-10, -KEEP + 0.5, 0], [10, -KEEP + 0.5, 0], [-KEEP + 0.5, -10, Math.PI / 2], [KEEP - 0.5, 10, -Math.PI / 2]]) {
  prop(rand() < 0.5 ? 'dungeon/banner_patternA_red' : 'dungeon/banner_shield_red', x, z, rot);
}

// Keep interior props (with colliders)
const interior = [
  ['dungeon/pillar', -7, -7, 0, 0.8], ['dungeon/pillar', 7, -7, 0, 0.8], ['dungeon/pillar', -7, 7, 0, 0.8], ['dungeon/pillar', 7, 7, 0, 0.8],
  ['dungeon/barrel_large', -13, -13, 0, 0.9], ['dungeon/barrel_small_stack', -11, -13.5, 0.3, 0.9], ['dungeon/crates_stacked', 13, -13, 0.4, 1.1],
  ['dungeon/box_large', 11, -13.5, 0, 0.8], ['dungeon/table_medium_decorated_A', 12, 12, 0.2, 1.0], ['dungeon/keg_decorated', -12.5, 13, 0, 1.2],
  ['dungeon/chest_gold', -5.5, -14, 0, 0.9], ['dungeon/box_stacked', -13, 9, 1.2, 1.4], ['dungeon/rubble_half', 9, 2, 1.0, 0],
  ['dungeon/trunk_large_A', 13.5, 4, -1.57, 0.8], ['dungeon/column', -3, 3, 0, 0.4], ['dungeon/column', 3, -3, 0, 0.4],
];
for (const [model, x, z, rot, r] of interior) {
  prop(model, x, z, rot);
  if (r > 0) circle(x, z, r);
}
prop('dungeon/candle_triple', 12.3, 11.6, 0); // on the table, decorative

const enemySpawns = [
    { kind: 'minion', x: -8, z: -10 }, { kind: 'minion', x: 8, z: -10 }, { kind: 'warrior', x: 0, z: -8 },
    { kind: 'mage', x: 0, z: -11 }, { kind: 'rogue', x: -10, z: 4 }, { kind: 'minion', x: 10, z: 6 },
    { kind: 'minion', x: -26, z: -20 }, { kind: 'rogue', x: 24, z: -24 }, { kind: 'warrior', x: -24, z: 12 },
    { kind: 'minion', x: 26, z: 14 }, { kind: 'mage', x: -28, z: -2 }, { kind: 'minion', x: 28, z: -6 },
    { kind: 'rogue', x: 0, z: -28 }, { kind: 'minion', x: 14, z: 22 },
  ];
const pickupSpawns = [
    { kind: 'potion', x: -12, z: -9 }, { kind: 'potion', x: 12, z: 9 }, { kind: 'potion', x: -22, z: 22 },
    { kind: 'potion', x: 22, z: -18 }, { kind: 'gold', x: 0, z: -4 }, { kind: 'gold', x: -9, z: 12 },
    { kind: 'gold', x: 9, z: -13 }, { kind: 'gold', x: -28, z: -28 }, { kind: 'gold', x: 28, z: 28 }, { kind: 'gold', x: 20, z: 0 },
  ];
const reserved = [...enemySpawns, ...pickupSpawns];

// Outdoor forest ring (single trees collide, rocks are decorative)
const isLane = (x, z) => Math.abs(x) < 5 || Math.abs(z) < 5;
const nearCamp = (x, z) => Math.hypot(x, z - 27) < 7;
let placed = 0;
for (let i = 0; i < 400 && placed < 70; i++) {
  const x = (rand() * 2 - 1) * (HALF - 1.5);
  const z = (rand() * 2 - 1) * (HALF - 1.5);
  if (Math.max(Math.abs(x), Math.abs(z)) < KEEP + 3 || isLane(x, z) || nearCamp(x, z)) continue;
  if (colliders.some((c) => c.type === 'circle' && Math.hypot(c.x - x, c.z - z) < 3.2)) continue;
  if (reserved.some((p) => Math.hypot(p.x - x, p.z - z) < 2.5)) continue;
  const model = rand() < 0.5 ? 'nature/tree_single_A' : 'nature/tree_single_B';
  prop(model, x, z, rand() * Math.PI * 2, round(2.6 + rand() * 0.8));
  circle(x, z, 0.7);
  placed++;
}
for (let i = 0; i < 40; i++) {
  const x = (rand() * 2 - 1) * HALF, z = (rand() * 2 - 1) * HALF;
  if (Math.max(Math.abs(x), Math.abs(z)) < KEEP + 2) continue;
  prop(['nature/rock_single_A', 'nature/rock_single_B', 'nature/rock_single_C'][i % 3], x, z, rand() * 6.28, round(2.5 + rand() * 2));
}

// Decorative mountains/forest beyond the playable boundary
for (let a = 0; a < Math.PI * 2; a += Math.PI / 14) {
  const d = HALF + 9 + rand() * 4;
  const model = ['nature/mountain_A_grass_trees', 'nature/mountain_B_grass_trees', 'nature/hills_A_trees', 'nature/trees_A_large', 'nature/trees_B_large'][Math.floor(rand() * 5)];
  prop(model, Math.cos(a) * d, Math.sin(a) * d, rand() * 6.28, round(6 + rand() * 3));
}
for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
  const d = HALF + 3 + rand() * 2;
  prop(rand() < 0.5 ? 'nature/trees_A_medium' : 'nature/trees_A_large', Math.cos(a) * d, Math.sin(a) * d, rand() * 6.28, round(3 + rand()));
}

// Camp (player spawn, enemies keep out)
prop('dungeon/barrel_large', -3.5, 30, 0); circle(-3.5, 30, 0.9);
prop('dungeon/box_large', 3.5, 30.5, 0.5); circle(3.5, 30.5, 0.8);
prop('dungeon/sword_shield', 0, 32.5, 0);

const map = {
  version: 1,
  half: HALF,
  keep: KEEP,
  playerRadius: 0.5,
  camp: { x: 0, z: 27, r: 7 },
  playerSpawns: [[0, 26], [-2, 27], [2, 27], [-1, 25], [1, 25], [0, 28]],
  enemySpawns,
  pickupSpawns,
  colliders,
  props,
};

const out = join(dirname(fileURLToPath(import.meta.url)), 'map.json');
writeFileSync(out, JSON.stringify(map));
console.log(`map.json: ${props.length} props, ${colliders.length} colliders, ${map.enemySpawns.length} enemy spawns`);
