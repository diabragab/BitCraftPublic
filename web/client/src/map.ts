// Same layout and collision rules as web/arena-module/src/map.rs. The client uses
// them only to predict local movement; the server's result always wins.
import mapJson from '../../shared/map.json';

export type Collider =
  | { type: 'box'; minX: number; minZ: number; maxX: number; maxZ: number }
  | { type: 'circle'; x: number; z: number; r: number };

export interface Prop { model: string; x: number; z: number; rotY: number; scale: number }
export interface SpawnPoint { kind: string; x: number; z: number }

export interface ArenaMap {
  version: number;
  half: number;
  keep: number;
  playerRadius: number;
  camp: { x: number; z: number; r: number };
  playerSpawns: [number, number][];
  enemySpawns: SpawnPoint[];
  pickupSpawns: SpawnPoint[];
  colliders: Collider[];
  props: Prop[];
}

export const MAP = mapJson as unknown as ArenaMap;

export function blocked(x: number, z: number, radius: number): boolean {
  const lim = MAP.half - radius;
  if (x < -lim || x > lim || z < -lim || z > lim) return true;
  for (const c of MAP.colliders) {
    if (c.type === 'box') {
      const cx = Math.min(Math.max(x, c.minX), c.maxX);
      const cz = Math.min(Math.max(z, c.minZ), c.maxZ);
      if ((x - cx) ** 2 + (z - cz) ** 2 < radius * radius) return true;
    } else if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + radius) ** 2) {
      return true;
    }
  }
  return false;
}

export function slide(x: number, z: number, dx: number, dz: number, radius: number): [number, number] {
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / 0.25));
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    if (!blocked(x + sx, z, radius)) x += sx;
    if (!blocked(x, z + sz, radius)) z += sz;
  }
  return [x, z];
}

/** Port of `ArenaMap::line_of_sight`: true if no wall (box collider) blocks the segment. */
export function lineOfSight(x0: number, z0: number, x1: number, z1: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.4));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    for (const c of MAP.colliders) {
      if (c.type === 'box' && x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) return false;
    }
  }
  return true;
}

/** Port of `ArenaMap::steer`: move toward a target, trying rotated directions when blocked. */
export function steer(x: number, z: number, tx: number, tz: number, step: number, radius: number): [number, number] {
  const dist = Math.hypot(tx - x, tz - z);
  if (dist < 1e-4) return [x, z];
  const dx = (tx - x) / dist;
  const dz = (tz - z) / dist;
  const direct = slide(x, z, dx * step, dz * step, radius);
  const moved = (p: [number, number]) => Math.hypot(p[0] - x, p[1] - z);
  if (moved(direct) >= step * 0.6) return direct;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const a of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
    const s = Math.sin(a);
    const c = Math.cos(a);
    const p = slide(x, z, (dx * c - dz * s) * step, (dx * s + dz * c) * step, radius);
    const d = (p[0] - tx) ** 2 + (p[1] - tz) ** 2;
    if (moved(p) >= step * 0.6 && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best ?? direct;
}

export function inCamp(x: number, z: number): boolean {
  return (x - MAP.camp.x) ** 2 + (z - MAP.camp.z) ** 2 < MAP.camp.r ** 2;
}

/** Client-side copy of the class table for UI and prediction (server values are authoritative). */
export const CLASSES = {
  knight: { label: 'Knight', hp: 140, speed: 5.0, damage: 22, cooldown: 650, ranged: false, range: 2.3, arc: 1.1, attackClip: '1H_Melee_Attack_Chop',
    blurb: 'Sword and shield. Sturdy and dependable.' },
  barbarian: { label: 'Barbarian', hp: 120, speed: 5.2, damage: 34, cooldown: 950, ranged: false, range: 2.6, arc: 1.3, attackClip: '2H_Melee_Attack_Chop',
    blurb: 'Huge axe swings that cleave through groups.' },
  mage: { label: 'Mage', hp: 85, speed: 5.0, damage: 26, cooldown: 800, ranged: true, range: 10, arc: 0, attackClip: 'Spellcast_Shoot',
    blurb: 'Ranged arcane bolts. Fragile up close.' },
  rogue: { label: 'Rogue', hp: 95, speed: 6.2, damage: 16, cooldown: 380, ranged: false, range: 2.0, arc: 1.0, attackClip: 'Dualwield_Melee_Attack_Stab',
    blurb: 'Fast twin daggers and quick feet.' },
} as const;
export type ClassId = keyof typeof CLASSES;
export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
