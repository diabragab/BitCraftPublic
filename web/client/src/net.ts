import { Identity } from 'spacetimedb';
import type { Backend, ConnState, LeaderboardRow } from './backend';
import { DbConnection } from './module_bindings';

const TOKEN_KEY = 'kaykit-arena.identityToken';
const USER_KEY = 'kaykit-arena.username';

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: the session simply will not survive a reload */
  }
}
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export class ApiError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}

export interface Health {
  status: string;
  spacetimedb: { reachable: boolean; databaseFound: boolean };
}
export const getHealth = () => api<Health>('/api/health');
export const getLeaderboard = () => api<{ players: LeaderboardRow[] }>('/api/leaderboard');

/**
 * Owns the SpacetimeDB connection. The identity token is kept in localStorage
 * (the standard SpacetimeDB client pattern); the account password never leaves
 * the login request and is only checked by the gateway.
 */
export class Net implements Backend {
  readonly offline = false;
  conn: DbConnection | null = null;
  identity: Identity | null = null;
  state: ConnState = 'offline';
  username = read(USER_KEY);
  private database = 'kaykit-arena';
  private wantConnected = false;
  private attempts = 0;
  private retryTimer: number | undefined;
  private readyResolvers: (() => void)[] = [];

  onState: (s: ConnState, detail?: string) => void = () => {};
  /** Called after every (re)connect once the subscription is applied. */
  onReady: (conn: DbConnection) => void = () => {};

  get hasSession() {
    return !!read(TOKEN_KEY) && !!this.username;
  }

  async health() {
    try {
      const h = await getHealth();
      return { ok: h.status === 'ok', label: h.status === 'ok' ? 'Server online' : 'Server degraded' };
    } catch (e) {
      return { ok: false, label: (e as Error).message };
    }
  }

  async leaderboard() {
    return (await getLeaderboard()).players;
  }

  async init() {
    try {
      const cfg = await api<{ database: string }>('/api/config');
      this.database = cfg.database;
    } catch {
      /* fall back to the default database name */
    }
  }

  private setState(s: ConnState, detail?: string) {
    this.state = s;
    this.onState(s, detail);
  }

  /** Connects (or reconnects) and resolves once the initial subscription is applied. */
  connect(): Promise<void> {
    this.wantConnected = true;
    const ready = new Promise<void>((resolve) => this.readyResolvers.push(resolve));
    this.open();
    return ready;
  }

  private open() {
    window.clearTimeout(this.retryTimer);
    this.setState(this.attempts ? 'reconnecting' : 'connecting', this.attempts ? `attempt ${this.attempts}` : undefined);
    const uri = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const conn = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(this.database)
      .withToken(read(TOKEN_KEY) ?? undefined)
      .withCompression('gzip')
      .onConnect((c, identity, token) => {
        this.identity = identity;
        store(TOKEN_KEY, token);
        this.attempts = 0;
        c.subscriptionBuilder()
          .onApplied(() => {
            this.setState('connected');
            this.onReady(c);
            this.readyResolvers.splice(0).forEach((r) => r());
          })
          .onError((ctx) => console.error('subscription error', ctx))
          .subscribe(['SELECT * FROM player', 'SELECT * FROM enemy', 'SELECT * FROM pickup', 'SELECT * FROM combat_event', 'SELECT * FROM world']);
      })
      .onConnectError((_ctx, err) => {
        console.warn('connect error', err);
        if (/verify token/i.test(err?.message ?? '')) {
          // Token from another server instance (e.g. a reset dev database): start over with a new identity.
          store(TOKEN_KEY, null);
          store(USER_KEY, null);
          this.username = null;
        }
        this.scheduleRetry(err?.message);
      })
      .onDisconnect((_ctx, err) => {
        if (this.conn === conn) this.conn = null;
        if (this.wantConnected) this.scheduleRetry(err?.message);
        else this.setState('offline');
      })
      .build();
    this.conn = conn;
  }

  private scheduleRetry(reason?: string) {
    if (!this.wantConnected) return;
    this.attempts++;
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.attempts - 1, 4));
    this.setState('reconnecting', `${reason ? reason + ' — ' : ''}retrying in ${Math.round(delay / 1000)}s`);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  disconnect() {
    this.wantConnected = false;
    window.clearTimeout(this.retryTimer);
    this.conn?.disconnect();
    this.conn = null;
    this.setState('offline');
  }

  /** Account login/registration. Needs a live connection so the gateway can bind this identity. */
  async login(username: string, password: string, create: boolean) {
    if (!this.conn) await this.connect();
    const identityToken = read(TOKEN_KEY);
    if (!identityToken) throw new ApiError('No identity yet, please retry.');
    const res = await api<{ username: string }>(create ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, identityToken }),
    });
    this.username = res.username;
    store(USER_KEY, res.username);
    return res;
  }

  /** Forgets the local identity so the next visitor on this device gets a fresh one. */
  logout() {
    this.disconnect();
    store(TOKEN_KEY, null);
    store(USER_KEY, null);
    this.username = null;
    this.identity = null;
  }
}
