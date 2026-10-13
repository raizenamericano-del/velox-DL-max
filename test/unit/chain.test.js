'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const resolvers = require('../../server/resolvers');
const config = require('../../server/config');
const { detect } = require('../../server/lib/detect');
const { AppError } = require('../../server/lib/errors');

const ctxFor = (href) => ({ url: new URL(href), platform: detect(new URL(href)) });
const names = (chain) => chain.map((c) => c.method.name);

const fakeResult = (via) => ({
  platform: 'x', platformName: 'X', url: 'https://x/1', title: via, kind: 'video', isPlaylist: false,
  items: [{ id: '1', title: via, kind: 'video', formats: [{ id: 'v', label: 'v', tag: 'HD', ext: 'mp4', kind: 'video', url: '/api/dl?t=direct&u=x' }] }],
  warnings: [],
});

/**
 * Temporarily swap a resolver's methods so resolve() runs a scripted chain.
 * All third-party providers are disabled meanwhile so the universal AIO
 * fallbacks (and the engine's own network calls) stay out of unit tests.
 */
function withMethods(platformId, methods, fn) {
  const spec = resolvers.SPECIFIC[platformId];
  const original = spec.methods;
  const disabled = config.providersDisabled.slice();
  spec.methods = methods;
  config.providersDisabled.splice(0, config.providersDisabled.length, 'izuka', 'savefbs', 'azbry', 'threadsworker');
  return Promise.resolve().then(fn).finally(() => {
    spec.methods = original;
    config.providersDisabled.splice(0, config.providersDisabled.length, ...disabled);
    resolvers._breaker.clear();
  });
}

test('chainFor(): Instagram puts keyless providers before the dead embed and the engine', () => {
  const chain = names(resolvers.chainFor(ctxFor('https://www.instagram.com/reel/abc/')));
  assert.ok(chain.indexOf('izuka-aio') < chain.indexOf('embed'));
  assert.ok(chain.indexOf('savefbs') < chain.indexOf('engine'));
  assert.ok(chain.includes('engine'), 'engine is still in the chain as a safety net');
});

test('chainFor(): YouTube keeps the engine first, provider fallbacks after', () => {
  const chain = names(resolvers.chainFor(ctxFor('https://youtu.be/dQw4w9WgXcQ')));
  assert.strictEqual(chain[0], 'engine');
  assert.ok(chain.includes('izuka-yt'));
});

test('chainFor(): every platform ends with the universal AIO fallbacks exactly once', () => {
  for (const href of ['https://vimeo.com/1', 'https://www.tiktok.com/@a/video/1', 'https://www.linkedin.com/posts/a_1', 'https://x.com/a/status/1']) {
    const chain = names(resolvers.chainFor(ctxFor(href)));
    assert.strictEqual(chain.filter((n) => n === 'izuka-aio').length, 1, href);
    assert.strictEqual(chain.filter((n) => n === 'savefbs').length, 1, href);
    assert.strictEqual(chain.filter((n) => n === 'engine').length, 1, href);
  }
});

test('chainFor(): TikTok primary path is untouched (tikwm first, engine second)', () => {
  const chain = names(resolvers.chainFor(ctxFor('https://www.tiktok.com/@a/video/1')));
  assert.deepStrictEqual(chain.slice(0, 2), ['tikwm', 'engine']);
});

test('resolve(): a provider NOT_FOUND no longer short-circuits the chain', async () => {
  await withMethods('pinterest', [
    { name: 'izuka-aio', run: async () => { throw new Error('HTTP Error 404: Not Found'); } },
    { name: 'savefbs', run: async () => fakeResult('savefbs') },
  ], async () => {
    const r = await resolvers.resolve(ctxFor('https://www.pinterest.com/pin/1/'));
    assert.strictEqual(r.via, 'savefbs');
    assert.deepStrictEqual(r.attempts.map((a) => `${a.method}:${a.ok ? 'ok' : a.error}`), ['izuka-aio:NOT_FOUND', 'savefbs:ok']);
  });
});

test('resolve(): ENGINE_MISSING skips only further engine attempts', async () => {
  const seen = [];
  await withMethods('facebook', [
    { name: 'engine', run: async () => { seen.push('engine'); throw new Error('yt-dlp not found on this server'); } },
    { name: 'azbry-fb', run: async () => { seen.push('azbry'); return fakeResult('azbry-fb'); } },
  ], async () => {
    const r = await resolvers.resolve(ctxFor('https://www.facebook.com/watch/?v=1'));
    assert.strictEqual(r.via, 'azbry-fb');
    assert.deepStrictEqual(seen, ['engine', 'azbry']);
  });
});

test('resolve(): engine verdicts outrank provider noise in the final error', async () => {
  await withMethods('facebook', [
    { name: 'engine', run: async () => { throw new Error('ERROR: [facebook] 1: This video is private'); } },
    { name: 'azbry-fb', run: async () => { throw new Error('HTTP Error 404'); } },
  ], async () => {
    await assert.rejects(resolvers.resolve(ctxFor('https://www.facebook.com/watch/?v=1')), (err) => {
      assert.ok(err instanceof AppError);
      assert.strictEqual(err.code, 'ACCESS_RESTRICTED');
      assert.deepStrictEqual(err.attempts.map((a) => a.error), ['ACCESS_RESTRICTED', 'NOT_FOUND'], 'both methods were tried');
      return true;
    });
  });
});

test('resolve(): bot-check failures demote the engine for the platform (circuit breaker)', async () => {
  const threshold = config.engineBreakerThreshold;
  const botError = async () => { throw new Error('ERROR: [youtube] abc: Sign in to confirm you’re not a bot.'); };
  await withMethods('youtube', [
    { name: 'engine', run: botError },
    { name: 'izuka-yt', run: async () => fakeResult('izuka-yt') },
  ], async () => {
    const ctx = ctxFor('https://youtu.be/dQw4w9WgXcQ');
    for (let i = 0; i < threshold; i++) {
      const r = await resolvers.resolve(ctx);
      assert.strictEqual(r.via, 'izuka-yt');
      assert.strictEqual(r.attempts[0].error, 'BOT_CHECK');
    }
    const state = resolvers.breakerState();
    assert.ok(state.youtube?.demotedUntil, 'engine demoted after repeated bot checks');
    const chain = names(resolvers.chainFor(ctx));
    assert.strictEqual(chain[chain.length - 1], 'engine', 'engine moved to the end of the chain');
    assert.strictEqual(chain[0], 'izuka-yt');

    // once the engine succeeds again the breaker resets
    resolvers.noteEngineSuccess('youtube');
    assert.deepStrictEqual(resolvers.breakerState(), {});
    assert.strictEqual(names(resolvers.chainFor(ctx))[0], 'engine');
  });
});

test('resolve(): RedNote failure explains the platform limitation', async () => {
  await withMethods('rednote', [
    { name: 'engine', run: async () => { throw new Error('No video formats found'); } },
  ], async () => {
    await assert.rejects(resolvers.resolve(ctxFor('https://www.xiaohongshu.com/explore/1')), (err) => {
      assert.match(err.title, /RedNote/);
      assert.ok(err.hint);
      return true;
    });
  });
});

test('friendlyError(): bot check gets its own code and a 503', () => {
  const { friendlyError } = require('../../server/lib/errors');
  const e = friendlyError(new Error('Sign in to confirm you’re not a bot'), { platform: 'YouTube' });
  assert.strictEqual(e.code, 'BOT_CHECK');
  assert.strictEqual(e.status, 503);
  assert.match(e.title, /robot/i);
});
