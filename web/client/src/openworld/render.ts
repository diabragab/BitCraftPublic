import * as THREE from 'three/webgpu';
import { FXSystem, type FixtureRun } from 'rollshade';
import { gltf } from '../assets';
import { STRUCTURES, type StructureId } from './content';
import { hash2, mulberry32 } from './noise';
import {
  Outline, crystalMaterial, depthTexture, grassMaterial, grassTuftGeometry, markInstancesDirty, tintedMaterial, updateFx, waterMaterial, windMaterial,
} from './shaders';
import type { OpenWorld } from './sim';
import { CHUNK, VILLAGE_RADIUS, WORLD_HALF, type Placed, type ResourceNode } from './terrain';

const isMobile = matchMedia('(pointer: coarse)').matches;
const VIEW_CHUNKS = isMobile ? 2 : 3; // chunks loaded in each direction around the player
const WATER_Y = -0.15;
const WATER_SEGMENTS = 96;

interface GroupOpts {
  shadows?: boolean;
  tint?: THREE.Color;
  /** Trees sway in the wind (shaders.ts). */
  wind?: boolean;
  /** Pulsing ore glow (shaders.ts). */
  crystal?: boolean;
}

/** Bloom on the whole HDR frame: only colours past the threshold (fire, magic, glowing ore) glow. */
const BLOOM = { strength: 0.45, radius: 0.3, threshold: 1.5 };

/**
 * All instances of one model, drawn with one InstancedMesh per sub-mesh. Rebuilt wholesale
 * when the set changes (chunks streamed in or out, a tree felled), which is cheap at these
 * counts and keeps draw calls independent of how many trees are on screen.
 */
class InstanceGroup {
  private meshes: THREE.InstancedMesh[] = [];
  private parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; local: THREE.Matrix4 }[] = [];
  private capacity = 0;

  constructor(private scene: THREE.Scene, model: string, private shadows: boolean, opts: GroupOpts) {
    const root = gltf(model).scene;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let material = mesh.material;
      const single = Array.isArray(material) ? material[0] : material;
      if (opts.crystal) material = crystalMaterial(single, opts.tint);
      else if (opts.tint) material = tintedMaterial(single, opts.tint);
      else if (opts.wind) material = windMaterial(single, mesh.geometry);
      this.parts.push({ geometry: mesh.geometry, material, local: mesh.matrixWorld.clone() });
    });
  }

  set(matrices: THREE.Matrix4[]) {
    if (matrices.length > this.capacity) {
      for (const m of this.meshes) {
        m.removeFromParent();
        m.dispose();
      }
      this.capacity = Math.max(16, Math.ceil(matrices.length * 1.5));
      this.meshes = this.parts.map((p) => {
        const m = new THREE.InstancedMesh(p.geometry, p.material, this.capacity);
        m.castShadow = this.shadows;
        m.receiveShadow = true;
        m.frustumCulled = false;
        this.scene.add(m);
        return m;
      });
    }
    const tmp = new THREE.Matrix4();
    this.meshes.forEach((m, i) => {
      matrices.forEach((mat, j) => m.setMatrixAt(j, tmp.multiplyMatrices(mat, this.parts[i].local)));
      m.count = matrices.length;
      markInstancesDirty(m);
    });
  }
}

const matrixFor = (x: number, y: number, z: number, rot: number, scale: number, offsetX = 0) => {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot),
    new THREE.Vector3(scale, scale, scale),
  );
  if (offsetX) m.multiply(new THREE.Matrix4().makeTranslation(offsetX, 0, 0));
  return m;
};

/** Most campfires that get flames and light at once (the nearest ones). */
const MAX_CAMPFIRES = 6;

export class WorldRenderer {
  readonly renderer: THREE.WebGPURenderer;
  /** rollshade: spell effects, statuses, campfire loops, bloom and camera shake. Set by init(). */
  fx!: FXSystem;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 400);
  readonly sun = new THREE.DirectionalLight('#fff3dd', 2.4);
  private hemi = new THREE.HemisphereLight('#dfefff', '#5a4a3a', 1.3);
  private water: THREE.Mesh;
  private waterLight: { value: number };
  private grass: THREE.InstancedMesh | null = null;
  private grassMat = grassMaterial();
  private grassGeo = grassTuftGeometry();
  private grassCache = new Map<string, { x: number; y: number; z: number; rot: number; scale: number; forest: boolean }[]>();
  grassEnabled = true;
  private outline: Outline;
  private fxPlayer = new THREE.Vector3();
  /** Campfire loops by structure position key, and their spots (all campfires, not only lit ones). */
  private campfires = new Map<string, FixtureRun>();
  private campfireSpots: THREE.Vector3[] = [];
  private daylight = 1;
  /**
   * HDR pipeline: rollshade's post pass renders the scene into a half-float target, so colours
   * brighter than 1 survive; bloom spreads light from those, then the renderer tone-maps (ACES).
   */
  bloomEnabled = true;
  private terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  private chunks = new Map<string, THREE.Mesh>();
  private chunkQueue: [number, number][] = [];
  private groups = new Map<string, InstanceGroup>();
  private visibleChunkKey = '';
  private ghost: THREE.Object3D | null = null;
  private ghostType: StructureId | null = null;
  readonly terrainMeshes: THREE.Mesh[] = [];
  private skyDay = new THREE.Color('#9cc7e8');
  private skyNight = new THREE.Color('#121a33');
  private skyDusk = new THREE.Color('#e8a07a');
  shadowsEnabled = !isMobile;

  constructor(canvas: HTMLCanvasElement, private world: OpenWorld) {
    // WebGPU where the browser has it, WebGL2 otherwise (the renderer falls back by itself).
    // Multisampling is skipped on high-DPI screens, where the extra pixels already hide edges.
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: !isMobile && window.devicePixelRatio < 1.5, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.info.autoReset = false; // several passes per frame: count the whole frame
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = this.skyDay.clone();
    this.scene.fog = new THREE.Fog(this.skyDay.clone(), 70, VIEW_CHUNKS * CHUNK + 10);
    this.scene.add(this.hemi);
    this.sun.shadow.mapSize.set(isMobile ? 1024 : 2048, isMobile ? 1024 : 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -36;
    sc.right = sc.top = 36;
    sc.near = 1;
    sc.far = 140;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun, this.sun.target);

    // water depth comes from the island's heightmap (2-3 m per texel is enough for shore foam)
    const depth = depthTexture((x, z) => world.gen.height(x, z), WORLD_HALF, 256, WATER_Y);
    const water = waterMaterial(depth, WORLD_HALF, WATER_Y);
    this.waterLight = water.light;
    const size = VIEW_CHUNKS * CHUNK * 3;
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(size, size, WATER_SEGMENTS, WATER_SEGMENTS), water.material);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_Y;
    this.water.frustumCulled = false;
    this.scene.add(this.water);
    this.outline = new Outline(this.scene);

    this.setShadows(this.shadowsEnabled);
    this.buildStatic();
    this.resize();
  }

  /**
   * Starts the GPU backend and rollshade, then compiles every effect, loop and the world's
   * materials so the first cast does not stutter. `onProgress` gets 0-1.
   */
  async init(opts: { bloom: boolean; shake: boolean }, onProgress?: (f: number) => void) {
    await this.renderer.init();
    this.fx = new FXSystem({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      post: { bloom: 'scene', ...BLOOM },
      feel: opts.shake,
      // our own impacts freeze only on hits that land (main.ts), not on every effect hit
      hitStopScale: 0,
      floorY: 0,
      quality: isMobile ? 'auto' : 'high',
      lights: isMobile ? 3 : 6,
      loopLights: 4,
    });
    this.setBloom(opts.bloom);
    this.buildStructures();
    this.camera.position.set(this.world.player.x, 18, this.world.player.z + 13);
    this.camera.lookAt(this.world.player.x, 0, this.world.player.z);
    this.camera.updateMatrixWorld();
    await this.fx.prewarm({}, onProgress);
  }

  /** 'webgpu', or 'webgl2' when the browser has no WebGPU and the renderer fell back. */
  backend() {
    return (this.renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend ? 'webgl2' : 'webgpu';
  }

  setShadows(on: boolean) {
    this.shadowsEnabled = on;
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  setBloom(on: boolean) {
    this.bloomEnabled = on;
    this.fx?.setBloom({ ...BLOOM, strength: on ? BLOOM.strength : 0 });
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 62 : 50;
    this.camera.updateProjectionMatrix();
  }

  /** Instance group for a model; `set` separates users of the same model (village vs player-built). */
  private group(model: string, set = 'nodes', opts: GroupOpts = {}) {
    const key = `${set}:${model}`;
    let g = this.groups.get(key);
    if (!g) {
      g = new InstanceGroup(this.scene, model, (opts.shadows ?? true) && !isMobile, opts);
      this.groups.set(key, g);
    }
    return g;
  }

  private placeMatrices(list: Placed[]) {
    const byModel = new Map<string, THREE.Matrix4[]>();
    for (const p of list) {
      const arr = byModel.get(p.model) ?? [];
      arr.push(matrixFor(p.x, this.world.gen.height(p.x, p.z), p.z, p.rot, p.scale, p.offsetX));
      byModel.set(p.model, arr);
    }
    return byModel;
  }

  /** Village, ruins and chests never change shape, only chests hide while looted. */
  private buildStatic() {
    const placed = [...this.world.gen.village, ...this.world.gen.ruins.flatMap((r) => r.props)];
    for (const [model, mats] of this.placeMatrices(placed)) this.group(model, 'static').set(mats);
    this.updateChests();
  }

  updateChests() {
    const now = Date.now();
    const mats = this.world.gen.ruins
      .filter((r) => (this.world.chests.get(r.id) ?? 0) <= now)
      .map((r) => matrixFor(r.chest.x, this.world.gen.height(r.chest.x, r.chest.z), r.chest.z, 0, 1));
    this.group('dungeon/chest_gold', 'chests').set(mats);
  }

  buildStructures() {
    const byModel = new Map<string, THREE.Matrix4[]>();
    for (const def of Object.values(STRUCTURES)) byModel.set(def.model, []);
    for (const s of this.world.structures) {
      const def = STRUCTURES[s.type];
      byModel.get(def.model)!.push(matrixFor(s.x, this.world.gen.height(s.x, s.z), s.z, s.rot, def.scale, def.offsetX));
    }
    for (const [model, mats] of byModel) this.group(model, 'built').set(mats);
    // flames on the campfire models come from rollshade's campfire loop (its own logs left out)
    this.campfireSpots = this.world.structures.filter((s) => s.type === 'campfire')
      .map((s) => new THREE.Vector3(s.x, this.world.gen.height(s.x, s.z) + 0.12, s.z));
    this.updateCampfires(new THREE.Vector3(this.world.player.x, 0, this.world.player.z));
    this.rebuildGrass();
  }

  /**
   * Keeps loops on the nearest campfires only: loops share a fixed pool of four lights, and a
   * camp of twenty fires should not run twenty flame effects.
   */
  private updateCampfires(focus: THREE.Vector3) {
    if (!this.fx) return;
    const near = this.campfireSpots
      .map((p) => ({ p, key: `${p.x},${p.z}`, d: Math.hypot(p.x - focus.x, p.z - focus.z) }))
      .filter((c) => c.d < 60)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_CAMPFIRES);
    const keep = new Set(near.map((c) => c.key));
    for (const [key, loop] of this.campfires) {
      if (!keep.has(key)) {
        loop.stop();
        this.campfires.delete(key);
      }
    }
    for (const c of near) {
      if (!this.campfires.has(c.key)) this.campfires.set(c.key, this.fx.loop('campfire', c.p, { prop: false }));
    }
    // brighter at night, when the fire is the only light around
    for (const loop of this.campfires.values()) loop.intensity = 0.55 + 0.45 * (1 - this.daylight);
  }

  /** Campfire loops currently burning (for tests). */
  campfireCount() {
    return this.campfires.size;
  }

  /** Grass tufts for one chunk: deterministic, only on grass and forest, never in the village or ruins. */
  private grassInChunk(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    let list = this.grassCache.get(key);
    if (list) return list;
    list = [];
    const gen = this.world.gen;
    const rnd = mulberry32(hash2(cx, cz, gen.seed ^ 0x6a55));
    const cell = 2;
    const density = isMobile ? 0.5 : 1;
    for (let j = 0; j < CHUNK / cell; j++) {
      for (let i = 0; i < CHUNK / cell; i++) {
        const x = cx * CHUNK + (i + rnd()) * cell;
        const z = cz * CHUNK + (j + rnd()) * cell;
        const roll = rnd();
        const rot = rnd() * Math.PI * 2;
        const scale = 0.55 + rnd() * 0.4;
        if (Math.hypot(x, z) < VILLAGE_RADIUS + 3) continue;
        const h = gen.height(x, z);
        const biome = gen.biome(x, z, h);
        if (biome !== 'grass' && biome !== 'forest') continue;
        if (roll > (biome === 'grass' ? 0.5 : 0.3) * density) continue;
        if (gen.ruins.some((r) => Math.hypot(r.x - x, r.z - z) < 12)) continue;
        list.push({ x, y: h - 0.05, z, rot, scale, forest: biome === 'forest' });
      }
    }
    if (this.grassCache.size > 40) this.grassCache.clear();
    this.grassCache.set(key, list);
    return list;
  }

  setGrass(on: boolean) {
    this.grassEnabled = on;
    this.rebuildGrass();
  }

  /** Grass for the 3x3 chunks around the player, kept clear of anything built. */
  rebuildGrass() {
    if (!this.grassEnabled) {
      if (this.grass) this.grass.count = 0;
      return;
    }
    const [pcx, pcz] = this.playerChunk();
    const built = this.world.structures;
    const tufts = [];
    for (let cx = pcx - 1; cx <= pcx + 1; cx++) {
      for (let cz = pcz - 1; cz <= pcz + 1; cz++) {
        for (const t of this.grassInChunk(cx, cz)) {
          if (!built.some((s) => Math.abs(s.x - t.x) < 2.5 && Math.abs(s.z - t.z) < 2.5)) tufts.push(t);
        }
      }
    }
    if (!this.grass || tufts.length > this.grass.instanceMatrix.count) {
      this.grass?.removeFromParent();
      this.grass?.dispose();
      this.grass = new THREE.InstancedMesh(this.grassGeo, this.grassMat, Math.max(1024, Math.ceil(tufts.length * 1.3)));
      this.grass.receiveShadow = true;
      this.grass.frustumCulled = false;
      this.scene.add(this.grass);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const meadow = new THREE.Color(1, 1, 1);
    const forest = new THREE.Color(0.72, 0.84, 0.7);
    tufts.forEach((t, i) => {
      m.compose(new THREE.Vector3(t.x, t.y, t.z), q.setFromAxisAngle(up, t.rot), new THREE.Vector3(t.scale, t.scale, t.scale));
      this.grass!.setMatrixAt(i, m);
      this.grass!.setColorAt(i, t.forest ? forest : meadow);
    });
    this.grass.count = tufts.length;
    markInstancesDirty(this.grass);
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
  }

  /** Outline around whatever the action key would use. */
  highlight(target: ReturnType<OpenWorld['interactTarget']>) {
    if (!target) return this.outline.clear();
    const chest = target.type === 'chest';
    const model = chest ? 'dungeon/chest_gold' : target.node.model;
    const at = chest
      ? matrixFor(target.x, this.world.gen.height(target.x, target.z), target.z, 0, 1)
      : matrixFor(target.node.x, target.node.y, target.node.z, target.node.rot, target.node.scale);
    const root = gltf(model).scene;
    root.updateMatrixWorld(true);
    const parts: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) parts.push({ geometry: mesh.geometry, matrix: at.clone().multiply(mesh.matrixWorld) });
    });
    this.outline.show(chest ? `chest:${target.ruin}` : target.node.id, parts, !chest && target.node.kind === 'tree');
  }

  /** Rebuilds resource instances for the chunks around the player. */
  rebuildResources() {
    this.outline.clear(); // a felled tree must not keep its outline until the next HUD refresh
    const now = Date.now();
    const groups = new Map<string, THREE.Matrix4[]>();
    const add = (key: string, m: THREE.Matrix4) => {
      const arr = groups.get(key) ?? [];
      arr.push(m);
      groups.set(key, arr);
    };
    const [pcx, pcz] = this.playerChunk();
    for (let cx = pcx - VIEW_CHUNKS; cx <= pcx + VIEW_CHUNKS; cx++) {
      for (let cz = pcz - VIEW_CHUNKS; cz <= pcz + VIEW_CHUNKS; cz++) {
        for (const n of this.world.nodesInChunk(cx, cz)) {
          const depleted = this.world.isDepleted(n.id, now);
          if (n.kind === 'tree') {
            add(depleted ? `${n.model}_cut` : n.model, matrixFor(n.x, n.y, n.z, n.rot, n.scale));
          } else if (!depleted) {
            add(n.kind === 'iron' ? `iron:${n.model}` : n.model, matrixFor(n.x, n.y, n.z, n.rot, n.scale));
          }
        }
      }
    }
    const models = ['nature/tree_single_A', 'nature/tree_single_B', 'nature/tree_single_A_cut', 'nature/tree_single_B_cut',
      'nature/rock_single_A', 'nature/rock_single_B', 'nature/rock_single_C', 'nature/rock_single_D', 'nature/rock_single_E'];
    for (const m of models) this.group(m, 'nodes', { wind: /tree_single_[AB]$/.test(m) }).set(groups.get(m) ?? []);
    const ironTint = new THREE.Color('#d08a5a');
    for (const m of ['nature/rock_single_D', 'nature/rock_single_E']) {
      this.group(m, 'iron', { tint: ironTint, crystal: true }).set(groups.get(`iron:${m}`) ?? []);
    }
  }

  private playerChunk(): [number, number] {
    const p = this.world.player;
    return [Math.floor(p.x / CHUNK), Math.floor(p.z / CHUNK)];
  }

  /** Streams terrain chunks: queues missing ones, builds at most two per frame, drops far ones. */
  updateChunks() {
    const [pcx, pcz] = this.playerChunk();
    const key = `${pcx},${pcz}`;
    if (key !== this.visibleChunkKey) {
      this.visibleChunkKey = key;
      const limit = Math.ceil(WORLD_HALF / CHUNK);
      const wanted = new Set<string>();
      for (let cx = pcx - VIEW_CHUNKS; cx <= pcx + VIEW_CHUNKS; cx++) {
        for (let cz = pcz - VIEW_CHUNKS; cz <= pcz + VIEW_CHUNKS; cz++) {
          if (cx < -limit - 1 || cx > limit || cz < -limit - 1 || cz > limit) continue;
          wanted.add(`${cx},${cz}`);
          if (!this.chunks.has(`${cx},${cz}`)) this.chunkQueue.push([cx, cz]);
        }
      }
      for (const [k, mesh] of this.chunks) {
        if (!wanted.has(k)) {
          mesh.removeFromParent();
          mesh.geometry.dispose();
          this.chunks.delete(k);
          this.terrainMeshes.splice(this.terrainMeshes.indexOf(mesh), 1);
        }
      }
      // nearest first
      this.chunkQueue.sort((a, b) => Math.hypot(a[0] - pcx, a[1] - pcz) - Math.hypot(b[0] - pcx, b[1] - pcz));
      this.rebuildResources();
      this.rebuildGrass();
    }
    for (let i = 0; i < 2 && this.chunkQueue.length; i++) {
      const [cx, cz] = this.chunkQueue.shift()!;
      const k = `${cx},${cz}`;
      if (this.chunks.has(k) || Math.abs(cx - pcx) > VIEW_CHUNKS || Math.abs(cz - pcz) > VIEW_CHUNKS) continue;
      const mesh = new THREE.Mesh(this.world.gen.chunkGeometry(cx, cz), this.terrainMat);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.chunks.set(k, mesh);
      this.terrainMeshes.push(mesh);
    }
  }

  pendingChunks() {
    return this.chunkQueue.length;
  }

  /** Sun position, sky colour and light levels for the time of day. */
  updateDayNight(focus: THREE.Vector3) {
    const t = this.world.dayTime();
    const angle = (t - 0.25) * Math.PI * 2; // 0 at sunrise, PI/2 at noon
    const elevation = Math.sin(angle);
    const daylight = THREE.MathUtils.smoothstep(elevation, -0.12, 0.25);
    const dusk = Math.max(0, 1 - Math.abs(elevation) / 0.25) * 0.6;
    const sky = this.skyNight.clone().lerp(this.skyDay, daylight).lerp(this.skyDusk, dusk * daylight);
    (this.scene.background as THREE.Color).copy(sky);
    (this.scene.fog as THREE.Fog).color.copy(sky);
    this.sun.intensity = 0.25 + 2.3 * daylight;
    this.sun.color.set(daylight > 0.3 ? '#fff3dd' : '#9fb3ff');
    this.hemi.intensity = 0.35 + 1.0 * daylight;
    // the "sun" doubles as moonlight at night, from the opposite side
    const dir = daylight > 0.05 ? 1 : -1;
    this.sun.position.set(focus.x + Math.cos(angle) * 40 * dir, focus.y + Math.max(18, Math.abs(elevation) * 45), focus.z + 18);
    this.sun.target.position.copy(focus);
    // the water follows the camera in whole grid steps so its waves do not slide
    const cell = (VIEW_CHUNKS * CHUNK * 3) / WATER_SEGMENTS;
    this.water.position.x = Math.round(focus.x / cell) * cell;
    this.water.position.z = Math.round(focus.z / cell) * cell;
    this.waterLight.value = 0.3 + 0.7 * daylight;
    this.daylight = daylight;
    this.campfireTimer -= 1;
    if (this.campfireTimer <= 0) {
      this.campfireTimer = 30;
      this.updateCampfires(focus);
    }
  }
  private campfireTimer = 0;

  /** Semi-transparent preview of a structure that follows the cursor in build mode. */
  setGhost(type: StructureId | null) {
    if (this.ghost) this.ghost.removeFromParent();
    this.ghost = null;
    this.ghostType = type;
    if (!type) return;
    const def = STRUCTURES[type];
    const g = gltf(def.model).scene.clone(true);
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = new THREE.MeshBasicMaterial({ color: '#7ee08a', transparent: true, opacity: 0.55, depthWrite: false });
        m.castShadow = false;
      }
    });
    g.scale.setScalar(def.scale);
    const holder = new THREE.Group();
    g.position.x = (def.offsetX ?? 0) * def.scale;
    holder.add(g);
    this.ghost = holder;
    this.scene.add(holder);
  }

  moveGhost(x: number, z: number, rot: number, ok: boolean) {
    if (!this.ghost || !this.ghostType) return;
    this.ghost.position.set(x, this.world.gen.height(x, z), z);
    this.ghost.rotation.y = rot;
    this.ghost.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) (m.material as THREE.MeshBasicMaterial).color.set(ok ? '#7ee08a' : '#ff6b5e');
    });
  }

  /** Point on the terrain under a screen position (normalized device coordinates). */
  pick(ndc: { x: number; y: number }): THREE.Vector3 | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    const hit = ray.intersectObjects(this.terrainMeshes, false)[0];
    return hit ? hit.point : null;
  }

  /**
   * Advances rollshade and draws the frame. The camera must already be placed for this frame:
   * effects project their screen-space parts through it.
   */
  render(dt: number) {
    const p = this.world.player;
    const ground = this.world.gen.height(p.x, p.z);
    updateFx(performance.now() / 1000, this.fxPlayer.set(p.x, ground, p.z));
    this.camera.updateMatrixWorld();
    // debris (rocks, shards) lands on one global floor: keep it under the action
    this.fx.floorY = ground;
    // same clamp as the game loop, so effects keep pace with the sim's (wall-clock) damage timing
    this.fx.update(Math.min(dt, 0.1));
    this.renderer.info.reset();
    this.fx.render();
  }

  drawCalls() {
    return this.renderer.info.render.drawCalls;
  }
}

export type { ResourceNode };
