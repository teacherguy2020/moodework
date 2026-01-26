#!/usr/bin/env node
/**
 * moode-nowplaying-api.mjs -- moOde Now-Playing API (Pi4)
 *
 * Stable endpoints:
 *   GET  /now-playing
 *   GET  /next-up
 *   GET  /art/*
 *   GET/POST /rating
 *   POST /queue/*
 *   POST /mpd/*
 *
 * Optional (gated):
 *   GET /track           (ENABLE_ALEXA=0)
 *   GET /_debug/mpd
 *
 * This pass: organization + guardrails (avoid empty resolver calls) + comments only.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import sharp from 'sharp';



const execFileP = promisify(execFile);

/* =========================
 * Config
 * ========================= */

const PORT = Number(process.env.PORT || '3000');

const MOODE_BASE_URL = process.env.MOODE_BASE_URL || 'http://REPLACE WITH YOUR MOODE IP ADDRESS';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://moode.brianwis.com';

const LOCAL_ADDRESS = process.env.LOCAL_ADDRESS || 'REPLACE WITH YOUR SERVER IP NO HTTP';

const MPD_HOST = process.env.MPD_HOST || 'REPLACE WITH MOODE IP NO HTTP';
const MPD_PORT = Number(process.env.MPD_PORT || '6600');

const MOODE_USB_PREFIX = process.env.MOODE_USB_PREFIX || 'USB/YOURDRIVEMOUNTNAME/';
const PI4_MOUNT_BASE = process.env.PI4_MOUNT_BASE || '/mnt/SamsungMoode';

const METAFLAC = process.env.METAFLAC || '/usr/bin/metaflac';

const TRACK_KEY = process.env.TRACK_KEY || 'YOUR TRACK KEY';
const ENABLE_ALEXA = String(process.env.ENABLE_ALEXA || '').trim() === '1';
const TRANSCODE_TRACKS = String(process.env.TRANSCODE_TRACKS || '0').trim() === '1';
const TRACK_CACHE_DIR = process.env.TRACK_CACHE_DIR || '/tmp/moode-track-cache';

const FAVORITES_PLAYLIST_NAME = process.env.FAVORITES_PLAYLIST_NAME || 'Favorites';
const FAVORITES_REFRESH_MS = Number(process.env.FAVORITES_REFRESH_MS || '3000');

/* iTunes (radio art) */
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ITUNES_COUNTRY = 'us';
const ITUNES_TIMEOUT_MS = Number(process.env.ITUNES_TIMEOUT_MS || '2500');
const ITUNES_TTL_HIT_MS = 1000 * 60 * 60 * 12; // 12h
const ITUNES_TTL_MISS_MS = 1000 * 60 * 10;     // 10m

const ART_DIR = '/home/brianwis/album_art/art'; // adjust to your real static dir
const ART_320_PATH = path.join(ART_DIR, 'current_320.jpg');
const ART_640_PATH = path.join(ART_DIR, 'current_640.jpg');
const ART_BG_PATH  = path.join(ART_DIR, 'current_bg_640_blur.jpg');


/* =========================
 * Express
 * ========================= */

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
 * Agents: LAN-bound vs default
 * ========================= */

const lanHttpAgent = new http.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });
const lanHttpsAgent = new https.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });
const defaultHttpAgent = new http.Agent({ keepAlive: true });
const defaultHttpsAgent = new https.Agent({ keepAlive: true });

function agentForUrl(url) {
  const s = String(url || '');
  const isLan =
    s.startsWith(MOODE_BASE_URL) ||
    s.startsWith('http://10.') ||
    s.startsWith('http://192.168.') ||
    s.startsWith('http://172.16.');

  const isHttps = s.startsWith('https:');
  if (isLan) return isHttps ? lanHttpsAgent : lanHttpAgent;
  return isHttps ? defaultHttpsAgent : defaultHttpAgent;
}

/* =========================
 * UPnP Identify helpers
 * ========================= */

function isUpnpMediaItemUrl(file) {
  const f = String(file || '');
  return f.includes(':8200/MediaItems/');
}

function getStreamKind(file) {
  if (!isStreamPath(file)) return '';
  if (isUpnpMediaItemUrl(file)) return 'upnp';
  return 'radio';
}

/* =========================
 * Fetch helpers
 * ========================= */
 
function normalizeArtKey(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  return s.split('#')[0].split('?')[0];
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function writeFileAtomic(destPath, buf) {
  const tmp = `${destPath}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, destPath);
}

async function fetchText(url, accept = 'text/plain') {
  const resp = await fetch(url, {
    headers: { Accept: accept },
    agent: agentForUrl(url),
    cache: 'no-store',
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 200)}`);
  return text;
}

async function fetchJson(url) {
  const text = await fetchText(url, 'application/json');
  if (!text.trim()) throw new Error(`Empty JSON body from ${url}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Bad JSON from ${url}: ${e.message}. Body: ${text.slice(0, 200)}`);
  }
}

async function fetchJsonWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      agent: agentForUrl(url),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 200)}`);
    if (!text.trim()) throw new Error(`Empty JSON body from ${url}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/* =========================
 * Basic helpers
 * ========================= */
 
function isStreamPath(file) {
  return !!file && file.includes('://');
}

function isAirplayFile(file) {
  return String(file || '').toLowerCase() === 'airplay active';
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function moodeValByKey(raw, keyOrIndex) {
  if (!raw) return '';

  if (typeof keyOrIndex === 'number') {
    const s = raw?.[String(keyOrIndex)];
    if (typeof s !== 'string') return '';
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1).trim() : s.trim();
  }

  const want = String(keyOrIndex).toLowerCase().trim() + ':';
  for (const v of Object.values(raw)) {
    if (typeof v !== 'string') continue;
    const line = v.trim();
    if (line.toLowerCase().startsWith(want)) {
      const i = line.indexOf(':');
      return i >= 0 ? line.slice(i + 1).trim() : line.trim();
    }
  }
  return '';
}

function normalizeMoodeStatus(raw) {
  const state = moodeValByKey(raw, 'state');
  const timeStr = moodeValByKey(raw, 'time');
  const elapsedStr = moodeValByKey(raw, 'elapsed');
  const durationStr = moodeValByKey(raw, 'duration');

  let elapsed = 0;
  let duration = 0;

  if (timeStr && String(timeStr).includes(':')) {
    const parts = String(timeStr).trim().split(':').map(s => s.trim());
    if (parts.length >= 2) {
      const e = Number.parseFloat(parts[0]);
      const d = Number.parseFloat(parts[1]);
      if (Number.isFinite(e)) elapsed = e;
      if (Number.isFinite(d)) duration = d;
    }
  }

  if (!(duration > 0)) {
    const e2 = Number.parseFloat(elapsedStr);
    const d2 = Number.parseFloat(durationStr);
    if (Number.isFinite(e2)) elapsed = e2;
    if (Number.isFinite(d2)) duration = d2;
  }

  const percent = duration > 0 ? Math.round((elapsed / duration) * 100) : 0;
  return { state, elapsed, duration, percent, time: timeStr };
}

function normalizeCoverUrl(coverurl, baseUrl = MOODE_BASE_URL) {
  const s = String(coverurl || '').trim();
  if (!s) return '';

  if (/^https?:\/\//i.test(s)) return s;

  // Fix accidental "http://host/http://host/..." duplication
  const m = s.match(/^(https?:\/\/[^/]+)\/(https?:\/\/.+)$/i);
  if (m) return m[2];

  const prefix = s.startsWith('/') ? '' : '/';
  return `${baseUrl}${prefix}${s}`;
}

function extractYear(str) {
  const m = String(str || '').match(/\b(\d{4})\b/);
  return m ? m[1] : '';
}

function requireTrackKey(req, res) {
  if (!TRACK_KEY) return true;
  const k = String(req.query.k || '') || String(req.headers['x-track-key'] || '');
  if (k !== TRACK_KEY) {
    res.status(403).send('Forbidden');
    return false;
  }
  return true;
}

/* =========================
 * MPD helpers (CLI)
 * ========================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mpcCmd(args) {
  return new Promise((resolve) => {
    const full = ['-h', MPD_HOST, '-p', String(MPD_PORT), ...args];
    execFile('mpc', full, { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        out: (stdout || '').trim(),
        err: (stderr || '').trim(),
        code: error?.code ?? 0,
      });
    });
  });
}

async function mpdPrimePlayPause() {
  await mpcCmd(['play']);
  await sleep(250);
  await mpcCmd(['stop']);
  return true;
}

/* =========================
 * Ratings (stickers)
 * ========================= */

function clampRating(n) {
  const x = Number.parseInt(String(n), 10);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(5, x));
}

async function mpdStickerGet(file, key) {
  if (!file || isStreamPath(file) || isAirplayFile(file)) return '';
  const { out } = await mpcCmd(['sticker', file, 'get', key]);
  return (out || '').trim();
}

async function mpdStickerSet(file, key, value) {
  if (!file || isStreamPath(file) || isAirplayFile(file)) return false;
  await mpcCmd(['sticker', file, 'set', key, String(value)]);
  return true;
}

async function mpdStickerDelete(file, key) {
  if (!file || isStreamPath(file) || isAirplayFile(file)) return false;
  try { await mpcCmd(['sticker', file, 'delete', key]); } catch {}
  return true;
}

function parseStickerValue(line, key) {
  const m = String(line || '').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, 'i'));
  return m ? String(m[1]).trim() : '';
}

async function getRatingForFile(file) {
  const s = await mpdStickerGet(file, 'rating');
  const v = parseStickerValue(s, 'rating');
  const n = Number.parseInt(v || '0', 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
}

async function setRatingForFile(file, rating0to5) {
  const r = clampRating(rating0to5);
  if (r === null) throw new Error('rating must be an integer 0..5');

  if (r === 0) {
    await mpdStickerDelete(file, 'rating');
    return 0;
  }
  await mpdStickerSet(file, 'rating', r);
  return r;
}

/* =========================
 * Favorites cache (MPD playlist)
 * ========================= */

let favoritesPlaylistCache = {
  ts: 0,
  set: new Set(),
  ok: false,
  err: '',
};

async function isFavoriteInPlaylist(mpdFile) {
  const f = String(mpdFile || '').trim();
  if (!f || isStreamPath(f) || isAirplayFile(f)) return false;

  const now = Date.now();
  if ((now - favoritesPlaylistCache.ts) < FAVORITES_REFRESH_MS) {
    return favoritesPlaylistCache.ok ? favoritesPlaylistCache.set.has(f) : false;
  }

  try {
    const { out, code, err } = await mpcCmd([
      'playlist',
      '-f', '%file%',
      FAVORITES_PLAYLIST_NAME,
    ]);
    if (code !== 0) throw new Error(err || `mpc exit code ${code}`);

    const set = new Set(
      String(out || '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    );

    favoritesPlaylistCache = { ts: now, set, ok: true, err: '' };
    return set.has(f);
  } catch (e) {
    favoritesPlaylistCache = { ts: now, set: new Set(), ok: false, err: e?.message || String(e) };
    return false;
  }
}

/* =========================
 * Local file mapping + tag reading
 * ========================= */

function mpdFileToLocalPath(mpdFile) {
  if (!mpdFile || isStreamPath(mpdFile) || isAirplayFile(mpdFile)) return '';
  if (!mpdFile.startsWith(MOODE_USB_PREFIX)) return '';
  return `${PI4_MOUNT_BASE}/${mpdFile.slice(MOODE_USB_PREFIX.length)}`;
}

function safeIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

async function runCmdQuiet(cmd, args) {
  try {
    const { stdout } = await execFileP(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return (stdout || '').trim();
  } catch {
    return '';
  }
}

async function metaflacTag(tag, filePath) {
  const out = await runCmdQuiet(METAFLAC, [`--show-tag=${tag}`, filePath]);
  const line = out.split('\n').find((l) => l.includes('='));
  return line ? line.split('=', 2)[1].trim() : '';
}

async function metaflacTagMulti(tag, filePath) {
  const out = await runCmdQuiet(METAFLAC, [`--show-tag=${tag}`, filePath]);
  return out
    .split('\n')
    .map((l) => l.split('=', 2)[1]?.trim())
    .filter(Boolean);
}

const deepTagCache = new Map();

async function getDeepMetadataCached(mpdFile) {
  const empty = { year: '', label: '', producer: '', performers: [] };
  if (!mpdFile) return empty;

  const cached = deepTagCache.get(mpdFile);
  if (cached) return cached;

  const p = mpdFileToLocalPath(mpdFile);
  if (!p || !safeIsFile(p)) {
    deepTagCache.set(mpdFile, empty);
    return empty;
  }

  const dateRaw = await metaflacTag('DATE', p);
  const year =
    (await metaflacTag('ORIGINALYEAR', p)) ||
    extractYear(await metaflacTag('ORIGINALDATE', p)) ||
    extractYear(dateRaw) ||
    '';

  const deep = {
    year,
    label: await metaflacTag('LABEL', p),
    producer: await metaflacTag('PRODUCER', p),
    performers: await metaflacTagMulti('PERFORMER', p),
  };

  deepTagCache.set(mpdFile, deep);
  return deep;
}

/* =========================
 * Art
 * ========================= */

async function buildArtDerivatives(rawUrl) {
  const r = await fetch(rawUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error(`art fetch failed: ${r.status}`);
  const input = Buffer.from(await r.arrayBuffer());

  // 320: UI thumb
  const out320 = await sharp(input)
    .rotate()
    .resize(320, 320, { fit: 'cover' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  // 640: MAIN foreground art (sharp)
  const out640 = await sharp(input)
    .rotate()
    .resize(640, 640, { fit: 'cover' })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  // 640: background (blurred)
  const outBG = await sharp(input)
    .rotate()
    .resize(640, 640, { fit: 'cover' })
    .blur(18)
    .jpeg({ quality: 70, mozjpeg: true })
    .toBuffer();

  return { out320, out640, outBG };
}

// =========================
// Album art cache state
// =========================
let lastArtKeyBuilt = '';

async function updateArtCacheIfNeeded(rawArtUrl) {
  const key = normalizeArtKey(rawArtUrl);
  if (!key) return;
  if (key === lastArtKeyBuilt) return;

  await ensureDir(ART_DIR);

  const { out320, out640, outBG } = await buildArtDerivatives(rawArtUrl);

  await writeFileAtomic(ART_320_PATH, out320);
  await writeFileAtomic(ART_640_PATH, out640);
  await writeFileAtomic(ART_BG_PATH,  outBG);

  lastArtKeyBuilt = key;
  console.log('[art] rebuilt', key);
}


/* =========================
 * MPD protocol (TCP) resolver
 * ========================= */

function mpdEscapeValue(v) {
  const s = String(v || '');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function mpdHasACK(raw) {
  return /(?:^|\r?\n)ACK\b/.test(String(raw || ''));
}

function parseMpdFirstBlock(txt) {
  const out = {};
  const lines = String(txt || '').split('\n');

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('OK MPD ')) continue;
    if (line === 'OK') break;
    if (line.startsWith('ACK')) break;

    const i = line.indexOf(':');
    if (i <= 0) continue;

    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

function mpdQueryRaw(command, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: MPD_HOST, port: MPD_PORT });

    let buf = '';
    let finished = false;
    let greetingSeen = false;
    let commandSent = false;

    const finish = (err) => {
      if (finished) return;
      finished = true;
      try { sock.destroy(); } catch {}
      err ? reject(err) : resolve(buf);
    };

    sock.setTimeout(timeoutMs, () => finish(new Error('mpd timeout')));
    sock.on('error', finish);

    const hasTerminalOK = (s) => /(?:\r?\n)OK\r?\n/.test(s) || /^OK\r?\n/.test(s);
    const hasACK = (s) => /(?:\r?\n)ACK /.test(s) || /^ACK /.test(s);

    sock.on('data', (d) => {
      buf += d.toString('utf8');

      if (!greetingSeen) {
        if (buf.includes('OK MPD ') && buf.includes('\n')) greetingSeen = true;
        else return;
      }

      if (!commandSent) {
        commandSent = true;
        sock.write(`${command}\nclose\n`);
        return;
      }

      if (hasACK(buf) || hasTerminalOK(buf)) finish();
    });

    sock.on('end', () => finish());
  });
}

async function mpdDeletePos0(pos0) {
  const n = Number(pos0);
  if (!Number.isFinite(n) || n < 0) throw new Error('bad pos0');
  await mpdQueryRaw(`delete ${n}`);
  return true;
}

async function mpdDeleteId(songid) {
  const id = Number(songid);
  if (!Number.isFinite(id) || id < 0) throw new Error('bad songid');
  await mpdQueryRaw(`deleteid ${id}`);
  return true;
}

async function mpdPlaylistInfoById(songid) {
  if (songid === '' || songid === null || songid === undefined) return null;
  const raw = await mpdQueryRaw(`playlistid ${songid}`);
  if (!raw || mpdHasACK(raw)) return null;

  const kv = parseMpdFirstBlock(raw);
  const file = kv.file || '';
  const title = kv.title || '';
  const artist = kv.artist || '';
  const album = kv.album || '';
  const id = kv.id || String(songid);
  const pos = kv.pos || '';

  if (!file && !title && !artist) return null;
  return { file, title, artist, album, songid: id, songpos: pos };
}

async function mpdPlaylistInfoByPos(songpos) {
  const n = Number(songpos);
  if (!Number.isFinite(n) || n < 0) return null;

  const raw = await mpdQueryRaw(`playlistinfo ${n}:${n + 1}`);
  if (!raw || mpdHasACK(raw)) return null;

  const kv = parseMpdFirstBlock(raw);
  const file   = kv.file   || '';
  const title  = kv.title  || '';
  const artist = kv.artist || '';
  const album  = kv.album  || '';
  const id     = kv.id     || '';
  const pos    = kv.pos    || String(n);

  if (!file && !title && !artist) return null;
  return { file, title, artist, album, songid: id, songpos: pos };
}

function isLibraryFile(mpdFile) {
  const f = String(mpdFile || '').trim();
  return !!f && !isStreamPath(f) && !isAirplayFile(f) && f.startsWith(MOODE_USB_PREFIX);
}

async function mpdFindFirstLocalByTag(tag, value) {
  if (!tag || !value) return '';

  const raw = await mpdQueryRaw(`find ${tag} ${mpdEscapeValue(value)}`);
  if (!raw || mpdHasACK(raw)) return '';

  // Minimal parse: find first "file:" occurrence
  const lines = String(raw).split('\n');
  for (const line of lines) {
    if (!line.toLowerCase().startsWith('file:')) continue;
    const f = line.slice(line.indexOf(':') + 1).trim();
    if (isLibraryFile(f)) return f;
  }
  for (const line of lines) {
    if (!line.toLowerCase().startsWith('file:')) continue;
    const f = line.slice(line.indexOf(':') + 1).trim();
    if (f && !isStreamPath(f) && !isAirplayFile(f)) return f;
  }
  return '';
}

/**
 * Resolve a UPnP/HTTP stream track to a local library file, when possible.
 * Guarded so we do nothing (and log nothing) when inputs are empty.
 */
async function resolveLibraryFileForStream(inputs, debugLog = null) {
  const songid  = String(inputs?.songid  || '').trim();
  const songpos = String(inputs?.songpos || '').trim();
  let title     = String(inputs?.title   || '').trim();
  let artist    = String(inputs?.artist  || '').trim();
  let album     = String(inputs?.album   || '').trim();
  let track     = String(inputs?.track   || '').trim();

  // If literally nothing to resolve, bail silently.
  if (!songid && !songpos && !title && !artist && !album && !track) return '';

  let mbTrackId = '';

  // Prefer songpos → playlistinfo (pulls musicbrainz_trackid when available)
  if (songpos) {
    const n = Number(songpos);
    if (Number.isFinite(n) && n >= 0) {
      const cmd = `playlistinfo ${n}:${n + 1}`;
      const raw = await mpdQueryRaw(cmd);

      if (debugLog) {
        debugLog('[resolver:playlistinfo-raw]', {
          cmd,
          rawLen: raw.length,
          hasACK: mpdHasACK(raw),
          head: raw.slice(0, 500),
        });
      }

      if (raw && !mpdHasACK(raw)) {
        const kv = parseMpdFirstBlock(raw);
        mbTrackId = kv.musicbrainz_trackid || '';
        title  = kv.title  || title  || '';
        artist = kv.artist || artist || '';
        album  = kv.album  || album  || '';
        track  = kv.track  || track  || '';
      }
    }
  }

  if (debugLog) {
    debugLog('[resolver:after-songpos]', { songpos, songid, mbTrackId, title, artist, album, track });
  }

  // Fallback songid → playlistid
  if (!mbTrackId && songid) {
    const raw = await mpdQueryRaw(`playlistid ${songid}`);
    if (raw && !mpdHasACK(raw)) {
      const kv = parseMpdFirstBlock(raw);
      mbTrackId = kv.musicbrainz_trackid || '';
      title  = title  || kv.title  || '';
      artist = artist || kv.artist || '';
      album  = album  || kv.album  || '';
      track  = track  || kv.track  || '';
    }
  }

  if (mbTrackId) {
    const f = await mpdFindFirstLocalByTag('MUSICBRAINZ_TRACKID', mbTrackId);
    if (f) return f;
  }

  // Loose fallback heuristics
  if (title) {
    const f1 = await mpdFindFirstLocalByTag('Title', title);
    if (f1) return f1;
  }
  if (album) {
    const f2 = await mpdFindFirstLocalByTag('Album', album);
    if (f2) return f2;
  }
  if (track && album) {
    const f3 = await mpdFindFirstLocalByTag('Track', track);
    if (f3) return f3;
  }

  return '';
}

/* =========================
 * iTunes artwork cache (radio)
 * ========================= */

const itunesArtCache = new Map();

function pickArtFromItunesItem(item) {
  let art = item?.artworkUrl100 || '';
  if (art) art = art.replace(/\/\d+x\d+bb\./, '/600x600bb.');
  return art;
}

function pickAlbumAndYearFromItunesItem(item) {
  const album = item?.collectionName || '';
  const year = item?.releaseDate ? String(item.releaseDate).slice(0, 4) : '';
  return { album, year };
}

async function lookupItunesFirst(artist, title, debug = false) {
  if (!artist || !title) return { url: '', album: '', year: '', reason: 'missing-artist-or-title' };

  const key = `song|${artist.toLowerCase()}|${title.toLowerCase()}`;
  const now = Date.now();

  const cached = itunesArtCache.get(key);
  if (cached && !debug) {
    const ttl = cached.url ? ITUNES_TTL_HIT_MS : ITUNES_TTL_MISS_MS;
    if (now - cached.ts < ttl) return { ...cached, reason: cached.url ? 'cache-hit' : 'cache-hit-empty' };
    itunesArtCache.delete(key);
  }

  const term = encodeURIComponent(`${artist} ${title}`);
  const queryUrl = `${ITUNES_SEARCH_URL}?term=${term}&media=music&entity=song&limit=5&country=${ITUNES_COUNTRY}`;

  try {
    const data = await fetchJsonWithTimeout(queryUrl, ITUNES_TIMEOUT_MS);
    const first = Array.isArray(data?.results) ? data.results[0] : null;

    const url = pickArtFromItunesItem(first);
    const { album, year } = pickAlbumAndYearFromItunesItem(first);

    const packed = { url, album, year, ts: now };
    itunesArtCache.set(key, packed);

    return { url, album, year, reason: url ? 'ok:songFirst' : 'no-art:songFirst' };
  } catch (e) {
    itunesArtCache.set(key, { url: '', album: '', year: '', ts: now });
    return { url: '', album: '', year: '', reason: `error:${e?.name || 'Error'}` };
  }
}

/* =========================
 * AirPlay aplmeta.txt
 * ========================= */

function parseAplmeta(txt) {
  const line = String(txt || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  const parts = line.split('~~~');

  const title = (parts[0] || '').trim();
  const artist = (parts[1] || '').trim();
  const album = (parts[2] || '').trim();
  const duration = (parts[3] || '').trim();
  const coverRel = (parts[4] || '').trim();
  const fmt = (parts[5] || '').trim();

  const coverUrl = coverRel ? normalizeCoverUrl('/' + coverRel.replace(/^\/+/, '')) : '';
  return { title, artist, album, duration, coverRel, coverUrl, format: fmt };
}

/* =========================
 * Artwork fetch + resize
 * ========================= */

async function fetchMoodeCoverBytes(ref) {
  const s = String(ref || '').trim();
  if (!s) throw new Error('empty cover ref');

  if (/^https?:\/\//i.test(s)) {
    const resp = await fetch(s, { agent: agentForUrl(s), cache: 'no-store' });
    if (!resp.ok) throw new Error(`cover fetch failed: HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  const url = normalizeCoverUrl(s.startsWith('/') ? s : `/${s}`, MOODE_BASE_URL);
  const resp = await fetch(url, { agent: agentForUrl(url), cache: 'no-store' });
  if (!resp.ok) throw new Error(`cover fetch failed: HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function sendJpeg(res, buf, max) {
  const out = max
    ? await sharp(buf).rotate().resize(max, max, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer()
    : await sharp(buf).rotate().jpeg({ quality: 85, mozjpeg: true }).toBuffer();

  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.status(200).send(out);
}

/* =========================
 * Last-good cache for now-playing
 * ========================= */

let lastNowPlayingOk = null;
let lastNowPlayingTs = 0;

/* =========================
 * Routes
 * ========================= */

app.post('/favorites/toggle', async (req, res) => {
  try {
    const file = String(req?.body?.file || '').trim();
    if (!file) return res.status(400).json({ ok: false, error: 'Missing { file }' });

    if (isStreamPath(file) || isAirplayFile(file)) {
      return res.json({ ok: true, file, isFavorite: false, disabled: true });
    }

    const isFav = await isFavoriteInPlaylist(file);

    if (isFav) {
      const { code, err } = await mpcCmd(['playlistdelete', FAVORITES_PLAYLIST_NAME, file]);
      if (code !== 0) throw new Error(err || 'playlistdelete failed');
      return res.json({ ok: true, file, isFavorite: false, action: 'removed' });
    } else {
      const { code, err } = await mpcCmd(['playlistadd', FAVORITES_PLAYLIST_NAME, file]);
      if (code !== 0) throw new Error(err || 'playlistadd failed');
      return res.json({ ok: true, file, isFavorite: true, action: 'added' });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/now-playing', async (req, res) => {
  const debug = req.query.debug === '1';
  const dlog = (...args) => { if (debug) console.log(...args); };

  function serveCached(reason, errMsg = '') {
    if (lastNowPlayingOk) {
      const ageMs = Date.now() - lastNowPlayingTs;
      return res.status(200).json({
        ...lastNowPlayingOk,
        _stale: true,
        _staleAgeMs: ageMs,
        ...(debug ? { _staleReason: reason, _staleError: errMsg } : {}),
      });
    }
    return res.status(503).json({
      error: 'now-playing unavailable',
      ...(debug ? { reason, err: errMsg } : {}),
    });
  }

  try {
    let song, statusRaw;
    try {
      song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    } catch (e) {
      return serveCached('get_currentsong_failed', e?.message || String(e));
    }

    try {
      statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
    } catch (e) {
      return serveCached('status_failed', e?.message || String(e));
    }

    const status = normalizeMoodeStatus(statusRaw);
    const songpos = String(moodeValByKey(statusRaw, 'song') || '').trim();
    const songid  = String(moodeValByKey(statusRaw, 'songid') || '').trim();

    const file = String(song.file || '').trim();
    const stream = isStreamPath(file);
    const airplay = isAirplayFile(file) || (String(song.encoded || '').toLowerCase() === 'airplay');

    // classify streams (radio vs upnp etc.)
    const streamKind = stream ? String(getStreamKind(file) || '').trim() : '';
    const isUpnp = streamKind === 'upnp';

    let albumArtUrl = '';
    if (stream) {
      albumArtUrl = song.coverurl ? normalizeCoverUrl(song.coverurl, MOODE_BASE_URL) : '';
    } else if (!airplay && file) {
      albumArtUrl = `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(file)}`;
    }

    const aplArtUrl = `${PUBLIC_BASE_URL}/art/current_320.jpg`;

    let artist = song.artist || '';
    let title  = song.title || '';
    let album  = song.album || '';

    let altArtUrl = '';
    let producer = '';
    let personnel = [];

    /* AIRPLAY authoritative aplmeta.txt */
    if (airplay) {
      let airplayInfoLine = 'AirPlay';
      try {
        const aplText = await fetchText(`${MOODE_BASE_URL}/aplmeta.txt`, 'text/plain');
        const ap = parseAplmeta(aplText);

        artist = ap.artist || artist || '';
        title  = ap.title  || title  || '';
        album  = ap.album  || album  || 'AirPlay Source';

        altArtUrl = ap.coverUrl || '';
        airplayInfoLine = ap.format || 'AirPlay';
      } catch {}

      // ✅ Build + cache art derivatives for UI thumb + blurred background
      const rawArtUrl = (altArtUrl && altArtUrl.trim())
        ? altArtUrl.trim()
        : (albumArtUrl || '');
      updateArtCacheIfNeeded(rawArtUrl)
        .catch(e => console.warn('[art] failed', e.message));

      const payload = {
        artist: artist || '',
        title: title || '',
        album: album || '',
        file: file || 'AirPlay Active',

        songpos,
        songid,

        albumArtUrl: albumArtUrl || '',
        aplArtUrl,
        altArtUrl: altArtUrl || '',

        radioAlbum: '',
        radioYear: '',
        radioLabel: '',
        radioComposer: '',
        radioWork: '',
        radioPerformers: '',

        state: status.state || song.state,
        elapsed: status.elapsed,
        duration: status.duration,
        percent: status.percent,

        year: '',
        label: '',
        producer: '',
        personnel: [],

        encoded: airplayInfoLine,
        bitrate: song.bitrate || '',
        outrate: song.outrate || '',
        volume: song.volume || '0',
        mute: song.mute || '0',
        track: song.track || '',
        date: song.date || '',

        // mode flags
        isStream: false,
        isAirplay: true,
        streamKind: '',
        isUpnp: false,

        isFavorite: false,

        ...(debug ? { debugAplmetaUrl: `${MOODE_BASE_URL}/aplmeta.txt` } : {}),
      };

      lastNowPlayingOk = payload;
      lastNowPlayingTs = Date.now();
      return res.json(payload);
    }

    /* STREAM: try to resolve to local file for better cover art */
    let debugArtUpgraded = false;
    let debugResolvedFile = '';
    let debugArtErr = '';

    if (stream) {
      try {
        const hasResolverInputs =
          !!songpos || !!songid ||
          !!String(song.title || '').trim() ||
          !!String(song.artist || '').trim() ||
          !!String(song.album || '').trim() ||
          !!String(song.track || '').trim();

        if (hasResolverInputs) {
          const realFile = await resolveLibraryFileForStream({
            songid,
            songpos,
            title: song.title || '',
            artist: song.artist || '',
            album: song.album || '',
            track: song.track || '',
          });

          debugResolvedFile = realFile || '';
          if (realFile) {
            albumArtUrl = `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(realFile)}`;
            debugArtUpgraded = true;
          }
        }
      } catch (e) {
        debugArtErr = e?.message || String(e);
        dlog('UPnP/stream art upgrade failed:', debugArtErr);
      }
    }

    /* FILE: deep tags */
    const deep = stream
      ? { year: '', label: '', producer: '', performers: [] }
      : await getDeepMetadataCached(file);

    producer = deep.producer || '';
    personnel = deep.performers || [];

    /* STREAM: iTunes optional alt art (RADIO ONLY) */
    let radioAlbum = '';
    let radioYear = '';
    let radioLabel = '';
    let radioComposer = '';
    let radioWork = '';
    let radioPerformers = '';
    let debugItunesReason = '';

    if (stream) {
      if (streamKind === 'radio') {
        const decodedTitle = decodeHtmlEntities(song.title || '');
        const parts = decodedTitle.split(' - ').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const it = await lookupItunesFirst(parts[0], parts.slice(1).join(' - '), debug);
          altArtUrl = it.url || '';
          radioAlbum = it.album || '';
          radioYear = it.year || '';
          debugItunesReason = it.reason || '';
        } else {
          debugItunesReason = 'no-parse';
        }
      } else {
        // don’t treat UPnP as radio
        debugItunesReason = `skip:${streamKind || 'stream'}`;
      }
    }

    const isFavorite = (!stream && file) ? await isFavoriteInPlaylist(file) : false;

    const payload = {
      artist: artist || '',
      title: title || '',
      album: album || '',
      file: file || '',

      songpos,
      songid,

      albumArtUrl: albumArtUrl || '',
      aplArtUrl,
      altArtUrl: altArtUrl || '',

      radioAlbum,
      radioYear,
      radioLabel,
      radioComposer,
      radioWork,
      radioPerformers,

      state: status.state || song.state,
      elapsed: status.elapsed,
      duration: status.duration,
      percent: status.percent,

      year: deep.year || '',
      label: deep.label || '',
      producer: producer || '',
      personnel: personnel || [],

      encoded: song.encoded || '',
      bitrate: song.bitrate || '',
      outrate: song.outrate || '',
      volume: song.volume || '0',
      mute: song.mute || '0',
      track: song.track || '',
      date: song.date || '',

      // mode flags
      isStream: stream,
      isAirplay: false,
      streamKind,
      isUpnp,

      isFavorite,

      ...(debug ? { debugArtUpgraded, debugResolvedFile, debugArtErr, debugItunesReason } : {}),
    };

    lastNowPlayingOk = payload;
    lastNowPlayingTs = Date.now();
    return res.json(payload);

  } catch (err) {
    console.error('now-playing error:', err?.stack || err?.message || String(err));
    return serveCached('exception', err?.message || String(err));
  }
});

app.get('/next-up', async (req, res) => {
  const debug = req.query.debug === '1';

  // moOde coverart.php expects the MPD-style file path URL-encoded after the slash
  const coverArtForFile = (filePath) => {
    const f = String(filePath || '').trim();
    if (!f) return '';
    return `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(f)}`;
  };

  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);

    const file = String(song.file || '').trim();
    const isStream = isStreamPath(file);
    const isAirplay =
      isAirplayFile(file) || String(song.encoded || '').toLowerCase() === 'airplay';

    if (isStream || isAirplay) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'stream-or-airplay' } : {}),
      });
    }

    const nextsongRaw = moodeValByKey(statusRaw, 'nextsong');
    const nextsongid = moodeValByKey(statusRaw, 'nextsongid');

    if (!String(nextsongRaw || '').trim()) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'no-nextsong' } : {}),
      });
    }

    const nextPos = Number.parseInt(String(nextsongRaw).trim(), 10);
    if (!Number.isFinite(nextPos) || nextPos < 0) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'bad-nextsong', nextsongRaw, nextsongid } : {}),
      });
    }

    let next = await mpdPlaylistInfoByPos(nextPos);
    if (!next && nextsongid) next = await mpdPlaylistInfoById(nextsongid);

    if (!next) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'mpd-no-match', nextPos, nextsongid } : {}),
      });
    }

    const nextFile = String(next.file || '').trim();
    const nextArtUrl = coverArtForFile(nextFile);

    return res.json({
      ok: true,
      next: {
        songid: next.songid || String(nextsongid || ''),
        songpos: next.songpos || String(nextPos),
        title: next.title || '',
        artist: next.artist || '',
        album: next.album || '',
        file: nextFile,
        artUrl: nextArtUrl, // ✅ art for the NEXT track
        // Optional: keep a "current art" url around for any older client that expects it
        currentArtUrl: `/art/current_320.jpg`,
      },
      ...(debug ? { reason: 'ok' } : {}),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      next: null,
      ...(debug ? { error: err?.message || String(err), reason: 'exception' } : {}),
    });
  }
});

app.get('/art/current_320.jpg', async (req, res) => {
  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);

    const file = String(song.file || '').trim();
    const stream = isStreamPath(file);
    const airplay = isAirplayFile(file) || String(song.encoded || '').toLowerCase() === 'airplay';

    let best = '';
    if (!airplay && !stream && file) {
      best = `/coverart.php/${encodeURIComponent(file)}`;
    } else if (stream) {
      const songpos = String(moodeValByKey(statusRaw, 'song') || '').trim();
      const songid  = String(moodeValByKey(statusRaw, 'songid') || '').trim();

      const realFile = await resolveLibraryFileForStream({
        songid,
        songpos,
        title: song.title || '',
        artist: song.artist || '',
        album: song.album || '',
        track: song.track || '',
      }, null);

      if (realFile) best = `/coverart.php/${encodeURIComponent(realFile)}`;
    }

    if (!best && song.coverurl) best = normalizeCoverUrl(song.coverurl, MOODE_BASE_URL);
    if (!best) return res.status(404).end();

    const buf = await fetchMoodeCoverBytes(best);
    await sendJpeg(res, buf, 320);
  } catch {
    res.status(404).end();
  }
});

app.get('/art/current_bg_640_blur.jpg', async (req, res) => {
  try {
    // If the cache file exists, serve it (fast path)
    if (safeIsFile(ART_BG_PATH)) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      return res.status(200).send(await fs.promises.readFile(ART_BG_PATH));
    }

    // Otherwise, fall back to building it from the best available art
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);

    const file = String(song.file || '').trim();
    const stream = isStreamPath(file);
    const airplay = isAirplayFile(file) || String(song.encoded || '').toLowerCase() === 'airplay';

    let best = '';
    if (!airplay && !stream && file) {
      best = `/coverart.php/${encodeURIComponent(file)}`;
    } else if (stream) {
      const songpos = String(moodeValByKey(statusRaw, 'song') || '').trim();
      const songid  = String(moodeValByKey(statusRaw, 'songid') || '').trim();

      const realFile = await resolveLibraryFileForStream({
        songid,
        songpos,
        title: song.title || '',
        artist: song.artist || '',
        album: song.album || '',
        track: song.track || '',
      }, null);

      if (realFile) best = `/coverart.php/${encodeURIComponent(realFile)}`;
    }

    if (!best && song.coverurl) best = normalizeCoverUrl(song.coverurl, MOODE_BASE_URL);
    if (!best) return res.status(404).end();

    const buf = await fetchMoodeCoverBytes(best);

    // build a blurred 640 derivative on the fly
    const outBG = await sharp(buf)
      .rotate()
      .resize(640, 640, { fit: 'cover' })
      .blur(18)
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    return res.status(200).send(outBG);
  } catch {
    res.status(404).end();
  }
});

app.get('/art/current_640.jpg', async (req, res) => {
  try {
    // Fast path: serve cached file
    if (safeIsFile(ART_640_PATH)) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      return res.status(200).send(await fs.promises.readFile(ART_640_PATH));
    }

    // Fallback: build from current best art
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);

    const file = String(song.file || '').trim();
    const stream = isStreamPath(file);
    const airplay = isAirplayFile(file) || String(song.encoded || '').toLowerCase() === 'airplay';

    let best = '';
    if (!airplay && !stream && file) {
      best = `/coverart.php/${encodeURIComponent(file)}`;
    } else if (stream) {
      const songpos = String(moodeValByKey(statusRaw, 'song') || '').trim();
      const songid  = String(moodeValByKey(statusRaw, 'songid') || '').trim();

      const realFile = await resolveLibraryFileForStream({
        songid,
        songpos,
        title: song.title || '',
        artist: song.artist || '',
        album: song.album || '',
        track: song.track || '',
      }, null);

      if (realFile) best = `/coverart.php/${encodeURIComponent(realFile)}`;
    }

    if (!best && song.coverurl) best = normalizeCoverUrl(song.coverurl, MOODE_BASE_URL);
    if (!best) return res.status(404).end();

    const buf = await fetchMoodeCoverBytes(best);

    const out640 = await sharp(buf)
      .rotate()
      .resize(640, 640, { fit: 'cover' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    return res.status(200).send(out640);
  } catch {
    res.status(404).end();
  }
});

app.get('/rating', async (req, res) => {
  try {
    const file = String(req.query.file || '').trim();
    if (!file) return res.status(400).json({ ok: false, error: 'Missing ?file=' });

    if (isStreamPath(file) || isAirplayFile(file)) {
      return res.json({ ok: true, file, rating: 0, disabled: true });
    }

    const rating = await getRatingForFile(file);
    return res.json({ ok: true, file, rating });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/rating', async (req, res) => {
  try {
    const file = String(req?.body?.file || '').trim();
    if (!file) return res.status(400).json({ ok: false, error: 'Missing JSON body { file, rating }' });

    if (isStreamPath(file) || isAirplayFile(file)) {
      return res.json({ ok: true, file, rating: 0, disabled: true });
    }

    const r = clampRating(req?.body?.rating);
    if (r === null) return res.status(400).json({ ok: false, error: 'rating must be an integer 0..5' });

    const newRating = await setRatingForFile(file, r);
    return res.json({ ok: true, file, rating: newRating });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/rating/current', async (req, res) => {
  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const file = String(song.file || '').trim();

    if (!file || isStreamPath(file) || isAirplayFile(file)) {
      return res.json({ ok: true, file: file || '', rating: 0, disabled: true });
    }

    const rating = await getRatingForFile(file);
    return res.json({ ok: true, file, rating, disabled: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/rating/current', async (req, res) => {
  try {
    const r = clampRating(req?.body?.rating);
    if (r === null) return res.status(400).json({ ok: false, error: 'rating must be an integer 0..5' });

    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const file = String(song.file || '').trim();

    if (!file || isStreamPath(file) || isAirplayFile(file)) {
      return res.json({ ok: true, file: file || '', rating: 0, disabled: true });
    }

    const newRating = await setRatingForFile(file, r);
    return res.json({ ok: true, file, rating: newRating, disabled: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/mpd/prime', async (req, res) => {
  try {
    await mpdPrimePlayPause();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/queue/advance', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;

    // Accept songid (preferred) from JSON body OR querystring
    const songidRaw =
      (req?.body?.songid !== undefined ? req.body.songid : undefined) ??
      (req?.query?.songid !== undefined ? req.query.songid : undefined);

    const songid = Number.parseInt(String(songidRaw ?? '').trim(), 10);

    // Accept pos0 as optional fallback / diagnostics
    const pos0raw =
      (req?.body?.pos0 !== undefined ? req.body.pos0 : undefined) ??
      (req?.query?.pos0 !== undefined ? req.query.pos0 : undefined);

    const pos0 = Number.parseInt(String(pos0raw ?? '').trim(), 10);

    // Optional: accept file for sanity checking
    const file = String(req?.body?.file || req?.query?.file || '').trim();

    // Require at least one identifier
    const haveSongId = Number.isFinite(songid) && songid >= 0;
    const havePos0   = Number.isFinite(pos0) && pos0 >= 0;

    if (!haveSongId && !havePos0) {
      return res.status(400).json({ ok: false, error: 'Missing/invalid songid (preferred) or pos0 (fallback)' });
    }

    // Optional safety: if file was provided and we have songid, confirm it still points to expected file
    if (file && haveSongId) {
      try {
        const info = await mpdPlaylistInfoById(songid);   // you already have this helper
        const actual = String(info?.file || '').trim();

        if (actual && actual !== file) {
          console.log('[queue/advance] id mismatch, priming only', {
            songid,
            tokenFile: file,
            mpdFile: actual,
          });

          await mpdPrimePlayPause();

          return res.json({
            ok: true,
            skippedDelete: true,
            reason: 'id-mismatch-primed',
          });
        }
      } catch (e) {
        console.log('[queue/advance] id check failed, continuing:', e?.message || String(e));
      }
    }

    // 1) Delete finished track
    if (haveSongId) {
      await mpdDeleteId(songid);
    } else {
      // fallback
      await mpdDeletePos0(pos0);
    }

    // 2) Prime MPD so a new "current" is selected (avoid STOP/empty)
    await mpdPrimePlayPause();

    // 3) Return a fresh now-playing snapshot (lightweight)
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);

    const songposNow = moodeValByKey(statusRaw, 'song');
    const songidNow  = moodeValByKey(statusRaw, 'songid');

    return res.json({
      ok: true,
      nowPlaying: {
        file: song.file || '',
        title: decodeHtmlEntities(song.title || ''),
        artist: decodeHtmlEntities(song.artist || ''),
        album: decodeHtmlEntities(song.album || ''),
        songpos: String(songposNow || '').trim(),
        songid: String(songidNow || '').trim(),
      },
    });
  } catch (e) {
    console.error('/queue/advance error:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================
 * /track (Alexa) - unchanged behavior
 * ========================= */

function parseRange(rangeHeader, size) {
  const m = String(rangeHeader || '').match(/bytes=(\d*)-(\d*)/i);
  if (!m) return null;

  let start = m[1] ? Number.parseInt(m[1], 10) : NaN;
  let end   = m[2] ? Number.parseInt(m[2], 10) : NaN;

  if (!Number.isFinite(start) && Number.isFinite(end)) {
    const n = end;
    if (!(n > 0)) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    if (Number.isFinite(start) && !Number.isFinite(end)) end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < 0) return null;
  if (start > end) return null;
  if (start >= size) return null;

  end = Math.min(end, size - 1);
  return { start, end };
}

function serveFileWithRange(req, res, absPath, contentType) {
  const stat = fs.statSync(absPath);
  const size = stat.size;

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', size);
    fs.createReadStream(absPath).pipe(res);
    return;
  }

  const r = parseRange(range, size);
  if (!r) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.end();
  }

  const { start, end } = r;
  const chunkSize = (end - start) + 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', chunkSize);

  fs.createReadStream(absPath, { start, end }).pipe(res);
}

function ensureDirSync(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function cacheKeyFor(mpdFile, startSec) {
  const raw = `${mpdFile}||t=${Math.floor(startSec || 0)}`;
  return Buffer.from(raw, 'utf8').toString('base64').replace(/[/+=]/g, '_');
}

async function transcodeToMp3File({ inputPath, outputPath, startSec }) {
  const tmp = outputPath + '.part';
  try { fs.unlinkSync(tmp); } catch {}

  const args = ['-hide_banner', '-loglevel', 'error'];
  if (startSec > 0) args.push('-ss', String(startSec));

  args.push(
    '-i', inputPath,
    '-vn',
    '-map', '0:a:0',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    '-f', 'mp3',
    tmp
  );

  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let errTxt = '';
    ff.stderr.on('data', (d) => { errTxt += d.toString('utf8'); });

    ff.on('error', reject);
    ff.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed code=${code} ${errTxt.slice(0, 300)}`));
    });
  });

  fs.renameSync(tmp, outputPath);
}

app.get('/track', async (req, res) => {
  if (!ENABLE_ALEXA) return res.status(404).end();

  try {
    if (!requireTrackKey(req, res)) return;

    const mpdFile = String(req.query.file || '').trim();
    if (!mpdFile) return res.status(400).send('Missing ?file=');

    if (isStreamPath(mpdFile) || isAirplayFile(mpdFile)) {
      return res.status(400).send('Not a local track');
    }

    const localPath = mpdFileToLocalPath(mpdFile);
    if (!localPath || !safeIsFile(localPath)) {
      return res.status(404).send('Track not found');
    }

    const startSec = Math.max(0, Number.parseFloat(String(req.query.t || '0')) || 0);

    if (localPath.toLowerCase().endsWith('.mp3') && startSec === 0) {
      return serveFileWithRange(req, res, localPath, 'audio/mpeg');
    }

    if (!TRANSCODE_TRACKS) {
      if (startSec > 0) return res.status(400).send('Seek requires transcoding');

      const ext = localPath.toLowerCase();
      const ct =
        ext.endsWith('.flac') ? 'audio/flac' :
        ext.endsWith('.wav')  ? 'audio/wav'  :
        ext.endsWith('.aac')  ? 'audio/aac'  :
        ext.endsWith('.m4a')  ? 'audio/mp4'  :
        ext.endsWith('.mp3')  ? 'audio/mpeg' :
        'application/octet-stream';

      return serveFileWithRange(req, res, localPath, ct);
    }

    ensureDirSync(TRACK_CACHE_DIR);
    const key = cacheKeyFor(mpdFile, startSec);
    const cachedMp3 = path.join(TRACK_CACHE_DIR, key + '.mp3');

    if (!safeIsFile(cachedMp3)) {
      console.log('[track] cache miss → transcoding:', mpdFile, 't=', startSec);
      await transcodeToMp3File({ inputPath: localPath, outputPath: cachedMp3, startSec });
    }

    return serveFileWithRange(req, res, cachedMp3, 'audio/mpeg');
  } catch (e) {
    console.error('/track error:', e?.message || String(e));
    try { res.status(500).send('track failed'); } catch {}
  }
});

/* =========================
 * Start
 * ========================= */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`moOde now-playing server running on port ${PORT}`);
  console.log(`Endpoint: http://${LOCAL_ADDRESS}:${PORT}/now-playing`);
  console.log(`Endpoint: http://${LOCAL_ADDRESS}:${PORT}/next-up`);
  console.log(`Public: ${PUBLIC_BASE_URL}`);
  console.log(`Alexa routes enabled? ${ENABLE_ALEXA ? 'YES' : 'NO'}`);
});