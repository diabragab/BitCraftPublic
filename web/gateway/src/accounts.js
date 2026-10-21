import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Username must be 3-16 characters: letters, digits or underscore.';
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return 'Password must be 8-128 characters.';
  }
  return null;
}

/** Account store. Only salted scrypt hashes are stored; never plaintext passwords. */
export class AccountStore {
  constructor(dataDir) {
    if (dataDir === ':memory:') {
      this.db = new DatabaseSync(':memory:');
    } else {
      // Password hashes must not be readable by other local users (also tightens existing installs).
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(dataDir, 0o700);
      const file = join(dataDir, 'accounts.sqlite');
      this.db = new DatabaseSync(file);
      chmodSync(file, 0o600);
    }
    // Idempotent, non-destructive schema setup.
    this.db.exec(`CREATE TABLE IF NOT EXISTS accounts (
      username_key TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      salt BLOB NOT NULL,
      hash BLOB NOT NULL,
      created_at TEXT NOT NULL,
      last_login TEXT
    )`);
  }

  async create(username, password) {
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, KEYLEN, SCRYPT);
    try {
      this.db
        .prepare('INSERT INTO accounts (username_key, username, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username.toLowerCase(), username, salt, hash, new Date().toISOString());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return null;
      throw e;
    }
    return { username };
  }

  /** Removes an account; used to roll back a registration whose session could not be authorized. */
  delete(username) {
    this.db.prepare('DELETE FROM accounts WHERE username_key = ?').run(username.toLowerCase());
  }

  /** Returns the canonical account name, or null if the credentials are wrong. */
  async verify(username, password) {
    const row = this.db.prepare('SELECT username, salt, hash FROM accounts WHERE username_key = ?').get(username.toLowerCase());
    // Hash even for unknown users so response timing does not reveal which names exist.
    const salt = row ? Buffer.from(row.salt) : randomBytes(16);
    const hash = await scrypt(password, salt, KEYLEN, SCRYPT);
    if (!row || !timingSafeEqual(hash, Buffer.from(row.hash))) return null;
    this.db.prepare('UPDATE accounts SET last_login = ? WHERE username_key = ?').run(new Date().toISOString(), username.toLowerCase());
    return { username: row.username };
  }

  ping() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  }

  close() {
    this.db.close();
  }
}
