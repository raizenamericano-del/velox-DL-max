'use strict';

const providers = require('../lib/providers');
const engine = require('../lib/ytdlp');
const { fromMedia, dlDirect, dlLazy, slugify, cleanTitle } = require('./normalize');

/**
 * YouTube.
 *
 * yt-dlp is the best source (1080p merge, MP3, playlists, Shorts) but from
 * most cloud IPs YouTube answers "Sign in to confirm you're not a bot". The
 * chain builder keeps the engine first and demotes it automatically (circuit
 * breaker) once that happens, so the keyless provider below takes over:
 *
 *   izuka yt-dl  → progressive 360p MP4 (itag 18) + audio track (m4a).
 *                  The audio link is resolved lazily at download time and
 *                  transcoded to MP3 by our own ffmpeg.
 */

const ID_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

function videoId(href) {
  const m = String(href).match(ID_RE);
  return m ? m[1] : null;
}

/** Canonical watch url — providers choke on share params like ?si=… or &t=…  */
function canonical(href) {
  const id = videoId(href);
  return id ? `https://www.youtube.com/watch?v=${id}` : href;
}

function thumbFormat(id, base) {
  return {
    id: 'thumb', label: 'Thumbnail · JPG', tag: 'IMG', ext: 'jpg', kind: 'image',
    url: dlDirect(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, { filename: `${base}-thumb`, ext: 'jpg' }),
  };
}

async function viaIzuka(ctx) {
  const id = videoId(ctx.url.href);
  if (!id) throw new Error('not a single-video YouTube link');
  const page = canonical(ctx.url.href);
  const r = await providers.izuka('yt-dl', page, { type: 'video' });
  if (!r.downloadUrl) throw new Error('izuka yt-dl: no downloadUrl');

  const title = cleanTitle(r.title) || 'YouTube video';
  const base = slugify(title);
  const q = String(r.quality || '').match(/\d{3,4}/)?.[0];
  const ffmpeg = engine.hasFfmpeg();

  const extra = [];
  if (ffmpeg) {
    extra.push({
      id: 'audio-mp3', label: 'MP3 · 192kbps', tag: 'MP3', ext: 'mp3', kind: 'audio',
      url: dlLazy('yt', page, { audio: 'mp3', filename: base, ext: 'mp3' }),
    });
  }
  extra.push({
    id: 'audio-native', label: ffmpeg ? 'Audio asli · M4A' : 'Audio · M4A', tag: 'AUDIO', ext: 'm4a', kind: 'audio',
    url: dlLazy('yt', page, { audio: 'native', filename: base, ext: 'm4a' }),
  });
  extra.push(thumbFormat(id, base));

  const result = fromMedia({
    platform: 'youtube', platformName: 'YouTube', url: ctx.url.href,
    title, author: r.author || r.channel || null,
    thumbnail: r.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: r.duration || null,
    media: [{ kind: 'video', url: r.downloadUrl, quality: q ? `${q}p` : 'SD', ext: 'mp4', note: 'progresif, langsung bisa diputar' }],
    referer: 'https://www.youtube.com/',
    ffmpeg: false,            // MP3 is provided by the lazy audio route above, not derived from the video
    extraFormats: extra,
    id,
  });
  result.warnings = [{
    code: 'YT_FALLBACK',
    text: 'YouTube membatasi engine utama dari server ini, jadi dipakai jalur cadangan: MP4 360p + MP3. Kualitas 720p/1080p kembali otomatis saat engine lolos lagi.',
  }];
  return result;
}

/** Secondary provider endpoint (different code path upstream). */
async function viaIzukaMp4(ctx) {
  const id = videoId(ctx.url.href);
  if (!id) throw new Error('not a single-video YouTube link');
  const page = canonical(ctx.url.href);
  const r = await providers.izuka('ytmp4', page);
  let url = null;
  if (typeof r.video_normal === 'string') url = r.video_normal;
  else if (Array.isArray(r.video_normal)) url = r.video_normal.filter((v) => v?.url).sort((a, b) => parseInt(b.quality, 10) - parseInt(a.quality, 10))[0]?.url || null;
  if (!url) throw new Error('izuka ytmp4: no video url');

  const title = cleanTitle(r.title) || 'YouTube video';
  const base = slugify(title);
  const ffmpeg = engine.hasFfmpeg();
  const extra = [];
  if (ffmpeg) extra.push({ id: 'audio-mp3', label: 'MP3 · 192kbps', tag: 'MP3', ext: 'mp3', kind: 'audio', url: dlLazy('yt', page, { audio: 'mp3', filename: base, ext: 'mp3' }) });
  extra.push({ id: 'audio-native', label: 'Audio · M4A', tag: 'AUDIO', ext: 'm4a', kind: 'audio', url: dlLazy('yt', page, { audio: 'native', filename: base, ext: 'm4a' }) });
  extra.push(thumbFormat(id, base));

  return fromMedia({
    platform: 'youtube', platformName: 'YouTube', url: ctx.url.href,
    title, thumbnail: r.thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, duration: r.duration || null,
    media: [{ kind: 'video', url, quality: 'SD', ext: 'mp4' }],
    referer: 'https://www.youtube.com/', ffmpeg: false, extraFormats: extra, id,
    warnings: [{ code: 'YT_FALLBACK', text: 'Jalur cadangan YouTube aktif: MP4 360p + MP3.' }],
  });
}

/**
 * Lazy source resolution used by /api/dl?t=yt — returns a fresh direct url
 * (googlevideo links expire, so this is never cached).
 *
 * The progressive 360p file is used as the audio source on purpose: the
 * audio-only itag the provider hands out is throttled to ~30 KB/s by
 * YouTube, while the progressive one downloads at full speed. ffmpeg then
 * drops the video track (copy → .m4a) or re-encodes to MP3.
 */
async function lazyAudio(pageUrl) {
  const page = canonical(pageUrl);
  if (!videoId(page)) throw new Error('not a YouTube video link');
  const r = await providers.izuka('yt-dl', page, { type: 'video' });
  if (!r.downloadUrl) throw new Error('izuka yt-dl: no downloadUrl');
  return { url: r.downloadUrl, title: cleanTitle(r.title) || 'youtube-audio' };
}

module.exports = {
  id: 'youtube',
  name: 'YouTube',
  methods: [
    { name: 'engine' },                                   // placeholder: filled by the chain builder
    { name: 'izuka-yt', run: viaIzuka, optional: () => !providers.enabled('izuka') },
    { name: 'izuka-ytmp4', run: viaIzukaMp4, optional: () => !providers.enabled('izuka') },
  ],
  videoId, canonical, lazyAudio,
};
