'use strict';

const { getText, metaContent, getJson } = require('../lib/http');
const providers = require('../lib/providers');
const engine = require('../lib/ytdlp');
const { dlDirect, slugify, fromMedia } = require('./normalize');
const { izukaAio, savefbsAio, REFERER } = require('./thirdparty');
const config = require('../config');

/**
 * Instagram.
 *
 * From a datacenter IP Instagram serves its public pages (and the /embed/
 * page) as a login shell, and yt-dlp needs cookies — so the keyless
 * third-party backends go FIRST and the engine is the safety net:
 *
 *  1. izuka aio-v2   — title/author/thumb/likes + every video/photo of a carousel
 *  2. izuka instagram — leaner, same backend family
 *  3. savefbs         — different operator; direct CDN urls recovered from tokens
 *  4. embed page      — still works from residential IPs / with luck
 *  5. (engine)        — appended by the chain builder; promoted to #1 when cookies exist
 */

const CODE_RE = /instagram\.com\/(?:[a-z]{2,3}\/)?(?:p|reel|reels|tv|share)\/([A-Za-z0-9_-]+)/i;
const STORY_RE = /instagram\.com\/stories\/([^/]+)\/([A-Za-z0-9_-]+)/i;

function shortcode(ctx) {
  const m = ctx.url.href.match(CODE_RE);
  return m ? m[1] : null;
}

async function viaCustomApi(ctx) {
  if (!config.igApiEndpoint) throw new Error('no custom IG endpoint configured');
  const u = config.igApiEndpoint.includes('{url}')
    ? config.igApiEndpoint.replace('{url}', encodeURIComponent(ctx.url.href))
    : `${config.igApiEndpoint}?url=${encodeURIComponent(ctx.url.href)}`;
  const json = await getJson(u, { timeoutMs: 20_000 });
  const list = json.data?.media || json.media || json.result?.media || json.data || json.result || json;
  const arr = Array.isArray(list) ? list : Array.isArray(list?.videos) ? list.videos : null;
  if (!arr || !arr.length) throw new Error('custom IG endpoint returned nothing');
  return fromMedia({
    platform: 'instagram', platformName: 'Instagram', url: ctx.url.href,
    title: json.data?.title || json.title || 'Instagram post',
    author: json.data?.author || json.author || null,
    thumbnail: json.data?.thumbnail || json.thumbnail || null,
    media: arr.map((m) => ({ kind: m.type === 'image' ? 'image' : 'video', url: m.url || m.video_url || m.display_url })),
    referer: REFERER.instagram, ffmpeg: engine.hasFfmpeg(),
  });
}

async function viaIzukaInstagram(ctx) {
  const r = await providers.izuka('instagram', ctx.url.href);
  const list = Array.isArray(r.media) ? r.media : [];
  return fromMedia({
    platform: 'instagram', platformName: 'Instagram', url: ctx.url.href,
    title: r.caption || r.title || `Instagram ${r.type === 'image' ? 'post' : 'Reel'}`,
    author: r.author ? `@${String(r.author).replace(/^@/, '')}` : null,
    thumbnail: r.thumbnail || list.find((m) => m.type === 'image')?.url || null,
    media: list.map((m) => ({ kind: m.type === 'image' || m.type === 'photo' ? 'image' : 'video', url: m.url })),
    referer: REFERER.instagram, ffmpeg: engine.hasFfmpeg(), id: r.shortcode || undefined,
  });
}

async function viaEmbed(ctx) {
  const code = shortcode(ctx);
  if (!code) throw new Error('not a post/reel/tv link');
  const isReel = /\/(reel|reels|tv)\//i.test(ctx.url.href);
  const embedUrl = `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/embed/captioned/`;
  const html = await getText(embedUrl, { timeoutMs: 18_000, retries: 1 });

  const videos = [...html.matchAll(/<video[^>]+src="([^"]+\.mp4[^"]*)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  const imgs = [...html.matchAll(/<img[^>]+class="[^"]*(?:EmbeddedMediaImage|t-9B9R0)[^"]*"[^>]+src="([^"]+)"/gi)]
    .map((m) => m[1].replace(/&amp;/g, '&'))
    .filter((s) => /cdninstagram/.test(s));
  const poster = metaContent(html, 'og:image') || [...html.matchAll(/poster="([^"]+)"/gi)].map((m) => m[1])[0] || null;
  const caption = (html.match(/<div[^>]+class="[^"]*Caption[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] || metaContent(html, 'og:title') || '').replace(/<[^>]+>/g, '').trim();
  const author = html.match(/<a[^>]+class="[^"]*Username[^"]*"[^>]*>[^<]*@?([A-Za-z0-9_.]+)/i)?.[1] || null;

  const title = caption.slice(0, 120) || `Instagram ${isReel ? 'Reel' : 'post'}`;
  const base = slugify(caption || 'instagram');
  const formats = [];

  videos.slice(0, 10).forEach((v, i) => formats.push({
    id: `v-${i + 1}`, label: videos.length > 1 ? `Video ${i + 1}/${videos.length}` : 'Video · MP4',
    tag: 'HD', ext: 'mp4', kind: 'video',
    url: dlDirect(v, { referer: REFERER.instagram, filename: videos.length > 1 ? `${base}-${i + 1}` : base }),
  }));
  imgs.slice(0, 20).forEach((v, i) => formats.push({
    id: `i-${i + 1}`, label: imgs.length > 1 ? `Foto ${i + 1}/${imgs.length}` : 'Foto HD',
    tag: 'IMG', ext: 'jpg', kind: 'image',
    url: dlDirect(v, { referer: REFERER.instagram, filename: `${base}-photo-${i + 1}` }),
  }));

  // The embed page is served as a bare login shell to many server IPs — say so
  // precisely instead of pretending the post is gone.
  if (!formats.length) throw new Error('embed page served as a bare shell, media blocked for this server IP');

  return {
    platform: 'instagram', platformName: 'Instagram', url: ctx.url.href,
    title, author: author ? `@${author}` : null, thumbnail: poster,
    kind: formats.some((f) => f.kind === 'video') ? 'video' : 'gallery',
    isPlaylist: false,
    items: [{ id: code, title, thumbnail: poster, kind: formats[0].kind, formats }],
    warnings: [],
  };
}

module.exports = {
  id: 'instagram',
  name: 'Instagram',
  methods: [
    { name: 'custom-api', run: viaCustomApi, optional: () => !config.igApiEndpoint },
    izukaAio(),
    { name: 'izuka-ig', run: viaIzukaInstagram, optional: () => !providers.enabled('izuka') },
    savefbsAio(),
    { name: 'embed', run: viaEmbed },
  ],
  isStory: (href) => STORY_RE.test(href),
};
