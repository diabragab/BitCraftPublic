import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';

const b64url = (s) => Buffer.from(s, 'base64url');

export class SpacetimeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Server-side client for the SpacetimeDB HTTP API. Holds the gateway's own (privileged) token. */
export class SpacetimeClient {
  constructor({ spacetimeUrl, database, tokenFile }) {
    this.url = spacetimeUrl;
    this.database = database;
    this.tokenFile = tokenFile;
    this.token = null;
    this.identity = null;
    this.publicKey = null;
  }

  async fetch(path, init = {}, timeoutMs = 5000) {
    return fetch(this.url + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }

  /** Loads the gateway identity token from its secret file, creating a new identity on first run. */
  async ensureIdentity() {
    if (existsSync(this.tokenFile)) {
      this.token = readFileSync(this.tokenFile, 'utf8').trim();
    } else {
      const res = await this.fetch('/v1/identity', { method: 'POST' });
      if (!res.ok) throw new SpacetimeError(`Could not create gateway identity: HTTP ${res.status}`, 502);
      this.token = (await res.json()).token;
      mkdirSync(dirname(this.tokenFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.tokenFile, this.token + '\n', { mode: 0o600 });
      log('info', 'created gateway identity token', { file: this.tokenFile });
    }
    this.identity = JSON.parse(b64url(this.token.split('.')[1]).toString()).hex_identity;
    return this.identity;
  }

  async getPublicKey() {
    if (!this.publicKey) {
      const res = await this.fetch('/v1/identity/public-key');
      if (!res.ok) throw new SpacetimeError(`Could not fetch SpacetimeDB public key: HTTP ${res.status}`, 502);
      this.publicKey = createPublicKey(await res.text());
    }
    return this.publicKey;
  }

  /**
   * Verifies a SpacetimeDB identity token (ES256 JWT) presented by a browser and
   * returns its identity. This proves the caller holds that identity's private token.
   */
  async verifyIdentityToken(token) {
    if (typeof token !== 'string' || token.length > 4096) throw new SpacetimeError('Missing identity token', 400);
    const parts = token.split('.');
    if (parts.length !== 3) throw new SpacetimeError('Malformed identity token', 400);
    let header, payload;
    try {
      header = JSON.parse(b64url(parts[0]).toString());
      payload = JSON.parse(b64url(parts[1]).toString());
    } catch {
      throw new SpacetimeError('Malformed identity token', 400);
    }
    if (header.alg !== 'ES256') throw new SpacetimeError('Unsupported token algorithm', 400);
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: await this.getPublicKey(), dsaEncoding: 'ieee-p1363' },
      b64url(parts[2]),
    );
    if (!ok) throw new SpacetimeError('Identity token signature is invalid', 401);
    if (payload.exp && payload.exp * 1000 < Date.now()) throw new SpacetimeError('Identity token expired', 401);
    if (!/^[0-9a-f]{64}$/.test(payload.hex_identity ?? '')) throw new SpacetimeError('Identity token has no identity', 400);
    return payload.hex_identity;
  }

  async callReducer(reducer, args) {
    const res = await this.fetch(`/v1/database/${encodeURIComponent(this.database)}/call/${reducer}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new SpacetimeError(`Reducer ${reducer} failed: ${text}`, res.status === 530 ? 403 : 502);
    }
  }

  async authorizeSession(identityHex, username) {
    await this.callReducer('authorize_session', [{ __identity__: `0x${identityHex}` }, username]);
  }

  /** Runs a read-only SQL query against public tables. */
  async sql(query) {
    const res = await this.fetch(`/v1/database/${encodeURIComponent(this.database)}/sql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'text/plain' },
      body: query,
    });
    if (!res.ok) throw new SpacetimeError(`SQL failed: HTTP ${res.status}`, 502);
    const [result] = await res.json();
    const names = result.schema.elements.map((e) => e.name.some ?? e.name);
    return result.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
  }

  async health() {
    const started = Date.now();
    const out = { url: this.url, database: this.database, reachable: false, databaseFound: false };
    try {
      const ping = await this.fetch('/v1/ping', {}, 2000);
      out.reachable = ping.ok;
      out.latencyMs = Date.now() - started;
      const db = await this.fetch(`/v1/database/${encodeURIComponent(this.database)}`, {}, 2000);
      out.databaseFound = db.ok;
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }
}
