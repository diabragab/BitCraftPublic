import * as THREE from 'three';
import { gltf } from './assets';
import { MAP } from './map';

export interface WorldView {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  ground: THREE.Mesh;
  setShadows(on: boolean): void;
  resize(): void;
  drawCalls(): number;
}

const isMobile = matchMedia('(pointer: coarse)').matches;

function grassTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6aa84f';
  g.fillRect(0, 0, 256, 256);
  // deterministic speckles so the ground does not look flat
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    const shade = rnd() < 0.5 ? 'rgba(40,90,30,0.25)' : 'rgba(150,200,90,0.22)';
    g.fillStyle = shade;
    g.fillRect(rnd() * 256, rnd() * 256, 2 + rnd() * 3, 2 + rnd() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Static props are drawn with one InstancedMesh per (model, sub-mesh), so ~300
 * placed objects cost a few dozen draw calls instead of several hundred.
 */
function buildProps(scene: THREE.Scene) {
  const byModel = new Map<string, THREE.Matrix4[]>();
  const tmp = new THREE.Object3D();
  for (const p of MAP.props) {
    tmp.position.set(p.x, 0, p.z);
    tmp.rotation.set(0, p.rotY, 0);
    tmp.scale.setScalar(p.scale);
    tmp.updateMatrix();
    const list = byModel.get(p.model) ?? [];
    list.push(tmp.matrix.clone());
    byModel.set(p.model, list);
  }
  for (const [model, placements] of byModel) {
    const root = gltf(model).scene;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length);
      const local = mesh.matrixWorld;
      placements.forEach((m, i) => inst.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(m, local)));
      inst.instanceMatrix.needsUpdate = true;
      const tall = !model.includes('floor') && !model.includes('rock');
      inst.castShadow = tall;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      inst.name = model;
      scene.add(inst);
    });
  }
}

export function createWorld(canvas: HTMLCanvasElement): WorldView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9cc7e8');
  scene.fog = new THREE.Fog('#9cc7e8', 45, 95);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 200);
  camera.position.set(0, 16, 38);

  scene.add(new THREE.HemisphereLight('#dfefff', '#5a4a3a', 1.3));
  const sun = new THREE.DirectionalLight('#fff3dd', 2.4);
  sun.position.set(18, 30, 12);
  sun.shadow.mapSize.set(isMobile ? 1024 : 2048, isMobile ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -24;
  sc.right = sc.top = 24;
  sc.near = 1;
  sc.far = 80;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.11;
  ground.receiveShadow = true;
  scene.add(ground);

  // dirt roads leading to the keep gates and the camp
  const dirt = new THREE.MeshStandardMaterial({ color: '#9c7b55', roughness: 1 });
  for (const [w, d, x, z] of [[7, 20, 0, 26], [7, 18, 0, -26], [18, 7, 26, 0], [18, 7, -26, 0]] as const) {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), dirt);
    road.rotation.x = -Math.PI / 2;
    road.position.set(x, -0.1, z);
    road.receiveShadow = true;
    scene.add(road);
  }
  // camp marker
  const camp = new THREE.Mesh(
    new THREE.RingGeometry(MAP.camp.r - 0.25, MAP.camp.r, 48),
    new THREE.MeshBasicMaterial({ color: '#f2c14e', transparent: true, opacity: 0.35 }),
  );
  camp.rotation.x = -Math.PI / 2;
  camp.position.set(MAP.camp.x, -0.05, MAP.camp.z);
  scene.add(camp);

  buildProps(scene);

  // warm torch lights at the gates (few, cheap point lights)
  if (!isMobile) {
    for (const [x, z] of [[0, -14.5], [0, 14.5], [-14.5, 0], [14.5, 0]]) {
      const l = new THREE.PointLight('#ffae4a', 6, 9, 2);
      l.position.set(x, 2.2, z);
      scene.add(l);
    }
  }

  const view: WorldView = {
    renderer,
    scene,
    camera,
    sun,
    ground,
    setShadows(on) {
      renderer.shadowMap.enabled = on;
      sun.castShadow = on;
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.needsUpdate = true;
      });
    },
    resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // portrait phones need a wider view
      camera.fov = w < h ? 62 : 50;
      camera.updateProjectionMatrix();
    },
    drawCalls: () => renderer.info.render.calls,
  };
  view.resize();
  return view;
}
