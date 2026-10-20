import * as THREE from 'three';
import { cloneCharacter, cloneProp } from './assets';

const ENEMY_MODELS: Record<string, { model: string; right?: string; left?: string; attack: string }> = {
  minion: { model: 'skeleton_minion', right: 'skeleton_blade', attack: '1H_Melee_Attack_Chop' },
  warrior: { model: 'skeleton_warrior', right: 'skeleton_axe', left: 'skeleton_shield_small_a', attack: '1H_Melee_Attack_Chop' },
  rogue: { model: 'skeleton_rogue', right: 'skeleton_blade', attack: '1H_Melee_Attack_Chop' },
  mage: { model: 'skeleton_mage', right: 'skeleton_staff', attack: 'Spellcast_Shoot' },
};

/** Exponential smoothing factor for a given responsiveness (1/s) and frame time. */
const smooth = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** An animated character driven by server state. */
export class CharacterView {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private base = 'Idle';
  private oneShot: THREE.AnimationAction | null = null;
  private dead = false;
  readonly attackClip: string;
  target = new THREE.Vector3();
  targetFacing = 0;
  moving = false;
  plate: HTMLDivElement;
  private plateFill: HTMLDivElement;

  constructor(model: string, opts: { attackClip: string; right?: string; left?: string; label: string; plateClass: string }) {
    const { root, clips } = cloneCharacter(model);
    this.root.add(root);
    this.attackClip = opts.attackClip;
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
    for (const [slot, weapon] of [['handslot.r', opts.right], ['handslot.l', opts.left]] as const) {
      if (!weapon) continue;
      const bone = root.getObjectByName(slot);
      if (bone) bone.add(cloneProp(`weapons/${weapon}`));
    }
    this.mixer.addEventListener('finished', (e) => {
      if (e.action === this.oneShot) {
        this.oneShot = null;
        if (!this.dead) this.fadeTo(this.base);
      }
    });
    this.actions.get('Idle')?.play();

    this.plate = document.createElement('div');
    this.plate.className = `nameplate ${opts.plateClass}`;
    this.plate.innerHTML = `<div class="label"></div><div class="mini"><div></div></div>`;
    (this.plate.querySelector('.label') as HTMLDivElement).textContent = opts.label;
    this.plateFill = this.plate.querySelector('.mini > div') as HTMLDivElement;
    document.body.appendChild(this.plate);
  }

  private fadeTo(name: string, duration = 0.2) {
    const next = this.actions.get(name);
    if (!next) return;
    for (const [n, a] of this.actions) if (n !== name && a.isRunning()) a.fadeOut(duration);
    next.reset().fadeIn(duration).play();
  }

  play(name: string) {
    const a = this.actions.get(name);
    if (!a || this.dead) return;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = false;
    this.oneShot = a;
    this.fadeTo(name, 0.08);
  }

  setHealth(hp: number, max: number) {
    this.plateFill.style.width = `${Math.max(0, (hp / Math.max(1, max)) * 100)}%`;
  }

  setAlive(alive: boolean) {
    if (alive === !this.dead) return;
    this.dead = !alive;
    if (this.dead) {
      const a = this.actions.get('Death_A');
      if (a) {
        for (const x of this.actions.values()) x.fadeOut(0.1);
        a.reset().setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        a.fadeIn(0.1).play();
      }
      this.plate.style.display = 'none';
    } else {
      this.oneShot = null;
      this.base = '';
      this.plate.style.display = '';
      this.snap();
      if (this.actions.has('Spawn_Ground_Skeletons')) this.play('Spawn_Ground_Skeletons');
      else this.fadeTo('Idle', 0.1);
    }
  }

  snap() {
    this.root.position.copy(this.target);
    this.root.rotation.y = this.targetFacing;
  }

  /** Smoothly follows the server position (remote entities). */
  update(dt: number, follow = true) {
    if (follow) {
      const d = this.root.position.distanceTo(this.target);
      if (d > 4) this.snap();
      else this.root.position.lerp(this.target, smooth(14, dt));
    }
    this.root.rotation.y = lerpAngle(this.root.rotation.y, this.targetFacing, smooth(16, dt));
    const wanted = this.moving ? 'Running_A' : 'Idle';
    if (!this.dead && wanted !== this.base) {
      this.base = wanted;
      if (!this.oneShot) this.fadeTo(wanted);
    }
    this.mixer.update(dt);
  }

  placePlate(camera: THREE.Camera, w: number, h: number) {
    const p = this.root.position.clone();
    p.y += 2.9;
    p.project(camera);
    if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) {
      this.plate.style.visibility = 'hidden';
      return;
    }
    this.plate.style.visibility = '';
    this.plate.style.left = `${((p.x + 1) / 2) * w}px`;
    this.plate.style.top = `${((1 - p.y) / 2) * h}px`;
  }

  dispose() {
    this.plate.remove();
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}

export function createEnemyView(kind: string) {
  const def = ENEMY_MODELS[kind] ?? ENEMY_MODELS.minion;
  const label = `Skeleton ${kind[0].toUpperCase()}${kind.slice(1)}`;
  return new CharacterView(def.model, { attackClip: def.attack, right: def.right, left: def.left, label, plateClass: 'enemy' });
}

/** Spinning potion / gold pickup. */
export class PickupView {
  readonly root = new THREE.Group();
  private t = Math.random() * 10;
  constructor(kind: string) {
    const model = cloneProp(kind === 'potion' ? 'dungeon/bottle_A_green' : 'dungeon/coin_stack_small');
    model.scale.setScalar(kind === 'potion' ? 1.4 : 1.1);
    this.root.add(model);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 24),
      new THREE.MeshBasicMaterial({ color: kind === 'potion' ? '#5fc46b' : '#f2c14e', transparent: true, opacity: 0.35, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    this.root.add(glow);
  }
  update(dt: number) {
    this.t += dt;
    const model = this.root.children[0];
    model.rotation.y = this.t * 1.5;
    model.position.y = 0.15 + Math.sin(this.t * 3) * 0.12;
  }
}

/** Short-lived magic bolt drawn for mage attacks (purely visual; hits are server-side). */
export class Bolt {
  readonly mesh: THREE.Mesh;
  private travelled = 0;
  constructor(from: THREE.Vector3, private dir: THREE.Vector3, private range: number, color: string) {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color }));
    this.mesh.position.copy(from).add(new THREE.Vector3(0, 1.3, 0));
  }
  /** Returns false when finished. */
  update(dt: number) {
    const step = 26 * dt;
    this.travelled += step;
    this.mesh.position.addScaledVector(this.dir, step);
    return this.travelled < this.range;
  }
}
