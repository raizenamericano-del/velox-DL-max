'use strict';

const providers = require('../lib/providers');
const engine = require('../lib/ytdlp');
const { fromMedia } = require('./normalize');

/**
 * Platform-agnostic resolver methods backed by the third-party AIO providers.
 * Each factory returns `{ name, run(ctx) }` so a platform resolver can splice
 * them into its chain wherever it wants.
 */

const REFERER = {
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
  twitter: 'https://x.com/',
  threads: 'https://www.threads.net/',
  pinterest: 'https://www.pinterest.com/',
  rednote: 'https://www.xiaohongshu.com/',
  tiktok: 'https://www.tiktok.com/',
};

/** Providers love placeholder titles ("Facebook", "- Facebook Reel"); make them presentable. */
function tidyTitle(title, platformName) {
  let t = String(title || '').replace(/^[\s\-–—|:·]+/, '').replace(/[\s\-–—|:·]+$/, '').trim();
  if (!t || t.toLowerCase() === platformName.toLowerCase() || /^facebook( reel| video)?$/i.test(t)) t = `${platformName} ${/reel/i.test(title || '') ? 'Reel' : 'video'}`;
  return t;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null));

/** izuka /api/downloader/aio-v2 → canonical result. Works for IG, FB, X, Pinterest, Threads(photo) and more. */
function izukaAio() {
  return {
    name: 'izuka-aio',
    optional: () => !providers.enabled('izuka'),
    async run(ctx) {
      const r = await providers.izuka('aio-v2', ctx.url.href);
      const media = [];
      for (const v of r.videos || []) {
        if (!v?.url || v.is_hls) continue;
        media.push({ kind: 'video', url: v.url, quality: v.quality, ext: v.format || 'mp4', size: num(v.size) });
      }
      for (const a of r.audios || []) if (a?.url) media.push({ kind: 'audio', url: a.url, ext: a.format || 'm4a', size: num(a.size) });
      for (const p of r.photos || []) if (p?.url) media.push({ kind: 'image', url: p.url, ext: p.format || 'jpg', quality: p.quality });
      // single-url shapes (some sources)
      if (!media.length && r.url) media.push({ kind: r.type === 'image' ? 'image' : 'video', url: r.url });

      const author = r.author && r.authorUsername && !String(r.author).includes(r.authorUsername)
        ? `${r.author} (@${r.authorUsername})` : (r.author || (r.authorUsername ? `@${r.authorUsername}` : null));
      return fromMedia({
        platform: ctx.platform.id, platformName: ctx.platform.name, url: ctx.url.href,
        title: tidyTitle(r.title || r.caption, ctx.platform.name),
        author: author ? String(author).replace(/&#064;/g, '@') : null,
        thumbnail: r.thumbnail || null,
        duration: r.duration || null,
        views: num(r.viewCount), likes: num(r.likeCount),
        media, referer: REFERER[ctx.platform.id], ffmpeg: engine.hasFfmpeg(),
      });
    },
  };
}

/** savefbs AIO → canonical result. Direct CDN urls are recovered from the proxy tokens. */
function savefbsAio() {
  return {
    name: 'savefbs',
    optional: () => !providers.enabled('savefbs'),
    async run(ctx) {
      const r = await providers.savefbs(ctx.url.href);
      const media = r.links.map((l) => ({
        kind: l.kind,
        url: l.url,
        quality: l.quality,
        ext: l.kind === 'audio' ? (l.converted ? 'mp3' : 'm4a') : 'mp4',
        label: l.kind === 'audio' && l.converted ? 'Audio · MP3 (dikonversi)' : undefined,
      }));
      // a converted MP3 proxy link is only useful when it actually is MP3; keep it as the native option
      return fromMedia({
        platform: ctx.platform.id, platformName: ctx.platform.name, url: ctx.url.href,
        title: tidyTitle(r.title, ctx.platform.name),
        author: r.owner && r.owner !== 'User' ? r.owner : null,
        thumbnail: r.thumbnail,
        media, referer: REFERER[ctx.platform.id], ffmpeg: engine.hasFfmpeg(),
      });
    },
  };
}

module.exports = { izukaAio, savefbsAio, REFERER, num, tidyTitle };
