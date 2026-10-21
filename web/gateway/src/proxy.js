import http from 'node:http';
import https from 'node:https';

/**
 * Only the SpacetimeDB endpoints a game client needs are forwarded. Publishing,
 * reducer calls over HTTP, SQL, logs and database management are never exposed.
 */
export function proxyRule(method, pathname, database) {
  if (pathname === '/v1/ping' && method === 'GET') return true;
  if (pathname === '/v1/identity' && method === 'POST') return true;
  if (pathname === '/v1/identity/websocket-token' && method === 'POST') return true;
  if (pathname === '/v1/identity/public-key' && method === 'GET') return true;
  if (pathname === `/v1/database/${database}/subscribe` && method === 'GET') return 'ws';
  return false;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];

function upstreamOptions(target, req) {
  const url = new URL(req.url, target);
  const headers = { ...req.headers };
  for (const h of HOP_BY_HOP) delete headers[h];
  delete headers.cookie;
  headers.host = url.host;
  return { url, headers, lib: url.protocol === 'https:' ? https : http };
}

export function proxyHttp(target, req, res) {
  const { url, headers, lib } = upstreamOptions(target, req);
  const up = lib.request(url, { method: req.method, headers, timeout: 10_000 }, (upRes) => {
    const out = { ...upRes.headers };
    delete out['access-control-allow-origin']; // CORS is decided by the gateway
    res.writeHead(upRes.statusCode ?? 502, out);
    upRes.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'SpacetimeDB is unreachable' }));
  });
  req.pipe(up);
}

/** Forwards a WebSocket upgrade by replaying the handshake upstream and piping the raw sockets. */
export function proxyUpgrade(target, req, socket, head) {
  const { url, headers, lib } = upstreamOptions(target, req);
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade;
  const up = lib.request(url, { method: 'GET', headers });
  up.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    const close = () => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on('error', close);
    socket.on('error', close);
    upSocket.on('close', close);
    socket.on('close', close);
  });
  up.on('response', (upRes) => {
    socket.end(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\nconnection: close\r\n\r\n`);
  });
  up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'));
  up.end();
}
