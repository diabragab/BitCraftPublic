// Combat effects: shockwave rings, slashes, projectiles, lightning, meteors, heals, buff auras,
// the shield bubble and status markers on enemies. Colours are HDR (above 1.0), so bloom
// makes them glow. Everything here is short-lived meshes or a few reused instanced markers.
import * as THREE from 'three';
import { ELEMENTS, type Element } from './content';
import { fx } from './shaders';

const hdr = (el: Element, k = 1) => new THREE.Color(...ELEMENTS[el].hdr).multiplyScalar(k);

const additive = (color: THREE.Color, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

interface Item {
  obj: THREE.Object3D;
  age: number;
  life: number;
  tick: (t: number, dt: number) => void;
  done?: () => void;
}

const RING = new THREE.RingGeometry(0.82, 1, 48);
const DISC = new THREE.CircleGeometry(1, 40);
const ORB = new THREE.IcosahedronGeometry(1, 1);
const BEAM = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);

/**
 * Port of GDQuest's force_field.gdshader (MIT, see shaders.ts): fresnel edges, a scrolling
 * pattern that cuts holes in it, a sweeping scanline and a gentle pulse. The pattern comes
 * from the shared generated noise instead of the demo's hexagon texture.
 */
function forceFieldMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    name: 'hearthwild-forcefield',
    uniforms: { fxTime: fx.time, fxNoise: fx.noise, uColor: { value: color }, uFade: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float fxTime;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position + normal * sin(fxTime * 2.0) * 0.025;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform sampler2D fxNoise;
      uniform vec3 uColor;
      uniform float uFade;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying vec2 vUv;
      void main() {
        float fresnel = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), 4.0) * 1.5 + 0.08;
        float pattern = smoothstep(0.35, 0.65, texture2D(fxNoise, vUv * vec2(6.0, 3.0) + fxTime * 0.025).r);
        fresnel *= 0.4 + 0.6 * pattern;
        float offset = mod(-fxTime * 0.5, 2.0) - 1.0;
        float scan = smoothstep(0.4, 0.5, vUv.y + offset) * (1.0 - smoothstep(0.5, 0.6, vUv.y + offset)) * pattern;
        gl_FragColor = vec4(uColor * (fresnel + scan * 0.35), 1.0) * uFade;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export class Vfx {
  private items: Item[] = [];
  private shield: THREE.Mesh;
  private aura: THREE.Mesh;
  private stun: THREE.InstancedMesh;
  private slow: THREE.InstancedMesh;
  private burn: THREE.InstancedMesh;

  constructor(private scene: THREE.Scene, private height: (x: number, z: number) => number) {
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1.25, 32, 16), forceFieldMaterial(hdr('arcane', 0.9)));
    this.shield.visible = false;
    this.shield.renderOrder = 3;
    this.aura = new THREE.Mesh(RING, additive(hdr('holy'), 0.8));
    this.aura.rotation.x = -Math.PI / 2;
    this.aura.visible = false;
    const marker = (geometry: THREE.BufferGeometry, color: THREE.Color) => {
      const m = new THREE.InstancedMesh(geometry, additive(color, 0.9), 64);
      m.count = 0;
      m.frustumCulled = false;
      return m;
    };
    this.stun = marker(new THREE.TorusGeometry(0.32, 0.05, 6, 20), hdr('holy', 1.2));
    this.slow = marker(RING, hdr('frost'));
    this.burn = marker(new THREE.IcosahedronGeometry(0.18, 0), hdr('fire', 1.4));
    scene.add(this.shield, this.aura, this.stun, this.slow, this.burn);
  }

  private add(obj: THREE.Object3D, life: number, tick: Item['tick'], done?: () => void) {
    this.scene.add(obj);
    this.items.push({ obj, age: 0, life, tick, done });
  }

  private y(x: number, z: number) {
    return this.height(x, z);
  }

  /** Expanding ground ring plus a flash: novas, impacts, taunts. */
  ring(x: number, z: number, radius: number, el: Element, life = 0.55) {
    const mat = additive(hdr(el), 1);
    const ring = new THREE.Mesh(RING, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, this.y(x, z) + 0.15, z);
    // the wide flash stays under the bloom threshold; the thin ring and sparks are what glow
    const flashMat = additive(hdr(el, 0.3), 0.45);
    const flash = new THREE.Mesh(DISC, flashMat);
    flash.rotation.x = -Math.PI / 2;
    flash.position.set(x, this.y(x, z) + 0.1, z);
    const g = new THREE.Group();
    g.add(ring, flash);
    this.add(g, life, (t) => {
      const s = 0.25 + 0.75 * (1 - (1 - t) ** 3);
      ring.scale.setScalar(radius * s);
      flash.scale.setScalar(radius * s * 0.95);
      mat.opacity = 1 - t;
      flashMat.opacity = 0.45 * (1 - t) ** 2;
    });
    this.sparks(x, z, el, Math.round(10 + radius * 4), radius * 0.6);
  }

  /** Glowing motes thrown out and up. */
  sparks(x: number, z: number, el: Element, count: number, spread = 1.5, rise = 2.2) {
    const mat = additive(hdr(el, 1.3), 1);
    const g = new THREE.Group();
    const vel: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(ORB, mat);
      m.scale.setScalar(0.05 + Math.random() * 0.06);
      m.position.set(x, this.y(x, z) + 0.4 + Math.random() * 0.6, z);
      const a = Math.random() * Math.PI * 2;
      const sp = spread * (0.5 + Math.random());
      vel.push(new THREE.Vector3(Math.cos(a) * sp, rise * (0.5 + Math.random()), Math.sin(a) * sp));
      g.add(m);
    }
    this.add(g, 0.8, (t, dt) => {
      g.children.forEach((m, i) => {
        m.position.addScaledVector(vel[i], dt);
        vel[i].y -= 4 * dt;
      });
      mat.opacity = 1 - t;
    });
  }

  /** A sweeping arc in front of the caster (cones, cleaves, bashes). */
  slash(x: number, z: number, facing: number, range: number, arc: number, el: Element) {
    const mat = additive(hdr(el, 1.2), 1);
    const geo = new THREE.RingGeometry(range * 0.35, range, 32, 1, -arc, arc * 2);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    // RingGeometry's angle 0 points along +x; turn it to face `facing` (0 = +z)
    m.rotation.z = facing - Math.PI / 2;
    m.position.set(x, this.y(x, z) + 0.6, z);
    this.add(m, 0.3, (t) => {
      mat.opacity = 1 - t;
      m.scale.setScalar(0.85 + 0.15 * t);
    }, () => geo.dispose());
  }

  /** A glowing orb flying from A to B; `onArrive` fires at B. */
  projectile(fx0: number, fz0: number, tx: number, tz: number, el: Element, speed = 22, size = 0.28, onArrive?: () => void) {
    const mat = additive(hdr(el, 1.6), 1);
    const g = new THREE.Group();
    const core = new THREE.Mesh(ORB, mat);
    core.scale.setScalar(size);
    const haloMat = additive(hdr(el, 0.5), 0.5);
    const halo = new THREE.Mesh(ORB, haloMat);
    halo.scale.setScalar(size * 2.2);
    g.add(core, halo);
    const from = new THREE.Vector3(fx0, this.y(fx0, fz0) + 1.2, fz0);
    const to = new THREE.Vector3(tx, this.y(tx, tz) + 1.0, tz);
    const life = Math.max(0.12, from.distanceTo(to) / speed);
    g.position.copy(from);
    this.add(g, life, (t) => {
      g.position.lerpVectors(from, to, t);
      halo.scale.setScalar(size * (2 + Math.sin(t * 30) * 0.3));
    }, onArrive);
  }

  /** Jagged lightning through a list of points. */
  lightning(points: [number, number][], el: Element) {
    const mat = additive(hdr(el, 1.8), 1);
    const g = new THREE.Group();
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1];
      const [bx, bz] = points[i];
      let prev = new THREE.Vector3(ax, this.y(ax, az) + 1.1, az);
      const end = new THREE.Vector3(bx, this.y(bx, bz) + 1.0, bz);
      for (let k = 1; k <= 4; k++) {
        const p = prev.clone().lerp(end, 1 / (5 - k));
        if (k < 4) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.7));
        const len = prev.distanceTo(p);
        const seg = new THREE.Mesh(BEAM, mat);
        seg.scale.set(0.05, len, 0.05);
        seg.position.copy(prev).lerp(p, 0.5);
        seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().sub(prev).normalize());
        g.add(seg);
        prev = p;
      }
      this.sparks(bx, bz, el, 6, 1, 1.5);
    }
    this.add(g, 0.35, (t) => {
      mat.opacity = t < 0.5 ? 1 : 2 * (1 - t);
      g.visible = Math.random() > 0.15;
    });
  }

  /** A rock of fire falling onto a marked circle. The impact itself comes as its own event. */
  meteor(tx: number, tz: number, radius: number, el: Element, delay: number) {
    const markMat = additive(hdr(el, 0.6), 0.2);
    const mark = new THREE.Mesh(RING, markMat);
    mark.rotation.x = -Math.PI / 2;
    mark.scale.setScalar(radius);
    mark.position.set(tx, this.y(tx, tz) + 0.12, tz);
    const rockMat = additive(hdr(el, 2), 1);
    const rock = new THREE.Mesh(ORB, rockMat);
    rock.scale.setScalar(0.6);
    const from = new THREE.Vector3(tx - 7, this.y(tx, tz) + 16, tz - 5);
    const to = new THREE.Vector3(tx, this.y(tx, tz) + 0.3, tz);
    const g = new THREE.Group();
    g.add(mark, rock);
    this.add(g, delay / 1000, (t) => {
      rock.position.lerpVectors(from, to, t * t);
      markMat.opacity = 0.2 + 0.6 * t;
      mark.scale.setScalar(radius * (1.1 - 0.1 * t));
    });
  }

  /** Light column and rising motes: buffs and heals. */
  column(x: number, z: number, el: Element, heal = false) {
    const mat = additive(hdr(el, 0.45), 0.5);
    const beam = new THREE.Mesh(BEAM, mat);
    beam.scale.set(0.9, 4, 0.9);
    beam.position.set(x, this.y(x, z) + 2, z);
    this.add(beam, 0.7, (t) => {
      mat.opacity = 0.5 * (1 - t);
      beam.scale.set(0.9 + t * 0.6, 4, 0.9 + t * 0.6);
    });
    this.sparks(x, z, el, heal ? 18 : 12, 0.6, heal ? 3.2 : 2.4);
    this.ring(x, z, 1.8, el, 0.5);
  }

  /** A streak along a dash. */
  trail(x0: number, z0: number, x1: number, z1: number, el: Element) {
    const a = new THREE.Vector3(x0, this.y(x0, z0) + 0.9, z0);
    const b = new THREE.Vector3(x1, this.y(x1, z1) + 0.9, z1);
    const len = a.distanceTo(b);
    if (len < 0.2) return;
    const mat = additive(hdr(el, 1.2), 0.9);
    const m = new THREE.Mesh(BEAM, mat);
    m.scale.set(0.35, len, 0.35);
    m.position.copy(a).lerp(b, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    this.add(m, 0.4, (t) => {
      mat.opacity = 0.9 * (1 - t);
      m.scale.set(0.35 * (1 - t), len, 0.35 * (1 - t));
    });
  }

  /** Persistent effects that follow state: the hero's shield and buff aura, enemy statuses. */
  follow(
    hero: THREE.Vector3,
    shield: number,
    buff: Element | null,
    enemies: { x: number; z: number; y: number; stunned: boolean; slowed: boolean; burning: boolean }[],
  ) {
    this.shield.visible = shield > 0;
    if (shield > 0) {
      this.shield.position.set(hero.x, hero.y + 1.0, hero.z);
      (this.shield.material as THREE.ShaderMaterial).uniforms.uFade.value = 0.35 + 0.65 * shield;
    }
    this.aura.visible = !!buff;
    if (buff) {
      (this.aura.material as THREE.MeshBasicMaterial).color.copy(hdr(buff, 0.9));
      this.aura.position.set(hero.x, hero.y + 0.08, hero.z);
      this.aura.rotation.z = fx.time.value * 1.5;
      this.aura.scale.setScalar(1.05 + Math.sin(fx.time.value * 4) * 0.05);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    let s = 0;
    let w = 0;
    let b = 0;
    for (const e of enemies) {
      if (e.stunned && s < 64) {
        q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), fx.time.value * 4));
        this.stun.setMatrixAt(s++, m.compose(new THREE.Vector3(e.x, e.y + 2.5, e.z), q, new THREE.Vector3(1, 1, 1)));
      }
      if (e.slowed && w < 64) this.slow.setMatrixAt(w++, m.compose(new THREE.Vector3(e.x, e.y + 0.1, e.z), flat, new THREE.Vector3(0.8, 0.8, 0.8)));
      if (e.burning && b < 64) {
        const bob = Math.sin(fx.time.value * 9 + e.x) * 0.15;
        this.burn.setMatrixAt(b++, m.compose(new THREE.Vector3(e.x, e.y + 1.4 + bob, e.z), q.identity(), new THREE.Vector3(1, 1.4, 1)));
      }
    }
    for (const [mesh, n] of [[this.stun, s], [this.slow, w], [this.burn, b]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      const t = Math.min(1, it.age / it.life);
      it.tick(t, dt);
      if (t >= 1) {
        it.obj.removeFromParent();
        it.obj.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
          mat?.dispose();
        });
        it.done?.();
        this.items.splice(i, 1);
      }
    }
  }

  get active() {
    return this.items.length;
  }
}
