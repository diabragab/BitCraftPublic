import * as THREE from 'three';
import { cloneCharacter } from './assets';
import { CLASS_IDS } from './map';

/** Renders each hero's idle pose into a small image for the class picker and HUD. */
export function renderPortraits(renderer: THREE.WebGLRenderer): Record<string, string> {
  const size = 192;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#554433', 2.2));
  const key = new THREE.DirectionalLight('#ffffff', 2);
  key.position.set(2, 3, 4);
  scene.add(key);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  cam.position.set(0, 2.0, 4.2);
  cam.lookAt(0, 1.55, 0);
  const target = new THREE.WebGLRenderTarget(size, size, { colorSpace: THREE.SRGBColorSpace });
  const pixels = new Uint8Array(size * size * 4);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const out: Record<string, string> = {};
  for (const id of CLASS_IDS) {
    const { root, clips } = cloneCharacter(id);
    const mixer = new THREE.AnimationMixer(root);
    const idle = clips.find((c) => c.name === 'Idle');
    if (idle) mixer.clipAction(idle).play();
    mixer.update(0.3);
    root.rotation.y = -0.35;
    scene.add(root);
    renderer.setRenderTarget(target);
    renderer.setClearColor('#2a2233', 1);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    g.putImageData(img, 0, 0);
    out[id] = canvas.toDataURL('image/png');
    scene.remove(root);
  }
  renderer.setRenderTarget(null);
  target.dispose();
  return out;
}
