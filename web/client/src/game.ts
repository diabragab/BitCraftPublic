import * as THREE from 'three';
import { Bolt, CharacterView, PickupView, createEnemyView } from './entities';
import { Input } from './input';
import { CLASSES, MAP, slide, type ClassId } from './map';
import type { DbConnection } from './module_bindings';
import type { Backend } from './backend';
import type { WorldView } from './world';

type Conn = DbConnection;
type PlayerRow = NonNullable<ReturnType<Conn['db']['player']['identity']['find']>>;
type EnemyRow = NonNullable<ReturnType<Conn['db']['enemy']['id']['find']>>;
type PickupRow = NonNullable<ReturnType<Conn['db']['pickup']['id']['find']>>;
type EventRow = Parameters<Parameters<Conn['db']['combatEvent']['onInsert']>[0]>[1];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const smooth = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const nowMicros = () => BigInt(Date.now()) * 1000n;

export class Game {
  private players = new Map<string, { view: CharacterView; row: PlayerRow }>();
  private enemies = new Map<number, { view: CharacterView; row: EnemyRow }>();
  private pickups = new Map<number, PickupView>();
  private bolts: Bolt[] = [];
  private me: PlayerRow | null = null;
  private predicted = new THREE.Vector3();
  private facing = Math.PI;
  private lastSent = { x: 0, z: 0, at: 0 };
  private lastAttackAt = 0;
  private lastPotionAt = 0;
  private camTarget = new THREE.Vector3();
  private zoom = 1;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private conn: Conn | null = null;
  private toastTimer = 0;
  active = false;
  onLeft: () => void = () => {};

  constructor(private world: WorldView, private net: Backend, private input: Input, private portraits: Record<string, string>) {
    input.onMoveChange = () => {
      if (this.canAct()) this.sendInput(this.input.move().x, this.input.move().z);
    };
    input.onAction = () => {
      if (!this.canAct()) return;
      if (this.input.wantsAttack()) this.tryAttack();
      if (this.input.wantsPotion()) this.tryPotion();
    };
    window.addEventListener('wheel', (e) => {
      if (this.active) this.zoom = THREE.MathUtils.clamp(this.zoom + Math.sign(e.deltaY) * 0.1, 0.7, 1.5);
    }, { passive: true });
  }

  private canAct() {
    return this.active && !!this.me && this.me.alive && !!this.conn;
  }

  get myIdentity() {
    return this.net.identity?.toHexString() ?? '';
  }

  /** (Re)binds to a fresh connection: rebuild every entity from the client cache. */
  attach(conn: Conn) {
    this.conn = conn;
    for (const p of this.players.values()) p.view.dispose();
    for (const e of this.enemies.values()) e.view.dispose();
    for (const p of this.pickups.values()) p.root.removeFromParent();
    this.players.clear();
    this.enemies.clear();
    this.pickups.clear();

    const db = conn.db;
    for (const p of db.player.iter()) this.upsertPlayer(p);
    for (const e of db.enemy.iter()) this.upsertEnemy(e);
    for (const p of db.pickup.iter()) this.upsertPickup(p);

    db.player.onInsert((_c, row) => this.upsertPlayer(row));
    db.player.onUpdate((_c, old, row) => this.upsertPlayer(row, old));
    db.player.onDelete((_c, row) => this.removePlayer(row.identity.toHexString()));
    db.enemy.onInsert((_c, row) => this.upsertEnemy(row));
    db.enemy.onUpdate((_c, old, row) => this.upsertEnemy(row, old));
    db.pickup.onInsert((_c, row) => this.upsertPickup(row));
    db.pickup.onUpdate((_c, _old, row) => this.upsertPickup(row));
    db.combatEvent.onInsert((_c, row) => this.onEvent(row));
  }

  // ---------------------------------------------------------------- entity sync

  private upsertPlayer(row: PlayerRow, old?: PlayerRow) {
    const id = row.identity.toHexString();
    const mine = id === this.myIdentity;
    if (mine) {
      const firstSight = !this.me || !this.me.inWorld;
      this.me = row;
      if (firstSight || !row.alive || (old && !old.alive && row.alive)) this.predicted.set(row.x, 0, row.z);
      this.updateHud();
    }
    const visible = row.inWorld && row.online;
    let entry = this.players.get(id);
    if (!visible) {
      if (entry) this.removePlayer(id);
      return;
    }
    if (!entry || (old && old.class !== row.class)) {
      if (entry) this.removePlayer(id);
      const cls = CLASSES[row.class as ClassId] ?? CLASSES.knight;
      const view = new CharacterView(row.class, { attackClip: cls.attackClip, label: row.username, plateClass: mine ? 'me' : 'ally' });
      view.target.set(row.x, 0, row.z);
      view.targetFacing = row.facing;
      view.snap();
      this.world.scene.add(view.root);
      entry = { view, row };
      this.players.set(id, entry);
    }
    const v = entry.view;
    v.target.set(row.x, 0, row.z);
    if (!mine) {
      v.targetFacing = row.facing;
      v.moving = row.moving;
    }
    v.setHealth(row.hp, row.maxHp);
    v.setAlive(row.alive);
    if (old) {
      if (row.attackSeq !== old.attackSeq && !mine) this.playAttack(v, row.class as ClassId, row.facing);
      if (row.hitSeq !== old.hitSeq && row.alive) v.play('Hit_A');
    }
    entry.row = row;
  }

  private removePlayer(id: string) {
    this.players.get(id)?.view.dispose();
    this.players.delete(id);
  }

  private upsertEnemy(row: EnemyRow, old?: EnemyRow) {
    let entry = this.enemies.get(row.id);
    if (!entry) {
      const view = createEnemyView(row.kind);
      view.target.set(row.x, 0, row.z);
      view.targetFacing = row.facing;
      view.snap();
      this.world.scene.add(view.root);
      entry = { view, row };
      this.enemies.set(row.id, entry);
    }
    const v = entry.view;
    v.target.set(row.x, 0, row.z);
    v.targetFacing = row.facing;
    v.moving = row.moving;
    v.setHealth(row.hp, row.maxHp);
    v.setAlive(row.alive);
    if (old && row.alive) {
      if (row.attackSeq !== old.attackSeq) {
        v.play(v.attackClip);
        if (row.kind === 'mage') this.spawnBolt(v.root.position, row.facing, 8, '#b06cff');
      } else if (row.hitSeq !== old.hitSeq) {
        v.play('Hit_A');
      }
    }
    entry.row = row;
  }

  private upsertPickup(row: PickupRow) {
    let view = this.pickups.get(row.id);
    if (!view) {
      view = new PickupView(row.kind);
      view.root.position.set(row.x, 0, row.z);
      this.world.scene.add(view.root);
      this.pickups.set(row.id, view);
    }
    view.root.visible = row.available;
  }

  private onEvent(e: EventRow) {
    // Ignore replayed history (e.g. after a reconnect).
    if (nowMicros() - e.at.microsSinceUnixEpoch > 3_000_000n) return;
    const pos = new THREE.Vector3(e.x, 2.2, e.z);
    switch (e.kind) {
      case 'damage':
        this.floatText(pos, `${e.amount}`, '');
        break;
      case 'crit':
        this.floatText(pos, `${e.amount}!`, 'crit');
        break;
      case 'player_damage':
        this.floatText(pos, `-${e.amount}`, 'player');
        break;
      case 'heal':
        this.floatText(pos, `+${e.amount}`, 'heal');
        break;
      case 'pickup':
        this.floatText(pos, e.text === 'potion' ? '+1 potion' : '+10 gold', 'heal');
        break;
    }
    if (e.text && e.kind !== 'pickup') this.feed(e.text);
  }

  // ---------------------------------------------------------------- actions

  private spawnBolt(from: THREE.Vector3, facing: number, range: number, color: string) {
    const bolt = new Bolt(from, new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), range, color);
    this.world.scene.add(bolt.mesh);
    this.bolts.push(bolt);
  }

  private playAttack(v: CharacterView, cls: ClassId, facing: number) {
    v.play(CLASSES[cls]?.attackClip ?? '1H_Melee_Attack_Chop');
    if (cls === 'mage') this.spawnBolt(v.root.position, facing, 10, '#7fd4ff');
  }

  private aimFacing(): number {
    if (this.input.lastDevice === 'mouse' && this.input.aimNdc) {
      this.raycaster.setFromCamera(new THREE.Vector2(this.input.aimNdc.x, this.input.aimNdc.y), this.world.camera);
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
        const dx = hit.x - this.predicted.x;
        const dz = hit.z - this.predicted.z;
        if (Math.hypot(dx, dz) > 0.3) return Math.atan2(dx, dz);
      }
    }
    // touch: auto-aim at the nearest living enemy in reach, otherwise keep facing.
    // Measured from the server's position of the hero, which is what the server validates against.
    const ox = this.me?.x ?? this.predicted.x;
    const oz = this.me?.z ?? this.predicted.z;
    let best: { d: number; f: number } | null = null;
    for (const { row } of this.enemies.values()) {
      if (!row.alive) continue;
      const dx = row.x - ox;
      const dz = row.z - oz;
      const d = Math.hypot(dx, dz);
      const reach = this.me && CLASSES[this.me.class as ClassId]?.ranged ? 10 : 3.5;
      if (d < reach && (!best || d < best.d)) best = { d, f: Math.atan2(dx, dz) };
    }
    return best?.f ?? this.facing;
  }

  private tryAttack() {
    const me = this.me;
    if (!me || !me.alive || !this.conn) return;
    const cls = CLASSES[me.class as ClassId];
    const now = performance.now();
    // small margin so the server-side cooldown check never rejects a well-timed click
    if (now - this.lastAttackAt < cls.cooldown + 40) return;
    this.lastAttackAt = now;
    this.facing = this.aimFacing();
    const view = this.players.get(this.myIdentity)?.view;
    if (view) {
      view.targetFacing = this.facing;
      this.playAttack(view, me.class as ClassId, this.facing);
    }
    this.conn.reducers.attack({ facing: this.facing }).catch((e: Error) => {
      if (!/cooldown/i.test(e.message)) this.toast(e.message);
    });
  }

  private tryPotion() {
    const now = performance.now();
    if (!this.conn || now - this.lastPotionAt < 400) return;
    this.lastPotionAt = now;
    this.conn.reducers.usePotion({}).catch((e: Error) => this.toast(e.message));
  }

  private sendInput(dx: number, dz: number) {
    if (!this.conn) return;
    const qx = Math.round(dx * 100) / 100;
    const qz = Math.round(dz * 100) / 100;
    const now = performance.now();
    const changed = qx !== this.lastSent.x || qz !== this.lastSent.z;
    // resend while moving so the server's 1s input timeout never stops us
    const heartbeat = (qx !== 0 || qz !== 0) && now - this.lastSent.at > 300;
    if (!changed && !heartbeat) return;
    this.lastSent = { x: qx, z: qz, at: now };
    this.conn.reducers.setInput({ dx: qx, dz: qz }).catch((e: Error) => console.warn('set_input rejected', e.message));
  }

  // ---------------------------------------------------------------- frame

  update(dt: number) {
    for (const b of [...this.bolts]) {
      if (!b.update(dt)) {
        b.mesh.removeFromParent();
        this.bolts.splice(this.bolts.indexOf(b), 1);
      }
    }
    for (const p of this.pickups.values()) p.update(dt);
    for (const { view } of this.enemies.values()) view.update(dt);

    const me = this.me;
    const myView = this.players.get(this.myIdentity)?.view;
    if (this.active && me && me.alive && this.conn) {
      const mv = this.input.move();
      this.sendInput(mv.x, mv.z);
      const cls = CLASSES[me.class as ClassId] ?? CLASSES.knight;
      const moving = mv.x !== 0 || mv.z !== 0;
      if (moving) {
        const [nx, nz] = slide(this.predicted.x, this.predicted.z, mv.x * cls.speed * dt, mv.z * cls.speed * dt, MAP.playerRadius);
        this.predicted.set(nx, 0, nz);
        this.facing = Math.atan2(mv.x, mv.z);
      }
      // Reconcile with the authoritative position. While moving the server trails us by
      // about one round trip, so only large errors are corrected; at rest we converge fully.
      const err = new THREE.Vector3(me.x - this.predicted.x, 0, me.z - this.predicted.z);
      const len = err.length();
      if (len > 3) this.predicted.set(me.x, 0, me.z);
      else if (!moving || len > 1.2) this.predicted.addScaledVector(err, smooth(moving ? 4 : 8, dt));
      if (this.input.wantsAttack()) this.tryAttack();
      if (this.input.wantsPotion()) this.tryPotion();
      if (myView) {
        myView.root.position.copy(this.predicted);
        myView.targetFacing = this.facing;
        myView.moving = moving;
      }
    } else if (this.active) {
      this.sendInput(0, 0);
    }
    for (const [id, { view }] of this.players) view.update(dt, id !== this.myIdentity || !me?.alive);

    // camera follow
    const focus = myView ? myView.root.position : this.camTarget;
    this.camTarget.lerp(focus, smooth(6, dt));
    const cam = this.world.camera;
    const portrait = window.innerWidth < window.innerHeight;
    const dist = (portrait ? 1.25 : 1) * this.zoom;
    cam.position.set(this.camTarget.x, 15 * dist, this.camTarget.z + 11 * dist);
    cam.lookAt(this.camTarget.x, 0.8, this.camTarget.z);
    this.world.sun.position.set(this.camTarget.x + 18, 30, this.camTarget.z + 12);
    this.world.sun.target.position.copy(this.camTarget);

    this.updateCooldown();
    this.updateRespawn();
  }

  placeOverlays() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const { view } of this.players.values()) view.placePlate(this.world.camera, w, h);
    for (const { view } of this.enemies.values()) view.placePlate(this.world.camera, w, h);
  }

  // ---------------------------------------------------------------- HUD

  private updateHud() {
    const me = this.me;
    if (!me) return;
    $('hud-name').textContent = `${me.username} · ${CLASSES[me.class as ClassId]?.label ?? me.class}`;
    $('hud-hp-fill').style.width = `${(me.hp / me.maxHp) * 100}%`;
    $('hud-hp-text').textContent = `${me.hp} / ${me.maxHp}`;
    $('hud-gold').textContent = String(me.gold);
    $('hud-kills').textContent = String(me.kills);
    $('hud-potions-touch').textContent = String(me.potions);
    $('hud-class').style.backgroundImage = this.portraits[me.class] ? `url(${this.portraits[me.class]})` : '';
    this.renderInventory();
  }

  renderInventory() {
    const me = this.me;
    const slots: [string, string, string][] = [
      ['🧪', 'Potion', `${me?.potions ?? 0}`],
      ['🪙', 'Gold', `${me?.gold ?? 0}`],
      ['⚔', 'Weapon', CLASSES[(me?.class ?? 'knight') as ClassId]?.label ?? ''],
    ];
    const el = $('inv-slots');
    el.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const s = slots[i];
      const d = document.createElement('div');
      d.className = 'slot';
      if (s) {
        d.title = s[1];
        d.textContent = s[0];
        const small = document.createElement('small');
        small.textContent = s[2];
        d.appendChild(small);
      }
      el.appendChild(d);
    }
  }

  private updateCooldown() {
    const me = this.me;
    if (!me) return;
    const cd = CLASSES[me.class as ClassId]?.cooldown ?? 600;
    const f = Math.min(1, (performance.now() - this.lastAttackAt) / cd);
    $('hud-cd-fill').style.width = `${f * 100}%`;
  }

  private updateRespawn() {
    const me = this.me;
    const el = $('respawn');
    if (!this.active || !me || me.alive) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const left = Number(me.respawnAt.microsSinceUnixEpoch - nowMicros()) / 1e6;
    $('respawn-time').textContent = String(Math.max(0, Math.ceil(left)));
  }

  drawMinimap() {
    const c = $<HTMLCanvasElement>('minimap');
    const g = c.getContext('2d')!;
    const s = c.width / (MAP.half * 2);
    const tx = (x: number) => (x + MAP.half) * s;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(106,168,79,0.35)';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(120,110,100,0.8)';
    g.fillRect(tx(-MAP.keep), tx(-MAP.keep), MAP.keep * 2 * s, MAP.keep * 2 * s);
    g.strokeStyle = 'rgba(242,193,78,0.8)';
    g.beginPath();
    g.arc(tx(MAP.camp.x), tx(MAP.camp.z), MAP.camp.r * s, 0, Math.PI * 2);
    g.stroke();
    const dot = (x: number, z: number, color: string, r: number) => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(tx(x), tx(z), r, 0, Math.PI * 2);
      g.fill();
    };
    for (const { row } of this.enemies.values()) if (row.alive) dot(row.x, row.z, '#e0544a', 2.5);
    for (const [id, { row }] of this.players) if (id !== this.myIdentity) dot(row.x, row.z, '#5aa9e6', 3);
    dot(this.predicted.x, this.predicted.z, '#ffffff', 3.5);
  }

  private floatText(world: THREE.Vector3, text: string, cls: string) {
    const p = world.clone().project(this.world.camera);
    if (p.z > 1) return;
    const el = document.createElement('div');
    el.className = `dmg ${cls}`;
    el.textContent = text;
    el.style.left = `${((p.x + 1) / 2) * window.innerWidth + (Math.random() * 20 - 10)}px`;
    el.style.top = `${((1 - p.y) / 2) * window.innerHeight}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  feed(text: string) {
    const ul = $('feed');
    const li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
    while (ul.children.length > 5) ul.firstChild?.remove();
    setTimeout(() => li.remove(), 6000);
  }

  toast(text: string, kind: 'error' | 'info' = 'error') {
    const t = $('toast');
    t.textContent = text;
    t.className = `show ${kind === 'info' ? 'info' : ''}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.className = ''), 2500);
  }

  // ---------------------------------------------------------------- lifecycle

  async enter(cls: ClassId) {
    if (!this.conn) throw new Error('Not connected');
    await this.conn.reducers.enterWorld({ class: cls });
    this.active = true;
    this.input.enabled = true;
    this.lastAttackAt = 0;
    const me = this.conn.db.player.identity.find(this.net.identity!);
    if (me) {
      this.upsertPlayer(me);
      this.predicted.set(me.x, 0, me.z);
      this.camTarget.set(me.x, 0, me.z);
    }
  }

  async leave() {
    this.active = false;
    this.input.enabled = false;
    this.input.reset();
    try {
      await this.conn?.reducers.leaveWorld({});
    } catch {
      /* already out of the world */
    }
    this.onLeft();
  }

  /** Debug/test hook: a read-only snapshot of what the client currently knows. */
  snapshot() {
    return {
      me: this.me && {
        username: this.me.username, class: this.me.class, x: this.me.x, z: this.me.z, hp: this.me.hp, alive: this.me.alive,
        kills: this.me.kills, deaths: this.me.deaths, gold: this.me.gold, potions: this.me.potions, attackSeq: this.me.attackSeq,
      },
      predicted: { x: this.predicted.x, z: this.predicted.z },
      players: this.players.size,
      enemies: [...this.enemies.values()].map(({ row }) => ({ id: row.id, kind: row.kind, x: row.x, z: row.z, hp: row.hp, alive: row.alive })),
      pickups: this.pickups.size,
      drawCalls: this.world.drawCalls(),
      connection: this.net.state,
    };
  }
}
