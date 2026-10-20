import http from 'node:http';
import { AccountStore, validateCredentials } from './accounts.js';
import { log } from './log.js';
import { proxyHttp, proxyRule, proxyUpgrade } from './proxy.js';
import { SpacetimeClient, SpacetimeError } from './spacetime.js';
import { serveStatic } from './static.js';

// 'unsafe-eval' is required by the SpacetimeDB TypeScript SDK, which compiles its
// BSATN (de)serializers with Function(). Scripts are still restricted to this origin.
// blob:/data: in connect-src let GLTFLoader read textures embedded in .glb files.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss: blob: data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Fixed-window rate limiter keyed by client address. */
function rateLimiter(limitPerMinute) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (key) => {
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    return n <= limitPerMinute;
  };
}

async function readJson(req, limit = 16 * 1024) {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Expected application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(data);
}

export async function createGateway(config, { accounts, spacetime } = {}) {
  accounts ??= new AccountStore(config.dataDir);
  spacetime ??= new SpacetimeClient(config);
  const started = Date.now();
  const allowAuth = rateLimiter(config.authRateLimit);

  try {
    const id = await spacetime.ensureIdentity();
    log('info', 'gateway identity ready', { identity: id });
  } catch (e) {
    // The gateway still starts (health reports the problem) so operators can see what is wrong.
    log('error', 'could not obtain gateway identity; is SpacetimeDB running?', { error: e.message });
  }

  const clientIp = (req) =>
    (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (curl, server-to-server)
    if (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host; // same origin
    } catch {
      return false;
    }
  }

  async function login(req, res, { create }) {
    if (!allowAuth(clientIp(req))) throw new HttpError(429, 'Too many attempts, wait a minute and try again.');
    const body = await readJson(req);
    const { username, password, identityToken } = body ?? {};
    const problem = validateCredentials(username, password);
    if (problem) throw new HttpError(400, problem);

    // Verify the identity first so a bad token never creates an orphan account.
    const identity = await spacetime.verifyIdentityToken(identityToken);
    const account = create ? await accounts.create(username, password) : await accounts.verify(username, password);
    if (!account) throw new HttpError(create ? 409 : 401, create ? 'That username is taken.' : 'Wrong username or password.');

    try {
      await spacetime.authorizeSession(identity, account.username);
    } catch (e) {
      // Registration only counts if the player can actually play; otherwise a retry would hit "username taken".
      if (create) accounts.delete(account.username);
      log('error', 'authorize_session failed', { error: e.message });
      const hint = e.message.includes('Only the login gateway')
        ? 'Game server has not registered this gateway yet (run web/scripts/register-gateway.sh).'
        : 'Game server rejected the session.';
      throw new HttpError(503, hint);
    }
    log('info', create ? 'account created' : 'login', { username: account.username, identity });
    send(res, create ? 201 : 200, { username: account.username, identity });
  }

  const routes = {
    'GET /api/health': async (req, res) => {
      const stdb = await spacetime.health();
      let accountsOk = true;
      try {
        accounts.ping();
      } catch {
        accountsOk = false;
      }
      const ok = stdb.reachable && stdb.databaseFound && accountsOk && !!spacetime.identity;
      send(res, ok ? 200 : 503, {
        status: ok ? 'ok' : 'degraded',
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        gateway: { identity: spacetime.identity },
        spacetimedb: stdb,
        accounts: { ok: accountsOk },
      });
    },
    'GET /api/config': async (req, res) => {
      // The browser connects to SpacetimeDB through this same origin (/v1/... is proxied).
      send(res, 200, { database: config.database, spacetimePath: '/' });
    },
    'POST /api/auth/register': (req, res) => login(req, res, { create: true }),
    'POST /api/auth/login': (req, res) => login(req, res, { create: false }),
    'GET /api/leaderboard': async (req, res) => {
      const rows = await spacetime.sql('SELECT username, class, kills, deaths, gold FROM player');
      rows.sort((a, b) => b.kills - a.kills || b.gold - a.gold);
      send(res, 200, { players: rows.slice(0, 10) }, { 'cache-control': 'max-age=5' });
    },
  };

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, 'http://gateway');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.on('finish', () => {
      if (config.logRequests && !url.pathname.startsWith('/assets/')) {
        log('info', 'request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0, ip: clientIp(req) });
      }
    });
    try {
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (!originAllowed(req)) throw new HttpError(403, 'Origin not allowed');
        if (origin) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'origin');
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
          return res.end();
        }
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) throw new HttpError(404, 'Not found');
        return await handler(req, res);
      }
      if (url.pathname.startsWith('/v1/')) {
        const rule = proxyRule(req.method, url.pathname, config.database);
        if (rule === true) return proxyHttp(config.spacetimeUrl, req, res);
        throw new HttpError(rule === 'ws' ? 426 : 403, rule === 'ws' ? 'WebSocket upgrade required' : 'Endpoint not available');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(config.staticDir, req, res, url.pathname)) return;
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError || e instanceof SpacetimeError ? e.status : 500;
      if (status >= 500) log('error', 'request failed', { path: url.pathname, error: e.message });
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : e.message });
      else res.end();
    }
  });

  const liveSockets = new Set(); // upgraded WebSockets are not closed by server.close()
  server.on('upgrade', (req, socket, head) => {
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));
    const url = new URL(req.url, 'http://gateway');
    if (proxyRule('GET', url.pathname, config.database) !== 'ws' || !originAllowed(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
      return;
    }
    proxyUpgrade(config.spacetimeUrl, req, socket, head);
  });

  return {
    server,
    spacetime,
    accounts,
    listen: () => new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address()))),
    async close() {
      for (const s of liveSockets) s.destroy();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 5000).unref();
      });
      accounts.close();
    },
  };
}
