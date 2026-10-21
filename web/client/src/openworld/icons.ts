// Skill, gear and pet icons, drawn as inline SVG: a white glyph on a tile shaded in the
// element's colours, with a rarity frame for gear. Original artwork, no image files.
import { ELEMENTS, GEAR, RARITIES, type Element, type GearBaseId, type Glyph } from './content';

type Part = { d: string; stroke?: number } | { circle: [number, number, number]; stroke?: number; dark?: boolean };

const star = (cx: number, cy: number, outer: number, inner: number, n: number) => {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(1)} ${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return `M${pts.join(' L')} Z`;
};
const rays = (cx: number, cy: number, r0: number, r1: number, n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + offset;
    return `M${(cx + Math.cos(a) * r0).toFixed(1)} ${(cy + Math.sin(a) * r0).toFixed(1)} L${(cx + Math.cos(a) * r1).toFixed(1)} ${(cy + Math.sin(a) * r1).toFixed(1)}`;
  }).join(' ');
const blade = (rot: number) => {
  // a small dagger pointing up, rotated about the bottom centre
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  const pt = (x: number, y: number) => {
    const dx = x - 32;
    const dy = y - 50;
    return `${(32 + dx * c - dy * s).toFixed(1)} ${(50 + dx * s + dy * c).toFixed(1)}`;
  };
  return `M${pt(32, 10)} L${pt(36, 30)} L${pt(40, 32)} L${pt(34, 34)} L${pt(34, 46)} L${pt(30, 46)} L${pt(30, 34)} L${pt(24, 32)} L${pt(28, 30)} Z`;
};

const GLYPHS: Record<Glyph, Part[]> = {
  sword: [{ d: 'M44 10 L54 10 L54 20 L28 46 L18 36 Z' }, { d: 'M14 34 L30 50 L26 54 L10 38 Z' }, { d: 'M18 46 L22 50 L13 59 L9 55 Z' }],
  axe: [{ d: 'M18 55 L22 58 L42 18 L38 15 Z' }, { d: 'M34 12 Q52 4 56 26 Q46 27 40 32 Z' }],
  dagger: [{ d: blade(35) }],
  staff: [{ d: 'M16 56 L20 59 L40 24 L36 21 Z' }, { circle: [43, 16, 8] }],
  shield: [{ d: 'M32 8 L52 15 L50 34 Q47 49 32 57 Q17 49 14 34 L12 15 Z' }, { d: 'M32 16 L32 50 M20 28 L44 28', stroke: 4 }],
  helm: [{ d: 'M13 44 C13 20 21 11 32 11 C43 11 51 20 51 44 L51 50 L40 50 L40 36 L24 36 L24 50 L13 50 Z' }],
  chest: [{ d: 'M20 12 L27 10 Q32 17 37 10 L44 12 L54 22 L47 31 L44 28 L44 54 L20 54 L20 28 L17 31 L10 22 Z' }],
  boots: [{ d: 'M20 10 L34 10 L34 36 L50 42 Q56 45 53 53 L16 53 L18 36 Z' }],
  ring: [{ circle: [32, 38, 13], stroke: 6 }, { d: 'M25 21 L32 12 L39 21 L32 28 Z' }],
  amulet: [{ d: 'M16 10 Q32 36 48 10', stroke: 4 }, { d: 'M32 28 L43 40 L32 56 L21 40 Z' }],
  shout: [{ d: 'M10 25 L22 25 L38 12 L38 52 L22 39 L10 39 Z' }, { d: 'M45 24 Q50 32 45 40 M51 17 Q59 32 51 47', stroke: 4 }],
  cross: [{ d: 'M26 10 H38 V26 H54 V38 H38 V54 H26 V38 H10 V26 H26 Z' }],
  burst: [{ d: star(32, 32, 24, 9, 8) }],
  swirl: [{ d: 'M32 32 m0 -4 a4 4 0 1 1 -4 4 a8 8 0 1 1 8 8 a12 12 0 1 1 -12 -12 a16 16 0 1 1 16 16', stroke: 5 }],
  flame: [{ d: 'M32 6 C38 19 51 24 47 40 C45 51 39 57 32 57 C23 57 15 51 17 38 C19 30 26 27 24 16 C30 21 31 27 32 30 C35 21 33 13 32 6 Z' }],
  snow: [{ d: `${rays(32, 32, 0, 24, 6)} ${rays(32, 32, 14, 22, 6, 0.35)} ${rays(32, 32, 14, 22, 6, -0.35)}`, stroke: 5 }],
  bubble: [{ circle: [32, 32, 20], stroke: 5 }, { d: 'M21 26 Q24 18 32 17', stroke: 4 }],
  meteor: [{ d: 'M8 8 L34 34 M18 6 L40 28 M6 18 L28 40', stroke: 5 }, { circle: [41, 41, 13] }],
  dash: [{ d: 'M27 16 L50 32 L27 48 L32 32 Z' }, { d: 'M8 22 H24 M12 32 H26 M8 42 H24', stroke: 5 }],
  leap: [{ d: 'M10 52 Q16 18 42 18', stroke: 5 }, { d: 'M38 8 L54 18 L40 28 Z' }, { d: 'M6 56 H58', stroke: 4 }],
  drop: [{ d: 'M32 8 C41 23 49 31 49 40 A17 17 0 0 1 15 40 C15 31 23 23 32 8 Z' }],
  eye: [{ d: 'M6 32 Q32 8 58 32 Q32 56 6 32 Z' }, { circle: [32, 32, 8], dark: true }],
  knives: [{ d: blade(-35) }, { d: blade(0) }, { d: blade(35) }],
  skull: [
    { d: 'M17 30 C17 17 24 10 32 10 C40 10 47 17 47 30 C47 36 43 38 43 42 L43 50 L21 50 L21 42 C21 38 17 36 17 30 Z' },
    { circle: [26, 30, 5], dark: true }, { circle: [38, 30, 5], dark: true }, { d: 'M28 50 L28 44 M32 50 L32 44 M36 50 L36 44', stroke: 3 },
  ],
  bolt: [{ d: 'M37 6 L17 36 L30 36 L25 58 L47 26 L34 26 L41 6 Z' }],
  leaf: [{ d: 'M12 52 C12 26 30 10 54 10 C54 34 38 52 12 52 Z' }, { d: 'M15 49 L42 22', stroke: 3 }],
  chain: [{ d: 'M8 18 L22 30 L17 37 L35 41 L30 47 L56 54', stroke: 5 }, { circle: [8, 18, 4] }, { circle: [56, 54, 4] }],
  paw: [{ d: 'M20 44 C20 34 26 30 32 30 C38 30 44 34 44 44 C44 52 38 54 32 52 C26 54 20 52 20 44 Z' }, { circle: [17, 28, 5] }, { circle: [26, 19, 5] }, { circle: [38, 19, 5] }, { circle: [47, 28, 5] }],
  totem: [{ d: 'M21 8 H43 V22 H21 Z M18 24 H46 V38 H18 Z M22 40 H42 V57 H22 Z' }, { circle: [27, 15, 2.5], dark: true }, { circle: [37, 15, 2.5], dark: true }, { circle: [26, 31, 2.5], dark: true }, { circle: [38, 31, 2.5], dark: true }],
  sun: [{ circle: [32, 32, 11] }, { d: rays(32, 32, 16, 26, 8), stroke: 5 }],
  quake: [{ d: 'M6 44 H58', stroke: 5 }, { d: 'M34 44 L28 34 L35 28 L29 16', stroke: 4 }, { d: 'M12 40 L18 30 L22 40 Z M44 40 L50 28 L55 40 Z' }],
  thorns: [{ d: 'M8 50 C20 46 22 30 32 28 C42 26 46 14 56 12', stroke: 5 }, { d: 'M18 44 L12 36 L22 40 Z M30 29 L28 18 L36 26 Z M44 20 L46 30 L38 24 Z' }],
};

let gradientId = 0;

function tile(glyph: Glyph, colors: [string, string], size: number, frame?: string, dim = false) {
  const id = `ig${gradientId++}`;
  const parts = GLYPHS[glyph]
    .map((p) => {
      if ('circle' in p) {
        const [cx, cy, r] = p.circle;
        if (p.stroke) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="${p.stroke + 3}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-width="${p.stroke}"/>`;
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${p.dark ? colors[1] : '#fff'}" stroke="#000" stroke-opacity=".45" stroke-width="2"/>`;
      }
      if (p.stroke) return `<path d="${p.d}" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="${p.stroke + 3}" stroke-linecap="round" stroke-linejoin="round"/><path d="${p.d}" fill="none" stroke="#fff" stroke-width="${p.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
      return `<path d="${p.d}" fill="#fff" stroke="#000" stroke-opacity=".45" stroke-width="2" stroke-linejoin="round"/>`;
    })
    .join('');
  return `<svg class="ico-svg${dim ? ' dim' : ''}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
<defs><radialGradient id="${id}" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></radialGradient></defs>
<rect x="2" y="2" width="60" height="60" rx="13" fill="url(#${id})"/>
<rect x="2" y="2" width="60" height="30" rx="13" fill="#fff" opacity=".12"/>
${parts}
<rect x="2" y="2" width="60" height="60" rx="13" fill="none" stroke="${frame ?? 'rgba(0,0,0,.35)'}" stroke-width="${frame ? 4 : 2}"/></svg>`;
}

export function skillIcon(glyph: Glyph, element: Element, size = 48, locked = false) {
  return tile(glyph, ELEMENTS[element].css, size, undefined, locked);
}

export function gearIcon(base: GearBaseId, rarity: number, size = 48) {
  const def = GEAR[base];
  return tile(def.glyph, ELEMENTS[def.element].css, size, RARITIES[rarity]?.css ?? RARITIES[0].css);
}

/** Empty equipment slot. */
export function slotIcon(glyph: Glyph, size = 48) {
  return tile(glyph, ['#3b3546', '#1c1824'], size, undefined, true);
}
