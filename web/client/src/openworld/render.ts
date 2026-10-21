import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { gltf } from '../assets';
import { STRUCTURES, type StructureId } from './content';
import { hash2, mulberry32 } from './noise';
import { Fires, Outline, crystalMaterial, depthTexture, grassMaterial, grassTuftGeometry, updateFx, waterMaterial, windMaterials } from './shaders';
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

/**
 * All instances of one model, drawn with one InstancedMesh per sub-mesh. Rebuilt wholesale
 * when the set changes (chunks streamed in or out, a tree felled), which is cheap at these
 * counts and keeps draw calls independent of how many trees are on screen.
 */
class InstanceGroup {
  private meshes: THREE.InstancedMesh[] = [];
  private parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; depth?: THREE.Material; local: THREE.Matrix4 }[] = [];
  private capacity = 0;

  constructor(private scene: THREE.Scene, model: string, private shadows: boolean, opts: GroupOpts) {
    const root = gltf(model).scene;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let material = mesh.material;
      let depth: THREE.Material | undefined;
      if (opts.tint || opts.crystal || opts.wind) {
        let single = (Array.isArray(material) ? material[0] : material).clone();
        if (opts.tint) {
          (single as THREE.MeshStandardMaterial).color.multiply(opts.tint);
          (single as THREE.MeshStandardMaterial).emissive = opts.tint.clone().multiplyScalar(0.12);
        }
        if (opts.crystal) crystalMaterial(single);
        if (opts.wind) ({ material: single, depth } = windMaterials(single, mesh.geometry));
        material = single;
      }
      this.parts.push({ geometry: mesh.geometry, material, depth, local: mesh.matrixWorld.clone() });
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
        if (p.depth) m.customDepthMaterial = p.depth;
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
      m.instanceMatrix.needsUpdate = true;
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

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 400);
  readonly sun = new THREE.DirectionalLight('#fff3dd', 2.4);
  private hemi = new THREE.HemisphereLight('#dfefff', '#5a4a3a', 1.3);
  private water: THREE.Mesh;
  private waterMat: THREE.ShaderMaterial;
  private grass: THREE.InstancedMesh | null = null;
  private grassMat = grassMaterial();
  private grassGeo = grassTuftGeometry();
  private grassCache = new Map<string, { x: number; y: number; z: number; rot: number; scale: number; forest: boolean }[]>();
  grassEnabled = true;
  private flames: Fires;
  private outline: Outline;
  private fxPlayer = new THREE.Vector3();
  /**
   * HDR pipeline: the scene renders into a half-float target, so colours brighter than 1
   * survive; bloom spreads light from those, then OutputPass tone-maps (ACES) to the screen.
   */
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  bloomEnabled = true;
  private terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  private chunks = new Map<string, THREE.Mesh>();
  private chunkQueue: [number, number][] = [];
  private groups = new Map<string, InstanceGroup>();
  private visibleChunkKey = '';
  private fires: THREE.PointLight[] = [];
  private ghost: THREE.Object3D | null = null;
  private ghostType: StructureId | null = null;
  readonly terrainMeshes: THREE.Mesh[] = [];
  private skyDay = new THREE.Color('#9cc7e8');
  private skyNight = new THREE.Color('#121a33');
  private skyDusk = new THREE.Color('#e8a07a');
  shadowsEnabled = !isMobile;

  constructor(canvas: HTMLCanvasElement, private world: OpenWorld) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.info.autoReset = false; // several passes per frame: count the whole frame
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: isMobile ? 0 : 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // threshold above what sunlit terrain (plus translucent overlays) reaches, so only emissive
    // HDR colours (fire, magic, glowing ore) bloom
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.4, 1.5);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
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
    this.waterMat = waterMaterial(depth, WORLD_HALF, WATER_Y);
    const size = VIEW_CHUNKS * CHUNK * 3;
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(size, size, WATER_SEGMENTS, WATER_SEGMENTS), this.waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_Y;
    this.water.frustumCulled = false;
    this.scene.add(this.water);
    this.flames = new Fires(this.scene);
    this.outline = new Outline(this.scene);

    this.setShadows(this.shadowsEnabled);
    this.buildStatic();
    this.buildStructures();
    this.resize();
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
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
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
    // flames + light for campfires
    for (const light of this.fires) light.removeFromParent();
    const campfires = this.world.structures.filter((s) => s.type === 'campfire');
    this.flames.set(campfires.map((s) => new THREE.Vector3(s.x, this.world.gen.height(s.x, s.z) + 0.55, s.z)));
    this.fires = campfires.map((s) => {
      const light = new THREE.PointLight('#ff9a3c', 0, 14, 1.6);
      light.position.set(s.x, this.world.gen.height(s.x, s.z) + 1.6, s.z);
      this.scene.add(light);
      return light;
    });
    this.rebuildGrass();
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
    this.grass.instanceMatrix.needsUpdate = true;
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
    this.waterMat.uniforms.uLight.value = 0.3 + 0.7 * daylight;
    const flicker = 0.85 + Math.sin(performance.now() / 90) * 0.1 + Math.random() * 0.05;
    for (const light of this.fires) {
      const dist = light.position.distanceTo(focus);
      light.intensity = dist < 40 ? (6 + 14 * (1 - daylight)) * flicker : 0;
    }
  }

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

  render() {
    const p = this.world.player;
    updateFx(performance.now() / 1000, this.fxPlayer.set(p.x, this.world.gen.height(p.x, p.z), p.z));
    this.renderer.info.reset();
    if (this.bloomEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  drawCalls() {
    return this.renderer.info.render.calls;
  }
}

export type { ResourceNode };
