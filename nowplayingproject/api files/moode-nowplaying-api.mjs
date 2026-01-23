#!/usr/bin/env node
/**
 * moode-nowplaying.mjs -- moOde Now-Playing API (Pi4)
 *
 * Primary goal:
 *  - Keep the LAN display endpoints stable and boring:
 *      GET  /now-playing
 *      GET  /next-up
 *      GET  /art/*
 *      GET/POST /rating
 *      POST /queue/*
 *      POST /mpd/*
 *
 * Secondary (optional) goal:
 *  - Support Alexa/public playback helpers without ever endangering the core:
 *      GET  /track
 *      GET  /alexa/*
 *
 * Safety design:
 *  - Alexa-related routes are intended to be gated by ENABLE_ALEXA=1
 *  - TRACK_KEY is used where clients (Alexa) cannot send custom headers
 *  - fetchJson() is hardened to avoid "Unexpected end of JSON input"
 *
 * This Phase A pass adds ORGANIZATION + COMMENTS only.
 * No new logic. No duplicates. No behavior changes.
 */

/* =========================
 * 1) Imports (keep this list single-source-of-truth)
 * ========================= */

// ---- Node built-ins ----
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

// ---- Third-party deps ----
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import sharp from 'sharp';

const execFileP = promisify(execFile);

/* =========================
 * 2) Express app + middleware
 * ========================= */

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
 * 3) Config (ORDER MATTERS)
 * ========================= *
 * Important: these are environment-driven (PM2 ecosystem).
 * Keep all config in one place so it’s obvious what controls behavior.
 *
 * ✅ PERSONALIZATION NOTE
 * This project is meant to be portable. Do NOT hardcode your own IPs/domains here.
 * Use environment variables (PM2 / systemd) and set the values for YOUR network.
 *
 * Typical setup:
 *  - MOODE_BASE_URL   = the LAN URL for your moOde player (Pi #1), e.g. http://moode.local
 *  - PUBLIC_BASE_URL  = your HTTPS public hostname (optional), e.g. https://moode.YOURDOMAINNAME.com
 *  - LOCAL_ADDRESS    = the LAN IP of THIS server (Pi #2) if you need to bind outbound LAN fetches
 *  - MPD_HOST/MPD_PORT= where MPD is listening (often the moOde Pi)
 *
 * If you are LAN-only and not using Alexa:
 *  - PUBLIC_BASE_URL can be left blank (or point at your LAN host)
 *  - ENABLE_ALEXA should remain OFF
 */

// Transcoding feature flag for /track
const TRANSCODE_TRACKS = String(process.env.TRANSCODE_TRACKS || '0').trim() === '1';

// Server port
const PORT = Number(process.env.PORT || '3000');

/**
 * moOde base URL (LAN) for:
 *  - /command (get_currentsong, status, etc.)
 *  - /aplmeta.txt (AirPlay authoritative metadata)
 *  - /coverart.php (local artwork)
 *
 * Examples:
 *  - http://moode.local
 *  - http://YOUR_MOODE_IP
 */
const MOODE_BASE_URL = String(process.env.MOODE_BASE_URL || 'http://moode.local').trim();

/**
 * Public HTTPS base URL for anything a client must load off-LAN:
 *  - Echo devices (Alexa AudioPlayer stream URLs must be HTTPS)
 *  - phones/tablets when away from home
 *
 * Examples:
 *  - https://moode.YOURDOMAINNAME.com
 *
 * If you are LAN-only, you can set this to your LAN host OR leave it empty,
 * but /track (Alexa) will not be usable without proper HTTPS.
 */
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://moode.YOURDOMAINNAME.com').trim();

/**
 * Shared secret for routes that must work for clients that can’t send headers
 * (Alexa AudioPlayer often uses querystring tokens):
 *  - /track
 *  - /queue/advance
 *
 * IMPORTANT:
 *  - If TRACK_KEY is blank, guarded routes are effectively unprotected.
 *  - That’s acceptable for LAN-only testing, but NOT for internet exposure.
 */
const TRACK_KEY = String(process.env.TRACK_KEY || '').trim();

/**
 * This server's LAN IP (Pi #2).
 * Used to bind outbound LAN requests (agent localAddress) to avoid dual-NIC oddities.
 *
 * If you don’t need this, you can leave it blank and remove localAddress binding.
 *
 * Example:
 *  - 192.168.1.50
 */
const LOCAL_ADDRESS = String(process.env.LOCAL_ADDRESS || '').trim();

// MPD connection (often your moOde Pi)
const MPD_HOST = String(process.env.MPD_HOST || '').trim() || new URL(MOODE_BASE_URL).hostname;
const MPD_PORT = Number(process.env.MPD_PORT || '6600');

// MPD file prefix and Pi #2 mount point (must match your environment)
const MOODE_USB_PREFIX = String(process.env.MOODE_USB_PREFIX || 'USB/YOURMUSICDRIVE/').trim();
const PI4_MOUNT_BASE   = String(process.env.PI4_MOUNT_BASE   || '/mnt/YOURMUSICDRIVE').trim();

// Tools
const METAFLAC = String(process.env.METAFLAC || '/usr/bin/metaflac').trim();

// iTunes Search (public)
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ITUNES_COUNTRY = 'us';
const ITUNES_TIMEOUT_MS = Number(process.env.ITUNES_TIMEOUT_MS || '2500');

const ITUNES_TTL_HIT_MS  = 1000 * 60 * 60 * 12; // 12 hours
const ITUNES_TTL_MISS_MS = 1000 * 60 * 10;      // 10 minutes

// Alexa features optional. Default OFF so experimenting can’t break /now-playing.
const ENABLE_ALEXA = String(process.env.ENABLE_ALEXA || '').trim() === '1';

/* =========================
 * Agents (LAN-bound vs default)
 * ========================= */

const lanHttpAgent = new http.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });
const lanHttpsAgent = new https.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });

const defaultHttpAgent = new http.Agent({ keepAlive: true });
const defaultHttpsAgent = new https.Agent({ keepAlive: true });

// Bind LAN fetches to LOCAL_ADDRESS to avoid dual-NIC weirdness.
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
 * Hardened fetch helpers
 * ========================= */

async function fetchText(url, accept = 'text/plain') {
  const resp = await fetch(url, {
    headers: { Accept: accept },
    agent: agentForUrl(url),
    cache: 'no-store',
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 200)}`);
  }
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

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Bad JSON from ${url}: ${e.message}. Body: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* =========================
 * 4) Helpers (grouped + single definitions)
 * ========================= *
 * These are used by multiple routes. Keep them here so:
 *  - duplicates are obvious
 *  - routes stay readable
 */

/* ---------- Auth / gating ---------- */

function requireTrackKey(req, res) {
  if (!TRACK_KEY) return true;

  const k =
    String(req.query.k || '') ||
    String(req.headers['x-track-key'] || '');

  if (k !== TRACK_KEY) {
    res.status(403).send('Forbidden');
    return false;
  }
  return true;
}

/* ---------- Path/type helpers ---------- */

function isStreamPath(file) {
  return !!file && file.includes('://');
}

function isAirplayFile(file) {
  return String(file || '').toLowerCase() === 'airplay active';
}

/* ---------- HTML decoding (moOde titles) ---------- */

function decodeHtmlEntities(str) {
  // Used server-side (node): quick decode for moOde titles
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/* ---------- Small string parsing helpers ---------- */

function splitArtistDashTitle(s) {
  const t = String(s || '').trim();
  const parts = t.split(' - ');
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return null;
}

// WFMT-style packed classical:
// "Composer - Work - Performers - Album - Label"
function parseDashPackedClassicalTitle(rawTitle) {
  const t = String(rawTitle || '').trim();
  if (!t) return null;

  const parts = t.split(' - ').map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;

  if (parts.length >= 5) {
    return {
      composer: parts[0] || '',
      work: parts[1] || '',
      performers: parts[2] || '',
      album: parts[3] || '',
      label: parts[4] || '',
      rawParts: parts,
      kind: 'wfmdash5',
    };
  }

  if (parts.length === 4) {
    return {
      composer: '',
      work: parts[0] || '',
      performers: parts[1] || '',
      album: parts[2] || '',
      label: parts[3] || '',
      rawParts: parts,
      kind: 'dash4',
    };
  }

  return { kind: 'dashN', rawParts: parts };
}

/* ---------- URL helpers ---------- */

function normalizeCoverUrl(coverurl, baseUrl = MOODE_BASE_URL) {
  if (!coverurl) return '';
  const prefix = coverurl.startsWith('/') ? '' : '/';
  return `${baseUrl}${prefix}${coverurl}`;
}

function makeAlbumKey({ artist, album, date }) {
  return `${(artist || '').toLowerCase()}|${(album || '').toLowerCase()}|${(date || '')}`;
}

function extractYear(str) {
  const m = str?.match(/\b(\d{4})\b/);
  return m ? m[1] : '';
}

function moodeValByKey(raw, keyOrIndex) {
  if (!raw) return '';

  // numeric legacy support
  if (typeof keyOrIndex === 'number') {
    const s = raw?.[String(keyOrIndex)];
    if (typeof s !== 'string') return '';
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1).trim() : s.trim();
  }

  // key lookup: scan values for "key:"
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

/* ---------- MPD/local file mapping ---------- */

function mpdFileToLocalPath(mpdFile) {
  if (!mpdFile || isStreamPath(mpdFile) || isAirplayFile(mpdFile)) return '';
  if (!mpdFile.startsWith(MOODE_USB_PREFIX)) return '';
  return `${PI4_MOUNT_BASE}/${mpdFile.slice(MOODE_USB_PREFIX.length)}`;
}

function safeIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ---------- Timing + MPD CLI helpers ---------- */

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
  // Empirically: play then stop forces MPD to select a new "current"
  await mpcCmd(['play']);
  await sleep(250);
  await mpcCmd(['stop']);
  return true;
}

/* ---------- Ratings (MPD stickers): 0..5 ---------- */

function clampRating(n) {
  const x = Number.parseInt(String(n), 10);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(5, x));
}

async function mpdStickerGet(file, key) {
  if (!file || isStreamPath(file) || isAirplayFile(file)) return '';
  // mpc sticker <uri> get <key>
  const { out } = await mpcCmd(['sticker', file, 'get', key]);
  // out example: "rating=4" or "" if not set
  return (out || '').trim();
}

async function mpdStickerSet(file, key, value) {
  if (!file || isStreamPath(file) || isAirplayFile(file)) return false;
  await mpcCmd(['sticker', file, 'set', key, String(value)]);
  return true;
}

async function mpdStickerDelete(file, key) {
  if (!file || isStreamPath(file) || isAirplayFile(file)) return false;
  // If it doesn't exist, MPD returns an error; we can ignore that
  try {
    await mpcCmd(['sticker', file, 'delete', key]);
  } catch {}
  return true;
}

function parseStickerValue(line, key) {
  // expects "key=value"
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

  // ✅ keep db clean: 0 means "no sticker"
  if (r === 0) {
    await mpdStickerDelete(file, 'rating');
    return 0;
  }

  await mpdStickerSet(file, 'rating', r);
  return r;
}

/* ---------- Alexa helper (token parsing + art URL) ---------- */

function parseTokenB64(token) {
  // token format: "moode-track:<base64json>"
  const s = String(token || '').trim();
  const i = s.indexOf(':');
  if (i < 0) return null;
  const b64 = s.slice(i + 1);
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function alexaArtUrlForFile(mpdFile) {
  if (!mpdFile) return '';
  if (isStreamPath(mpdFile) || isAirplayFile(mpdFile)) return '';
  return `${PUBLIC_BASE_URL}/coverart.php/${encodeURIComponent(mpdFile)}`;
}

/* ---------- Track serving (range + optional transcode) ---------- */
/*
 * /track uses these helpers:
 *  - serveFileWithRange(): HTTP Range support (Alexa resume/seek)
 *  - parseRange():        parse "Range: bytes=start-end"
 *  - ensureDir():         create cache dir for transcodes
 *  - cacheKeyFor():       stable key per (mpdFile + startSec)
 *  - transcodeToMp3File(): ffmpeg wrapper (seek + transcode)
 *
 * Keep these helpers together so /track stays readable.
 */
 
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
    // Invalid range
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

function parseRange(rangeHeader, size) {
  // Expects: "bytes=start-end" (end optional)
  const m = String(rangeHeader || '').match(/bytes=(\d*)-(\d*)/i);
  if (!m) return null;

  let start = m[1] ? Number.parseInt(m[1], 10) : NaN;
  let end   = m[2] ? Number.parseInt(m[2], 10) : NaN;

  // bytes=-N  (suffix)
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    const n = end;
    if (!(n > 0)) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    // bytes=N-  (open-ended)
    if (Number.isFinite(start) && !Number.isFinite(end)) {
      end = size - 1;
    }
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < 0) return null;
  if (start > end) return null;
  if (start >= size) return null;

  end = Math.min(end, size - 1);
  return { start, end };
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

const TRACK_CACHE_DIR =
  process.env.TRACK_CACHE_DIR || '/tmp/moode-track-cache';

// Safe filename from MPD file + optional startSec
function cacheKeyFor(mpdFile, startSec) {
  // keep it deterministic and filesystem-safe
  const raw = `${mpdFile}||t=${Math.floor(startSec || 0)}`;
  return Buffer.from(raw, 'utf8').toString('base64').replace(/[/+=]/g, '_');
}

async function transcodeToMp3File({ inputPath, outputPath, startSec }) {
  // Write to a temp file then rename to avoid serving partial files
  const tmp = outputPath + '.part';

  // Remove any stale partial
  try { fs.unlinkSync(tmp); } catch {}

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
  ];

  if (startSec > 0) {
    // -ss before -i for speed (good enough for "resume")
    args.push('-ss', String(startSec));
  }

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

  // Atomic-ish promote
  fs.renameSync(tmp, outputPath);
}


/* =========================
 * Tag reading (FILE playback)
 * ========================= */

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

/* =========================
 * MPD TCP helper (for /next-up)
 * ========================= */

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
        if (buf.includes('OK MPD ') && buf.includes('\n')) {
          greetingSeen = true;
        } else {
          return;
        }
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
  // MPD protocol uses 0-based positions
  await mpdQueryRaw(`delete ${n}`);
  return true;
}

async function mpdQueryRawDebug(command) {
  const raw = await mpdQueryRaw(command);
  return {
    command,
    rawLength: raw.length,
    rawVisible: raw.replace(/\r/g, '\\r').replace(/\n/g, '\\n\n'),
    sawOK: /\nOK(\n|$)/.test(raw),
    sawACK: /\nACK /.test(raw),
  };
}

// Parse FIRST block of "key: value" lines into case-insensitive map.
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

async function mpdPlaylistInfoById(songid) {
  if (songid === '' || songid === null || songid === undefined) return null;

  const raw = await mpdQueryRaw(`playlistid ${songid}`);
  if (!raw || raw.includes('ACK')) return null;

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

async function mpdPlaylistInfoByPos(songpos, debug = false) {
  if (songpos === '' || songpos === null || songpos === undefined) return null;

  const n = Number(songpos);
  if (!Number.isFinite(n) || n < 0) return null;

  const cmd = `playlistinfo ${n}:${n + 1}`;
  const raw = await mpdQueryRaw(cmd);

  if (!raw || raw.includes('ACK')) return debug ? { _raw: raw, _cmd: cmd, _fail: 'empty-or-ack' } : null;

  const kv = parseMpdFirstBlock(raw);
  const file = kv.file || '';
  const title = kv.title || '';
  const artist = kv.artist || '';
  const album = kv.album || '';
  const id = kv.id || '';
  const pos = kv.pos || String(n);

  if (!file && !title && !artist) {
    return debug ? { _raw: raw, _cmd: cmd, _fail: 'no-fields' } : null;
  }

  return { file, title, artist, album, songid: id, songpos: pos };
}

/* =========================
 * Caches
 * ========================= */

const trackCache = new Map();
const itunesArtCache = new Map();

/* =========================
 * Deep tags for FILE playback
 * ========================= */

async function getDeepMetadataCached(mpdFile) {
  const empty = { year: '', label: '', producer: '', performers: [] };
  if (!mpdFile) return empty;

  const cached = trackCache.get(mpdFile);
  if (cached) return cached;

  const p = mpdFileToLocalPath(mpdFile);
  if (!p || !safeIsFile(p)) {
    trackCache.set(mpdFile, empty);
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

  trackCache.set(mpdFile, deep);
  return deep;
}

/* =========================
 * iTunes artwork for RADIO (optional)
 * ========================= */

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
    if (now - cached.ts < ttl) {
      return { ...cached, reason: cached.url ? 'cache-hit' : 'cache-hit-empty' };
    }
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

function normStr(s) {
  return String(s || '').toLowerCase().trim();
}

function pickBestItunesAlbum(results, wantAlbum, wantLabel) {
  const albumNeedle = normStr(wantAlbum);
  const labelNeedle = normStr(wantLabel);

  let best = null;
  let bestScore = -1;

  for (const r of (results || [])) {
    const name = normStr(r.collectionName);
    const genre = normStr(r.primaryGenreName);
    const copyright = normStr(r.copyright);

    let score = 0;

    if (albumNeedle && name === albumNeedle) score += 100;
    else if (albumNeedle && name.includes(albumNeedle)) score += 40;

    if (labelNeedle && labelNeedle.length >= 3 && copyright.includes(labelNeedle)) score += 20;
    if (genre.includes('classical')) score += 5;
    if (r.artworkUrl100 || r.artworkUrl60) score += 5;

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  return best;
}

async function lookupItunesAlbumTerm(albumTerm, labelHint = '', debug = false) {
  if (!albumTerm) return { url: '', album: '', year: '', reason: 'missing-albumTerm' };

  const key = `albumTerm|${albumTerm.toLowerCase()}|${(labelHint || '').toLowerCase()}`;
  const now = Date.now();

  const cached = itunesArtCache.get(key);
  if (cached && !debug) {
    const ttl = cached.url ? ITUNES_TTL_HIT_MS : ITUNES_TTL_MISS_MS;
    if (now - cached.ts < ttl) {
      return { ...cached, reason: cached.url ? 'cache-hit' : 'cache-hit-empty' };
    }
    itunesArtCache.delete(key);
  }

  const term = encodeURIComponent(albumTerm);
  const queryUrl =
    `${ITUNES_SEARCH_URL}?term=${term}` +
    `&media=music&entity=album&attribute=albumTerm&limit=10&country=${ITUNES_COUNTRY}`;

  try {
    const data = await fetchJsonWithTimeout(queryUrl, ITUNES_TIMEOUT_MS);
    const results = Array.isArray(data?.results) ? data.results : [];

    const best = pickBestItunesAlbum(results, albumTerm, labelHint);

    const url = pickArtFromItunesItem(best);
    const { album, year } = pickAlbumAndYearFromItunesItem(best);

    const packed = { url, album, year, ts: now };
    itunesArtCache.set(key, packed);

    return { url, album, year, reason: url ? 'ok:albumTerm' : 'no-art:albumTerm' };
  } catch (e) {
    itunesArtCache.set(key, { url: '', album: '', year: '', ts: now });
    return { url: '', album: '', year: '', reason: `error:${e?.name || 'Error'}` };
  }
}

/* =========================
 * AirPlay: moOde authoritative aplmeta.txt
 * ========================= */

function parseAplmeta(txt) {
  // title~~~artist~~~album~~~duration~~~cover_url~~~format
  const line = String(txt || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  const parts = line.split('~~~');

  const title = (parts[0] || '').trim();
  const artist = (parts[1] || '').trim();
  const album = (parts[2] || '').trim();
  const duration = (parts[3] || '').trim();
  const coverRel = (parts[4] || '').trim();   // imagesw/airplay-covers/....
  const fmt = (parts[5] || '').trim();

  const coverUrl = coverRel ? normalizeCoverUrl('/' + coverRel.replace(/^\/+/, '')) : '';
  return { title, artist, album, duration, coverRel, coverUrl, format: fmt };
}

/* =========================
 * Artwork helpers (stable URLs for clients)
 * ========================= */

async function fetchMoodeCoverBytes(coverurlOrFileish) {
  // If you pass "/coverart.php/USB%2F..."
  const url = String(coverurlOrFileish || '').startsWith('/coverart.php')
    ? normalizeCoverUrl(coverurlOrFileish, MOODE_BASE_URL) // LAN fetch
    : `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(coverurlOrFileish)}`;

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
 * 5) Routes (grouped)
 * ========================= *
 * Core LAN display API (stable):
 *  - /now-playing
 *  - /next-up
 *  - /art/*
 *  - /rating (file + current)
 *
 * Queue/MPD control (LAN / automation):
 *  - /queue/*
 *  - /mpd/*
 *
 * Optional public/Alexa helpers:
 *  - /track   (guarded by TRACK_KEY; may be internet-facing)
 *  - /alexa/* (if present later; should be gated by ENABLE_ALEXA)
 *
 * Debug:
 *  - /_debug/*
 */
 
/* =========================
 * Route: /now-playing
 * ========================= */

app.get('/now-playing', async (req, res) => {
  const debug = req.query.debug === '1';

  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
    const status = normalizeMoodeStatus(statusRaw);

    // NEW: queue identifiers (needed for Lambda to delete by position)
    const songpos = moodeValByKey(statusRaw, 'song');     // queue position
    const songid  = moodeValByKey(statusRaw, 'songid');   // MPD song id (optional)

    const file = song.file || '';
    const stream = isStreamPath(file);
    const airplay =
      isAirplayFile(file) || (String(song.encoded || '').toLowerCase() === 'airplay');

    // Cover art (MPD-authoritative)
    // - Local file: tie art directly to the current file
    // - Stream: use moOde's coverurl (station logo), if provided
    let albumArtUrl = '';

    // Album artwork policy:
    // - Radio streams: use moOde-provided station logo (LAN-only asset, e.g. /imagesw/...)
    // - Local files: use moOde coverart.php via LAN
    // - AirPlay: no album art here (handled separately)
    if (stream) {
      albumArtUrl = song.coverurl
        ? normalizeCoverUrl(song.coverurl, MOODE_BASE_URL)
        : '';
    } else if (!airplay && file) {
      albumArtUrl = `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(file)}`;
    }

    // Stable APL-safe artwork URL
    const aplArtUrl = `${PUBLIC_BASE_URL}/art/current_320.jpg`;

    // Defaults
    let artist = song.artist || '';
    let title = song.title || '';
    let album = song.album || '';
    let year = '';

    let producer = '';
    let personnel = [];
    let altArtUrl = '';
    let airplayInfoLine = '';

    // AIRPLAY: override from aplmeta.txt
    if (airplay) {
      try {
        const aplText = await fetchText(`${MOODE_BASE_URL}/aplmeta.txt`, 'text/plain');
        const ap = parseAplmeta(aplText);

        artist = ap.artist || artist || '';
        title = ap.title || title || '';
        album = ap.album || album || 'AirPlay Source';

        altArtUrl = ap.coverUrl || '';
        airplayInfoLine = ap.format || 'AirPlay';
      } catch {
        airplayInfoLine = 'AirPlay';
      }

      return res.json({
        artist,
        title,
        album,
        file: file || 'AirPlay Active',

        // NEW: queue identifiers
        songpos: songpos || '',
        songid: songid || '',

        albumArtUrl: albumArtUrl || '',
        aplArtUrl: aplArtUrl || '',
        altArtUrl: altArtUrl || '',

        state: status.state || song.state,
        elapsed: status.elapsed,
        duration: status.duration,
        percent: status.percent,

        year: '',
        label: '',
        producer: '',
        personnel: [],

        encoded: airplayInfoLine || 'AirPlay',
        bitrate: song.bitrate || '',
        outrate: song.outrate || '',
        volume: song.volume || '0',
        mute: song.mute || '0',
        track: song.track || '',
        date: song.date || '',

        isStream: false,
        isAirplay: true,

        ...(debug ? { debugAplmetaUrl: `${MOODE_BASE_URL}/aplmeta.txt` } : {}),
      });
    }

    // FILE: deep tags
    const deep = stream
      ? { year: '', label: '', producer: '', performers: [] }
      : await getDeepMetadataCached(file);

    year = deep.year || '';
    producer = deep.producer || '';
    personnel = deep.performers || [];

    // RADIO: optional iTunes artwork + album/year
    let radioAlbum = '';
    let radioYear = '';
    let radioLabel = '';
    let radioComposer = '';
    let radioWork = '';
    let radioPerformers = '';

    let debugItunesReason = '';
    let debugRadioParsed = null;

    if (stream) {
      const decodedTitle = decodeHtmlEntities(song.title);

      const simple = splitArtistDashTitle(decodedTitle);
      const packed = parseDashPackedClassicalTitle(decodedTitle);

      debugRadioParsed = { simple, packed };

      if (packed && packed.album) {
        radioAlbum = packed.album || '';
        radioLabel = packed.label || '';
        radioComposer = packed.composer || '';
        radioWork = packed.work || '';
        radioPerformers = packed.performers || '';

        const it = await lookupItunesAlbumTerm(radioAlbum, radioLabel, debug);
        altArtUrl = it.url || '';
        radioYear = it.year || '';
        debugItunesReason = it.reason || '';
      } else if (simple && simple.artist && simple.title) {
        const it = await lookupItunesFirst(simple.artist, simple.title, debug);
        altArtUrl = it.url || '';
        radioAlbum = it.album || '';
        radioYear = it.year || '';
        debugItunesReason = it.reason || '';
      } else {
        debugItunesReason = 'no-parse';
      }
    }

    return res.json({
      artist: artist || '',
      title: title || '',
      album: album || '',
      file: file || '',

      // NEW: queue identifiers
      songpos: songpos || '',
      songid: songid || '',

      albumArtUrl: albumArtUrl || '',
      aplArtUrl: aplArtUrl || '',
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

      year: year || '',
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

      isStream: stream,
      isAirplay: false,

      ...(debug ? { debugRadioParsed, debugItunesReason } : {}),
    });
  } catch (err) {
    console.error('now-playing error:', (err && err.message) ? err.message : String(err));
    return res.status(500).json({ error: 'now-playing failed' });
  }
});

/* =========================
 * Route: /next-up
 * ========================= */

app.get('/next-up', async (req, res) => {
  const debug = req.query.debug === '1';

  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);

    const file = song.file || '';
    const isStream = isStreamPath(file);
    const isAirplay =
      isAirplayFile(file) || String(song.encoded || '').toLowerCase() === 'airplay';

    if (isStream || isAirplay) {
      return res.json({ ok: true, next: null, ...(debug ? { reason: 'stream-or-airplay' } : {}) });
    }

    const nextsongRaw = moodeValByKey(statusRaw, 'nextsong');
    const nextsongid  = moodeValByKey(statusRaw, 'nextsongid');

    if (!String(nextsongRaw || '').trim()) {
      return res.json({ ok: true, next: null, ...(debug ? { reason: 'no-nextsong' } : {}) });
    }

    const nextPos = Number.parseInt(String(nextsongRaw).trim(), 10);
    if (!Number.isFinite(nextPos) || nextPos < 0) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { nextsong: nextsongRaw, nextsongid, reason: 'bad-nextsong' } : {}),
      });
    }

    let next = null;
    let nextPos2 = null;
    let nextsongid2 = '';

    // Attempt 1: by pos
    try {
      const raw = await mpdQueryRaw(`playlistinfo ${nextPos}:${nextPos + 1}`);
      const kv = parseMpdFirstBlock(raw);
      if (kv.file || kv.title || kv.artist) {
        next = {
          file: kv.file || '',
          title: kv.title || '',
          artist: kv.artist || '',
          album: kv.album || '',
          songid: kv.id || '',
          songpos: kv.pos || String(nextPos),
        };
      }
    } catch {}

    // Attempt 2: by id
    if (!next && nextsongid) next = await mpdPlaylistInfoById(nextsongid);

    // Attempt 3: re-fetch once
    if (!next) {
      const statusRaw2 = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
      const nextsongRaw2 = moodeValByKey(statusRaw2, 'nextsong');
      nextsongid2 = moodeValByKey(statusRaw2, 'nextsongid');

      nextPos2 = Number.parseInt(String(nextsongRaw2 || '').trim(), 10);
      if (Number.isFinite(nextPos2) && nextPos2 >= 0) next = await mpdPlaylistInfoByPos(nextPos2);
      if (!next && nextsongid2) next = await mpdPlaylistInfoById(nextsongid2);
    }

    if (!next) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? {
          nextsong: nextPos,
          nextsongid,
          nextsong2: nextPos2,
          nextsongid2,
          reason: 'mpd-playlistinfo-no-match',
          mpdHost: MPD_HOST,
          mpdPort: MPD_PORT,
          localAddress: LOCAL_ADDRESS,
        } : {}),
      });
    }

    const nextArtUrl = next.file ? `${PUBLIC_BASE_URL}/coverart.php/${encodeURIComponent(next.file)}` : '';

    return res.json({
      ok: true,
      next: {
        songid: next.songid || nextsongid2 || nextsongid || '',
        songpos: next.songpos || String(nextPos2 ?? nextPos),
        title: next.title || '',
        artist: next.artist || '',
        album: next.album || '',
        file: next.file || '',
        artUrl: nextArtUrl,
      },
      ...(debug ? { nextsong: nextPos, nextsongid, nextsong2: nextPos2, nextsongid2, reason: 'ok' } : {}),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      next: null,
      ...(debug ? { error: err?.message || String(err), reason: 'exception' } : {}),
    });
  }
});

/* =========================
 * Route: /art
 * ========================= */

app.get('/art/current.jpg', async (req, res) => {
  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const coverurl = song.coverurl || '';
    if (!coverurl) return res.status(404).end();
    const buf = await fetchMoodeCoverBytes(coverurl);
    await sendJpeg(res, buf, null);
  } catch (e) {
    console.error('art/current.jpg error:', e?.message || String(e));
    res.status(404).end();
  }
});

app.get('/art/current_320.jpg', async (req, res) => {
  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const coverurl = song.coverurl || '';
    if (!coverurl) return res.status(404).end();
    const buf = await fetchMoodeCoverBytes(coverurl);
    await sendJpeg(res, buf, 320);
  } catch (e) {
    console.error('art/current_320.jpg error:', e?.message || String(e));
    res.status(404).end();
  }
});

app.get('/art/next_320.jpg', async (req, res) => {
  try {
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
    const nextsongRaw = moodeValByKey(statusRaw, 'nextsong');
    const nextPos = Number.parseInt(String(nextsongRaw || '').trim(), 10);
    if (!Number.isFinite(nextPos) || nextPos < 0) return res.status(404).end();

    const next = await mpdPlaylistInfoByPos(nextPos);
    if (!next?.file) return res.status(404).end();

    const buf = await fetchMoodeCoverBytes(`/coverart.php/${encodeURIComponent(next.file)}`);
    await sendJpeg(res, buf, 320);
  } catch (e) {
    console.error('art/next_320.jpg error:', e?.message || String(e));
    res.status(404).end();
  }
});

/* =========================
 * Route: /rating (by file)
 * ========================= */

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
 
app.post('/mpd/prime', async (req, res) => {
  try {
    // optional: protect it
    // if (!requireTrackKey(req, res)) return;

    await mpdPrimePlayPause();
    res.json({ ok: true });
  } catch (e) {
    console.error('/mpd/prime failed:', e?.message || String(e));
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
 

/* =========================
 * Route: /queue/play_item (album, playlist) 
 * ========================= */
 
app.post('/queue/play_item', async (req, res) => {
  try {
    if (!requireTrackKey(req, res)) return;

    const item = String(req?.body?.item || req?.query?.item || '').trim();
    if (!item) {
      return res.status(400).json({ ok: false, error: 'Missing item' });
    }

    // moOde command endpoint expects cmd=play_item <arg>
    const url = `${MOODE_BASE_URL}/command/?cmd=${encodeURIComponent('play_item ' + item)}`;
    await fetchText(url, 'text/plain');

    // play_item loads + starts playback in moOde.
    // Stop immediately so the queue is ready but moOde stays silent.
    await mpcCmd(['stop']);

    // return a fresh now-playing snapshot
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
    const songpos = moodeValByKey(statusRaw, 'song');
    const songid  = moodeValByKey(statusRaw, 'songid');

    return res.json({
      ok: true,
      nowPlaying: {
        file: song.file || '',
        title: decodeHtmlEntities(song.title || ''),
        artist: decodeHtmlEntities(song.artist || ''),
        album: decodeHtmlEntities(song.album || ''),
        songpos: String(songpos || '').trim(),
        songid: String(songid || '').trim(),
      },
    });
  } catch (e) {
    console.error('/queue/play_item error:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


/* =========================
 * Route: /rating/current (GET/POST)
 * ========================= */

app.get('/rating/current', async (req, res) => {
  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const file = String(song.file || '').trim();

    if (!file || isStreamPath(file) || isAirplayFile(file)) {
      return res.json({ ok: true, disabled: true, file: file || '', rating: 0 });
    }

    const rating = await getRatingForFile(file);
    return res.json({ ok: true, file, rating });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/rating/current', async (req, res) => {
  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const file = String(song.file || '').trim();

    if (!file || isStreamPath(file) || isAirplayFile(file)) {
      return res.json({ ok: true, disabled: true, file: file || '', rating: 0 });
    }

    const r = clampRating(req?.body?.rating);
    if (r === null) {
      return res.status(400).json({ ok: false, error: 'rating must be an integer 0..5' });
    }

    const newRating = await setRatingForFile(file, r); // ✅ handles delete-on-0
    return res.json({ ok: true, file, rating: newRating });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/mpd/delete', async (req, res) => {
  try {
    // optional: protect like /track (recommended)
    // if (!requireTrackKey(req, res)) return;

    const pos0 = (req.body && req.body.pos0 !== undefined) ? req.body.pos0 : null;
    if (pos0 === null) {
      return res.status(400).json({ ok: false, error: 'Missing JSON body { "pos0": <0-based> }' });
    }

    await mpdDeletePos0(pos0);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/mpd/delete error:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/queue/advance', async (req, res) => {
  try {
    // Protect it (same shared secret as /track)
    if (!requireTrackKey(req, res)) return;

    // Accept pos0 from JSON body OR querystring
    const pos0raw =
      (req?.body?.pos0 !== undefined ? req.body.pos0 : undefined) ??
      (req?.query?.pos0 !== undefined ? req.query.pos0 : undefined);

    const pos0 = Number.parseInt(String(pos0raw).trim(), 10);
    if (!Number.isFinite(pos0) || pos0 < 0) {
      return res.status(400).json({ ok: false, error: 'Missing/invalid pos0' });
    }

    // Optional: accept file for sanity checking
    const file = String(req?.body?.file || req?.query?.file || '').trim();

    // Optional safety: confirm pos0 still points to expected file
    if (file) {
      try {
        const info = await mpdPlaylistInfoByPos(pos0);
        const actual = String(info?.file || '').trim();

        if (actual && actual !== file) {
          console.log('[queue/advance] pos mismatch, priming only', {
            pos0,
            tokenFile: file,
            mpdFile: actual,
          });

          // Do NOT delete if MPD already moved; just re-prime
          await mpdPrimePlayPause();

          return res.json({
            ok: true,
            skippedDelete: true,
            reason: 'pos-mismatch-primed',
          });
        }
      } catch (e) {
        console.log('[queue/advance] pos check failed, continuing delete:', e?.message || String(e));
      }
    }

    // 1) Delete finished track (0-based position)
    await mpdDeletePos0(pos0);

    // 2) Prime MPD so a new "current" is selected (avoid STOP/empty)
    await mpdPrimePlayPause();

    // 3) Return a fresh now-playing snapshot (lightweight)
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);

    const songpos = moodeValByKey(statusRaw, 'song');
    const songid  = moodeValByKey(statusRaw, 'songid');

    return res.json({
      ok: true,
      nowPlaying: {
        file: song.file || '',
        title: decodeHtmlEntities(song.title || ''),
        artist: decodeHtmlEntities(song.artist || ''),
        album: decodeHtmlEntities(song.album || ''),
        songpos: String(songpos || '').trim(),
        songid: String(songid || '').trim(),
      },
    });

  } catch (e) {
    console.error('/queue/advance error:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


app.get('/track', async (req, res) => {
  if (!ENABLE_ALEXA) return res.status(404).end();
  try {
    if (!requireTrackKey(req, res)) return;

    const mpdFile = String(req.query.file || '').trim();
    if (!mpdFile) return res.status(400).send('Missing ?file=');

    // Only allow local library files
    if (isStreamPath(mpdFile) || isAirplayFile(mpdFile)) {
      return res.status(400).send('Not a local track');
    }

    const localPath = mpdFileToLocalPath(mpdFile);
    if (!localPath || !safeIsFile(localPath)) {
      return res.status(404).send('Track not found');
    }

    const startSec = Math.max(0, Number.parseFloat(String(req.query.t || '0')) || 0);

    // If it's already an MP3 and no seek: serve directly WITH range support
    if (localPath.toLowerCase().endsWith('.mp3') && startSec === 0) {
      return serveFileWithRange(req, res, localPath, 'audio/mpeg');
    }
    
    // If transcoding is disabled, serve the ORIGINAL file with range support
    if (!TRANSCODE_TRACKS) {
      // If you want to be strict: don’t allow resume/seek without transcode
      if (startSec > 0) return res.status(400).send('Seek requires transcoding');

      // Basic content-type based on extension (good enough for testing)
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

    // Otherwise: cache a transcoded MP3 and serve it (this is what gives Alexa controls)
    ensureDir(TRACK_CACHE_DIR);

    const key = cacheKeyFor(mpdFile, startSec);
    const cachedMp3 = path.join(TRACK_CACHE_DIR, key + '.mp3');

    if (!safeIsFile(cachedMp3)) {
      console.log('[track] cache miss → transcoding:', mpdFile, 't=', startSec);
      await transcodeToMp3File({
        inputPath: localPath,
        outputPath: cachedMp3,
        startSec,
      });
    } else {
      // Optional: log hits while you test
      // console.log('[track] cache hit:', mpdFile);
    }

    return serveFileWithRange(req, res, cachedMp3, 'audio/mpeg');
  } catch (e) {
    console.error('/track error:', e?.message || String(e));
    try { res.status(500).send('track failed'); } catch {}
  }
});

/* =========================
 * Debug route: MPD
 * ========================= */

app.get('/_debug/mpd', async (req, res) => {
  try {
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
    const nextsongRaw = moodeValByKey(statusRaw, 'nextsong');
    const nextsongid  = moodeValByKey(statusRaw, 'nextsongid');

    const pos = Number.parseInt(String(nextsongRaw).trim(), 10);

    const byPos = Number.isFinite(pos)
      ? await mpdQueryRawDebug(`playlistinfo ${pos}:${pos + 1}`)
      : null;

    const byId = nextsongid
      ? await mpdQueryRawDebug(`playlistid ${nextsongid}`)
      : null;

    res.json({ nextsongRaw, nextsongid, byPos, byId });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
