import { loadConfig } from './config.js';
import { log } from './log.js';
import { createGateway } from './server.js';

const config = loadConfig();
const gateway = await createGateway(config);
const addr = await gateway.listen();
log('info', 'gateway listening', {
  url: `http://${addr.address}:${addr.port}`,
  spacetimedb: config.spacetimeUrl,
  database: config.database,
  static: config.staticDir,
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { signal });
  await gateway.close();
  log('info', 'shutdown complete');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
