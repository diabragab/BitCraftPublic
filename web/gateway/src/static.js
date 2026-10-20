import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

// Compressed responses are cached in memory (keyed by path + mtime); the client bundle is a few MB.
const gzCache = new Map();
function gzipped(file, mtimeMs) {
  const hit = gzCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.buf;
  const buf = gzipSync(readFileSync(file), { level: 9 });
  gzCache.set(file, { mtimeMs, buf });
  return buf;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.glb', '.svg', '.txt', '.webmanifest']);

/** Serves the built client. Unknown paths fall back to index.html (single-page app). */
export function serveStatic(root, req, res, pathname) {
  if (!root || !existsSync(root)) return false;
  let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(root, rel);
  if (!file.startsWith(root + sep) && file !== root) return false; // path traversal
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(rel)) return false; // missing asset -> 404 instead of index.html
    file = join(root, 'index.html');
    rel = 'index.html';
    if (!existsSync(file)) return false;
  }
  const ext = extname(file);
  const headers = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    // Vite emits content-hashed file names under /assets/js; everything else is revalidated.
    'cache-control': rel.startsWith('assets/js/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  const st = statSync(file);
  headers.vary = 'accept-encoding';
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    const body = gzipped(file, st.mtimeMs);
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end(), true;
  createReadStream(file).pipe(res);
  return true;
}
