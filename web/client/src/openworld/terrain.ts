// Procedural island: heightmap, biomes, terrain chunk meshes, resource placement and
// points of interest. Everything is a pure function of the seed, so nothing about the
// untouched world has to be saved: only changes (depleted nodes, buildings) are stored.
import * as THREE from 'three';
import { hash2, mulberry32, Simplex, smoothstep } from './noise';
import type { EnemyKind, ResourceKind } from './content';

export const WORLD_HALF = 384; // the island spans [-384, 384] m on both axes
export const CHUNK = 64;
const STEP = 2;
export const WATER_LEVEL = 0;
export const VILLAGE_RADIUS = 34;

export type Biome = 'water' | 'sand' | 'grass' | 'forest' | 'rock' | 'snow';
const BIOME_COLORS: Record<Biome, THREE.Color> = {
  water: new THREE.Color('#c8b57c'),
  sand: new THREE.Color('#e3d08f'),
  grass: new THREE.Color('#7dbb4c'),
  forest: new THREE.Color('#4e9440'),
  rock: new THREE.Color('#8f877b'),
  snow: new THREE.Color('#eef2f6'),
};

export interface ResourceNode {
  id: string;
  kind: ResourceKind;
  x: number;
  z: number;
  y: number;
  rot: number;
  scale: number;
  model: string;
}

export interface Placed {
  model: string;
  x: number;
  z: number;
  rot: number;
  scale: number;
  radius: number;
  offsetX?: number;
  station?: 'workbench' | 'forge';
}

export interface Ruin {
  id: string;
  x: number;
  z: number;
  level: number;
  props: Placed[];
  chest: { x: number; z: number };
  spawns: { kind: EnemyKind; x: number; z: number }[];
}

export class WorldGen {
  readonly noise: Simplex;
  readonly ruins: Ruin[];
  readonly village: Placed[];

  constructor(readonly seed: number) {
    this.noise = new Simplex(seed);
    this.village = buildVillage();
    this.ruins = this.placeRuins();
  }

  height(x: number, z: number): number {
    const n = this.noise;
    const r = Math.max(Math.abs(x), Math.abs(z)) * 0.55 + Math.hypot(x, z) * 0.45;
    const land = smoothstep(WORLD_HALF * 0.98, WORLD_HALF * 0.68, r + n.noise(x / 90, z / 90) * 26);
    let h = 3.5 + n.fbm(x / 230, z / 230, 5) * 9;
    const mountains = smoothstep(0.02, 0.42, n.fbm(x / 420 + 31.7, z / 420 - 12.3, 3));
    h += n.ridge(x / 120, z / 120, 4) * 40 * mountains;
    h = -9 + (h + 9) * land;
    // flatten the starting village
    const v = smoothstep(VILLAGE_RADIUS + 14, VILLAGE_RADIUS - 6, Math.hypot(x, z));
    return h * (1 - v) + 3 * v;
  }

  biome(x: number, z: number, h = this.height(x, z)): Biome {
    if (h < WATER_LEVEL - 0.2) return 'water';
    if (h < 1.3) return 'sand';
    const jitter = this.noise.noise(x / 18, z / 18) * 2.5;
    if (h > 31 + jitter) return 'snow';
    if (h > 18 + jitter) return 'rock';
    return this.noise.fbm(x / 280 + 211, z / 280 - 97, 3) > 0.02 ? 'forest' : 'grass';
  }

  /** Flat-shaded terrain mesh for one chunk, coloured by biome. */
  chunkGeometry(cx: number, cz: number): THREE.BufferGeometry {
    const n = CHUNK / STEP;
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const hs = new Float32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) hs[j * (n + 1) + i] = this.height(x0 + i * STEP, z0 + j * STEP);
    const pos = new Float32Array(n * n * 6 * 3);
    const col = new Float32Array(n * n * 6 * 3);
    const c = new THREE.Color();
    let p = 0;
    const put = (i: number, j: number, color: THREE.Color) => {
      pos[p] = x0 + i * STEP;
      pos[p + 1] = hs[j * (n + 1) + i];
      pos[p + 2] = z0 + j * STEP;
      col[p] = color.r;
      col[p + 1] = color.g;
      col[p + 2] = color.b;
      p += 3;
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        for (const tri of [[[0, 0], [0, 1], [1, 0]], [[1, 0], [0, 1], [1, 1]]] as const) {
          const mx = x0 + (i + (tri[0][0] + tri[1][0] + tri[2][0]) / 3) * STEP;
          const mz = z0 + (j + (tri[0][1] + tri[1][1] + tri[2][1]) / 3) * STEP;
          const mh = (hs[(j + tri[0][1]) * (n + 1) + i + tri[0][0]] + hs[(j + tri[1][1]) * (n + 1) + i + tri[1][0]] + hs[(j + tri[2][1]) * (n + 1) + i + tri[2][0]]) / 3;
          c.copy(BIOME_COLORS[this.biome(mx, mz, mh)]);
          const shade = 1 + ((hash2(Math.floor(mx), Math.floor(mz), this.seed) % 1000) / 1000 - 0.5) * 0.08;
          c.multiplyScalar(shade);
          for (const [di, dj] of tri) put(i + di, j + dj, c);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  /** Harvestable trees, rocks and iron veins in a chunk (deterministic). */
  chunkResources(cx: number, cz: number): ResourceNode[] {
    const rnd = mulberry32(hash2(cx, cz, this.seed));
    const out: ResourceNode[] = [];
    const cell = 5;
    for (let j = 0; j < CHUNK / cell; j++) {
      for (let i = 0; i < CHUNK / cell; i++) {
        const x = cx * CHUNK + (i + rnd()) * cell;
        const z = cz * CHUNK + (j + rnd()) * cell;
        const roll = rnd();
        const pick = rnd();
        const rot = rnd() * Math.PI * 2;
        const size = rnd();
        if (Math.hypot(x, z) < VILLAGE_RADIUS + 4) continue;
        if (this.ruins.some((r) => Math.hypot(r.x - x, r.z - z) < 14)) continue;
        const h = this.height(x, z);
        const b = this.biome(x, z, h);
        let kind: ResourceKind | null = null;
        if (b === 'forest') kind = roll < 0.4 ? 'tree' : roll < 0.43 ? 'rock' : null;
        else if (b === 'grass') kind = roll < 0.055 ? 'tree' : roll < 0.08 ? 'rock' : null;
        else if (b === 'rock') kind = roll < 0.12 ? 'rock' : roll < 0.19 ? 'iron' : null;
        else if (b === 'snow') kind = roll < 0.04 ? 'rock' : null;
        if (!kind) continue;
        const id = `${cx}:${cz}:${j * 64 + i}`;
        if (kind === 'tree') {
          out.push({ id, kind, x, z, y: h, rot, scale: 2.6 + size, model: pick < 0.5 ? 'nature/tree_single_A' : 'nature/tree_single_B' });
        } else {
          const rocks = kind === 'iron' ? ['nature/rock_single_D', 'nature/rock_single_E'] : ['nature/rock_single_A', 'nature/rock_single_B', 'nature/rock_single_C', 'nature/rock_single_E'];
          out.push({ id, kind, x, z, y: h, rot, scale: 5 + size * 2, model: rocks[Math.floor(pick * rocks.length)] });
        }
      }
    }
    return out;
  }

  private placeRuins(): Ruin[] {
    const rnd = mulberry32(this.seed ^ 0x9e3779b9);
    const ruins: Ruin[] = [];
    for (let attempt = 0; attempt < 600 && ruins.length < 10; attempt++) {
      const x = (rnd() * 2 - 1) * WORLD_HALF * 0.78;
      const z = (rnd() * 2 - 1) * WORLD_HALF * 0.78;
      const d = Math.hypot(x, z);
      const h = this.height(x, z);
      if (d < 110 || h < 2.5 || h > 20) continue;
      if (ruins.some((r) => Math.hypot(r.x - x, r.z - z) < 95)) continue;
      const level = 1 + Math.floor(d / 110);
      const id = `ruin${ruins.length}`;
      const props: Placed[] = [
        { model: 'village/building_destroyed', x, z, rot: rnd() * 6.28, scale: 6.5, radius: 3.2 },
        { model: 'dungeon/pillar', x: x + 6, z: z - 5, rot: 0, scale: 1, radius: 0.8 },
        { model: 'dungeon/pillar', x: x - 6, z: z + 5, rot: 0, scale: 1, radius: 0.8 },
        { model: 'dungeon/rubble_half', x: x - 7, z: z - 6, rot: rnd() * 6.28, scale: 1, radius: 0 },
        { model: 'dungeon/banner_patternA_red', x: x + 6, z: z - 4.4, rot: 0, scale: 1, radius: 0 },
        { model: 'dungeon/barrel_small_stack', x: x + 3, z: z + 7, rot: rnd() * 6.28, scale: 1, radius: 0.9 },
      ];
      const kinds: EnemyKind[] = level >= 3 ? ['warrior', 'mage', 'rogue', 'warrior', 'minion'] : level === 2 ? ['warrior', 'minion', 'rogue', 'minion'] : ['minion', 'minion', 'rogue'];
      const spawns = kinds.map((kind, i) => {
        const a = (i / kinds.length) * Math.PI * 2 + 0.4;
        return { kind, x: x + Math.cos(a) * 8, z: z + Math.sin(a) * 8 };
      });
      ruins.push({ id, x, z, level, props, chest: { x: x + 1.5, z: z + 4.5 }, spawns });
    }
    return ruins;
  }
}

function buildVillage(): Placed[] {
  const P = (model: string, x: number, z: number, rot: number, scale: number, radius: number, station?: Placed['station']): Placed =>
    ({ model, x, z, rot, scale, radius, station });
  return [
    P('village/building_well_blue', 0, 0, 0, 5, 1.6),
    P('village/building_home_A_blue', -15, -10, 0.6, 6, 2.6),
    P('village/building_home_B_blue', 15, -12, -0.5, 6, 2.8),
    P('village/building_tavern_blue', -17, 10, 2.3, 6, 3.4),
    P('village/building_blacksmith_blue', 16, 11, -2.2, 5, 3.2, 'forge'),
    P('village/building_market_blue', 0, -20, 0, 5, 3.6),
    P('village/building_windmill_blue', -26, -22, 0.3, 6, 3.0),
    P('village/building_tower_A_blue', 25, -24, 0, 5, 2.6),
    P('dungeon/table_medium_decorated_A', 7, 5, 0.4, 1, 1.1, 'workbench'),
    P('village/barrel', 9, 7, 0, 6, 0.7),
    P('village/crate_A_big', 10.5, 5.5, 0.3, 6, 0.7),
    P('village/sack', 5, 7.5, 0, 6, 0),
    P('village/resource_lumber', 20, 6, 1.2, 5, 1.2),
    P('village/resource_stone', 12, 16, 0.4, 5, 1.0),
    P('village/weaponrack', 19, 15, -2.2, 6, 0.6),
    P('village/wheelbarrow', -9, 13, 0.8, 6, 0.8),
    P('village/flag_blue', 3, -6, 0, 6, 0),
    P('village/flag_blue', -3, -6, 0, 6, 0),
  ];
}
