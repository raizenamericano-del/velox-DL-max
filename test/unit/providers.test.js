'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const providers = require('../../server/lib/providers');
const { fromMedia, shortSide, cleanTitle, dlLazy } = require('../../server/resolvers/normalize');
const { tidyTitle } = require('../../server/resolvers/thirdparty');

// ── savefbs token decoder ────────────────────────────────────────────────
function encodeSavefbs(cdnUrl, { oeTail = '1760400000', junk = 'O0O' } = {}) {
  // mirror of what the site does: base64(url + 10 digits), then interleave
  // one junk char after each of the first 5 chars, strip padding, append O/0 noise.
  const b64 = Buffer.from(cdnUrl + oeTail).toString('base64').replace(/=+$/, '');
  let out = '';
  for (let i = 0; i < 5; i++) out += b64[i] + 'x';
  out += b64.slice(5) + junk;
  return out;
}

test('decodeSavefbsToken() recovers the CDN url and drops the appended timestamp', () => {
  const url = 'https://scontent.cdninstagram.com/v/t50.2886-16/abc.mp4?efg=eyJ2&_nc_ht=scontent&oe=6AD01588';
  const token = encodeSavefbs(url);
  assert.strictEqual(providers.decodeSavefbsToken(token), url);
});

test('decodeSavefbsToken() returns null for garbage', () => {
  assert.strictEqual(providers.decodeSavefbsToken('not-a-token'), null);
  assert.strictEqual(providers.decodeSavefbsToken(''), null);
});

test('parseSavefbs() extracts links, owner, title and thumbnail', () => {
  const url = 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/x.mp4?tag=16';
  const token = encodeSavefbs(url);
  const html = `
    <div class="aio-result">
      <img class="aio-thumbnail" src="https://pbs.twimg.com/media/thumb.jpg">
      <h3>New crew soon! Crew-13 is scheduled</h3>
      <p><strong>Owner:</strong> NASA</p>
      <a class="download-btn" href="https://dl.tiktokio.com/download?token=${token}&p=x">Download (1280x720p)</a>
      <a class="download-btn" href="https://dl.tiktokio.com/download?token=${token}&p=y">Download (SD)</a>
      <a class="download-btn" href="https://dl.tiktokio.com/download?token=${token}&p=z&convert=1">Download Audio</a>
    </div>`;
  const r = providers.parseSavefbs(html);
  assert.strictEqual(r.thumbnail, 'https://pbs.twimg.com/media/thumb.jpg');
  assert.strictEqual(r.owner, 'NASA');
  assert.match(r.title, /Crew-13/);
  assert.strictEqual(r.links.length, 3);
  assert.strictEqual(r.links[0].kind, 'video');
  assert.strictEqual(r.links[0].quality, '1280x720p');
  assert.strictEqual(r.links[0].url, url, 'direct CDN url recovered from token');
  assert.strictEqual(r.links[2].kind, 'audio');
});

test('parseSavefbs() reports a format-selection page as having no links', () => {
  const html = '<div><button onclick="aioDownloadFormat(\'720\')">720p</button><button onclick="aioDownloadFormat(\'360\')">360p</button></div>';
  const r = providers.parseSavefbs(html);
  assert.strictEqual(r.links.length, 0);
  assert.deepStrictEqual(r.formatButtons, ['720', '360']);
});

test('qualityHeight() understands every label flavour', () => {
  assert.strictEqual(providers.qualityHeight('1920x1080'), 1080);
  assert.strictEqual(providers.qualityHeight('720x1280'), 720);
  assert.strictEqual(providers.qualityHeight('1080p'), 1080);
  assert.strictEqual(providers.qualityHeight('HD'), 720);
  assert.strictEqual(providers.qualityHeight('Full HD'), 1080);
  assert.strictEqual(providers.qualityHeight('sd'), 480);
  assert.strictEqual(providers.qualityHeight(undefined), null);
});

test('enabled() honours PROVIDERS_DISABLED', () => {
  const config = require('../../server/config');
  const before = config.providersDisabled.slice();
  config.providersDisabled.splice(0, config.providersDisabled.length, 'savefbs');
  assert.strictEqual(providers.enabled('savefbs'), false);
  assert.strictEqual(providers.enabled('izuka'), true);
  config.providersDisabled.splice(0, config.providersDisabled.length, ...before);
});

// ── canonical result builder ─────────────────────────────────────────────
test('shortSide() labels portrait video by its short side', () => {
  assert.strictEqual(shortSide({ width: 1080, height: 1920 }), 1080);
  assert.strictEqual(shortSide({ width: 1920, height: 1080 }), 1080);
  assert.strictEqual(shortSide({ height: 720 }), 720);
  assert.strictEqual(shortSide({}), null);
});

test('cleanTitle() strips noise and caps length', () => {
  assert.strictEqual(cleanTitle('  Hello   world  '), 'Hello world');
  assert.strictEqual(cleanTitle('x'.repeat(300)).length <= 161, true);
  assert.strictEqual(cleanTitle(null), '');
});

test('fromMedia() ranks videos, dedupes, labels by short side and adds MP3 only with ffmpeg', () => {
  const base = {
    platform: 'instagram', platformName: 'Instagram', url: 'https://www.instagram.com/reel/abc/',
    title: 'Hello', author: '@nasa', thumbnail: 'https://x/t.jpg',
    media: [
      { kind: 'video', url: 'https://cdn/a.mp4', quality: '720x1280' },
      { kind: 'video', url: 'https://cdn/b.mp4', quality: '1080x1920' },
      { kind: 'video', url: 'https://cdn/b.mp4', quality: '1080x1920' }, // dupe
      { kind: 'image', url: 'https://cdn/p.jpg' },
    ],
    referer: 'https://www.instagram.com/',
  };
  const withFf = fromMedia({ ...base, ffmpeg: true });
  const labels = withFf.items[0].formats.map((f) => f.label);
  assert.deepStrictEqual(labels.slice(0, 2), ['1080p · MP4', '720p · MP4'], 'best first, short-side labels');
  assert.ok(labels.includes('MP3 · 192kbps'));
  assert.ok(labels.includes('Foto HD'));
  assert.strictEqual(withFf.kind, 'video');
  assert.match(withFf.items[0].formats[0].url, /^\/api\/dl\?t=direct&u=/);
  const mp3 = withFf.items[0].formats.find((f) => f.id === 'audio-mp3');
  assert.match(mp3.url, /a=mp3/);

  const noFf = fromMedia({ ...base, ffmpeg: false });
  assert.ok(!noFf.items[0].formats.some((f) => f.id === 'audio-mp3'), 'no MP3 offer without ffmpeg');
});

test('fromMedia() throws when nothing is downloadable', () => {
  assert.throws(() => fromMedia({ platform: 'x', platformName: 'X', url: 'https://x/1', media: [] }), /no media|No video could be found/i);
});

test('fromMedia() keeps SD tag for low-res single video', () => {
  const r = fromMedia({ platform: 'youtube', platformName: 'YouTube', url: 'https://youtu.be/a', media: [{ kind: 'video', url: 'https://cdn/v.mp4', quality: '360p' }] });
  assert.strictEqual(r.items[0].formats[0].tag, 'SD');
  assert.strictEqual(r.items[0].formats[0].label, '360p · MP4');
});

test('dlLazy() builds a lazy download url', () => {
  const u = dlLazy('yt', 'https://www.youtube.com/watch?v=abc', { audio: 'mp3', filename: 'song', ext: 'mp3' });
  assert.match(u, /^\/api\/dl\?t=yt&u=https%3A%2F%2Fwww\.youtube\.com/);
  assert.match(u, /a=mp3/);
});

test('tidyTitle() replaces provider placeholders', () => {
  assert.strictEqual(tidyTitle('Facebook', 'Facebook'), 'Facebook video');
  assert.strictEqual(tidyTitle('- Facebook Reel', 'Facebook'), 'Facebook Reel');
  assert.strictEqual(tidyTitle('Real title', 'Facebook'), 'Real title');
});
