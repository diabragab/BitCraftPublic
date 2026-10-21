import { resolve } from 'node:path';

const here = new URL('..', import.meta.url).pathname;

/** Reads configuration from environment variables (see web/.env.example). */
export function loadConfig(env = process.env) {
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    host: env.GATEWAY_HOST ?? '127.0.0.1',
    port: Number(env.GATEWAY_PORT ?? 8080),
    spacetimeUrl: (env.SPACETIME_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, ''),
    database: env.SPACETIME_DB ?? 'kaykit-arena',
    dataDir: resolve(here, env.GATEWAY_DATA_DIR ?? '../.data'),
    tokenFile: resolve(here, env.GATEWAY_TOKEN_FILE ?? '../.secrets/gateway-token'),
    staticDir: env.GATEWAY_STATIC_DIR === '' ? null : resolve(here, env.GATEWAY_STATIC_DIR ?? '../client/dist'),
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    trustProxy: env.TRUST_PROXY === '1',
    authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 20),
    logRequests: env.LOG_REQUESTS !== '0',
  };
}
