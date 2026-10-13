'use strict';

const { getJson } = require('../lib/http');
const providers = require('../lib/providers');
const engine = require('../lib/ytdlp');
const { fromMedia } = require('./normalize');
const { izukaAio, savefbsAio, REFERER } = require('./thirdparty');

/**
 * X / Twitter fallback via the public syndication CDN.
 * Needs no login and returns every media variant of a public tweet.
 * Token algorithm is the one the official embed widget uses.
 */

const ID_RE = /(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com)\/(?:[^/]+\/status(?:es)?\/|i\/(?:status|web\/detail)\/|i\/events\/)(\d+)/i;

function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, '');
}

async function viaSyndication(ctx) {
  const m = ctx.url.href.match(ID_RE);
  if (!m) throw new Error('not a tweet status link');
  const id = m[1];
  const json = await getJson(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`, {
    timeoutMs: 15_000,
    headers: { referer: 'https://platform.twitter.com/' },
  });

  if (json.__typename === 'TweetTombstone') throw new Error('No video could be found in this tweet (tombstone)');

  const details = json.mediaDetails || [];
  const photos = json.photos || [];
  const media = [];

  for (const item of details) {
    if (item.type === 'video' || item.type === 'animated_gif') {
      const variants = (item.video_info?.variants || [])
        .filter((v) => (v.content_type || v.type) === 'video/mp4' && v.url);
      for (const v of variants) {
        const dims = v.url.match(/\/(\d{2,4})x(\d{2,4})\//);
        media.push({
          kind: 'video', url: v.url,
          width: dims ? Number(dims[1]) : undefined, height: dims ? Number(dims[2]) : undefined,
          quality: dims ? `${dims[1]}x${dims[2]}` : undefined,
          label: item.type === 'animated_gif' ? 'GIF · MP4' : undefined,
        });
      }
    } else if (item.type === 'photo' && item.media_url_https) {
      media.push({ kind: 'image', url: `${item.media_url_https}?name=orig` });
    }
  }
  if (!details.length) for (const p of photos) if (p.url) media.push({ kind: 'image', url: `${p.url}${p.url.includes('?') ? '&' : '?'}name=orig` });

  if (!media.length) throw new Error('No video could be found in this tweet');

  const durMs = json.video?.durationMs;
  return fromMedia({
    platform: 'twitter', platformName: 'X / Twitter', url: ctx.url.href,
    title: (json.text || 'Tweet media').replace(/\s*https:\/\/t\.co\/\w+$/, ''),
    author: json.user ? `${json.user.name} (@${json.user.screen_name})` : null,
    thumbnail: json.video?.poster || details[0]?.media_url_https || photos[0]?.url || null,
    duration: durMs ? Math.round(durMs / 1000) : null,
    views: json.video?.viewCount || null, likes: json.favorite_count ?? null,
    media, referer: REFERER.twitter, ffmpeg: engine.hasFfmpeg(), id,
  });
}

async function viaIzukaTwitter(ctx) {
  const r = await providers.izuka('twitter', ctx.url.href);
  const media = [];
  for (const v of r.videos || []) {
    const variants = (v.variants || []).filter((x) => x?.url && (!x.mimeType || /mp4/.test(x.mimeType)));
    for (const x of variants) media.push({ kind: 'video', url: x.url, quality: x.quality });
  }
  for (const p of r.photos || []) if (p?.url || typeof p === 'string') media.push({ kind: 'image', url: p.url || p });
  return fromMedia({
    platform: 'twitter', platformName: 'X / Twitter', url: ctx.url.href,
    title: r.text || 'Tweet media',
    author: r.user?.screen_name ? `@${r.user.screen_name}` : (r.user?.name || null),
    thumbnail: r.thumbnail || null,
    media, referer: REFERER.twitter, ffmpeg: engine.hasFfmpeg(), id: r.id || undefined,
  });
}

module.exports = {
  id: 'twitter',
  name: 'X / Twitter',
  methods: [
    { name: 'syndication', run: viaSyndication },
    { name: 'izuka-x', run: viaIzukaTwitter, optional: () => !providers.enabled('izuka') },
    { name: 'engine' },
    savefbsAio(),
    izukaAio(),
  ],
};
