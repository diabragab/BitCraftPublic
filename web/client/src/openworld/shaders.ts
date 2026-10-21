/*!
 * Hearthwild shader effects, ported to three.js TSL (node materials for WebGPURenderer, which
 * also run on its WebGL2 fallback) from GDQuest's "Godot Shaders" demos:
 * https://github.com/gdquest-demos/godot-shaders (commit 05a3931)
 * Copyright (c) 2020-present GDQuest. MIT License: the full text is in shaders.LICENSE.txt and
 * ships as assets/licenses/GDQuest-godot-shaders.LICENSE.txt.
 * Only the shader code was ported. The demos' textures and models are CC-BY-NC-SA and
 * are not used: every noise texture here is generated at runtime.
 * The fire and dissolve ports were retired when rollshade took over campfires and deaths.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, clamp, cos, cross, dot, float, fract, instancedBufferAttribute, materialEmissive, max, mix, modelWorldMatrix,
  modelWorldMatrixInverse, normalLocal, normalView, positionGeometry, positionLocal, positionViewDirection, positionWorld,
  pow, select, sin, smoothstep, step, texture, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
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

/**
 * Values every effect shares: one clock (fed from performance.now(), not TSL's own `time`, so CPU
 * code can read the same seconds), one noise texture, the hero's position and the wind strength.
 */
export const fxTime = uniform(0);
export const fxNoiseTex = noiseTexture(128, 1234);
export const fxPlayer = uniform(new THREE.Vector3());
export const fxWind = uniform(0.022);

export function updateFx(seconds: number, player: THREE.Vector3) {
  fxTime.value = seconds;
  fxPlayer.value.copy(player);
}

const DEG = Math.PI / 180;
const noise = (uv: Node<'vec2'>) => texture(fxNoiseTex, uv).r;
const fxRand = (p: Node<'vec3'>) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453123));
/** Rodrigues rotation of v about the unit axis n by angle a. */
const fxRotate = (v: Node<'vec3'>, n: Node<'vec3'>, a: Node<'float'>) =>
  v.mul(cos(a)).add(cross(n, v).mul(sin(a))).add(n.mul(dot(n, v)).mul(float(1).sub(cos(a))));

/**
 * A second view of an InstancedMesh's instanceMatrix array as a per-instance vertex buffer, so
 * the instance origin (column 3) can be read as an attribute: three keeps its own instancing
 * buffers private. Wherever instances change, call markInstancesDirty instead of setting
 * instanceMatrix.needsUpdate, so this view uploads too.
 */
const originBuffers = new WeakMap<THREE.InstancedBufferAttribute, THREE.InstancedInterleavedBuffer>();
function instanceOriginBuffer(mesh: THREE.InstancedMesh) {
  let b = originBuffers.get(mesh.instanceMatrix);
  if (!b) {
    b = new THREE.InstancedInterleavedBuffer(mesh.instanceMatrix.array as Float32Array, 16, 1);
    originBuffers.set(mesh.instanceMatrix, b);
  }
  return b;
}
export function markInstancesDirty(mesh: THREE.InstancedMesh) {
  mesh.instanceMatrix.needsUpdate = true;
  instanceOriginBuffer(mesh).needsUpdate = true;
}

/**
 * World origin of what is drawn: the instance's on an InstancedMesh, the object's otherwise.
 * Built per object (the render-object cache key includes the InstancedMesh), so one material
 * can be shared by several meshes.
 */
const objectOrigin = Fn((builder) => {
  const mesh = builder.object as THREE.InstancedMesh;
  if (mesh.isInstancedMesh) {
    const column3 = instancedBufferAttribute<'vec4'>(instanceOriginBuffer(mesh), 'vec4', 16, 12);
    return modelWorldMatrix.mul(vec4(column3.xyz, 1)).xyz;
  }
  return modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
});

/** World position of positionLocal (which positionNode receives with instancing already applied). */
const worldOf = (p: Node<'vec3'>) => modelWorldMatrix.mul(vec4(p, 1)).xyz;
/** A world-space offset in the space positionNode returns. */
const worldToLocal = (v: Node<'vec3'>) => modelWorldMatrixInverse.mul(vec4(v, 0)).xyz;

/** A node-material copy of a GLTF material (colour, map, emissive, roughness…), named for tests. */
function standardFrom(source: THREE.Material, name: string) {
  const material = new THREE.MeshStandardNodeMaterial();
  material.copy(source as unknown as THREE.MeshStandardNodeMaterial);
  material.name = `hearthwild-${name}`;
  return material;
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
 * stands in for them. Returns the offset to add to positionLocal.
 */
function windOffset(range: { base: number; height: number }) {
  const base = uniform(range.base);
  const height = uniform(range.height);
  return Fn(() => {
    const seed = fxRand(objectOrigin());
    const worldPos = worldOf(positionLocal);
    const windDir = fxRotate(vec3(1, 0, 0), vec3(0, 0, 1), cos(fxTime.add(seed.mul(6.28))).mul(4 * DEG)).toVar();
    windDir.assign(fxRotate(windDir, vec3(0, 1, 0), sin(fxTime.mul(2).add(seed.mul(6.28))).mul(4).add(35).mul(DEG)));
    // height before instancing: positionGeometry, not positionLocal
    const heightMask = pow(clamp(positionGeometry.y.sub(base).div(height), 0, 1), 2);
    const leanNoise = noise(vec2(0.199, 0.0199).mul(fxTime.mul(0.25)).add(seed));
    const clusterNoise = noise(vec2(0.398, 0.0398).mul(fxTime.mul(0.5)).add(seed).add(0.37));
    const leafNoise = noise(worldPos.xz.mul(0.1).add(vec2(0, fxTime)));
    const lean = fxWind.mul(heightMask).mul(leanNoise.mul(12).add(2)).add(clusterNoise.mul(heightMask).mul(fxWind).mul(6));
    return worldToLocal(windDir.mul(lean.add(leafNoise.mul(heightMask).mul(fxWind.sqrt()).mul(0.15))));
  })();
}

/** Swaying copy of a tree material. The shadow pass reuses positionNode, so shadows sway too. */
export function windMaterial(source: THREE.Material, geometry: THREE.BufferGeometry) {
  const material = standardFrom(source, 'wind');
  material.positionNode = positionLocal.add(windOffset(heightRange(geometry)));
  return material;
}

// ------------------------------------------------------------------ crystal glow (fresnel_crystal.gdshader)

/**
 * Port of fresnel_crystal: a pulsing fresnel rim plus a slower pulsing core glow, added to the
 * material's own emissive. Used on iron ore so the veins catch the eye; the colours are warm
 * instead of the demo's cyan.
 */
export function crystalMaterial(source: THREE.Material, tint?: THREE.Color, color = new THREE.Color('#ff9a4a')) {
  const material = standardFrom(source, 'crystal');
  if (tint) {
    material.color.multiply(tint);
    material.emissive.copy(tint).multiplyScalar(0.12);
  }
  const glow = uniform(color);
  const fresnel = pow(float(1).sub(clamp(normalView.dot(positionViewDirection), 0, 1)), 3);
  const pulse = sin(fxTime.mul(0.75));
  // HDR: the rim goes well past 1.0 so bloom makes the veins glint
  material.emissiveNode = materialEmissive
    .add(glow.mul(fresnel.mul(3.5).mul(clamp(pulse, 0.15, 1))))
    .add(glow.mul(clamp(pulse.add(0.33), 0.33, 1).mul(0.1)));
  return material;
}

// ------------------------------------------------------------------ hit flash

/** How white a mesh flashes when hit: `userData.flash` of the mesh being drawn, read per draw. */
const hitFlash = uniform(0).onObjectUpdate(({ object }) => (object?.userData.flash as number | undefined) ?? 0);
const flashCache = new WeakMap<THREE.Material, THREE.MeshStandardNodeMaterial>();

/**
 * One node-material copy per source material, shared by every enemy that uses it, whose
 * emissive adds an HDR white flash (so it blooms) from that mesh's `userData.flash`. Sharing
 * matters for rollshade: its status looks are built once per source material.
 */
export function flashMaterial(source: THREE.Material) {
  let material = flashCache.get(source);
  if (!material) {
    material = standardFrom(source, 'flash');
    material.emissiveNode = materialEmissive.add(vec3(hitFlash.mul(2.4)));
    flashCache.set(source, material);
  }
  return material;
}

/** A tinted copy of a GLTF material, for models that only need a colour change. */
export function tintedMaterial(source: THREE.Material, tint: THREE.Color) {
  const material = standardFrom(source, 'tint');
  material.color.multiply(tint);
  material.emissive.copy(tint).multiplyScalar(0.12);
  return material;
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
  const material = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  material.name = 'hearthwild-grass';
  material.positionNode = Fn(() => {
    const worldPos = worldOf(positionLocal);
    const affect = clamp(positionGeometry.y, 0, 1); // tuft height before instancing
    const dir = vec2(1, 0.5).normalize();
    const n = noise(worldPos.xz.div(20).add(dir.mul(fxTime.mul(0.05)))).sub(0.5).toVar();
    n.addAssign(noise(worldPos.xz.div(7).add(dir.mul(fxTime.mul(0.11)))).sub(0.5).mul(0.5));
    const strength = fxWind.mul(32);
    const bump = vec3(dir.x.mul(n).mul(strength), n.abs().mul(-0.25), dir.y.mul(n).mul(strength)).toVar();
    const away = objectOrigin().sub(fxPlayer).mul(vec3(1, 0, 1)).toVar();
    const d = away.length();
    const falloff = pow(float(1).sub(smoothstep(0, 1, d.div(1.7))), 2);
    const push = select(d.greaterThan(0.001), away.div(d), vec3(0));
    bump.addAssign(push.mul(falloff).mul(0.6).sub(vec3(0, falloff.mul(0.35), 0)));
    return positionLocal.add(worldToLocal(bump).mul(affect));
  })();
  return material;
}

// ------------------------------------------------------------------ water (water_3d.gdshader)

/**
 * Port of water_3d: noise-driven vertex waves, shallow-to-deep colour by water depth and foam
 * where the water meets the shore. The demo reads depth from the depth buffer; the island's
 * heightmap gives the same answer here without an extra render pass, and the screen-space
 * refraction becomes a wobble of that lookup. For a PlaneGeometry turned flat
 * (rotation.x = -PI/2), so local +z is world up. Fog is applied by the node material.
 */
export function waterMaterial(depthMap: THREE.Texture, half: number, surfaceY: number) {
  const uHalf = uniform(half);
  const uSurface = uniform(surfaceY);
  const shallow = uniform(new THREE.Color('#5cc3cf'));
  const deep = uniform(new THREE.Color('#1c4f93'));
  const foamColor = uniform(new THREE.Color('#f2fbff'));
  const light = uniform(1);
  const flow = vec2(fxTime.mul(0.02), 0);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  material.name = 'hearthwild-water';
  const displacement = noise(worldOf(positionLocal).xz.mul(0.02).add(flow)).mul(2).sub(1);
  material.positionNode = positionLocal.add(vec3(0, 0, displacement.mul(0.12)));
  const w = positionWorld; // displaced and interpolated
  const refraction = vec2(noise(w.xz.mul(0.05).add(flow)), noise(w.zx.mul(0.05).sub(flow))).sub(0.5);
  const uv = w.xz.add(uHalf).div(uHalf.mul(2)).add(refraction.mul(0.003));
  const depth = texture(depthMap, uv).r.mul(12).add(w.y.sub(uSurface));
  const foam = step(clamp(depth.div(1.1), 0, 1), noise(w.xz.mul(0.16).add(flow.mul(5))).mul(0.95));
  material.colorNode = mix(mix(shallow, deep, clamp(depth.div(6), 0, 1)), foamColor, foam.mul(0.85)).mul(light);
  material.opacityNode = max(mix(0.62, 0.9, clamp(depth.div(4), 0, 1)), foam.mul(0.9));
  return { material, light };
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
      const material = new THREE.MeshBasicNodeMaterial({ color: this.color, side: THREE.BackSide });
      material.name = 'hearthwild-outline';
      let position: Node<'vec3'> = positionLocal.add(normalLocal.mul(uniform(thickness / scale)));
      if (wind) position = position.add(windOffset(heightRange(p.geometry)));
      material.positionNode = position;
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

// ------------------------------------------------------------------ x-ray (xray_3d / xray_glow)

/**
 * The demo's x-ray draws a hidden character through a stencil mask. Here a glowing copy of the
 * hero is drawn only where something is in front of it (depth test "greater"), after the rest
 * of the scene and before the hero itself, so the hero never x-rays through its own body.
 * The copies carry rollshade's own overlay tag so status effects (the shield, a burn) leave
 * them alone instead of turning them into solid copies of the hero.
 */
export function addXray(root: THREE.Object3D, color = new THREE.Color(0.3, 0.75, 1.2)) {
  // kept below the bloom threshold: a glowing haze would hide the hero instead of showing it
  const material = new THREE.MeshBasicNodeMaterial({
    color, opacity: 0.45, depthFunc: THREE.GreaterDepth, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  material.name = 'hearthwild-xray';
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
    copy.userData.__rollshadeStatus = true; // rollshade 0.6.0 skips meshes with this tag
    m.renderOrder = 2;
    m.add(copy);
  }
}
