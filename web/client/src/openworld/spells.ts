/*!
 * Spell effects by rollshade 0.6.0 (https://rollshade.tsuyatt.com/), Copyright (c) 2026 tsuyatt,
 * MIT License; its noise functions are ported from psrdnoise, Copyright (c) 2021 Stefan Gustavson
 * and Ian McEwan, MIT License. Licence text: assets/licenses/rollshade-0.6.0.LICENSE.txt
 */
// Combat effects, played by rollshade (https://rollshade.tsuyatt.com, MIT): every skill is a
// rollshade move (SKILL_LOOKS in content.ts says which), enemy burns, slows and stuns are
// statuses on the enemy model, the Arcane Shield is a status on the hero, buffs are an aura
// loop, and the fallen burn away with the dissolve status. This module only turns game events
// into rollshade calls; the sim decides what is hit and for how much.
import * as THREE from 'three/webgpu';
import { effect, type EffectDef, type FXHandle, type FXSystem, type FixtureRun, type RecipeName, type StatusName, type StatusRun } from 'rollshade';
import { FX_ELEMENT, SKILL_LOOKS, type Element } from './content';

/** Characters are about 1.8 m tall: effects start and land at chest height. */
const CHEST = 1.05;

/** A move's definition, cached so a cast allocates nothing new for its look. */
const defs = new Map<string, EffectDef>();
function look(recipe: RecipeName, el: Element, o: { element?: string; color?: number; params?: Record<string, number> } = {}) {
  const fe = FX_ELEMENT[el];
  const element = (o.element ?? fe.element) as EffectDef['element'];
  const color = o.color ?? (o.element ? undefined : fe.color);
  const key = `${recipe}|${element}|${color ?? ''}|${JSON.stringify(o.params ?? {})}`;
  let def = defs.get(key);
  if (!def) {
    def = effect(recipe as RecipeName, element as never, { id: `hw-${defs.size}`, ...(color !== undefined ? { color } : {}), ...(o.params ? { params: o.params } : {}) });
    defs.set(key, def);
  }
  return def;
}

/** Statuses we keep in step with the sim, per enemy. */
type Kept = 'burn' | 'freeze' | 'stun';

export class Spells {
  private statuses = new Map<THREE.Object3D, Map<Kept, StatusRun>>();
  private shield: StatusRun | null = null;
  private aura: FixtureRun | null = null;
  private auraElement: Element | null = null;
  private dissolves = 0;
  /** Statuses started per name, for tests (a short stun can start and end between two slow frames). */
  private started: Record<string, number> = {};
  private shieldTarget = 0;

  constructor(private fx: FXSystem, private height: (x: number, z: number) => number) {}

  /** A point at chest height above the ground. */
  at(x: number, z: number, lift = CHEST) {
    return new THREE.Vector3(x, this.height(x, z) + lift, z);
  }

  /** A chest-height anchor that follows a character (moves read anchors every frame). */
  static anchor(root: THREE.Object3D, lift = CHEST) {
    const a = new THREE.Object3D();
    a.position.y = lift / Math.max(1e-3, root.scale.y);
    a.name = 'fx-anchor';
    root.add(a);
    return a;
  }

  /** Ground height under a point or an object. */
  private ground(a: THREE.Vector3 | THREE.Object3D) {
    const p = a instanceof THREE.Vector3 ? a : a.getWorldPosition(new THREE.Vector3());
    return this.height(p.x, p.z);
  }

  play(def: EffectDef, from: THREE.Vector3 | THREE.Object3D, to: THREE.Vector3 | THREE.Object3D, o: { scale?: number; floorY?: number } = {}): FXHandle {
    return this.fx.play(def, { from, to, scale: o.scale, floorY: o.floorY ?? this.ground(to) });
  }

  /**
   * One skill cast. `caster` is the caster's chest anchor; `target` where it lands (a point
   * from the sim, or the caster for self buffs).
   */
  skill(id: string, el: Element, caster: THREE.Object3D, target: { x: number; z: number } | null, facing: number, radius = 3, start?: { x: number; z: number }, ally?: THREE.Object3D) {
    const l = SKILL_LOOKS[id];
    if (!l) return null;
    const def = look(l.recipe, el, l);
    const origin = caster.getWorldPosition(new THREE.Vector3());
    // melee moves expect the target about 2 m ahead; with none, aim 2 m ahead
    const ahead = (d: number) => this.at(origin.x + Math.sin(facing) * d, origin.z + Math.cos(facing) * d);
    let to: THREE.Vector3;
    switch (l.recipe) {
      case 'buff':
        return this.play(def, caster, caster);
      case 'heal':
        // light flies from the caster to the one it heals (the hero, for pets' heals too)
        return this.play(def, caster, ally ?? caster);
      case 'nova':
        // the ring is centred on the caster's feet and reaches 1.2 m past `to`
        to = ahead(Math.max(0.5, radius - 1.2));
        return this.play(def, caster, to, { floorY: this.ground(caster) });
      case 'dash':
      case 'tackle':
        // the sim has already moved the caster: charge from where the dash started
        if (start && target) return this.play(def, this.at(start.x, start.z), this.at(target.x, target.z), { scale: l.scale });
        break;
      case 'spin':
        return this.play(def, caster, ahead(2), { scale: l.scale });
      default:
        to = target ? this.at(target.x, target.z) : ahead(l.recipe === 'projectile' || l.recipe === 'lance' ? 8 : 2);
        return this.play(def, caster, to, { scale: l.scale });
    }
  }

  /** Lightning that jumps along `points` (ground x/z), one lance per jump. */
  chain(el: Element, caster: THREE.Object3D, points: [number, number][]) {
    const def = look('lance', el);
    for (let i = 1; i < points.length; i++) {
      const from = i === 1 ? caster : this.at(points[i - 1][0], points[i - 1][1]);
      this.play(def, from, this.at(points[i][0], points[i][1]), { scale: 0.8 });
    }
  }

  /** A hero's basic swing (or the finisher of a combo) toward a point `range` ahead. */
  swing(el: Element, caster: THREE.Object3D, facing: number, range: number, finisher: boolean) {
    const o = caster.getWorldPosition(new THREE.Vector3());
    const to = this.at(o.x + Math.sin(facing) * range, o.z + Math.cos(facing) * range);
    return this.play(look(finisher ? 'cross' : 'swipe', el), caster, to, { scale: finisher ? 1.1 : 0.85 });
  }

  /** A spell shot (ranged finishers, sprite pets' attacks). */
  shot(el: Element, from: THREE.Object3D, to: THREE.Vector3 | THREE.Object3D, scale = 0.6) {
    return this.play(look('lance', el), from, to, { scale });
  }

  /** Dust and speed lines along a dodge roll. */
  dodge(el: Element, caster: THREE.Object3D, x: number, z: number, facing: number) {
    const to = this.at(x + Math.sin(facing) * 4.5, z + Math.cos(facing) * 4.5);
    return this.play(look('tackle', el, { element: 'wind', color: FX_ELEMENT[el].color }), caster, to, { scale: 0.6 });
  }

  /** A burst on a pet when it is summoned or gets back up. */
  burst(el: Element, anchor: THREE.Object3D) {
    return this.play(look('buff', el), anchor, anchor, { scale: 0.7 });
  }

  // ---- statuses

  /**
   * Keeps an enemy's burn, slow (a partial freeze) and stun statuses in step with the sim. Call
   * every frame for every visible, living enemy; statuses are never restarted while they run.
   */
  reconcile(root: THREE.Object3D, want: Record<Kept, boolean>) {
    let runs = this.statuses.get(root);
    for (const name of ['burn', 'freeze', 'stun'] as Kept[]) {
      const run = runs?.get(name);
      if (want[name] && !run?.alive) {
        if (!runs) this.statuses.set(root, (runs = new Map()));
        this.started[name] = (this.started[name] ?? 0) + 1;
        runs.set(name, this.fx.status(root, name as StatusName, name === 'freeze' ? { progress: 0.35, duration: 0.5 } : {}));
      } else if (!want[name] && run) {
        run.stop();
        runs!.delete(name);
      }
    }
  }

  /** Ends an enemy's statuses (it died, or went out of view). */
  clear(root: THREE.Object3D) {
    const runs = this.statuses.get(root);
    if (!runs) return;
    for (const run of runs.values()) run.stop(0);
    this.statuses.delete(root);
  }

  /** Burns a fallen enemy away; `gone` runs once it has vanished. */
  dissolve(root: THREE.Object3D, gone: () => void) {
    this.clear(root);
    this.dissolves++;
    this.fx.status(root, 'dissolve', { duration: 1.3 }).on('full', gone);
  }

  /** A respawned enemy fades back in (call after it is back in the scene, before rendering). */
  appear(root: THREE.Object3D) {
    this.fx.status(root, 'appear');
  }

  /** The Arcane Shield bubble on the hero, `amount` 0-1 of what is left. */
  heroShield(root: THREE.Object3D, amount: number, el: Element) {
    if (amount > 0) {
      if (!this.shield?.alive) this.shield = this.fx.status(root, 'shield', { element: FX_ELEMENT[el].element, progress: amount });
      else if (Math.abs(this.shieldTarget - amount) > 0.01) this.shield.to(amount, 0.2);
      this.shieldTarget = amount;
    } else if (this.shield) {
      this.shield.stop(); // it shatters
      this.shield = null;
    }
  }

  /** A ripple where the shield took a hit, from the direction of `from`. */
  shieldHit(from: { x: number; z: number }) {
    if (this.shield?.alive) this.shield.impact(this.at(from.x, from.z));
  }

  /** The aura of the newest buff on the hero, or none. */
  heroAura(root: THREE.Object3D, el: Element | null) {
    if (el === this.auraElement) return;
    this.aura?.stop();
    this.aura = null;
    this.auraElement = el;
    if (!el) return;
    const fe = FX_ELEMENT[el];
    this.aura = this.fx.loop('aura', root, { element: fe.element, ...(fe.color !== undefined ? { color: fe.color } : {}), light: false, intensity: 0.6 });
  }

  /** Compiles the statuses used on this kind of model, so the first one does not stutter. */
  prewarmStatuses(model: THREE.Object3D, names: StatusName[]) {
    return this.fx.prewarmStatus(model, names);
  }

  /** Counts for the stats line and tests. */
  stats() {
    return { ...this.fx.stats(), enemyStatuses: [...this.statuses.values()].reduce((n, m) => n + m.size, 0), dissolves: this.dissolves, started: { ...this.started }, shield: !!this.shield?.alive, aura: this.auraElement };
  }
}
