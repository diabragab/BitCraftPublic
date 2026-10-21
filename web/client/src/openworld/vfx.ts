// Combat effects: shockwave rings, slashes, projectiles with ember trails, lightning, meteors,
// light pillars, ice and thorn spikes, spinning blades, flying knives, scorch marks, heals,
// buff auras, the shield bubble and status markers. Colours are HDR (above 1.0), so bloom
// makes them glow. Sparks, embers and dust all go through one GPU particle system.
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
const BEAM = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
const SPIKE = new THREE.ConeGeometry(0.22, 1.5, 5);
const BLADE = new THREE.BoxGeometry(0.08, 0.04, 0.7);

/**
 * Sparks, embers, trails and dust: one Points object, simulated on the CPU (position,
 * velocity, gravity, drag) and drawn as soft additive discs with HDR colour.
 */
class Particles {
  readonly points: THREE.Points;
  private n = 0;
  private readonly max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private life: Float32Array;
  private age: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private geo = new THREE.BufferGeometry();

  constructor(max: number) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      name: 'hearthwild-particles',
      uniforms: { uScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 color;
        attribute float size;
        attribute float alpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  setScale(viewportHeight: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = viewportHeight * 0.5;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, size: number, life: number, gravity = -4, drag = 0.5) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.alpha[i] = 1;
    this.life[i] = life;
    this.age[i] = 0;
    this.grav[i] = gravity;
    this.drag[i] = drag;
  }

  update(dt: number) {
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        // swap the last live particle into this slot
        const last = --this.n;
        if (i !== last) {
          for (const [arr, w] of [[this.pos, 3], [this.vel, 3], [this.col, 3]] as const) arr.copyWithin(i * w, last * w, last * w + w);
          for (const arr of [this.size, this.alpha, this.life, this.age, this.grav, this.drag]) arr[i] = arr[last];
        }
        continue;
      }
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.age[i] / this.life[i];
      this.alpha[i] = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (const name of ['position', 'color', 'size', 'alpha']) this.geo.getAttribute(name).needsUpdate = true;
  }

  get count() {
    return this.n;
  }
}

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
  private particles = new Particles(2500);
  private shield: THREE.Mesh;
  private aura: THREE.Mesh;
  private stun: THREE.InstancedMesh;
  private slow: THREE.InstancedMesh;
  private burn: THREE.InstancedMesh;
  private auraEmit = 0;

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
    this.particles.setScale(window.innerHeight);
    window.addEventListener('resize', () => this.particles.setScale(window.innerHeight));
    scene.add(this.shield, this.aura, this.stun, this.slow, this.burn, this.particles.points);
  }

  private add(obj: THREE.Object3D, life: number, tick: Item['tick'], done?: () => void) {
    this.scene.add(obj);
    this.items.push({ obj, age: 0, life, tick, done });
  }

  private y(x: number, z: number) {
    return this.height(x, z);
  }

  /** Expanding ground ring, a soft flash and a burst of sparks: novas, impacts, taunts. */
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
    this.sparks(x, z, el, Math.round(14 + radius * 6), radius * 0.9);
  }

  /** Glowing sparks thrown out and up. */
  sparks(x: number, z: number, el: Element, count: number, spread = 1.5, rise = 2.6, y?: number) {
    const c = hdr(el, 1.4);
    const y0 = y ?? this.y(x, z) + 0.6;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = spread * (0.6 + Math.random() * 1.4);
      this.particles.emit(x, y0 + Math.random() * 0.5, z, Math.cos(a) * sp, rise * (0.4 + Math.random()), Math.sin(a) * sp,
        c, 0.12 + Math.random() * 0.12, 0.5 + Math.random() * 0.5, -6, 1.2);
    }
  }

  /** Dust kicked up on the ground (rolls, landings). */
  dust(x: number, z: number, count = 12) {
    const c = new THREE.Color(0.55, 0.5, 0.42);
    const y0 = this.y(x, z) + 0.15;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.particles.emit(x, y0, z, Math.cos(a) * 1.6, 0.6 + Math.random(), Math.sin(a) * 1.6, c, 0.4 + Math.random() * 0.3, 0.6, -0.5, 2.5);
    }
  }

  /** A sweeping arc in front of the caster (basic attacks, cones, cleaves, bashes). */
  slash(x: number, z: number, facing: number, range: number, arc: number, el: Element, strength = 1) {
    const mat = additive(hdr(el, strength), 0.85);
    // a crescent rather than a filled fan: bright at the blade's edge only
    const geo = new THREE.RingGeometry(range * 0.68, range, 32, 1, -arc, arc * 2);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    // RingGeometry's angle 0 points along +x; turn it to face `facing` (0 = +z)
    m.rotation.z = facing - Math.PI / 2;
    m.position.set(x, this.y(x, z) + 0.8, z);
    this.add(m, 0.22 + 0.08 * strength, (t) => {
      mat.opacity = 0.85 * (1 - t);
      m.rotation.z = facing - Math.PI / 2 + (t - 0.5) * 0.5;
      m.scale.setScalar(0.85 + 0.2 * t);
    }, () => geo.dispose());
    // sparks along the edge of the arc
    const c = hdr(el, 1.5);
    for (let i = 0; i < 8 * strength; i++) {
      const a = facing + (Math.random() * 2 - 1) * arc;
      const px = x + Math.sin(a) * range;
      const pz = z + Math.cos(a) * range;
      this.particles.emit(px, this.y(px, pz) + 0.8, pz, Math.sin(a) * 2, 1 + Math.random(), Math.cos(a) * 2, c, 0.12, 0.4, -4, 2);
    }
  }

  /** A glowing orb flying from A to B, trailing embers; `onArrive` fires at B. */
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
    const trail = hdr(el, 1.2);
    this.add(g, life, (t) => {
      g.position.lerpVectors(from, to, t);
      halo.scale.setScalar(size * (2 + Math.sin(t * 30) * 0.3));
      for (let i = 0; i < 3; i++) {
        this.particles.emit(g.position.x + (Math.random() - 0.5) * size, g.position.y + (Math.random() - 0.5) * size, g.position.z + (Math.random() - 0.5) * size,
          (Math.random() - 0.5) * 0.8, 0.3 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8, trail, size * 0.6, 0.35, 0.5, 1.5);
      }
    }, onArrive);
  }

  /** Jagged lightning through a list of points, with a flash at every hit. */
  lightning(points: [number, number][], el: Element) {
    const mat = additive(hdr(el, 1.8), 1);
    const g = new THREE.Group();
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1];
      const [bx, bz] = points[i];
      let prev = new THREE.Vector3(ax, this.y(ax, az) + 1.1, az);
      const end = new THREE.Vector3(bx, this.y(bx, bz) + 1.0, bz);
      for (let k = 1; k <= 5; k++) {
        const p = prev.clone().lerp(end, 1 / (6 - k));
        if (k < 5) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.8));
        const len = prev.distanceTo(p);
        const seg = new THREE.Mesh(BEAM, mat);
        seg.scale.set(0.05, len, 0.05);
        seg.position.copy(prev).lerp(p, 0.5);
        seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().sub(prev).normalize());
        g.add(seg);
        prev = p;
      }
      this.sparks(bx, bz, el, 10, 1.4, 1.8, end.y);
    }
    this.add(g, 0.35, (t) => {
      mat.opacity = t < 0.5 ? 1 : 2 * (1 - t);
      g.visible = Math.random() > 0.15;
    });
  }

  /** A burning rock falling onto a marked circle. The impact itself comes as its own event. */
  meteor(tx: number, tz: number, radius: number, el: Element, delay: number) {
    const markMat = additive(hdr(el, 0.6), 0.2);
    const mark = new THREE.Mesh(RING, markMat);
    mark.rotation.x = -Math.PI / 2;
    mark.scale.setScalar(radius);
    mark.position.set(tx, this.y(tx, tz) + 0.12, tz);
    const rockMat = additive(hdr(el, 2), 1);
    const rock = new THREE.Mesh(ORB, rockMat);
    rock.scale.setScalar(0.65);
    const from = new THREE.Vector3(tx - 7, this.y(tx, tz) + 16, tz - 5);
    const to = new THREE.Vector3(tx, this.y(tx, tz) + 0.3, tz);
    const g = new THREE.Group();
    g.add(mark, rock);
    const trail = hdr(el, 1.3);
    this.add(g, delay / 1000, (t) => {
      rock.position.lerpVectors(from, to, t * t);
      rock.rotation.set(t * 9, t * 7, 0);
      markMat.opacity = 0.2 + 0.6 * t;
      mark.scale.setScalar(radius * (1.1 - 0.1 * t));
      for (let i = 0; i < 6; i++) {
        this.particles.emit(rock.position.x + (Math.random() - 0.5) * 0.8, rock.position.y + (Math.random() - 0.5) * 0.8, rock.position.z + (Math.random() - 0.5) * 0.8,
          (Math.random() - 0.5), 1 + Math.random(), (Math.random() - 0.5), trail, 0.45 + Math.random() * 0.3, 0.5, 0.5, 1);
      }
    });
  }

  /** The aftermath of a big impact: a scorched patch and drifting embers. */
  scorch(x: number, z: number, radius: number, el: Element = 'fire') {
    const mat = new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.55, depthWrite: false });
    const m = new THREE.Mesh(DISC, mat);
    m.rotation.x = -Math.PI / 2;
    m.scale.setScalar(radius * 0.8);
    m.position.set(x, this.y(x, z) + 0.05, z);
    const ember = hdr(el, 1.2);
    this.add(m, 5, (t, dt) => {
      mat.opacity = 0.55 * (1 - t);
      if (t < 0.6 && Math.random() < dt * 30) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * radius * 0.7;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        this.particles.emit(px, this.y(px, pz) + 0.1, pz, 0, 0.6 + Math.random() * 0.8, 0, ember, 0.1, 1.2, 0.3, 0.5);
      }
    });
  }

  /** A pillar of light slamming down (Judgement, Thunderclap). */
  pillar(x: number, z: number, el: Element, radius = 1.4) {
    const mat = additive(hdr(el, 1.1), 0.9);
    const beam = new THREE.Mesh(BEAM, mat);
    const y0 = this.y(x, z);
    this.add(beam, 0.6, (t) => {
      const w = radius * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
      beam.scale.set(Math.max(0.01, w), 14, Math.max(0.01, w));
      beam.position.set(x, y0 + 7, z);
      mat.opacity = 0.9 * (1 - t);
    });
    this.sparks(x, z, el, 30, 3, 4);
  }

  /** Spikes bursting out of the ground in a circle (ice for Frost Nova, thorns, bone). */
  spikes(x: number, z: number, radius: number, el: Element, count = 16) {
    const mat = additive(hdr(el, 1.0), 0.9);
    const g = new THREE.Group();
    const spikes: { m: THREE.Mesh; y0: number; h: number }[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const r = radius * (0.45 + Math.random() * 0.5);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const m = new THREE.Mesh(SPIKE, mat);
      const h = 0.7 + Math.random() * 0.8;
      m.scale.set(1, h, 1);
      m.rotation.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5);
      m.position.set(px, this.y(px, pz) - 1.2, pz);
      g.add(m);
      spikes.push({ m, y0: this.y(px, pz), h });
    }
    this.add(g, 0.9, (t) => {
      // shoot up fast, hold, sink
      const rise = t < 0.12 ? t / 0.12 : t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      for (const s of spikes) s.m.position.y = s.y0 - 1.2 + rise * (0.6 + s.h * 0.6);
      mat.opacity = t < 0.6 ? 0.9 : 0.9 * (1 - (t - 0.6) / 0.4);
    });
    this.sparks(x, z, el, 20, radius * 0.6, 2);
  }

  /** Blades whirling around a moving centre (Whirlwind). */
  spin(center: () => THREE.Vector3, radius: number, el: Element, seconds = 0.7) {
    const mat = additive(hdr(el, 1.4), 1);
    const g = new THREE.Group();
    const blades: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(BLADE, mat);
      b.scale.set(1.2, 1, radius * 0.9);
      blades.push(b);
      g.add(b);
    }
    const ringMat = additive(hdr(el, 0.8), 0.7);
    const ring = new THREE.Mesh(RING, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.scale.setScalar(radius);
    g.add(ring);
    const c = hdr(el, 1.3);
    this.add(g, seconds, (t) => {
      const p = center();
      g.position.set(p.x, p.y + 0.9, p.z);
      ring.position.y = -0.8;
      const a0 = t * Math.PI * 7;
      blades.forEach((b, i) => {
        const a = a0 + (i * Math.PI) / 2;
        b.position.set(Math.sin(a) * radius * 0.55, 0, Math.cos(a) * radius * 0.55);
        b.rotation.y = a;
      });
      mat.opacity = t < 0.8 ? 1 : (1 - t) * 5;
      ringMat.opacity = 0.7 * (1 - t);
      const a = a0 + Math.random() * Math.PI * 2;
      this.particles.emit(p.x + Math.sin(a) * radius, p.y + 0.9, p.z + Math.cos(a) * radius, Math.cos(a) * 3, 0.5, -Math.sin(a) * 3, c, 0.15, 0.35, -2, 2);
    });
  }

  /** Knives flying out in every direction (Fan of Knives). */
  knives(x: number, z: number, radius: number, el: Element = 'steel', count = 16) {
    const mat = additive(hdr(el, 1.5), 1);
    const g = new THREE.Group();
    const y0 = this.y(x, z) + 1;
    for (let i = 0; i < count; i++) {
      const b = new THREE.Mesh(BLADE, mat);
      b.rotation.y = (i / count) * Math.PI * 2;
      g.add(b);
    }
    g.position.set(x, y0, z);
    this.add(g, 0.35, (t) => {
      g.children.forEach((b) => {
        const a = b.rotation.y;
        b.position.set(Math.sin(a) * radius * t, 0, Math.cos(a) * radius * t);
      });
      mat.opacity = 1 - t * t;
    });
  }

  /** Light column and rising motes: buffs, heals, summons. */
  column(x: number, z: number, el: Element, heal = false) {
    const mat = additive(hdr(el, 0.45), 0.5);
    const beam = new THREE.Mesh(BEAM, mat);
    beam.scale.set(0.9, 4, 0.9);
    beam.position.set(x, this.y(x, z) + 2, z);
    this.add(beam, 0.7, (t) => {
      mat.opacity = 0.5 * (1 - t);
      beam.scale.set(0.9 + t * 0.6, 4, 0.9 + t * 0.6);
    });
    // a rising spiral of motes
    const c = hdr(el, 1.3);
    const y0 = this.y(x, z);
    for (let i = 0; i < (heal ? 28 : 20); i++) {
      const a = (i / 7) * Math.PI;
      this.particles.emit(x + Math.cos(a) * 0.8, y0 + 0.2 + i * 0.05, z + Math.sin(a) * 0.8, -Math.sin(a) * 1.2, 2 + Math.random(), Math.cos(a) * 1.2, c, 0.16, 0.9, 0, 0.8);
    }
    this.ring(x, z, 1.8, el, 0.5);
  }

  /** A streak along a dash or roll. */
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
    const c = hdr(el, 1.2);
    for (let i = 0; i < 16; i++) {
      const p = a.clone().lerp(b, i / 15);
      this.particles.emit(p.x, p.y, p.z, (Math.random() - 0.5), 0.5 + Math.random(), (Math.random() - 0.5), c, 0.14, 0.5, -1, 1);
    }
  }

  /** Persistent effects that follow state: the hero's shield and buff aura, enemy statuses. */
  follow(
    hero: THREE.Vector3,
    shield: number,
    buff: Element | null,
    enemies: { x: number; z: number; y: number; stunned: boolean; slowed: boolean; burning: boolean }[],
    dt = 0,
  ) {
    this.shield.visible = shield > 0;
    if (shield > 0) {
      this.shield.position.set(hero.x, hero.y + 1.0, hero.z);
      (this.shield.material as THREE.ShaderMaterial).uniforms.uFade.value = 0.35 + 0.65 * shield;
    }
    this.aura.visible = !!buff;
    if (buff) {
      const c = hdr(buff, 0.9);
      (this.aura.material as THREE.MeshBasicMaterial).color.copy(c);
      this.aura.position.set(hero.x, hero.y + 0.08, hero.z);
      this.aura.rotation.z = fx.time.value * 1.5;
      this.aura.scale.setScalar(1.05 + Math.sin(fx.time.value * 4) * 0.05);
      // motes drifting up from the aura
      this.auraEmit += dt * 14;
      for (; this.auraEmit >= 1; this.auraEmit--) {
        const a = Math.random() * Math.PI * 2;
        this.particles.emit(hero.x + Math.cos(a) * 0.9, hero.y + 0.1, hero.z + Math.sin(a) * 0.9, 0, 1.2 + Math.random(), 0, c, 0.1, 0.8, 0, 0.5);
      }
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
        if (Math.random() < dt * 12) this.particles.emit(e.x, e.y + 1.2, e.z, 0, 1.5, 0, hdr('fire', 1.2), 0.14, 0.5, 0.5, 1);
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
    this.particles.update(dt);
  }

  get active() {
    return this.items.length + this.particles.count;
  }
}
