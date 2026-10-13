'use strict';

const config = require('../config');

/**
 * Turns engine output into one canonical shape the UI understands:
 *
 * {
 *   platform, platformName, url, title, author, thumbnail, duration, kind,
 *   items: [{ id, title, thumbnail, duration, kind,
 *             formats: [{ id, label, tag, ext, kind, url, size }] }],
 *   warnings: []
 * }
 *
 * Every `formats[].url` points at OUR /api/dl endpoint so that the browser
 * never has to deal with cross-origin CDN headers or expiring referers.
 */

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'avif']);
const AUDIO_EXT = new Set(['m4a', 'mp3', 'opus', 'webm', 'ogg', 'aac', 'flac', 'wav']);

const enc = encodeURIComponent;
const slugify = (s, max = 60) =>
  String(s || 'velox-media')
    .normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/\s+/g, '-').slice(0, max) || 'velox-media';

/** Proxy link for a direct CDN URL. */
function dlDirect(mediaUrl, { referer, filename, mime, audio, ext } = {}) {
  const q = new URLSearchParams({ t: 'direct', u: mediaUrl });
  if (referer) q.set('r', referer);
  if (filename) q.set('n', filename);
  if (mime) q.set('m', mime);
  if (ext) q.set('x', ext);
  if (audio) q.set('a', audio);          // 'mp3' → ffmpeg transcode of a direct url
  return `/api/dl?${q.toString()}`;
}

/**
 * Proxy link that is resolved again at download time by a third-party
 * provider (used when the provider needs a separate call per format, e.g.
 * YouTube audio). `kind` names the server-side lazy handler.
 */
function dlLazy(kind, pageUrl, { audio, filename, ext } = {}) {
  const q = new URLSearchParams({ t: kind, u: pageUrl });
  if (audio) q.set('a', audio);
  if (ext) q.set('x', ext);
  if (filename) q.set('n', filename);
  return `/api/dl?${q.toString()}`;
}

/** Collapse whitespace/newlines and cap the length — titles come from captions. */
const cleanTitle = (s, max = 160) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** Pixel "p" value shown to users: the SHORT side, so a 1080×1920 reel is 1080p, not 1920p. */
const shortSide = (f) => {
  const h = Number(f?.height) || 0; const w = Number(f?.width) || 0;
  if (h && w) return Math.min(h, w);
  return h || w || null;
};

/** Proxy link that streams through the yt-dlp engine. */
function dlEngine(pageUrl, { format, audio, ext, filename } = {}) {
  const q = new URLSearchParams({ t: 'engine', u: pageUrl });
  if (format) q.set('f', format);
  if (audio) q.set('a', audio);
  if (ext) q.set('x', ext);
  if (filename) q.set('n', filename);
  return `/api/dl?${q.toString()}`;
}

const fmtSize = (bytes) => {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

function humanDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Build the format list for one yt-dlp entry.
 * - progressive MP4s first (playable everywhere, no merge needed)
 * - a "Best (merged)" option when ffmpeg is present
 * - audio-only option, MP3 when ffmpeg is present, otherwise native M4A/Opus
 */
function buildFormats(info, { ffmpeg, pageUrl, referer, baseName, maxMergeHeight = 1080 }) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const list = [];
  const seen = new Set();

  const CONTAINER = new Set(['mp4', 'mov', 'mkv', 'webm']);
  const progressive = formats.filter((f) =>
    f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && CONTAINER.has(String(f.ext || '')),
  );

  // de-duplicate per resolution+container, keep the heaviest (= best bitrate) variant
  const byHeight = new Map();
  for (const f of progressive) {
    const h = f.height || 0;
    const k = `${h}-${f.ext}`;
    const prev = byHeight.get(k);
    if (!prev || (f.filesize || f.filesize_approx || 0) > (prev.filesize || prev.filesize_approx || 0)) byHeight.set(k, f);
  }
  const ranked = [...byHeight.entries()].sort((a, b) => (b[1].height || 0) - (a[1].height || 0));

  ranked.forEach(([key, f], idx) => {
    if (seen.has(key)) return;
    seen.add(key);
    const ext = String(f.ext).toLowerCase();
    const height = shortSide(f);
    list.push({
      id: f.format_id,
      label: height ? `${height}p · ${ext.toUpperCase()}` : ext.toUpperCase(),
      tag: idx === 0 || height >= 720 ? 'HD' : 'SD',
      ext,
      kind: 'video',
      size: fmtSize(f.filesize || f.filesize_approx),
      fps: f.fps || null,
      url: dlEngine(pageUrl, { format: f.format_id, ext, filename: `${baseName}-${height || 'video'}p` }),
    });
  });

  // images (Instagram carousel, Pinterest, XiaoHongShu…)
  const directImage = formats.filter((f) => f.url && IMAGE_EXT.has(String(f.ext || '').toLowerCase()));
  for (const f of directImage) {
    list.push({
      id: f.format_id || 'image',
      label: f.resolution ? `Photo ${f.resolution}` : 'Photo HD',
      tag: 'IMG',
      ext: String(f.ext).toLowerCase(),
      kind: 'image',
      size: fmtSize(f.filesize || f.filesize_approx),
      url: dlDirect(f.url, { referer, filename: baseName }),
    });
  }

  // "hasVideo" must look at the SOURCE format list, not at `list`: on YouTube a
  // datacentre IP gets DASH-only streams, so there is no progressive entry and a
  // check against `list` would silently hide the merged best-quality option.
  const hasProgressive = list.some((f) => f.kind === 'video');
  const videoStreams = formats
    .filter((f) => f.url && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (ffmpeg && videoStreams.length) {
    list.unshift({
      id: 'best-merged',
      label: 'Terbaik · MP4',
      note: 'video + audio digabung',
      tag: 'MAX',
      ext: 'mp4',
      kind: 'video',
      // Cap the height: an uncapped "best" picks 4K/8K sources that can be
      // hundreds of MB and will exhaust a small instance's disk mid-request.
      // mp4+m4a is preferred so the muxed file plays in every browser.
      url: dlEngine(pageUrl, {
        format: `bv*[height<=${maxMergeHeight}][ext=mp4]+ba[ext=m4a]/bv*[height<=${maxMergeHeight}]+ba/b`,
        ext: 'mp4',
        filename: `${baseName}-best`,
      }),
    });
  }

  // No single-file video available → expose the top video-only stream, labelled
  // honestly so nobody downloads a silent clip by accident.
  if (!hasProgressive && videoStreams.length) {
    const top = videoStreams[0];
    const vext = String(top.ext || 'mp4').toLowerCase();
    list.push({
      id: top.format_id,
      label: `${shortSide(top) || '?'}p · ${vext.toUpperCase()}`,
      note: 'video saja, tanpa audio',
      tag: 'HD',
      ext: vext,
      kind: 'video',
      size: fmtSize(top.filesize || top.filesize_approx),
      url: dlEngine(pageUrl, { format: top.format_id, ext: vext, filename: baseName }),
    });
  }

  // audio
  const audioCandidates = formats.filter((f) => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  if (audioCandidates.length) {
    const pref = ['m4a', 'mp3', 'opus', 'webm', 'ogg', 'aac'];
    const sorted = [...audioCandidates].sort((a, b) => {
      const pa = pref.indexOf(a.ext); const pb = pref.indexOf(b.ext);
      if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      return (b.tbr || b.filesize || 0) - (a.tbr || a.filesize || 0);
    });
    const best = sorted[0];
    const nativeExt = best.ext === 'webm' ? 'webm' : best.ext === 'opus' ? 'opus' : 'm4a';
    const kbps = Math.round((best.tbr || best.abr || 128));

    if (ffmpeg) {
      list.push({
        id: 'audio-mp3',
        label: `MP3 · ${Math.min(Math.max(kbps, 128), 320)}kbps`,
        tag: 'MP3',
        ext: 'mp3',
        kind: 'audio',
        url: dlEngine(pageUrl, { format: best.format_id, audio: 'mp3', filename: baseName }),
      });
    }
    list.push({
      id: best.format_id,
      label: ffmpeg ? `Audio asli · ${nativeExt.toUpperCase()}` : `Audio · ${nativeExt.toUpperCase()} ${kbps}kbps`,
      tag: 'AUDIO',
      ext: nativeExt,
      kind: 'audio',
      size: fmtSize(best.filesize || best.filesize_approx),
      url: dlEngine(pageUrl, { format: best.format_id, audio: 'native', ext: nativeExt, filename: baseName }),
    });
  }

  // splitOnly = video and audio live in separate streams and this server has
  // no ffmpeg to mux them. The UI says so instead of handing over a silent file.
  const splitOnly = !ffmpeg && list.some((f) => f.kind === "video") && !list.some((f) => f.id === "best-merged");
  return { list, splitOnly };
}

/** Convert a single yt-dlp info dict into one result item. */
function entryToItem(entry, { ffmpeg, pageUrl, referer, fallbackTitle, maxMergeHeight = 1080 }) {
  const ext = String(entry.ext || '').toLowerCase();
  const title = cleanTitle(entry.title || entry.fulltitle || fallbackTitle) || 'Media';
  const baseName = slugify(title);
  const kind = IMAGE_EXT.has(ext) ? 'image' : AUDIO_EXT.has(ext) && (!entry.vcodec || entry.vcodec === 'none') ? 'audio' : 'video';

  const built = buildFormats(entry, { ffmpeg, pageUrl: entry.webpage_url || pageUrl, referer, baseName, maxMergeHeight });
  let formats = built.list;
  const splitOnly = built.splitOnly;

  // single-file entries (images, direct mp3, some CDNs) expose the url directly
  if (entry.url && (IMAGE_EXT.has(ext) || ext === 'mp3' || !entry.formats?.length)) {
    if (!formats.some((f) => f.kind === kind)) {
      formats.unshift({
        id: 'direct',
        label: kind === 'image' ? 'Photo HD' : kind === 'audio' ? `Audio · ${ext.toUpperCase()}` : `Video · ${ext.toUpperCase()}`,
        tag: kind === 'image' ? 'IMG' : kind === 'audio' ? 'AUDIO' : 'HD',
        ext: ext || 'mp4',
        kind,
        size: fmtSize(entry.filesize || entry.filesize_approx),
        url: dlDirect(entry.url, { referer, filename: baseName }),
      });
    }
  }

  return {
    id: entry.id || baseName,
    title,
    thumbnail: entry.thumbnail || entry.thumbnails?.at(-1)?.url || null,
    duration: humanDuration(entry.duration),
    kind,
    splitOnly: !!splitOnly,
    formats,
  };
}

/** Top-level normaliser for engine JSON (single video OR flat playlist). */
function normalizeYtDlp(info, { platform, platformName, url, ffmpeg, warnings = [] }) {
  const isList = info._type === 'playlist' || info._type === 'multi_video' || Array.isArray(info.entries);

  if (isList) {
    const entries = (info.entries || []).filter(Boolean);
    const items = entries.map((e) => {
      const pageUrl = e.url || e.webpage_url || url;
      return {
        id: e.id || pageUrl,
        title: e.title || 'Item playlist',
        thumbnail: e.thumbnail || e.thumbnails?.at(-1)?.url || null,
        duration: humanDuration(e.duration),
        kind: 'video',
        url: pageUrl,
        formats: [
          { id: 'best', label: 'Kualitas Terbaik · MP4', tag: 'HD', ext: 'mp4', kind: 'video', url: dlEngine(pageUrl, { format: 'b', ext: 'mp4', filename: slugify(e.title) }) },
          { id: 'audio', label: ffmpeg ? 'MP3 Audio' : 'Audio asli', tag: 'MP3', ext: ffmpeg ? 'mp3' : 'm4a', kind: 'audio', url: dlEngine(pageUrl, { audio: ffmpeg ? 'mp3' : 'native', ext: ffmpeg ? 'mp3' : 'm4a', filename: slugify(e.title) }) },
        ],
      };
    });
    return {
      platform, platformName, url,
      title: info.title || 'Playlist',
      author: info.uploader || info.channel || null,
      thumbnail: info.thumbnails?.at(-1)?.url || items[0]?.thumbnail || null,
      duration: null,
      kind: 'playlist',
      isPlaylist: true,
      count: items.length,
      items,
      warnings,
    };
  }

  const item = entryToItem(info, {
    ffmpeg,
    pageUrl: info.webpage_url || url,
    referer: info.webpage_url || url,
    fallbackTitle: info.title,
    maxMergeHeight: config.maxMergeHeight,
  });

  // YouTube thumbnails as an extra option
  if (/youtube|youtu\.be/i.test(url) && info.id) {
    item.formats.push({
      id: 'thumb',
      label: 'Thumbnail · JPG',
      tag: 'IMG',
      ext: 'jpg',
      kind: 'image',
      url: dlDirect(`https://i.ytimg.com/vi/${info.id}/maxresdefault.jpg`, { filename: `${slugify(info.title)}-thumb` }),
    });
  }

  if (!item.formats.length) {
    throw Object.assign(new Error('No formats available'), { noMedia: true });
  }

  const allWarnings = [...warnings];
  if (item.splitOnly) {
    allWarnings.push({
      code: 'NO_FFMPEG',
      text: 'Server ini belum punya ffmpeg, jadi track video dan audio masih terpisah. Pasang ffmpeg untuk mendapat satu file MP4 utuh + konversi MP3.',
    });
  }

  return {
    platform,
    platformName,
    url,
    title: cleanTitle(info.title) || item.title,
    author: info.uploader || info.channel || info.creator || null,
    thumbnail: item.thumbnail,
    duration: item.duration,
    kind: item.kind,
    isPlaylist: false,
    views: info.view_count ?? null,
    likes: info.like_count ?? null,
    items: [item],
    warnings: allWarnings,
  };
}

/**
 * Build a canonical result from a flat media list (third-party providers).
 *
 * media: [{ kind: 'video'|'image'|'audio', url, quality?, height?, width?, size?, ext?, label?, note? }]
 * Videos are ranked by resolution; when ffmpeg is present an "MP3" option is
 * derived from the best video (or the explicit audio track) via the direct
 * transcode path of /api/dl.
 */
function fromMedia({
  platform, platformName, url, title, author, thumbnail, duration, views, likes,
  media, referer, ffmpeg, warnings = [], extraFormats = [], id,
}) {
  const { qualityHeight } = require('../lib/providers');
  const cleaned = cleanTitle(title) || `${platformName || 'Media'}`;
  const base = slugify(cleaned);
  const seen = new Set();
  const uniq = (media || []).filter((m) => {
    if (!m || !m.url || typeof m.url !== 'string' || !/^https?:\/\//i.test(m.url)) return false;
    if (seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });

  const videos = uniq.filter((m) => m.kind === 'video')
    .map((m) => ({ ...m, h: m.height && m.width ? Math.min(m.height, m.width) : (m.height || qualityHeight(m.quality)) }))
    .sort((a, b) => (b.h || 0) - (a.h || 0));
  const images = uniq.filter((m) => m.kind === 'image');
  const audios = uniq.filter((m) => m.kind === 'audio');

  const formats = [];
  videos.forEach((v, i) => {
    const ext = (v.ext || 'mp4').toLowerCase();
    const q = v.h ? `${v.h}p` : (i === 0 ? 'HD' : 'SD');
    formats.push({
      id: `v-${i + 1}`,
      label: v.label || `${q} · ${ext.toUpperCase()}`,
      note: v.note || null,
      tag: v.h ? (v.h >= 720 ? 'HD' : 'SD') : (i === 0 ? 'HD' : 'SD'),
      ext, kind: 'video',
      size: typeof v.size === 'number' ? fmtSize(v.size) : (v.size || null),
      url: dlDirect(v.url, { referer, filename: videos.length > 1 ? `${base}-${q}` : base, ext }),
    });
  });

  images.forEach((im, i) => {
    const ext = (im.ext || 'jpg').toLowerCase();
    formats.push({
      id: `i-${i + 1}`,
      label: im.label || (images.length > 1 ? `Foto ${i + 1}/${images.length}` : 'Foto HD'),
      tag: 'IMG', ext, kind: 'image',
      size: typeof im.size === 'number' ? fmtSize(im.size) : (im.size || null),
      url: dlDirect(im.url, { referer, filename: images.length > 1 ? `${base}-${i + 1}` : base, ext }),
    });
  });

  // audio: explicit track first, else derive from the best video
  const audioSrc = audios[0] || null;
  const mp3Source = audioSrc?.url || videos[0]?.url || null;
  if (mp3Source && ffmpeg) {
    formats.push({
      id: 'audio-mp3', label: 'MP3 · 192kbps', tag: 'MP3', ext: 'mp3', kind: 'audio',
      url: dlDirect(mp3Source, { referer, filename: base, audio: 'mp3', ext: 'mp3' }),
    });
  }
  if (audioSrc) {
    const ext = (audioSrc.ext || 'm4a').toLowerCase();
    formats.push({
      id: 'audio-native', label: audioSrc.label || `Audio asli · ${ext.toUpperCase()}`, tag: 'AUDIO', ext, kind: 'audio',
      size: typeof audioSrc.size === 'number' ? fmtSize(audioSrc.size) : (audioSrc.size || null),
      url: dlDirect(audioSrc.url, { referer, filename: base, ext }),
    });
  }
  formats.push(...extraFormats);

  if (!formats.length) throw new Error('No video could be found (provider returned no media)');

  const kind = videos.length ? 'video' : images.length ? 'gallery' : 'audio';
  return {
    platform, platformName, url,
    title: cleaned,
    author: author || null,
    thumbnail: thumbnail || (images[0]?.url ?? null),
    duration: typeof duration === 'number' ? humanDuration(duration) : (duration || null),
    kind, isPlaylist: false,
    views: views ?? null, likes: likes ?? null,
    items: [{ id: id || base, title: cleaned, thumbnail: thumbnail || null, duration: typeof duration === 'number' ? humanDuration(duration) : (duration || null), kind, formats }],
    warnings,
  };
}

module.exports = {
  normalizeYtDlp, entryToItem, buildFormats, fromMedia,
  dlDirect, dlEngine, dlLazy, slugify, cleanTitle, shortSide, humanDuration, fmtSize, IMAGE_EXT, AUDIO_EXT,
};
