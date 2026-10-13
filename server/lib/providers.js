'use strict';

const config = require('../config');
const { getJson, request } = require('./http');

/**
 * Third-party resolver backends ("the WA-bot scrapers", audited and modernised).
 *
 * Every function here returns RAW provider data — the per-platform resolvers
 * turn it into the canonical shape. Keeping the HTTP/parsing details in one
 * place means a provider change is a one-file fix.
 *
 * All providers are keyless and can be disabled individually with
 * PROVIDERS_DISABLED=izuka,savefbs,azbry,threadsworker.
 */

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

const enabled = (name) => !config.providersDisabled.includes(name);

function assertEnabled(name) {
  if (!enabled(name)) throw new Error(`provider ${name} disabled`);
}

// ── izuka (REST, JSON) ──────────────────────────────────────────────────
/**
 * GET {IZUKA_BASE}/api/downloader/{endpoint}?url=…
 * Known endpoints: aio-v2, instagram, twitter, threads, facebook, yt-dl (type=video|audio), ytmp4, ytmp3.
 */
async function izuka(endpoint, url, extra = {}, { timeoutMs } = {}) {
  assertEnabled('izuka');
  const q = new URLSearchParams({ url, ...extra });
  const json = await getJson(`${config.izukaBase}/api/downloader/${endpoint}?${q}`, {
    timeoutMs: timeoutMs || config.providerTimeoutMs,
    retries: 0,
    headers: { 'user-agent': config.userAgent },
  });
  if (!json || json.status === false) {
    throw new Error(`izuka ${endpoint}: ${json?.message || 'status false'}`);
  }
  const result = json.result;
  if (!result || (typeof result === 'object' && !Object.keys(result).length)) {
    throw new Error(`izuka ${endpoint}: empty result`);
  }
  return result;
}

// ── azbry (REST, JSON) ──────────────────────────────────────────────────
async function azbry(endpoint, url, { timeoutMs } = {}) {
  assertEnabled('azbry');
  const json = await getJson(`${config.azbryBase}/api/download/${endpoint}?url=${encodeURIComponent(url)}`, {
    timeoutMs: timeoutMs || config.providerTimeoutMs,
    retries: 0,
    headers: { 'user-agent': config.userAgent },
  });
  if (!json || json.status === false) throw new Error(`azbry ${endpoint}: ${json?.message || 'status false'}`);
  return json;
}

// ── savefbs (AIO, returns an HTML fragment) ─────────────────────────────
/**
 * Decode a dl.tiktokio.com token back into the original CDN url.
 * Layout (reverse-engineered, verified on IG/FB/X/Pinterest responses):
 *   - first 10 chars = 5 base64 chars interleaved with 5 junk chars
 *   - then the rest of the base64 of `<cdn url><10-digit timestamp>`
 *   - then junk made of "O"/"0" characters
 * Returns null when the layout does not match (caller falls back to the proxy link).
 */
function decodeSavefbsToken(token) {
  if (!token || token.length < 16) return null;
  const core = token.slice(0, 10).split('').filter((_, i) => i % 2 === 0).join('') + token.slice(10);
  const tail = core.match(/[O0]+$/);
  const maxStrip = tail ? tail[0].length : 0;
  for (let k = maxStrip; k >= 0; k--) {
    const b64 = core.slice(0, core.length - k);
    let decoded;
    try {
      decoded = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8');
    } catch { continue; }
    const m = decoded.match(/^(https?:\/\/[\x21-\x7e]+?)(\d{10})$/);
    if (m) return m[1];
  }
  return null;
}

const decodeHtml = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[k]);

/** Parse the savefbs HTML fragment into links + metadata. */
function parseSavefbs(html) {
  const h = String(html || '').replace(/<style>[\s\S]*?<\/style>/g, '');
  const title = decodeHtml((h.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || '').trim();
  const owner = decodeHtml((h.match(/<strong>\s*Owner:\s*<\/strong>\s*([^<]+)/i) || [])[1] || '').trim();
  const thumbRaw = (h.match(/<img[^>]+class="[^"]*aio-thumbnail[^"]*"[^>]*>/i) || h.match(/<img[^>]+src="[^"]+"[^>]*>/i) || [''])[0];
  const thumbSrc = (thumbRaw.match(/src="([^"]+)"/) || [])[1] || null;

  const links = [];
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>/gi;
  let m;
  while ((m = re.exec(h))) {
    const href = decodeHtml(m[1]);
    const label = m[2].replace(/\s+/g, ' ').trim();
    if (!/^Download/i.test(label)) continue;
    let u;
    try { u = new URL(href); } catch { continue; }
    const token = u.searchParams.get('token');
    const direct = token ? decodeSavefbsToken(token) : null;
    const isAudio = /audio/i.test(label) || u.searchParams.get('sf') === 'mp3';
    const qm = label.match(/\((.*?)\)/);
    links.push({
      label,
      quality: qm ? qm[1] : (isAudio ? 'audio' : ''),
      kind: isAudio ? 'audio' : 'video',
      url: direct || href,          // prefer the real CDN url
      proxyUrl: href,
      converted: isAudio && u.searchParams.get('sf') === 'mp3',
    });
  }
  const formatButtons = [...h.matchAll(/aioDownloadFormat\('([^']+)'\)/g)].map((x) => x[1]);
  const thumbTokenUrl = (() => { try { return new URL(thumbSrc); } catch { return null; } })();
  const thumbnail = thumbTokenUrl?.searchParams.get('token') ? (decodeSavefbsToken(thumbTokenUrl.searchParams.get('token')) || thumbSrc) : thumbSrc;
  const bodyText = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, owner, thumbnail, links, formatButtons, bodyText };
}

async function savefbs(url, { timeoutMs } = {}) {
  assertEnabled('savefbs');
  const res = await request(`${config.savefbsBase}/api/v1/aio/html`, {
    method: 'POST',
    timeoutMs: timeoutMs || config.providerTimeoutMs,
    retries: 0,
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      referer: `${config.savefbsBase}/all-in-one-video-downloader/`,
      origin: config.savefbsBase,
      'user-agent': UA_MOBILE,
    },
    body: JSON.stringify({ vid: url, prefix: 'savefbs.com', ex: '', format: '' }),
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`savefbs: HTTP ${res.status} ${html.replace(/<[^>]+>/g, ' ').trim().slice(0, 80)}`);
  const parsed = parseSavefbs(html);
  if (!parsed.links.length) {
    throw new Error(parsed.formatButtons.length ? 'savefbs: format step not supported' : `savefbs: no media (${parsed.bodyText.slice(0, 80)})`);
  }
  return parsed;
}

// ── Threads worker (threadsvid.com backend) ─────────────────────────────
async function threadsWorker(url, { timeoutMs } = {}) {
  assertEnabled('threadsworker');
  const json = await getJson(`${config.threadsWorkerBase}/?url=${encodeURIComponent(url)}&action=info`, {
    timeoutMs: timeoutMs || config.providerTimeoutMs,
    retries: 0,
    headers: { 'user-agent': UA_MOBILE, origin: 'https://threadsvid.com', referer: 'https://threadsvid.com/' },
  });
  if (!json?.success || !json.data) throw new Error(`threads worker: ${json?.message || json?.error || 'no data'}`);
  return json.data;
}

/** Parse "1920x1080", "720p", "HD", "Full HD", "360" into a comparable pixel height. */
function qualityHeight(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return null;
  const dims = s.match(/(\d{2,5})\s*x\s*(\d{2,5})/);
  if (dims) return Math.min(Number(dims[1]), Number(dims[2]));
  const p = s.match(/(\d{3,4})\s*p?\b/);
  if (p) return Number(p[1]);
  if (/full\s*hd|fhd|1080/.test(s)) return 1080;
  if (/\bhd\b|high/.test(s)) return 720;
  if (/\bsd\b|normal|low|md/.test(s)) return 480;
  return null;
}

module.exports = {
  izuka, azbry, savefbs, threadsWorker,
  decodeSavefbsToken, parseSavefbs, qualityHeight,
  enabled,
};
