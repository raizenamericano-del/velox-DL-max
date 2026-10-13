'use strict';

const providers = require('../lib/providers');
const engine = require('../lib/ytdlp');
const generic = require('./generic');
const { fromMedia } = require('./normalize');
const { izukaAio, REFERER } = require('./thirdparty');

/**
 * Threads.
 *   engine (yt-dlp only knows threads.net, so threads.com is rewritten)
 *   → izuka threads → threadsvid worker → izuka aio-v2 (photos)
 */
const toNet = (href) => href.replace(/^https?:\/\/(www\.)?threads\.com\//i, 'https://www.threads.net/');

async function viaEngine(ctx) {
  const u = new URL(toNet(ctx.url.href));
  return generic.methods[0].run({ ...ctx, url: u });
}

async function viaIzukaThreads(ctx) {
  const r = await providers.izuka('threads', ctx.url.href);
  const list = Array.isArray(r.Result) ? r.Result : Array.isArray(r.result) ? r.result : [];
  const media = list.filter((m) => m?.Result_url || m?.url).map((m) => ({
    kind: /image|photo/i.test(m.Type || m.type) ? 'image' : 'video',
    url: m.Result_url || m.url,
    quality: m.Quality || m.quality,
  }));
  return fromMedia({
    platform: 'threads', platformName: 'Threads', url: ctx.url.href,
    title: r.Title || r.title || 'Threads post',
    author: r.Author || r.author ? `@${String(r.Author || r.author).replace(/^@/, '')}` : null,
    thumbnail: list[0]?.Thumbnail || list[0]?.thumbnail || null,
    media, referer: REFERER.threads, ffmpeg: engine.hasFfmpeg(),
  });
}

async function viaWorker(ctx) {
  const d = await providers.threadsWorker(ctx.url.href);
  const media = [];
  const pushQualities = (qs) => {
    for (const q of qs || []) if (q?.url && !/dash_ln_heaac|_audio|m78\//.test(q.url)) media.push({ kind: 'video', url: q.url, quality: q.quality });
  };
  // "video.qualities" is the primary rendition; "videos.items" are the DASH ladders of the same clip
  pushQualities(d.video?.qualities);
  if (!media.length) for (const it of d.videos?.items || []) pushQualities(it.qualities);
  for (const im of d.images?.urls || d.images?.items || []) if (im?.url) media.push({ kind: 'image', url: im.url });
  return fromMedia({
    platform: 'threads', platformName: 'Threads', url: ctx.url.href,
    title: d.title || d.description || 'Threads post',
    author: d.author ? `@${String(d.author).replace(/^@/, '')}` : null,
    thumbnail: d.thumbnail || null, duration: d.video?.duration || null,
    media, referer: REFERER.threads, ffmpeg: engine.hasFfmpeg(),
  });
}

module.exports = {
  id: 'threads',
  name: 'Threads',
  methods: [
    { name: 'engine', run: viaEngine },
    { name: 'izuka-threads', run: viaIzukaThreads, optional: () => !providers.enabled('izuka') },
    { name: 'threads-worker', run: viaWorker, optional: () => !providers.enabled('threadsworker') },
    izukaAio(),
  ],
};
