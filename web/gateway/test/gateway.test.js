import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AccountStore, validateCredentials } from '../src/accounts.js';
import { proxyRule } from '../src/proxy.js';
import { SpacetimeClient } from '../src/spacetime.js';
import { clientAddress, createGateway } from '../src/server.js';

const IDENTITY = 'c2'.padEnd(64, '0');

function makeToken(privateKey, payload, alg = 'ES256') {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ typ: 'JWT', alg })}.${enc(payload)}`;
  const sig = sign('sha256', Buffer.from(head), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${sig}`;
}

test('credential validation', () => {
  assert.equal(validateCredentials('hero_1', 'password123'), null);
  assert.match(validateCredentials('a', 'password123'), /Username/);
  assert.match(validateCredentials('bad name', 'password123'), /Username/);
  assert.match(validateCredentials('hero', 'short'), /Password/);
  assert.match(validateCredentials(undefined, undefined), /Username/);
});

test('account store hashes and verifies passwords', async () => {
  const store = new AccountStore(':memory:');
  assert.deepEqual(await store.create('Hero', 'correct horse'), { username: 'Hero' });
  assert.equal(await store.create('hero', 'other password'), null, 'usernames are case-insensitive unique');
  assert.deepEqual(await store.verify('HERO', 'correct horse'), { username: 'Hero' });
  assert.equal(await store.verify('Hero', 'wrong password'), null);
  assert.equal(await store.verify('nobody', 'whatever1'), null);
  const row = store.db.prepare('SELECT hash FROM accounts').get();
  assert.ok(!Buffer.from(row.hash).toString('utf8').includes('correct horse'));
  store.close();
});

test('account database is private to the gateway user', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'arena-accounts-')), 'data');
  const store = new AccountStore(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'accounts.sqlite')).mode & 0o777, 0o600);
  store.close();
  rmSync(dirname(dir), { recursive: true, force: true });
});

test('client address behind a proxy cannot be forged', () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(clientAddress(req({ 'x-forwarded-for': '6.6.6.6' }), false), '127.0.0.1', 'headers ignored unless TRUST_PROXY');
  assert.equal(clientAddress(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), true), '203.0.113.9');
  assert.equal(clientAddress(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }), true), '198.51.100.7', 'right-most (proxy-added) entry');
  assert.equal(clientAddress(req({}), true), '127.0.0.1');
});

test('proxy only exposes client endpoints', () => {
  assert.equal(proxyRule('GET', '/v1/ping', 'arena'), true);
  assert.equal(proxyRule('POST', '/v1/identity', 'arena'), true);
  assert.equal(proxyRule('POST', '/v1/identity/websocket-token', 'arena'), true);
  assert.equal(proxyRule('GET', '/v1/database/arena/subscribe', 'arena'), 'ws');
  assert.equal(proxyRule('GET', '/v1/database/other/subscribe', 'arena'), false);
  assert.equal(proxyRule('POST', '/v1/database/arena/call/attack', 'arena'), false);
  assert.equal(proxyRule('POST', '/v1/database/arena/sql', 'arena'), false);
  assert.equal(proxyRule('POST', '/v1/database/arena', 'arena'), false, 'publishing is never proxied');
  assert.equal(proxyRule('DELETE', '/v1/database/arena', 'arena'), false);
  assert.equal(proxyRule('GET', '/v1/database/arena/logs', 'arena'), false);
});

test('identity token verification', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const client = new SpacetimeClient({ spacetimeUrl: 'http://unused', database: 'arena', tokenFile: '/dev/null' });
  client.publicKey = publicKey;
  assert.equal(await client.verifyIdentityToken(makeToken(privateKey, { hex_identity: IDENTITY })), IDENTITY);
  await assert.rejects(client.verifyIdentityToken(makeToken(other.privateKey, { hex_identity: IDENTITY })), /signature/);
  await assert.rejects(client.verifyIdentityToken(makeToken(privateKey, { hex_identity: IDENTITY, exp: 1 })), /expired/);
  await assert.rejects(client.verifyIdentityToken(makeToken(privateKey, { hex_identity: IDENTITY }, 'none')), /algorithm/);
  await assert.rejects(client.verifyIdentityToken('garbage'), /Malformed/);
  await assert.rejects(client.verifyIdentityToken(undefined), /Missing/);
});

test('auth routes (fake SpacetimeDB)', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const authorized = [];
  const spacetime = new SpacetimeClient({ spacetimeUrl: 'http://unused', database: 'arena', tokenFile: '/dev/null' });
  spacetime.publicKey = publicKey;
  spacetime.ensureIdentity = async () => (spacetime.identity = 'gateway');
  spacetime.authorizeSession = async (id, name) => authorized.push([id, name]);
  spacetime.health = async () => ({ reachable: true, databaseFound: true });
  const gw = await createGateway(
    { host: '127.0.0.1', port: 0, database: 'arena', staticDir: null, allowedOrigins: [], authRateLimit: 4, logRequests: false },
    { accounts: new AccountStore(':memory:'), spacetime },
  );
  const { port } = await gw.listen();
  t.after(() => gw.close());
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const identityToken = makeToken(privateKey, { hex_identity: IDENTITY });

  let res = await post('/api/auth/register', { username: 'Hero', password: 'password123', identityToken });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { username: 'Hero', identity: IDENTITY });
  assert.deepEqual(authorized, [[IDENTITY, 'Hero']]);

  res = await post('/api/auth/register', { username: 'hero', password: 'password123', identityToken });
  assert.equal(res.status, 409);

  res = await post('/api/auth/login', { username: 'Hero', password: 'wrong-password', identityToken });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'Wrong username or password.');

  res = await post('/api/auth/login', { username: 'Hero', password: 'password123', identityToken: 'x.y.z' });
  assert.equal(res.status, 400);

  res = await post('/api/auth/login', { username: 'Hero', password: 'password123', identityToken }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403, 'cross-origin requests are refused');

  res = await post('/api/auth/login', { username: 'Hero', password: 'password123', identityToken });
  assert.equal(res.status, 429, 'rate limit (4/min) reached');

  res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  res = await fetch(base + '/v1/database/arena/sql', { method: 'POST' });
  assert.equal(res.status, 403);
});

test('registration is rolled back when the game server refuses the session', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let gatewayRegistered = false;
  const spacetime = new SpacetimeClient({ spacetimeUrl: 'http://unused', database: 'arena', tokenFile: '/dev/null' });
  spacetime.publicKey = publicKey;
  spacetime.ensureIdentity = async () => (spacetime.identity = 'gateway');
  spacetime.authorizeSession = async () => {
    if (!gatewayRegistered) throw new Error('Reducer authorize_session failed: Only the login gateway may authorize sessions');
  };
  const gw = await createGateway(
    { host: '127.0.0.1', port: 0, database: 'arena', staticDir: null, allowedOrigins: [], authRateLimit: 50, logRequests: false },
    { accounts: new AccountStore(':memory:'), spacetime },
  );
  const { port } = await gw.listen();
  t.after(() => gw.close());
  const register = () =>
    fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Early', password: 'password123', identityToken: makeToken(privateKey, { hex_identity: IDENTITY }) }),
    });
  let res = await register();
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /register-gateway/);
  gatewayRegistered = true;
  res = await register();
  assert.equal(res.status, 201, 'the same username can be registered once the server accepts sessions');
});

// Runs only when a local SpacetimeDB with the arena module is up (see web/scripts/dev.sh).
test('integration: real SpacetimeDB login flow', async (t) => {
  const url = process.env.SPACETIME_URL ?? 'http://127.0.0.1:3000';
  const database = process.env.SPACETIME_DB ?? 'kaykit-arena';
  try {
    const r = await fetch(`${url}/v1/database/${database}`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) throw new Error();
  } catch {
    t.skip('SpacetimeDB with the arena module is not running');
    return;
  }
  const tokenFile = process.env.GATEWAY_TOKEN_FILE ?? new URL('../../.secrets/gateway-token', import.meta.url).pathname;
  const gw = await createGateway(
    { host: '127.0.0.1', port: 0, spacetimeUrl: url, database, tokenFile, staticDir: null, allowedOrigins: [], authRateLimit: 50, logRequests: false },
    { accounts: new AccountStore(':memory:') },
  );
  const { port } = await gw.listen();
  t.after(() => gw.close());
  const base = `http://127.0.0.1:${port}`;

  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.status, 'ok');

  // A browser gets its identity token from SpacetimeDB (via the gateway proxy).
  const { identity, token } = await (await fetch(base + '/v1/identity', { method: 'POST' })).json();
  const username = `it_${Date.now().toString(36)}`;
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'integration-pass', identityToken: token }),
  });
  const body = await res.json();
  if (res.status === 503) {
    t.skip(`gateway not registered with the module: ${body.error}`);
    return;
  }
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.identity, identity);

  // The authorized identity can now play: enter the world and send input.
  const call = (reducer, args) =>
    fetch(`${url}/v1/database/${database}/call/${reducer}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
  assert.equal((await call('enter_world', ['knight'])).status, 200);
  assert.equal((await call('enter_world', ['dragon'])).status, 530, 'unknown class is rejected server-side');
  const rows = await gw.spacetime.sql(`SELECT username, class, hp, max_hp FROM player WHERE username = '${username}'`);
  assert.deepEqual(rows, [{ username, class: 'knight', hp: 140, max_hp: 140 }]);
  // Each HTTP call is its own short-lived connection, so the player is offline again here.
  // Live movement over a WebSocket is covered by the browser end-to-end test (web/tests/e2e.mjs).
  assert.equal((await call('attack', [Number.NaN])).status >= 400, true, 'non-finite input rejected');
});
