import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MAP } from './map';

export const CHARACTER_MODELS = ['knight', 'barbarian', 'mage', 'rogue', 'skeleton_minion', 'skeleton_warrior', 'skeleton_rogue', 'skeleton_mage'];
export const WEAPON_MODELS = ['skeleton_blade', 'skeleton_axe', 'skeleton_staff', 'skeleton_shield_small_a'];
const EXTRA_PROPS = ['dungeon/bottle_A_green', 'dungeon/coin_stack_small'];

const gltfs = new Map<string, GLTF>();

export function propUrl(key: string) {
  // BASE_URL is '/' for the served build and './' for the single-player page build. Page hosts
  // that only serve standard web file types (claude.ai) get the models as JSON-wrapped GLBs,
  // written by tools/build-artifact.mjs.
  return `${import.meta.env.BASE_URL}assets/${key}${__OFFLINE__ ? '.glb.json' : '.glb'}`;
}

async function loadModel(loader: GLTFLoader, key: string): Promise<GLTF> {
  if (!__OFFLINE__) return loader.loadAsync(propUrl(key));
  const res = await fetch(propUrl(key));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { base64 } = (await res.json()) as { base64: string };
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return loader.parseAsync(bytes.buffer, '');
}

/** Loads every model the game needs. Reports progress as a 0..1 fraction. */
export async function loadAll(onProgress: (fraction: number, label: string) => void): Promise<void> {
  const keys = [
    ...CHARACTER_MODELS.map((k) => `characters/${k}`),
    ...WEAPON_MODELS.map((k) => `weapons/${k}`),
    ...new Set([...MAP.props.map((p) => p.model), ...EXTRA_PROPS]),
  ];
  // GLTFLoader decodes embedded textures with fetch(blob:) + createImageBitmap when available.
  // Hosts whose content-security policy blocks fetching blob: URLs (the claude.ai page sandbox)
  // still allow <img src="blob:...">, so the single-player build takes that path instead.
  // GLTFParser checks this per file, so it stays disabled until loading has finished.
  const savedBitmap = window.createImageBitmap;
  if (__OFFLINE__) (window as { createImageBitmap?: unknown }).createImageBitmap = undefined;
  try {
    await loadFiles(keys, onProgress);
  } finally {
    if (__OFFLINE__) window.createImageBitmap = savedBitmap;
  }
}

async function loadFiles(keys: string[], onProgress: (fraction: number, label: string) => void) {
  const loader = new GLTFLoader();
  let done = 0;
  const failures: string[] = [];
  // Limited concurrency keeps mobile connections responsive.
  const queue = [...keys];
  async function worker() {
    for (let key = queue.shift(); key; key = queue.shift()) {
      try {
        gltfs.set(key, await loadModel(loader, key));
      } catch (e) {
        console.error('asset failed', key, e);
        failures.push(key);
      }
      onProgress(++done / keys.length, key);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failures.length) throw new Error(`Missing assets: ${failures.join(', ')}`);
  for (const g of gltfs.values()) {
    g.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }
}

export function gltf(key: string): GLTF {
  const g = gltfs.get(key);
  if (!g) throw new Error(`asset not loaded: ${key}`);
  return g;
}

/** A skinned, independently animatable copy of a character model. */
export function cloneCharacter(model: string): { root: THREE.Object3D; clips: THREE.AnimationClip[] } {
  const g = gltf(`characters/${model}`);
  return { root: SkeletonUtils.clone(g.scene), clips: g.animations };
}

export function cloneProp(key: string): THREE.Object3D {
  return gltf(key).scene.clone(true);
}

export function loadedCount() {
  return gltfs.size;
}
