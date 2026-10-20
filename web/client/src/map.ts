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

/** Client-side copy of the class table for UI and prediction (server values are authoritative). */
export const CLASSES = {
  knight: { label: 'Knight', hp: 140, speed: 5.0, damage: 22, cooldown: 650, ranged: false, attackClip: '1H_Melee_Attack_Chop',
    blurb: 'Sword and shield. Sturdy and dependable.' },
  barbarian: { label: 'Barbarian', hp: 120, speed: 5.2, damage: 34, cooldown: 950, ranged: false, attackClip: '2H_Melee_Attack_Chop',
    blurb: 'Huge axe swings that cleave through groups.' },
  mage: { label: 'Mage', hp: 85, speed: 5.0, damage: 26, cooldown: 800, ranged: true, attackClip: 'Spellcast_Shoot',
    blurb: 'Ranged arcane bolts. Fragile up close.' },
  rogue: { label: 'Rogue', hp: 95, speed: 6.2, damage: 16, cooldown: 380, ranged: false, attackClip: 'Dualwield_Melee_Attack_Stab',
    blurb: 'Fast twin daggers and quick feet.' },
} as const;
export type ClassId = keyof typeof CLASSES;
export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
