'use strict';

const os = require('os');

const env = process.env;
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const BROWSER_UA =
  env.APP_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

module.exports = {
  appName: env.APP_NAME || 'VELOX',
  tagline: env.APP_TAGLINE || 'Satu link. Semua platform.',
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  nodeEnv: env.NODE_ENV || 'development',
  trustProxy: bool(env.TRUST_PROXY, true),

  // ── Engine ────────────────────────────────────────────────────────────
  ytdlpPath: env.YT_DLP_PATH || '',           // explicit binary path; empty = auto-detect
  ytdlpAutoInstall: bool(env.YTDLP_AUTO_INSTALL, true),
  ytdlpAutoUpdate: bool(env.YTDLP_AUTO_UPDATE, true),
  ytdlpUpdateHours: int(env.YTDLP_UPDATE_HOURS, 12),
  cookiesFile: env.YTDLP_COOKIES || '',        // Netscape cookies.txt for IG / gated content
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',

  // ── Behaviour ─────────────────────────────────────────────────────────
  cacheTtlMs: int(env.CACHE_TTL_MINUTES, 10) * 60_000,
  cacheMaxEntries: int(env.CACHE_MAX_ENTRIES, 500),
  resolveTimeoutMs: int(env.RESOLVE_TIMEOUT_SECONDS, 45) * 1000,
  maxPlaylistItems: int(env.MAX_PLAYLIST_ITEMS, 30),
  maxMergeHeight: int(env.MAX_MERGE_HEIGHT, 1080), // cap for merged "best quality" (4K/8K would exhaust disk)

  // ── Protection ────────────────────────────────────────────────────────
  rateWindowMs: int(env.RATE_WINDOW_SECONDS, 60) * 1000,
  rateMaxResolve: int(env.RATE_MAX_RESOLVE, 20),
  rateMaxDownload: int(env.RATE_MAX_DOWNLOAD, 40),
  allowDirectProxy: bool(env.ALLOW_DIRECT_PROXY, true),
  corsOrigin: env.CORS_ORIGIN || '*',

  // ── Upstreams ─────────────────────────────────────────────────────────
  userAgent: BROWSER_UA,
  tikwmBase: (env.TIKWM_BASE || 'https://www.tikwm.com').replace(/\/$/, ''),
  cobaltBase: (env.COBALT_BASE || '').replace(/\/$/, ''), // optional self-hosted cobalt instance
  cobaltKey: env.COBALT_API_KEY || '',
  igApiEndpoint: env.IG_API_ENDPOINT || '',             // optional 3rd-party IG endpoint

  // ── Third-party provider backends (keyless; see server/lib/providers.js) ─
  providersDisabled: String(env.PROVIDERS_DISABLED || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  providerTimeoutMs: int(env.PROVIDER_TIMEOUT_SECONDS, 15) * 1000,
  izukaBase: (env.IZUKA_BASE || 'https://my.izuka-api.xyz').replace(/\/$/, ''),
  savefbsBase: (env.SAVEFBS_BASE || 'https://savefbs.com').replace(/\/$/, ''),
  azbryBase: (env.AZBRY_BASE || 'https://api.azbry.com').replace(/\/$/, ''),
  threadsWorkerBase: (env.THREADS_WORKER_BASE || 'https://workers-playground-cool-wood-c008.accoutydusra.workers.dev').replace(/\/$/, ''),

  // ── Engine circuit breaker ────────────────────────────────────────────
  // After N consecutive "blocked/login/bot-check" failures for a platform the
  // engine is demoted behind the third-party providers for M minutes.
  engineBreakerThreshold: int(env.ENGINE_BREAKER_THRESHOLD, 2),
  engineBreakerMinutes: int(env.ENGINE_BREAKER_MINUTES, 15),

  tmpDir: env.TMPDIR || os.tmpdir(),
};
