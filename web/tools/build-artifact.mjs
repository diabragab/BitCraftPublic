// Builds the single-player pages (OFFLINE=1) and writes client/dist-offline/artifact.html: the open
// world (world.html) without <!doctype>/<html>/<head>/<body>, for hosts such as claude.ai that wrap
// the published page in their own document skeleton. Usage: node tools/build-artifact.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const client = join(dirname(fileURLToPath(import.meta.url)), '..', 'client');
execFileSync('npx', ['vite', 'build'], { cwd: client, stdio: 'inherit', env: { ...process.env, OFFLINE: '1' } });

// The host serves only standard web file types, so each .glb ships as { "base64": ... } JSON
// (decoded by client/src/assets.ts in this build).
let models = 0;
for (const entry of readdirSync(join(client, 'dist-offline', 'assets'), { recursive: true })) {
  if (!entry.endsWith('.glb')) continue;
  const file = join(client, 'dist-offline', 'assets', entry);
  writeFileSync(file + '.json', JSON.stringify({ base64: readFileSync(file).toString('base64') }));
  unlinkSync(file);
  models++;
}
console.log(`wrapped ${models} models as .glb.json`);

const html = readFileSync(join(client, 'dist-offline', 'world.html'), 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? '';
const keep = (re) => [...head.matchAll(re)].map((m) => m[0]);
const page = [
  ...keep(/<title>[\s\S]*?<\/title>/g), // the host reads the title from the top of the file
  ...keep(/<meta name="theme-color"[^>]*>/g),
  '<meta name="description" content="Hearthwild: an open-world survival RPG that runs entirely in your browser." />',
  ...keep(/<link [^>]*>/g),
  ...keep(/<script [\s\S]*?<\/script>/g),
  body.trim(),
].join('\n');
writeFileSync(join(client, 'dist-offline', 'artifact.html'), page + '\n');
console.log(`artifact.html written (${page.length} bytes)`);
