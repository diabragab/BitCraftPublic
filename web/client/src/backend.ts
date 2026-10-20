import type { Identity } from 'spacetimedb';
import type { DbConnection } from './module_bindings';

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface LeaderboardRow {
  username: string;
  class: string;
  kills: number;
  deaths: number;
  gold: number;
}

/**
 * What the UI needs from "the server". `Net` talks to SpacetimeDB through the gateway;
 * `OfflineBackend` (offline/backend.ts) runs the same rules in the browser for the
 * single-player build. Both hand the game a DbConnection-shaped object.
 */
export interface Backend {
  readonly offline: boolean;
  conn: DbConnection | null;
  identity: Identity | null;
  state: ConnState;
  username: string | null;
  readonly hasSession: boolean;
  onState: (s: ConnState, detail?: string) => void;
  /** Called after every (re)connect once the initial state is available. */
  onReady: (conn: DbConnection) => void;
  init(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): void;
  login(username: string, password: string, create: boolean): Promise<{ username: string }>;
  logout(): void;
  health(): Promise<{ ok: boolean; label: string }>;
  leaderboard(): Promise<LeaderboardRow[]>;
}
