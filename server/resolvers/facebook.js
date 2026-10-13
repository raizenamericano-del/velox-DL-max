'use strict';

const providers = require('../lib/providers');
const engine = require('../lib/ytdlp');
const { fromMedia } = require('./normalize');
const { izukaAio, savefbsAio, REFERER } = require('./thirdparty');

/**
 * Facebook video / Reels / Watch.
 *   engine (yt-dlp, HD+SD, works from most server IPs) → azbry (title + HD/SD + sizes)
 *   → izuka aio-v2 → savefbs
 */
async function viaAzbry(ctx) {
  const json = await providers.azbry('facebook', ctx.url.href);
  const r = json.result || {};
  const medias = Array.isArray(r.medias) ? r.medias : [];
  const media = medias
    .filter((m) => m?.url && (m.videoAvailable !== false))
    .map((m) => ({
      kind: m.audioAvailable === false && m.videoAvailable === false ? 'audio' : 'video',
      url: m.url,
      quality: m.quality,
      ext: (m.extension || 'mp4').toLowerCase(),
      size: typeof m.size === 'number' ? m.size : null,
      note: m.audioAvailable === false ? 'video saja, tanpa audio' : undefined,
    }));
  return fromMedia({
    platform: 'facebook', platformName: 'Facebook', url: ctx.url.href,
    title: r.title || 'Facebook video', author: r.author || null,
    thumbnail: r.thumbnail || null, duration: r.duration || null,
    media, referer: REFERER.facebook, ffmpeg: engine.hasFfmpeg(),
  });
}

module.exports = {
  id: 'facebook',
  name: 'Facebook',
  methods: [
    { name: 'engine' },
    { name: 'azbry-fb', run: viaAzbry, optional: () => !providers.enabled('azbry') },
    izukaAio(),
    savefbsAio(),
  ],
};
