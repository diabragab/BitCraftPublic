// Seeded 2D simplex noise and helpers for world generation (deterministic for a given seed).

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash of integer coordinates, used to seed per-chunk generators. */
export function hash2(x: number, z: number, seed: number) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(seed | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1],
];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export class Simplex {
  private perm = new Uint8Array(512);
  constructor(seed: number) {
    const rnd = mulberry32(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Noise in roughly [-1, 1]. */
  noise(x: number, y: number) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const corner = (gx: number, gy: number, g: number) => {
      let tt = 0.5 - gx * gx - gy * gy;
      if (tt < 0) return 0;
      tt *= tt;
      const gr = GRAD[g % 8];
      return tt * tt * (gr[0] * gx + gr[1] * gy);
    };
    const n0 = corner(x0, y0, this.perm[ii + this.perm[jj]]);
    const n1 = corner(x1, y1, this.perm[ii + i1 + this.perm[jj + j1]]);
    const n2 = corner(x2, y2, this.perm[ii + 1 + this.perm[jj + 1]]);
    return 70 * (n0 + n1 + n2);
  }

  /** Fractal sum of octaves, roughly [-1, 1]. */
  fbm(x: number, y: number, octaves = 5) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  /** Ridged noise in [0, 1]: sharp crests, good for mountain ranges. */
  ridge(x: number, y: number, octaves = 4) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq));
      sum += n * n * amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum;
  }
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
