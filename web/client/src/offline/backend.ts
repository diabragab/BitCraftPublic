import type { Backend, ConnState, LeaderboardRow } from '../backend';
import type { DbConnection } from '../module_bindings';
import { OFFLINE_IDENTITY, OfflineWorld, type SavedProgress } from './sim';

const NAME_KEY = 'kaykit-arena.offline.name';
const PROGRESS_KEY = 'kaykit-arena.offline.progress';

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: progress just isn't remembered */
  }
}

/**
 * Single-player backend: the arena rules run in the browser (offline/sim.ts), so the game
 * works without any server, e.g. as a page hosted on claude.ai. Progress is remembered in
 * this browser only.
 */
export class OfflineBackend implements Backend {
  readonly offline = true;
  conn: DbConnection | null = null;
  identity = OFFLINE_IDENTITY as unknown as Backend['identity'];
  state: ConnState = 'offline';
  username: string | null = read<string | null>(NAME_KEY, null);
  private world: OfflineWorld | null = null;
  private progress: SavedProgress = read<SavedProgress>(PROGRESS_KEY, {});
  onState: (s: ConnState, detail?: string) => void = () => {};
  onReady: (conn: DbConnection) => void = () => {};

  get hasSession() {
    return !!this.username;
  }

  async init() {}

  async connect() {
    if (this.world) return;
    this.world = new OfflineWorld(this.username ?? 'Hero');
    this.world.onProgress = (p) => {
      this.progress = p;
      write(PROGRESS_KEY, p);
    };
    this.conn = this.world.conn as unknown as DbConnection;
    this.world.start(this.progress);
    this.state = 'connected';
    this.onState('connected', 'single-player');
    this.onReady(this.conn);
  }

  disconnect() {
    this.world?.stop();
    this.world = null;
    this.conn = null;
    this.state = 'offline';
    this.onState('offline');
  }

  async login(username: string) {
    if (this.username !== username) {
      // a different hero name starts fresh
      this.progress = {};
      write(PROGRESS_KEY, {});
      this.disconnect();
    }
    this.username = username;
    write(NAME_KEY, username);
    await this.connect();
    return { username };
  }

  logout() {
    this.disconnect();
    this.username = null;
    write(NAME_KEY, null);
  }

  async health() {
    return { ok: true, label: 'Single-player: runs in your browser' };
  }

  async leaderboard(): Promise<LeaderboardRow[]> {
    const p = this.progress;
    return this.username ? [{ username: this.username, class: p.class ?? '-', kills: p.kills ?? 0, deaths: p.deaths ?? 0, gold: p.gold ?? 0 }] : [];
  }
}
