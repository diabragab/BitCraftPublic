// How pets look: the Skeleton Squire is the KayKit skeleton minion, smaller and with a faint
// spectral glow; the sprites are procedural glowing spirits (HDR core, halo, orbiting motes).
import * as THREE from 'three';
import { CharacterView } from '../entities';
import { ELEMENTS, PETS, type PetSpecies } from './content';

const smooth = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export class PetView {
  readonly root = new THREE.Group();
  readonly plate: HTMLDivElement;
  private plateFill: HTMLDivElement;
  private skeleton: CharacterView | null = null;
  private body: THREE.Group | null = null;
  private core: THREE.Mesh | null = null;
  private motes: THREE.Mesh[] = [];
  private t = Math.random() * 10;
  private pulse = 0;
  private seen = { attack: 0, hit: 0 };
  target = new THREE.Vector3();
  facing = 0;
  moving = false;
  private down = false;

  constructor(readonly species: PetSpecies, label: string) {
    const def = PETS[species];
    const hdr = new THREE.Color(...ELEMENTS[def.element].hdr);
    if (def.look === 'skeleton') {
      this.skeleton = new CharacterView('skeleton_minion', { attackClip: '1H_Melee_Attack_Chop', right: 'skeleton_blade', label, plateClass: 'pet' });
      this.skeleton.root.scale.setScalar(0.72);
      // a faint ghostly glow, on this pet's own copies of the materials
      this.skeleton.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.emissive = hdr.clone().multiplyScalar(0.12);
        m.material = mat;
      });
      this.root.add(this.skeleton.root);
      this.plate = this.skeleton.plate;
      this.plateFill = this.plate.querySelector('.mini > div') as HTMLDivElement;
    } else {
      this.body = new THREE.Group();
      this.core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.26, 0),
        new THREE.MeshStandardMaterial({ color: '#111', emissive: hdr, emissiveIntensity: 1.4, flatShading: true, roughness: 0.4 }),
      );
      const halo = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.5, 2),
        new THREE.MeshBasicMaterial({ color: hdr.clone().multiplyScalar(0.25), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.body.add(this.core, halo);
      const moteMat = new THREE.MeshBasicMaterial({ color: hdr.clone().multiplyScalar(1.4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), moteMat);
        this.motes.push(m);
        this.body.add(m);
      }
      this.body.scale.setScalar(1.45);
      this.root.add(this.body);
      this.plate = document.createElement('div');
      this.plate.className = 'nameplate pet';
      this.plate.innerHTML = `<div class="label"></div><div class="mini"><div></div></div>`;
      (this.plate.querySelector('.label') as HTMLDivElement).textContent = label;
      this.plateFill = this.plate.querySelector('.mini > div') as HTMLDivElement;
      document.body.appendChild(this.plate);
    }
  }

  setLabel(text: string) {
    (this.plate.querySelector('.label') as HTMLDivElement).textContent = text;
  }

  setHealth(hp: number, max: number) {
    this.plateFill.style.width = `${Math.max(0, (hp / Math.max(1, max)) * 100)}%`;
  }

  snap() {
    this.root.position.copy(this.target);
    this.skeleton?.target.copy(this.target);
    this.skeleton?.snap();
  }

  /** `seq` counters come from the simulation: a change means a new attack or hit. */
  update(dt: number, alive: boolean, attackSeq: number, hitSeq: number) {
    this.t += dt;
    if (alive !== !this.down) {
      this.down = !alive;
      if (this.skeleton) this.skeleton.setAlive(alive);
      else this.root.visible = alive;
      if (alive) this.snap();
    }
    if (this.skeleton) {
      this.skeleton.target.copy(this.target);
      this.skeleton.targetFacing = this.facing;
      this.skeleton.moving = this.moving;
      if (attackSeq !== this.seen.attack) this.skeleton.play('1H_Melee_Attack_Chop');
      else if (hitSeq !== this.seen.hit && alive) this.skeleton.play('Hit_A');
      this.skeleton.update(dt);
      this.root.position.set(0, 0, 0);
    } else if (this.body && this.core) {
      if (this.root.position.distanceTo(this.target) > 6) this.root.position.copy(this.target);
      else this.root.position.lerp(this.target, smooth(8, dt));
      if (attackSeq !== this.seen.attack) this.pulse = 1;
      this.pulse = Math.max(0, this.pulse - dt * 4);
      this.body.position.y = 1.3 + Math.sin(this.t * 2.6) * 0.18;
      this.core.rotation.set(this.t * 1.3, this.t * 1.9, 0);
      this.core.scale.setScalar(1 + this.pulse * 0.6);
      (this.core.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.4 + this.pulse * 2.5;
      this.motes.forEach((m, i) => {
        const a = this.t * (2 + i * 0.3) + (i * Math.PI) / 2;
        m.position.set(Math.cos(a) * 0.55, Math.sin(this.t * 3 + i) * 0.25, Math.sin(a) * 0.55);
      });
    }
    this.seen = { attack: attackSeq, hit: hitSeq };
  }

  /** World position of the glowing part (where its bolts come from). */
  get position() {
    return this.skeleton ? this.skeleton.root.position : this.root.position;
  }

  placePlate(camera: THREE.Camera, w: number, h: number) {
    if (this.skeleton) return this.skeleton.placePlate(camera, w, h);
    const p = this.root.position.clone();
    p.y += 2.4;
    p.project(camera);
    if (this.down || p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) {
      this.plate.style.visibility = 'hidden';
      return;
    }
    this.plate.style.visibility = '';
    this.plate.style.left = `${((p.x + 1) / 2) * w}px`;
    this.plate.style.top = `${((1 - p.y) / 2) * h}px`;
  }

  dispose() {
    if (this.skeleton) this.skeleton.dispose();
    else this.plate.remove();
    this.root.removeFromParent();
  }
}
