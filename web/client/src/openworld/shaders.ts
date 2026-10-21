/*!
 * Hearthwild shader effects, ported to three.js from GDQuest's "Godot Shaders" demos:
 * https://github.com/gdquest-demos/godot-shaders (commit 05a3931)
 * Copyright (c) 2020-present GDQuest. MIT License: the full text is in shaders.LICENSE.txt and
 * ships as assets/licenses/GDQuest-godot-shaders.LICENSE.txt.
 * Only the shader code was ported. The demos' textures and models are CC-BY-NC-SA and
 * are not used: every noise texture here is generated at runtime.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ------------------------------------------------------------------ shared state

/** Tileable fractal value noise, the stand-in for the demos' noise textures. */
function noiseTexture(size: number, seed: number) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const acc = new Float32Array(size * size);
  for (const [cells, amp] of [[4, 0.45], [8, 0.27], [16, 0.16], [32, 0.12]]) {
    const grid = Float32Array.from({ length: cells * cells }, rnd);
    const at = (x: number, y: number) => grid[(y % cells) * cells + (x % cells)];
    const step = size / cells;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = x / step;
        const gy = y / step;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = (gx - x0) ** 2 * (3 - 2 * (gx - x0));
        const fy = (gy - y0) ** 2 * (3 - 2 * (gy - y0));
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
        const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
        acc[y * size + x] += amp * (top + (bottom - top) * fy);
      }
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of acc) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < acc.length; i++) {
    const v = Math.round(((acc[i] - lo) / (hi - lo)) * 255);
    data.set([v, v, v, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Uniforms every effect shares: one clock, one noise texture, the hero's position, wind strength. */
export const fx = {
  time: { value: 0 },
  noise: { value: noiseTexture(128, 1234) },
  player: { value: new THREE.Vector3() },
  wind: { value: 0.022 },
};

export function updateFx(seconds: number, player: THREE.Vector3) {
  fx.time.value = seconds;
  fx.player.value.copy(player);
}

const COMMON = /* glsl */ `
uniform float fxTime;
uniform sampler2D fxNoise;
float fxRand(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
vec3 fxRotate(vec3 v, vec3 n, float a) { return v * cos(a) + cross(n, v) * sin(a) + n * dot(n, v) * (1.0 - cos(a)); }
`;

// The model matrix of the vertex being drawn, with or without instancing.
const MODEL = /* glsl */ `
#ifdef USE_INSTANCING
  mat4 fxM = modelMatrix * instanceMatrix;
#else
  mat4 fxM = modelMatrix;
#endif
`;

interface Patch {
  key: string;
  uniforms?: Record<string, THREE.IUniform>;
  vertexHead?: string;
  /** Runs right after `transformed` is set up (object space, before skinning). */
  vertex?: string;
  /** Runs after the vertex is projected (`transformed` includes skinning). */
  vertexEnd?: string;
  fragmentHead?: string;
  /** Runs after emissive is computed (lit materials). */
  fragment?: string;
}

/** Injects GLSL into a built-in material so it keeps three.js lighting, fog and shadows. */
function patch<T extends THREE.Material>(mat: T, patches: Patch[]): T {
  const p = (k: keyof Patch) => patches.map((x) => x[k] ?? '').join('\n');
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { fxTime: fx.time, fxNoise: fx.noise }, ...patches.map((x) => x.uniforms ?? {}));
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${COMMON}\n${p('vertexHead')}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${p('vertex')}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${p('vertexEnd')}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}\n${p('fragmentHead')}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${p('fragment')}`);
  };
  const key = patches.map((x) => x.key).join('+');
  mat.customProgramCacheKey = () => key;
  return mat;
}

// ------------------------------------------------------------------ wind (foliage_wind_tree_*.gdshader)

/** Vertical extent of a geometry, used to fade the sway from the roots to the crown. */
export function heightRange(geometry: THREE.BufferGeometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  return { base: b.min.y, height: Math.max(1e-3, b.max.y - b.min.y) };
}

/**
 * Port of foliage_wind_tree_leaves/trunk: the tree leans with a slowly varying gust, a cluster
 * wobble and a leaf flutter, all masked by height squared so the roots stay put. The demo reads
 * per-vertex weights from painted vertex colours; KayKit trees have none, so the height mask
 * stands in for them.
 */
function windPatch(range: { base: number; height: number }): Patch {
  return {
    key: 'wind',
    uniforms: { fxWind: fx.wind, fxTreeBase: { value: range.base }, fxTreeHeight: { value: range.height } },
    vertexHead: 'uniform float fxWind; uniform float fxTreeBase; uniform float fxTreeHeight;',
    vertex: /* glsl */ `{
      ${MODEL}
      float seed = fxRand(fxM[3].xyz);
      vec3 worldPos = (fxM * vec4(transformed, 1.0)).xyz;
      vec3 windDir = vec3(1.0, 0.0, 0.0);
      windDir = fxRotate(windDir, vec3(0.0, 0.0, 1.0), cos(fxTime + seed * 6.28) * 4.0 * 0.01745329);
      windDir = fxRotate(windDir, vec3(0.0, 1.0, 0.0), (35.0 + sin(fxTime * 2.0 + seed * 6.28) * 4.0) * 0.01745329);
      float heightMask = pow(clamp((transformed.y - fxTreeBase) / fxTreeHeight, 0.0, 1.0), 2.0);
      float leanNoise = texture2D(fxNoise, vec2(0.199, 0.0199) * fxTime * 0.25 + seed).r;
      float clusterNoise = texture2D(fxNoise, vec2(0.398, 0.0398) * fxTime * 0.5 + seed + 0.37).r;
      float leafNoise = texture2D(fxNoise, worldPos.xz * 0.1 + vec2(0.0, fxTime)).r;
      float lean = fxWind * heightMask * (2.0 + leanNoise * 12.0) + clusterNoise * heightMask * fxWind * 6.0;
      // world-space wind into object space: transpose() undoes the rotation, the division the scale
      vec3 windLocal = (vec4(windDir, 0.0) * fxM).xyz / dot(fxM[0].xyz, fxM[0].xyz);
      transformed += windLocal * (lean + leafNoise * heightMask * sqrt(fxWind) * 0.15);
    }`,
  };
}

/** Swaying copy of a tree material plus the matching shadow material. */
export function windMaterials(material: THREE.Material, geometry: THREE.BufferGeometry) {
  const range = heightRange(geometry);
  return {
    material: patch(material.clone(), [windPatch(range)]),
    depth: patch(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), [windPatch(range)]),
  };
}

// ------------------------------------------------------------------ crystal glow (fresnel_crystal.gdshader)

/**
 * Port of fresnel_crystal: a pulsing fresnel rim plus a slower pulsing core glow. Used on iron
 * ore so the veins catch the eye; the colours are warm instead of the demo's cyan.
 */
export function crystalMaterial(material: THREE.Material, color = new THREE.Color('#ff9a4a')) {
  return patch(material, [{
    key: 'crystal',
    uniforms: { fxCrystal: { value: color } },
    fragmentHead: 'uniform vec3 fxCrystal;',
    fragment: /* glsl */ `{
      float fresnel = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
      // HDR: the rim goes well past 1.0 so bloom makes the veins glint
      totalEmissiveRadiance += fresnel * fxCrystal * 3.5 * clamp(sin(fxTime * 0.75), 0.15, 1.0);
      totalEmissiveRadiance += fxCrystal * 0.1 * clamp(sin(fxTime * 0.75) + 0.33, 0.33, 1.0);
    }`,
  }]);
}

// ------------------------------------------------------------------ grass (wind_grass.gdshader)

/**
 * A tuft of five blades, one unit tall, normals up so it lights like the ground it grows on.
 * Each blade is two triangles of opposite winding rather than a double-sided material, which
 * would flip the normal of back faces and light them from below.
 */
export function grassTuftGeometry() {
  const pos: number[] = [];
  const col: number[] = [];
  const root = new THREE.Color('#3f6b2a');
  const tip = new THREE.Color('#b5dd6c');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + i * 0.7;
    const r = 0.08 + (i % 2) * 0.06;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    const w = 0.07;
    const h = 0.75 + ((i * 37) % 10) / 40;
    const lean = 0.18;
    const px = Math.cos(a + Math.PI / 2) * w;
    const pz = Math.sin(a + Math.PI / 2) * w;
    const tipX = cx + Math.cos(a) * lean;
    const tipZ = cz + Math.sin(a) * lean;
    pos.push(cx - px, 0, cz - pz, cx + px, 0, cz + pz, tipX, h, tipZ);
    pos.push(cx + px, 0, cz + pz, cx - px, 0, cz - pz, tipX, h, tipZ);
    for (const c of [root, root, tip, root, root, tip]) col.push(c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/**
 * Port of wind_grass: blades bend with two layers of scrolling world-space noise and are pushed
 * away from the hero (the demo's character_position push). The falloff curve texture of the demo
 * is replaced by a squared smoothstep.
 */
export function grassMaterial() {
  return patch(new THREE.MeshLambertMaterial({ vertexColors: true }), [{
    key: 'grass',
    uniforms: { fxPlayer: fx.player, fxWind: fx.wind },
    vertexHead: 'uniform vec3 fxPlayer; uniform float fxWind;',
    vertex: /* glsl */ `{
      ${MODEL}
      vec3 worldPos = (fxM * vec4(transformed, 1.0)).xyz;
      float affect = clamp(transformed.y, 0.0, 1.0);
      vec2 dir = normalize(vec2(1.0, 0.5));
      float n = texture2D(fxNoise, worldPos.xz / 20.0 + dir * fxTime * 0.05).r - 0.5;
      n += (texture2D(fxNoise, worldPos.xz / 7.0 + dir * fxTime * 0.11).r - 0.5) * 0.5;
      float strength = fxWind * 32.0;
      vec3 bump = vec3(dir.x * n * strength, -abs(n) * 0.25, dir.y * n * strength);
      vec3 away = fxM[3].xyz - fxPlayer;
      away.y = 0.0;
      float d = length(away);
      float falloff = 1.0 - smoothstep(0.0, 1.0, d / 1.7);
      falloff *= falloff;
      bump += (d > 0.001 ? away / d : vec3(0.0)) * falloff * 0.6 - vec3(0.0, falloff * 0.35, 0.0);
      transformed += (vec4(bump, 0.0) * fxM).xyz / dot(fxM[0].xyz, fxM[0].xyz) * affect;
    }`,
  }]);
}

// ------------------------------------------------------------------ water (water_3d.gdshader)

/**
 * Port of water_3d: noise-driven vertex waves, shallow-to-deep colour by water depth and foam
 * where the water meets the shore. The demo reads depth from the depth buffer; the island's
 * heightmap gives the same answer here without an extra render pass, and the screen-space
 * refraction becomes a wobble of that lookup.
 */
export function waterMaterial(depthMap: THREE.Texture, half: number, surfaceY: number) {
  // merge() clones values, so shared uniforms and the texture are attached afterwards
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uHalf: { value: half },
    uSurface: { value: surfaceY },
    uShallow: { value: new THREE.Color('#5cc3cf') },
    uDeep: { value: new THREE.Color('#1c4f93') },
    uFoam: { value: new THREE.Color('#f2fbff') },
    uLight: { value: 1 },
  }]);
  Object.assign(uniforms, { fxTime: fx.time, fxNoise: fx.noise, uDepth: { value: depthMap } });
  return new THREE.ShaderMaterial({
    name: 'hearthwild-water',
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: true,
    vertexShader: /* glsl */ `
      uniform float fxTime;
      uniform sampler2D fxNoise;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        float displacement = texture2D(fxNoise, world.xz * 0.02 + vec2(fxTime * 0.02, 0.0)).r * 2.0 - 1.0;
        world.y += displacement * 0.12;
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform sampler2D fxNoise;
      uniform sampler2D uDepth;
      uniform float uHalf;
      uniform float uSurface;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uFoam;
      uniform float uLight;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      void main() {
        vec2 flow = vec2(fxTime * 0.02, 0.0);
        vec2 refraction = vec2(
          texture2D(fxNoise, vWorld.xz * 0.05 + flow).r,
          texture2D(fxNoise, vWorld.zx * 0.05 - flow).r) - 0.5;
        vec2 uv = (vWorld.xz + uHalf) / (2.0 * uHalf) + refraction * 0.003;
        float depth = texture2D(uDepth, uv).r * 12.0 + (vWorld.y - uSurface);
        vec3 color = mix(uShallow, uDeep, clamp(depth / 6.0, 0.0, 1.0));
        float intersection = clamp(depth / 1.1, 0.0, 1.0);
        float foam = step(intersection, texture2D(fxNoise, vWorld.xz * 0.16 + flow * 5.0).r * 0.95);
        color = mix(color, uFoam, foam * 0.85) * uLight;
        float alpha = max(mix(0.62, 0.9, clamp(depth / 4.0, 0.0, 1.0)), foam * 0.9);
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

/** Water depth below the surface (0-12 m) sampled over the whole island, one texel per `step` metres. */
export function depthTexture(height: (x: number, z: number) => number, half: number, size: number, surfaceY: number) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size) * half * 2 - half;
      const z = ((j + 0.5) / size) * half * 2 - half;
      const d = Math.max(0, Math.min(1, (surfaceY - height(x, z)) / 12));
      const v = Math.round(d * 255);
      data.set([v, v, v, 255], (j * size + i) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ fire (stylized_fire.gdshader)

const FIRE_PARTICLES = 14;

/**
 * Port of stylized_fire (itself after Minionsart's): camera-facing particles whose alpha is the
 * product of a round mask and world-space noise panned upwards, eroded over each particle's life
 * and sharpened with a smoothstep. Particle motion runs in the vertex shader, so the CPU only
 * places the fires.
 */
export class Fires {
  mesh: THREE.InstancedMesh;
  private capacity = 0;
  private material: THREE.ShaderMaterial;

  constructor(private scene: THREE.Scene) {
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(uniforms, { fxTime: fx.time, fxNoise: fx.noise });
    this.material = new THREE.ShaderMaterial({
      name: 'hearthwild-fire',
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float fxTime;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vLife;
        varying float vXDot;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          float life = fract(fxTime * 0.85 + aSeed);
          vLife = life;
          vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float scale = length(instanceMatrix[0].xyz);
          float a = aSeed * 43.0;
          vec3 center = base + vec3(sin(a) * 0.22 * (1.0 - life), 0.15 + life * 1.35, cos(a) * 0.22 * (1.0 - life)) * scale;
          float size = scale * mix(0.85, 0.35, life);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 forward = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
          float r = aSeed * 6.28 + life * 1.5;
          vec2 p = mat2(cos(r), sin(r), -sin(r), cos(r)) * position.xy;
          vec3 world = center + (right * p.x + up * p.y) * size;
          vWorld = world;
          vXDot = abs(forward.x);
          vec4 mvPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float fxTime;
        uniform sampler2D fxNoise;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vLife;
        varying float vXDot;
        #include <fog_pars_fragment>
        void main() {
          float mask = 1.0 - smoothstep(0.12, 0.5, length(vUv - 0.5));
          vec2 pan = vec2(0.2, 1.0) * (-fxTime * 1.6);
          float noiseXY = texture2D(fxNoise, vWorld.xy * 1.1 + pan).r;
          float noiseZY = texture2D(fxNoise, vWorld.zy * 1.1 + pan + vec2(0.7, 0.3)).r;
          float noise = mix(noiseXY, noiseZY, clamp(vXDot, 0.0, 1.0));
          // alpha erosion: COLOR.a in the demo falls from 1 to 0 over the particle's life
          float alpha = clamp(noise * mask + (1.0 - vLife) - 1.0, 0.0, 1.0);
          alpha = smoothstep(0.0, 0.12, alpha);
          if (alpha < 0.01) discard;
          vec3 color = mix(vec3(1.0, 0.72, 0.22), vec3(1.0, 0.32, 0.05), smoothstep(0.05, 0.5, vLife));
          color = mix(color, vec3(0.55, 0.08, 0.03), smoothstep(0.6, 1.0, vLife));
          gl_FragColor = vec4(color * 4.0, alpha); // HDR: bright enough to bloom
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = this.make(16);
  }

  private make(fires: number) {
    this.capacity = fires;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const n = fires * FIRE_PARTICLES;
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(Float32Array.from({ length: n }, (_, i) => ((i * 0.6180339) % 1)), 1));
    const mesh = new THREE.InstancedMesh(geometry, this.material, n);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    return mesh;
  }

  /** One fire per position (the base of the flames). */
  set(positions: THREE.Vector3[], size = 1.3) {
    let mesh = this.mesh;
    if (positions.length > this.capacity) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.dispose();
      mesh = this.mesh = this.make(Math.ceil(positions.length * 1.5));
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3(size, size, size);
    positions.forEach((p, i) => {
      m.compose(p, q, scale);
      for (let k = 0; k < FIRE_PARTICLES; k++) mesh.setMatrixAt(i * FIRE_PARTICLES + k, m);
    });
    mesh.count = positions.length * FIRE_PARTICLES;
    mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ outline (outline3D + smooth normals variant)

const smoothCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/**
 * Low-poly models have split normals, so pushing vertices along them tears the hull at every
 * hard edge. Like the demo's outline3D_smooth_normals variant, the hull uses averaged normals.
 */
function smoothNormals(geometry: THREE.BufferGeometry) {
  let g = smoothCache.get(geometry);
  if (g) return g;
  const src = geometry.getAttribute('position');
  const pos = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) pos.set([src.getX(i), src.getY(i), src.getZ(i)], i * 3);
  const plain = new THREE.BufferGeometry();
  plain.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (geometry.index) plain.setIndex(Array.from(geometry.index.array));
  g = mergeVertices(plain, 1e-4);
  g.computeVertexNormals();
  smoothCache.set(geometry, g);
  return g;
}

/**
 * Port of outline3D: the model drawn again with front faces culled and every vertex pushed out
 * along its normal, in a flat colour. Used to highlight what the E key would act on. Trees keep
 * swaying under their outline because the hull runs the same wind code with the same seed.
 */
export class Outline {
  readonly group = new THREE.Group();
  private key = '';

  constructor(scene: THREE.Scene, private color = new THREE.Color('#ffd76a').multiplyScalar(1.8)) {
    scene.add(this.group);
  }

  show(key: string, parts: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[], wind: boolean, thickness = 0.06) {
    if (key === this.key) return;
    this.clear();
    this.key = key;
    for (const p of parts) {
      const scale = Math.cbrt(Math.abs(p.matrix.determinant()));
      const patches: Patch[] = [{
        key: 'outline',
        uniforms: { fxThickness: { value: thickness / scale } },
        vertexHead: 'uniform float fxThickness;',
        vertex: 'transformed += normal * fxThickness;',
      }];
      if (wind) patches.push(windPatch(heightRange(p.geometry)));
      const material = patch(new THREE.MeshBasicMaterial({ color: this.color, side: THREE.BackSide }), patches);
      const mesh = new THREE.Mesh(smoothNormals(p.geometry), material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(p.matrix);
      this.group.add(mesh);
    }
  }

  clear() {
    this.key = '';
    for (const m of this.group.children as THREE.Mesh[]) (m.material as THREE.Material).dispose();
    this.group.clear();
  }
}

// ------------------------------------------------------------------ dissolve (dissolve.gdshader)

/**
 * Port of dissolve: fragments whose noise value is under the dissolve amount are dropped and a
 * band just above it glows like embers. The demo samples a noise texture through the mesh UVs;
 * KayKit models share one small atlas, so 3D noise of the world position is used instead.
 */
const dissolvePatch = (amount: THREE.IUniform<number>): Patch => ({
  key: 'dissolve',
  uniforms: { fxDissolve: amount },
  vertexHead: 'varying vec3 vFxWorld;',
  vertexEnd: 'vFxWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
  fragmentHead: /* glsl */ `
    uniform float fxDissolve;
    varying vec3 vFxWorld;
    float fxHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float fxNoise3(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(fxHash(i), fxHash(i + vec3(1, 0, 0)), f.x), mix(fxHash(i + vec3(0, 1, 0)), fxHash(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(fxHash(i + vec3(0, 0, 1)), fxHash(i + vec3(1, 0, 1)), f.x), mix(fxHash(i + vec3(0, 1, 1)), fxHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }`,
  fragment: /* glsl */ `{
    float s = fxNoise3(vFxWorld * 1.8) * 0.65 + fxNoise3(vFxWorld * 5.0) * 0.35;
    if (s < fxDissolve) discard;
    float burn = 1.0 - smoothstep(fxDissolve, fxDissolve + 0.09, s);
    totalEmissiveRadiance += burn * vec3(1.0, 0.45, 0.12) * 9.0 * step(0.001, fxDissolve);
  }`,
});

export class Dissolver {
  private amount = { value: 0 };
  private saved: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[]; shadow: boolean }[] = [];

  constructor(root: THREE.Object3D) {
    const make = (m: THREE.Material) => patch(m.clone(), [dissolvePatch(this.amount)]);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.saved.push({ mesh, material: mesh.material, shadow: mesh.castShadow });
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(make) : make(mesh.material);
      mesh.castShadow = false;
    });
  }

  /** 0 = intact, 1 = gone. */
  set(amount: number) {
    this.amount.value = amount;
  }

  restore() {
    for (const s of this.saved) {
      for (const m of [s.mesh.material].flat()) m.dispose();
      s.mesh.material = s.material;
      s.mesh.castShadow = s.shadow;
    }
    this.saved = [];
  }
}

// ------------------------------------------------------------------ x-ray (xray_3d / xray_glow)

/**
 * The demo's x-ray draws a hidden character through a stencil mask. Here a glowing copy of the
 * hero is drawn only where something is in front of it (depth test "greater"), after the rest
 * of the scene and before the hero itself, so the hero never x-rays through its own body.
 */
export function addXray(root: THREE.Object3D, color = new THREE.Color(0.3, 0.75, 1.2)) {
  // kept below the bloom threshold: a glowing haze would hide the hero instead of showing it
  const material = new THREE.MeshBasicMaterial({
    color, opacity: 0.45, depthFunc: THREE.GreaterDepth, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
  for (const m of meshes) {
    let copy: THREE.Mesh;
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) {
      const s = m as THREE.SkinnedMesh;
      const skinned = new THREE.SkinnedMesh(s.geometry, material);
      skinned.bindMode = s.bindMode;
      skinned.bind(s.skeleton, s.bindMatrix);
      copy = skinned;
    } else copy = new THREE.Mesh(m.geometry, material);
    copy.renderOrder = 1;
    copy.castShadow = false;
    copy.frustumCulled = false;
    m.renderOrder = 2;
    m.add(copy);
  }
}
