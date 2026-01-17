#!/usr/bin/env node
/**
 * server.mjs -- moOde Now-Playing API (Pi4)
 *
 * GET /now-playing
 *  - FILE: deep tags via metaflac (local mount)
 *  - RADIO: iTunes artwork + album/year (optional)
 *          - Supports both "Artist - Title" (pop) and WFMT packed classical:
 *            "Composer - Work - Performers - Album - Label"
 *  - AIRPLAY: uses moOde's aplmeta.txt + airplay-covers (authoritative, matches moOde UI)
 *
 * GET /next-up
 *  - FILE only (not radio/airplay)
 *  - Uses moOde /command/?cmd=status field "nextsong" when available
 *  - Fetches that queue position via MPD TCP: "playlistinfo <pos>"
 *  - Returns { ok:true, next:{...} } or { ok:true, next:null }
 *  - If called with ?debug=1, returns diagnostic fields on failure
 */

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const execFileP = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
 * Config
 * ========================= */

const PORT = 3000;

// moOde base URL (where we fetch /command and /aplmeta.txt)
const MOODE_BASE_URL = 'http://10.0.0.254';

// This server's LAN IP (bind outbound LAN requests to avoid dual-NIC oddities)
const LOCAL_ADDRESS = '10.0.0.233';
const lanHttpAgent  = new http.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });
const lanHttpsAgent = new https.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });

// Default agents (no local bind) -- best for public internet (iTunes)
const defaultHttpAgent  = new http.Agent({ keepAlive: true });
const defaultHttpsAgent = new https.Agent({ keepAlive: true });

// MPD file prefix and Pi4 mount point
const MOODE_USB_PREFIX = 'USB/SamsungMoode/';
const PI4_MOUNT_BASE   = '/mnt/SamsungMoode';

// Tools
const METAFLAC = '/usr/bin/metaflac';

// Ensure MPD queries always go to moOde's MPD
const MPD_HOST = '10.0.0.254';
const MPD_PORT = 6600;

// iTunes Search (public, no auth)
const ITUNES_SEARCH_URL  = 'https://itunes.apple.com/search';
const ITUNES_COUNTRY     = 'us';
const ITUNES_TIMEOUT_MS  = 2500;

const ITUNES_TTL_HIT_MS  = 1000 * 60 * 60 * 12; // 12 hours
const ITUNES_TTL_MISS_MS = 1000 * 60 * 10;      // 10 minutes

/* =========================
 * Helpers
 * ========================= */

// Bind LAN fetches to LOCAL_ADDRESS to avoid dual-NIC weirdness.
function agentForUrl(url) {
  const isLan = url.startsWith(MOODE_BASE_URL);
  const isHttps = url.startsWith('https:');
  if (isLan) return isHttps ? lanHttpsAgent : lanHttpAgent;
  return isHttps ? defaultHttpsAgent : defaultHttpAgent;
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    agent: agentForUrl(url),
    cache: 'no-store',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
}

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: { Accept: 'text/plain' },
    agent: agentForUrl(url),
    cache: 'no-store',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.text();
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
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function isStreamPath(file) {
  return !!file && file.includes('://');
}

function isAirplayFile(file) {
  return String(file || '').toLowerCase() === 'airplay active';
}

// Used server-side (node): quick decode for moOde titles
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

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

  // Some stations: Work - Performers - Album - Label
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

function normalizeCoverUrl(coverurl) {
  if (!coverurl) return '';
  const prefix = coverurl.startsWith('/') ? '' : '/';
  return `${MOODE_BASE_URL}${prefix}${coverurl}`;
}

function makeAlbumKey({ artist, album, date }) {
  return `${(artist || '').toLowerCase()}|${(album || '').toLowerCase()}|${(date || '')}`;
}

function normalizeMoodeStatus(raw) {
  const state = moodeValByKey(raw, 'state');
  const timeStr = moodeValByKey(raw, 'time');
  const elapsedStr = moodeValByKey(raw, 'elapsed');
  const durationStr = moodeValByKey(raw, 'duration');

  let elapsed = 0;
  let duration = 0;

  // ✅ Preferred: parse "time: <elapsed>:<duration>" (integer seconds)
  if (timeStr && String(timeStr).includes(':')) {
    const parts = String(timeStr).trim().split(':').map(s => s.trim());
    if (parts.length >= 2) {
      const e = Number.parseFloat(parts[0]);
      const d = Number.parseFloat(parts[1]);
      if (Number.isFinite(e)) elapsed = e;
      if (Number.isFinite(d)) duration = d;
    }
  }

  // Fallback only if time didn't yield usable values
  if (!(duration > 0)) {
    const e2 = Number.parseFloat(elapsedStr);
    const d2 = Number.parseFloat(durationStr);
    if (Number.isFinite(e2)) elapsed = e2;
    if (Number.isFinite(d2)) duration = d2;
  }

  const percent = duration > 0 ? Math.round((elapsed / duration) * 100) : 0;
  return { state, elapsed, duration, percent, time: timeStr };
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

function extractYear(str) {
  const m = str?.match(/\b(\d{4})\b/);
  return m ? m[1] : '';
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

/* =========================
 * MPD TCP helper (for /next-up)
 * ========================= */

function mpdQueryRaw(command, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({
      host: MPD_HOST,
      port: MPD_PORT,
      // localAddress: LOCAL_ADDRESS, // optional; your nc test says it's fine either way
    });

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

    function hasTerminalOK(s) {
      // MPD command terminator is a line containing only "OK"
      return /(?:\r?\n)OK\r?\n/.test(s) || /^OK\r?\n/.test(s);
    }

    function hasACK(s) {
      return /(?:\r?\n)ACK /.test(s) || /^ACK /.test(s);
    }

    sock.on('data', (d) => {
      buf += d.toString('utf8');

      // 1) Wait for greeting before sending any commands.
      if (!greetingSeen) {
        // Greeting always starts with "OK MPD "
        if (buf.includes('OK MPD ')) {
          // Make sure we have the full greeting line ending
          if (buf.includes('\n')) {
            greetingSeen = true;
          } else {
            return;
          }
        } else {
          return;
        }
      }

      // 2) Send command once after greeting is seen.
      if (!commandSent) {
        commandSent = true;
        sock.write(`${command}\nclose\n`);
        return;
      }

      // 3) After command is sent, finish on ACK or terminal OK.
      if (hasACK(buf) || hasTerminalOK(buf)) {
        finish();
      }
    });

    sock.on('connect', () => {
      // do nothing here; we wait for greeting in 'data'
    });

    sock.on('end', () => finish());
  });
}

async function mpdQueryRawDebug(command) {
  const raw = await mpdQueryRaw(command);

  return {
    command,
    rawLength: raw.length,
    rawVisible: raw
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n\n'),
    sawOK: /\nOK(\n|$)/.test(raw),
    sawACK: /\nACK /.test(raw),
  };
}

// Parse the FIRST block of "key: value" lines into a case-insensitive map.
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

  // If MPD returns just greeting + OK, raw may look "valid" but contain no block.
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
const albumArtCache = new Map();
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

// Song-style lookup: best for pop stations ("Artist - Title")
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

// Album-style lookup: best for WFMT packed classical (we already have the album title)
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
  const coverRel = (parts[4] || '').trim();   // e.g. imagesw/airplay-covers/cover-....jpg
  const fmt = (parts[5] || '').trim();        // e.g. ALAC/AAC

  const coverUrl = coverRel ? normalizeCoverUrl('/' + coverRel.replace(/^\/+/, '')) : '';
  return { title, artist, album, duration, coverRel, coverUrl, format: fmt };
}

/* =========================
 * Routes
 * ========================= */

app.get('/next-up', async (req, res) => {
  const debug = req.query.debug === '1';

  try {
    // Current song + status from moOde
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);

    const file = song.file || '';
    const isStream = isStreamPath(file);
    const isAirplay =
      isAirplayFile(file) || String(song.encoded || '').toLowerCase() === 'airplay';

    // Streams and AirPlay never have a next-up
    if (isStream || isAirplay) {
      return res.json({
        ok: true,
        next: null,
        ...(debug ? { reason: 'stream-or-airplay' } : {}),
      });
    }

    // Extract nextsong fields from moOde status (key-based, not index-based)
    const nextsongRaw = moodeValByKey(statusRaw, 'nextsong');
    const nextsongid  = moodeValByKey(statusRaw, 'nextsongid');

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
        ...(debug ? { nextsong: nextsongRaw, nextsongid, reason: 'bad-nextsong' } : {}),
      });
    }

    let next = null;
    let nextPos2 = null;
    let nextsongid2 = '';

    // =========================
    // Attempt 1: MPD playlistinfo by position (fast)
    // =========================
    try {
      const cmd = `playlistinfo ${nextPos}:${nextPos + 1}`;
      const raw = await mpdQueryRaw(cmd);
      const kv = parseMpdFirstBlock(raw);

      const file2 = kv.file || '';
      const title2 = kv.title || '';
      const artist2 = kv.artist || '';
      const album2 = kv.album || '';
      const id2 = kv.id || '';
      const pos2 = kv.pos || String(nextPos);

      if (file2 || title2 || artist2) {
        next = {
          file: file2,
          title: title2,
          artist: artist2,
          album: album2,
          songid: id2,
          songpos: pos2,
        };
      }
    } catch {
      // ignore and fall through
    }

    // =========================
    // Attempt 2: MPD playlistid fallback (authoritative)
    // =========================
    if (!next && nextsongid) {
      next = await mpdPlaylistInfoById(nextsongid);
    }

    // =========================
    // Attempt 3: re-fetch status once (race protection), then retry
    // =========================
    if (!next) {
      const statusRaw2 = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
      const nextsongRaw2 = moodeValByKey(statusRaw2, 'nextsong');
      nextsongid2 = moodeValByKey(statusRaw2, 'nextsongid');

      nextPos2 = Number.parseInt(String(nextsongRaw2 || '').trim(), 10);

      if (Number.isFinite(nextPos2) && nextPos2 >= 0) {
        next = await mpdPlaylistInfoByPos(nextPos2);
      }
      if (!next && nextsongid2) {
        next = await mpdPlaylistInfoById(nextsongid2);
      }
    }

    // =========================
    // Final result
    // =========================
    if (!next) {
      return res.json({
        ok: true,
        next: null,
        ...(debug
          ? {
              nextsong: nextPos,
              nextsongid,
              nextsong2: nextPos2,
              nextsongid2,
              reason: 'mpd-playlistinfo-no-match',
              mpdHost: MPD_HOST,
              mpdPort: MPD_PORT,
              localAddress: LOCAL_ADDRESS,
            }
          : {}),
      });
    }

    // moOde cover art endpoint is file-based (not ID-based)
    const nextArtUrl = next.file
      ? `${MOODE_BASE_URL}/coverart.php/${encodeURIComponent(next.file)}`
      : '';

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
      ...(debug
        ? {
            nextsong: nextPos,
            nextsongid,
            nextsong2: nextPos2,
            nextsongid2,
            reason: 'ok',
          }
        : {}),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      next: null,
      ...(debug ? { error: err?.message || String(err), reason: 'exception' } : {}),
    });
  }
});

app.get('/now-playing', async (req, res) => {
  const debug = req.query.debug === '1';

  try {
    const song = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=get_currentsong`);
    const statusRaw = await fetchJson(`${MOODE_BASE_URL}/command/?cmd=status`);
    const status = normalizeMoodeStatus(statusRaw);

    const file = song.file || '';
    const stream = isStreamPath(file);
    const airplay = isAirplayFile(file) || (String(song.encoded || '').toLowerCase() === 'airplay');

    // Station/logo cover (cache by albumKey) for FILE/RADIO only
    const aKey = makeAlbumKey(song);
    let albumArtUrl = albumArtCache.get(aKey) || '';
    if (!albumArtUrl) {
      albumArtUrl = song.coverurl ? normalizeCoverUrl(song.coverurl) : '';
      albumArtCache.set(aKey, albumArtUrl);
    }

    // Defaults
    let artist = song.artist || '';
    let title = song.title || '';
    let album = song.album || '';
    let year = '';
    let producer = '';
    let personnel = [];
    let altArtUrl = '';

    let airplayInfoLine = '';

    // AIRPLAY: override fields from aplmeta.txt (matches moOde UI)
    if (airplay) {
      try {
        const aplText = await fetchText(`${MOODE_BASE_URL}/aplmeta.txt`);
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

        albumArtUrl: albumArtUrl || '',
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

      if (packed?.album) {
        radioAlbum = packed.album || '';
        radioLabel = packed.label || '';
        radioComposer = packed.composer || '';
        radioWork = packed.work || '';
        radioPerformers = packed.performers || '';

        const it = await lookupItunesAlbumTerm(radioAlbum, radioLabel, debug);
        altArtUrl = it.url || '';
        radioYear = it.year || '';
        debugItunesReason = it.reason || '';
      } else if (simple?.artist && simple?.title) {
        const it = await lookupItunesFirst(simple.artist, simple.title, debug);
        altArtUrl = it.url || '';
        radioAlbum = it.album || '';
        radioYear = it.year || '';
        debugItunesReason = it.reason || '';
      } else {
        debugItunesReason = 'no-parse';
      }
    }

    res.json({
      artist: artist || '',
      title: title || '',
      album: album || '',
      file: file || '',

      albumArtUrl: albumArtUrl || '',
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
    console.error('now-playing error:', err?.message || String(err));
    res.status(500).json({ error: 'now-playing failed' });
  }
});

/* =========================
 * Start
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

    res.json({
      nextsongRaw,
      nextsongid,
      byPos,
      byId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`moOde now-playing server running on port ${PORT}`);
  console.log(`Endpoint: http://${LOCAL_ADDRESS}:${PORT}/now-playing`);
  console.log(`Endpoint: http://${LOCAL_ADDRESS}:${PORT}/next-up`);
});