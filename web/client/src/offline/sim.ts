// Single-player simulation for the offline build. A port of web/arena-module/src/lib.rs
// (reducers + world_tick) that exposes the same table/reducer surface the game reads from
// a SpacetimeDB connection, so the rendering and input code is shared unchanged.
import { CLASSES, MAP, inCamp, lineOfSight, slide, steer, type ClassId } from '../map';

export interface Ts {
  microsSinceUnixEpoch: bigint;
}
export interface Ident {
  toHexString(): string;
  isEqual(other: Ident): boolean;
}

export interface PlayerRow {
  identity: Ident;
  username: string;
  class: string;
  x: number;
  z: number;
  facing: number;
  moving: boolean;
  hp: number;
  maxHp: number;
  alive: boolean;
  online: boolean;
  inWorld: boolean;
  gold: number;
  potions: number;
  kills: number;
  deaths: number;
  respawnAt: Ts;
  lastAttack: Ts;
  attackSeq: number;
  hitSeq: number;
}
export interface EnemyRow {
  id: number;
  kind: string;
  x: number;
  z: number;
  facing: number;
  moving: boolean;
  hp: number;
  maxHp: number;
  alive: boolean;
  target: Ident | undefined;
  respawnAt: Ts;
  lastAttack: Ts;
  attackSeq: number;
  hitSeq: number;
}
export interface PickupRow {
  id: number;
  kind: string;
  x: number;
  z: number;
  available: boolean;
  respawnAt: Ts;
}
export interface CombatEventRow {
  id: bigint;
  at: Ts;
  kind: string;
  x: number;
  z: number;
  amount: number;
  text: string;
}

// ---- constants and tables (same values as arena-module/src/rules.rs)
const TICK_MS = 50;
const PLAYER_RESPAWN_MS = 5_000;
const ENEMY_RESPAWN_MS = 12_000;
const PICKUP_RESPAWN_MS = 20_000;
const PICKUP_RADIUS = 1.3;
const POTION_HEAL = 40;
const LEASH_DISTANCE = 18;
const ENEMY_RADIUS = 0.55;

const ENEMIES: Record<string, { maxHp: number; speed: number; damage: number; range: number; cooldown: number; aggro: number; gold: number }> = {
  warrior: { maxHp: 110, speed: 3.2, damage: 14, range: 2.0, cooldown: 1400, aggro: 10, gold: 8 },
  rogue: { maxHp: 55, speed: 4.6, damage: 8, range: 1.8, cooldown: 800, aggro: 12, gold: 6 },
  mage: { maxHp: 50, speed: 3.0, damage: 10, range: 8.0, cooldown: 1800, aggro: 12, gold: 7 },
  minion: { maxHp: 60, speed: 3.6, damage: 9, range: 1.8, cooldown: 1100, aggro: 9, gold: 4 },
};
const enemyStats = (kind: string) => ENEMIES[kind] ?? ENEMIES.minion;

const ts = (ms: number): Ts => ({ microsSinceUnixEpoch: BigInt(Math.round(ms)) * 1000n });
const msOf = (t: Ts) => Number(t.microsSinceUnixEpoch / 1000n);
const facingTo = (dx: number, dz: number) => Math.atan2(dx, dz);
function angleDiff(a: number, b: number) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const OFFLINE_IDENTITY: Ident = {
  toHexString: () => 'offline-player',
  isEqual: (o) => o.toHexString() === 'offline-player',
};

// ---- a tiny table with the callback API the game uses (iter / find / onInsert / onUpdate / onDelete)
type Cb<R> = (ctx: unknown, ...rows: R[]) => void;
class Table<R, K> {
  rows = new Map<K, R>();
  private ins: Cb<R>[] = [];
  private upd: Cb<R>[] = [];
  private del: Cb<R>[] = [];
  constructor(private key: (r: R) => K) {}
  iter() {
    return this.rows.values();
  }
  find(k: K) {
    return this.rows.get(k);
  }
  onInsert(cb: Cb<R>) {
    this.ins.push(cb);
  }
  onUpdate(cb: Cb<R>) {
    this.upd.push(cb);
  }
  onDelete(cb: Cb<R>) {
    this.del.push(cb);
  }
  insert(r: R) {
    this.rows.set(this.key(r), r);
    for (const cb of this.ins) cb({}, r);
  }
  /** Replaces a row with an updated copy, so listeners can compare old and new. */
  update(old: R, changes: Partial<R>) {
    const next = { ...old, ...changes };
    this.rows.set(this.key(next), next);
    for (const cb of this.upd) cb({}, old, next);
    return next;
  }
  delete(k: K) {
    const r = this.rows.get(k);
    if (!r) return;
    this.rows.delete(k);
    for (const cb of this.del) cb({}, r);
  }
}

export interface SavedProgress {
  class?: string;
  gold?: number;
  kills?: number;
  deaths?: number;
  potions?: number;
}

export class OfflineWorld {
  readonly players = new Table<PlayerRow, string>((r) => r.identity.toHexString());
  readonly enemies = new Table<EnemyRow, number>((r) => r.id);
  readonly pickups = new Table<PickupRow, number>((r) => r.id);
  readonly events = new Table<CombatEventRow, bigint>((r) => r.id);
  /** Input in effect at `lastTick`, plus timestamped changes not yet simulated. */
  private input = { dx: 0, dz: 0 };
  private inputLog: { t: number; dx: number; dz: number }[] = [];
  private nextEventId = 1n;
  private lastTick = performance.now();
  private timer: number | undefined;
  onProgress: (p: SavedProgress) => void = () => {};

  /** The DbConnection-shaped facade handed to the game. */
  readonly conn;

  constructor(private username: string) {
    const now = Date.now();
    MAP.enemySpawns.forEach((s, i) => {
      const st = enemyStats(s.kind);
      this.enemies.insert({
        id: i, kind: s.kind, x: s.x, z: s.z, facing: 0, moving: false, hp: st.maxHp, maxHp: st.maxHp, alive: true,
        target: undefined, respawnAt: ts(now), lastAttack: ts(0), attackSeq: 0, hitSeq: 0,
      });
    });
    MAP.pickupSpawns.forEach((s, i) => this.pickups.insert({ id: i, kind: s.kind, x: s.x, z: s.z, available: true, respawnAt: ts(now) }));

    const players = this.players;
    const wrap = <A>(fn: (a: A) => void) => (a: A) => {
      try {
        fn(a);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    this.conn = {
      db: {
        player: { iter: () => players.iter(), onInsert: players.onInsert.bind(players), onUpdate: players.onUpdate.bind(players),
          onDelete: players.onDelete.bind(players), identity: { find: (id: Ident) => players.find(id.toHexString()) } },
        enemy: { iter: () => this.enemies.iter(), onInsert: this.enemies.onInsert.bind(this.enemies),
          onUpdate: this.enemies.onUpdate.bind(this.enemies), id: { find: (id: number) => this.enemies.find(id) } },
        pickup: { iter: () => this.pickups.iter(), onInsert: this.pickups.onInsert.bind(this.pickups),
          onUpdate: this.pickups.onUpdate.bind(this.pickups), id: { find: (id: number) => this.pickups.find(id) } },
        combatEvent: { iter: () => this.events.iter(), onInsert: this.events.onInsert.bind(this.events) },
      },
      reducers: {
        enterWorld: wrap((a: { class: string }) => this.enterWorld(a.class)),
        leaveWorld: wrap(() => this.leaveWorld()),
        setInput: wrap((a: { dx: number; dz: number }) => this.setInput(a.dx, a.dz)),
        attack: wrap((a: { facing: number }) => this.attack(a.facing)),
        usePotion: wrap(() => this.usePotion()),
        authorizeSession: () => Promise.reject(new Error('Only the login gateway may authorize sessions')),
      },
    };
  }

  start(saved: SavedProgress) {
    this.saved = saved;
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }
  stop() {
    window.clearInterval(this.timer);
  }
  private saved: SavedProgress = {};

  private me() {
    return this.players.find(OFFLINE_IDENTITY.toHexString());
  }
  private event(kind: string, x: number, z: number, amount: number, text = '') {
    const id = this.nextEventId++;
    this.events.insert({ id, at: ts(Date.now()), kind, x, z, amount, text });
  }
  private progress(p: PlayerRow) {
    this.onProgress({ class: p.class, gold: p.gold, kills: p.kills, deaths: p.deaths, potions: p.potions });
  }
  private spawnPoint(): [number, number] {
    return MAP.playerSpawns[0];
  }

  // ---------------------------------------------------------------- reducers
  private enterWorld(cls: string) {
    const stats = CLASSES[cls as ClassId];
    if (!stats) throw new Error('Unknown class');
    const [x, z] = this.spawnPoint();
    const p = this.me();
    if (p) {
      // same rule as rules::reentry: no skipping the respawn timer, no free heals
      let hp: number;
      let pos = { x: p.x, z: p.z };
      if (!p.alive) {
        if (Date.now() < msOf(p.respawnAt)) throw new Error('You are dead: wait for the respawn timer');
        hp = stats.hp;
        pos = { x, z };
      } else {
        hp = Math.min(stats.hp, Math.max(1, Math.floor((p.hp * stats.hp) / Math.max(1, p.maxHp))));
      }
      this.players.update(p, { class: cls, maxHp: stats.hp, hp, alive: true, inWorld: true, online: true, ...pos });
    } else {
      const s = this.saved;
      this.players.insert({
        identity: OFFLINE_IDENTITY, username: this.username, class: cls, x, z, facing: Math.PI, moving: false,
        hp: stats.hp, maxHp: stats.hp, alive: true, online: true, inWorld: true,
        gold: s.gold ?? 0, potions: s.potions ?? 1, kills: s.kills ?? 0, deaths: s.deaths ?? 0,
        respawnAt: ts(Date.now()), lastAttack: ts(0), attackSeq: 0, hitSeq: 0,
      });
    }
    this.progress(this.me()!);
    this.event('join', x, z, 0, `${this.username} entered the arena`);
  }

  private leaveWorld() {
    const p = this.me();
    if (!p?.inWorld) throw new Error('Character is not in the world');
    this.players.update(p, { inWorld: false, moving: false });
    this.clearInput();
  }

  private setInput(dx: number, dz: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) throw new Error('Invalid input');
    const len = Math.hypot(dx, dz);
    const v = len > 1 ? { dx: dx / len, dz: dz / len } : { dx, dz };
    this.inputLog.push({ t: performance.now(), ...v });
  }

  private clearInput() {
    this.input = { dx: 0, dz: 0 };
    this.inputLog = [];
  }

  private attack(facing: number) {
    let p = this.me();
    if (!p?.inWorld) throw new Error('No character');
    if (!p.alive) throw new Error('You are dead');
    if (!Number.isFinite(facing)) throw new Error('Invalid facing');
    const c = CLASSES[p.class as ClassId];
    const now = Date.now();
    if (now - msOf(p.lastAttack) < c.cooldown) throw new Error('Attack on cooldown');
    p = this.players.update(p, { facing, lastAttack: ts(now), attackSeq: p.attackSeq + 1 });

    const hits = (tx: number, tz: number) => {
      const dx = tx - p!.x;
      const dz = tz - p!.z;
      if (c.ranged) {
        const fx = Math.sin(facing);
        const fz = Math.cos(facing);
        const along = dx * fx + dz * fz;
        return along > 0 && along <= c.range && Math.abs(dx * fz - dz * fx) <= 1;
      }
      const dist = Math.hypot(dx, dz);
      return dist <= c.range + ENEMY_RADIUS && (dist < 0.6 || Math.abs(angleDiff(facingTo(dx, dz), facing)) <= c.arc);
    };
    let targets = [...this.enemies.iter()].filter((e) => e.alive && hits(e.x, e.z) && lineOfSight(p!.x, p!.z, e.x, e.z));
    if (c.ranged) {
      targets.sort((a, b) => Math.hypot(a.x - p!.x, a.z - p!.z) - Math.hypot(b.x - p!.x, b.z - p!.z));
      targets = targets.slice(0, 1);
    }
    let kills = 0;
    let gold = 0;
    for (const e of targets) {
      const crit = Math.random() < 0.12;
      const dmg = crit ? c.damage * 2 : c.damage;
      const hp = e.hp - dmg;
      this.event(crit ? 'crit' : 'damage', e.x, e.z, dmg);
      if (hp <= 0) {
        const st = enemyStats(e.kind);
        this.enemies.update(e, { hp: 0, alive: false, moving: false, target: undefined, hitSeq: e.hitSeq + 1, respawnAt: ts(now + ENEMY_RESPAWN_MS) });
        kills++;
        gold += st.gold;
        this.event('kill', e.x, e.z, st.gold, `${p.username} defeated a skeleton ${e.kind}`);
      } else {
        this.enemies.update(e, { hp, hitSeq: e.hitSeq + 1, target: OFFLINE_IDENTITY });
      }
    }
    if (kills) {
      p = this.players.update(p, { kills: p.kills + kills, gold: p.gold + gold });
      this.progress(p);
    }
  }

  private usePotion() {
    const p = this.me();
    if (!p?.inWorld) throw new Error('No character');
    if (!p.alive) throw new Error('You are dead');
    if (p.potions === 0) throw new Error('No potions left');
    if (p.hp >= p.maxHp) throw new Error('Already at full health');
    const healed = Math.min(POTION_HEAL, p.maxHp - p.hp);
    this.progress(this.players.update(p, { potions: p.potions - 1, hp: p.hp + healed }));
    this.event('heal', p.x, p.z, healed);
  }

  // ---------------------------------------------------------------- world_tick
  private tick() {
    // Unlike the server, this timer shares the page's thread with rendering, so a slow frame can
    // delay it. Elapsed time (up to 1 s) is replayed in steps of at most 50 ms, switching input
    // exactly when it changed, so movement does not depend on the frame rate.
    const end = performance.now();
    const now = Date.now();
    let t = Math.max(this.lastTick, end - 1000);
    while (t < end) {
      while (this.inputLog.length && this.inputLog[0].t <= t) this.input = this.inputLog.shift()!;
      const stepEnd = Math.min(end, t + TICK_MS, this.inputLog[0]?.t ?? Infinity);
      this.tickPlayer((stepEnd - t) / 1000, now);
      this.tickEnemies((stepEnd - t) / 1000, now);
      t = stepEnd;
    }
    while (this.inputLog.length) this.input = this.inputLog.shift()!;
    this.lastTick = end;
    this.tickPickups(now);
    for (const e of [...this.events.iter()]) if (now - msOf(e.at) > 5000) this.events.delete(e.id);
  }

  private tickPlayer(dt: number, now: number) {
    const p = this.me();
    if (!p?.inWorld) return;
    if (!p.alive) {
      if (now >= msOf(p.respawnAt)) {
        const [x, z] = this.spawnPoint();
        this.players.update(p, { x, z, hp: p.maxHp, alive: true });
      }
      return;
    }
    const { dx, dz } = this.input;
    if (dx === 0 && dz === 0) {
      if (p.moving) this.players.update(p, { moving: false });
      return;
    }
    const speed = CLASSES[p.class as ClassId]?.speed ?? 5;
    const [nx, nz] = slide(p.x, p.z, dx * speed * dt, dz * speed * dt, MAP.playerRadius);
    this.players.update(p, { x: nx, z: nz, facing: facingTo(dx, dz), moving: Math.abs(nx - p.x) > 1e-4 || Math.abs(nz - p.z) > 1e-4 });
  }

  private tickEnemies(dt: number, now: number) {
    const me = this.me();
    const player = me && me.inWorld && me.alive ? me : undefined;
    for (const e of [...this.enemies.iter()]) {
      const spawn = MAP.enemySpawns[e.id];
      const st = enemyStats(e.kind);
      if (!e.alive) {
        if (now >= msOf(e.respawnAt)) {
          this.enemies.update(e, { alive: true, hp: e.maxHp, x: spawn.x, z: spawn.z, target: undefined });
          this.event('spawn', spawn.x, spawn.z, 0);
        }
        continue;
      }
      const valid = (p: PlayerRow) => !inCamp(p.x, p.z) && Math.hypot(p.x - spawn.x, p.z - spawn.z) < LEASH_DISTANCE;
      const visible = (p: PlayerRow) => lineOfSight(e.x, e.z, p.x, p.z);
      let target: PlayerRow | undefined;
      if (player && valid(player)) {
        const engaged = !!e.target;
        const inAggro = Math.hypot(player.x - e.x, player.z - e.z) < st.aggro && visible(player);
        if (engaged || inAggro) target = player;
      }
      if (target) {
        const dx = target.x - e.x;
        const dz = target.z - e.z;
        const dist = Math.hypot(dx, dz);
        const facing = facingTo(dx, dz);
        if (dist > st.range) {
          const step = Math.min(st.speed * dt, dist - st.range * 0.8);
          const [nx, nz] = steer(e.x, e.z, target.x, target.z, step, ENEMY_RADIUS);
          this.enemies.update(e, { x: nx, z: nz, facing, target: OFFLINE_IDENTITY, moving: Math.abs(nx - e.x) > 1e-4 || Math.abs(nz - e.z) > 1e-4 });
        } else if (now - msOf(e.lastAttack) >= st.cooldown && visible(target)) {
          this.enemies.update(e, { facing, moving: false, target: OFFLINE_IDENTITY, lastAttack: ts(now), attackSeq: e.attackSeq + 1 });
          this.damagePlayer(st.damage, e.kind, now);
        } else if (e.moving || e.facing !== facing || !e.target) {
          this.enemies.update(e, { facing, moving: false, target: OFFLINE_IDENTITY });
        }
      } else {
        const dx = spawn.x - e.x;
        const dz = spawn.z - e.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.3) {
          const step = Math.min(st.speed * 0.6 * dt, dist);
          const [nx, nz] = steer(e.x, e.z, spawn.x, spawn.z, step, ENEMY_RADIUS);
          this.enemies.update(e, { x: nx, z: nz, facing: facingTo(dx, dz), target: undefined, moving: Math.abs(nx - e.x) > 1e-4 || Math.abs(nz - e.z) > 1e-4 });
        } else if (e.moving || e.target || e.hp < e.maxHp) {
          this.enemies.update(e, { moving: false, target: undefined, hp: e.maxHp });
        }
      }
    }
  }

  private damagePlayer(damage: number, source: string, now: number) {
    const p = this.me();
    if (!p?.alive) return;
    const hp = p.hp - damage;
    this.event('player_damage', p.x, p.z, damage);
    if (hp <= 0) {
      this.progress(this.players.update(p, { hp: 0, alive: false, moving: false, deaths: p.deaths + 1, hitSeq: p.hitSeq + 1, respawnAt: ts(now + PLAYER_RESPAWN_MS) }));
      this.event('death', p.x, p.z, 0, `${p.username} was slain by a skeleton ${source}`);
      this.clearInput();
    } else {
      this.players.update(p, { hp, hitSeq: p.hitSeq + 1 });
    }
  }

  private tickPickups(now: number) {
    const p = this.me();
    for (const pk of [...this.pickups.iter()]) {
      if (!pk.available) {
        if (now >= msOf(pk.respawnAt)) this.pickups.update(pk, { available: true });
        continue;
      }
      if (p?.inWorld && p.alive && Math.hypot(p.x - pk.x, p.z - pk.z) < PICKUP_RADIUS) {
        const cur = this.me()!;
        this.progress(this.players.update(cur, pk.kind === 'potion' ? { potions: cur.potions + 1 } : { gold: cur.gold + 10 }));
        this.event('pickup', pk.x, pk.z, 0, pk.kind);
        this.pickups.update(pk, { available: false, respawnAt: ts(now + PICKUP_RESPAWN_MS) });
      }
    }
  }
}
