'use strict';

const tiktok = require('./tiktok');
const instagram = require('./instagram');
const twitter = require('./twitter');
const youtube = require('./youtube');
const facebook = require('./facebook');
const threads = require('./threads');
const pinterest = require('./pinterest');
const rednote = require('./rednote');
const generic = require('./generic');
const { izukaAio, savefbsAio } = require('./thirdparty');
const engine = require('../lib/ytdlp');
const { friendlyError, AppError } = require('../lib/errors');
const { Semaphore } = require('../lib/semaphore');
const config = require('../config');

const engineSlot = new Semaphore(parseInt(process.env.MAX_CONCURRENT_RESOLVE, 10) || 4);

const SPECIFIC = { tiktok, instagram, twitter, youtube, facebook, threads, pinterest, rednote };

// ── Engine circuit breaker ─────────────────────────────────────────────
// Cloud IPs get "Sign in to confirm you're not a bot" (YouTube) or login
// walls (Instagram) from yt-dlp. Each such failure costs seconds before the
// providers get their turn, so after N consecutive ones per platform the
// engine is demoted to the END of the chain for a while. A later success
// (or the timer) restores it, so quality comes back on its own.
const BREAKER_CODES = new Set(['ACCESS_RESTRICTED', 'BOT_CHECK', 'UPSTREAM_BLOCKED', 'UPSTREAM_RATE_LIMITED', 'TIMEOUT']);
const breaker = new Map(); // platformId → { fails, until }

function engineDemoted(platformId) {
  const b = breaker.get(platformId);
  if (!b) return false;
  if (b.until && b.until > Date.now()) return true;
  if (b.until && b.until <= Date.now()) { breaker.delete(platformId); }
  return false;
}
function noteEngineFailure(platformId, code) {
  if (!BREAKER_CODES.has(code)) return;
  const b = breaker.get(platformId) || { fails: 0, until: 0 };
  b.fails += 1;
  b.lastCode = code;
  if (b.fails >= config.engineBreakerThreshold) b.until = Date.now() + config.engineBreakerMinutes * 60_000;
  breaker.set(platformId, b);
}
function noteEngineSuccess(platformId) { breaker.delete(platformId); }
function breakerState() {
  const out = {};
  for (const [k, v] of breaker) out[k] = { fails: v.fails, lastCode: v.lastCode || null, demotedUntil: v.until && v.until > Date.now() ? new Date(v.until).toISOString() : null };
  return out;
}

const ENGINE_METHOD = generic.methods[0];
const UNIVERSAL_FALLBACKS = [izukaAio(), savefbsAio()];

/**
 * Build the attempt chain for a platform.
 * Order matters: fastest/most-likely-to-work first; the engine sits wherever
 * the resolver put it (or first by default) unless the breaker demoted it;
 * the keyless AIO providers close the chain for every platform.
 */
function chainFor(ctx) {
  const specific = SPECIFIC[ctx.platform.id];
  let chain = [];

  if (specific) {
    let methods = specific.methods
      .filter((m) => !m.optional || !m.optional())
      .map((m) => (m.name === 'engine' && !m.run ? { ...m, run: ENGINE_METHOD.run } : m));

    // With cookies configured, the engine is the better primary for Instagram
    // (HD sources, carousels, stories).
    if (specific.id === 'instagram' && config.cookiesFile && !methods.some((m) => m.name === 'engine')) {
      methods = [{ name: 'engine', run: ENGINE_METHOD.run }, ...methods];
    }
    chain = methods.map((m) => ({ resolver: specific, method: m }));
  }

  if (!chain.some((c) => c.method.name === 'engine')) {
    chain.push({ resolver: generic, method: ENGINE_METHOD });
  }

  for (const m of UNIVERSAL_FALLBACKS) {
    if (!chain.some((c) => c.method.name === m.name) && (!m.optional || !m.optional())) chain.push({ resolver: generic, method: m });
  }

  if (engineDemoted(ctx.platform.id)) {
    const idx = chain.findIndex((c) => c.method.name === 'engine');
    if (idx > -1 && chain.length > 1) chain.push(...chain.splice(idx, 1));
  }
  return chain;
}

// Platforms with no reliable keyless backend from a cloud IP get an honest
// message instead of whichever provider happened to fail last.
const PLATFORM_NOTES = {
  rednote: {
    title: 'RedNote belum bisa diambil dari server ini 🙏',
    message: 'Xiaohongshu membatasi akses dari luar aplikasinya dan semua jalur cadangan ikut gagal untuk link ini.',
    hint: 'Coba link share dari aplikasi (xhslink.com) atau coba lagi nanti; dukungan RedNote masih terbatas.',
  },
};

// Higher = more informative. A hard answer ("deleted") beats a vague one ("timeout").
const ERROR_RANK = {
  NOT_FOUND: 6, ACCESS_RESTRICTED: 5, BOT_CHECK: 4, UPSTREAM_BLOCKED: 3,
  UPSTREAM_RATE_LIMITED: 3, NO_MEDIA: 2, TIMEOUT: 1, NETWORK: 1, ENGINE_MISSING: 0, RESOLVE_FAILED: 0,
};

/**
 * Resolve a URL into the canonical result shape.
 * Every method in the chain gets a turn — a broken or blocked upstream
 * degrades into the next one instead of failing the request. Only the
 * engine's own errors are allowed to speak for the engine (ENGINE_MISSING
 * skips the remaining engine attempts, nothing else).
 */
async function resolve(ctx) {
  const chain = chainFor(ctx);
  const attempts = [];
  let bestError = null;
  let engineMissing = false;
  // Overall budget: a long chain of slow failures must still answer within
  // something a browser (and a proxy) will wait for. Every method gets a turn
  // until the budget is spent; the first one always runs.
  const deadline = Date.now() + Math.max(config.resolveTimeoutMs, 30_000) * 1.5;

  for (const { resolver, method } of chain) {
    if (engineMissing && method.name === 'engine') continue;
    if (attempts.length && Date.now() > deadline) {
      attempts.push({ resolver: resolver.id, method: method.name, ok: false, ms: 0, error: 'SKIPPED_BUDGET' });
      continue;
    }
    const t0 = Date.now();
    let slot = false;
    try {
      if (method.name === 'engine') {
        await engineSlot.acquire(config.resolveTimeoutMs + 5000);
        slot = true;
      }
      const result = await method.run(ctx);
      if (!result?.items?.length) throw new Error('resolver returned no items');

      if (method.name === 'engine') noteEngineSuccess(ctx.platform.id);
      result.via = method.name;
      result.engine = { name: 'yt-dlp', version: engine.status().version, ffmpeg: engine.hasFfmpeg() };
      result.attempts = attempts.concat([{ resolver: resolver.id, method: method.name, ok: true, ms: Date.now() - t0 }]);
      return result;
    } catch (err) {
      const friendly = friendlyError(err, { platform: ctx.platform.name });
      const entry = { resolver: resolver.id, method: method.name, ok: false, ms: Date.now() - t0, error: friendly.code };
      attempts.push(entry);

      if (method.name === 'engine') {
        if (friendly.code === 'ENGINE_MISSING') engineMissing = true;
        else noteEngineFailure(ctx.platform.id, friendly.code);
      }

      // Only the engine's verdicts on "gone"/"locked" are trustworthy; a
      // provider that answers 404 may simply not support the link, so its
      // errors never outrank anything the engine itself concluded.
      const trusted = method.name === 'engine' || method.name === 'tikwm' || method.name === 'syndication';
      const rank = trusted ? (ERROR_RANK[friendly.code] ?? 0) : Math.min(ERROR_RANK[friendly.code] ?? 0, 1.5);
      const bestRank = bestError ? bestError._rank : -Infinity;
      if (!bestError || rank > bestRank) {
        bestError = Object.assign(friendly, { _rank: rank });
      }
    } finally {
      if (slot) engineSlot.release();
    }
  }

  if (bestError) {
    delete bestError._rank;
    bestError.attempts = attempts;
    const note = PLATFORM_NOTES[ctx.platform.id];
    if (note && !['NOT_FOUND', 'ACCESS_RESTRICTED'].includes(bestError.code)) {
      bestError.title = note.title;
      bestError.message = note.message;
      bestError.hint = note.hint;
    }
    throw bestError;
  }
  throw new AppError('RESOLVE_FAILED', { status: 500, title: 'Tidak ada resolver yang cocok', message: 'Tidak ada metode yang bisa menangani link ini.' });
}

module.exports = { resolve, chainFor, engineSlot, SPECIFIC, generic, breakerState, noteEngineFailure, noteEngineSuccess, _breaker: breaker };
