#!/usr/bin/env node
/**
 * server.mjs — moOde Now-Playing API (Pi4)
 *
 * GET /now-playing
 *  - FILE: deep tags via metaflac (local mount)
 *  - RADIO: iTunes artwork + album/year (optional)
 *          - Supports both "Artist - Title" (pop) and WFMT packed classical:
 *            "Composer - Work - Performers - Album - Label"
 *  - AIRPLAY: uses moOde's aplmeta.txt + airplay-covers (authoritative, matches moOde UI)
 */

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const execFileP = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
 * Config
 * ========================= */

const PORT = 3000;

// moOde base URL
const MOODE_BASE_URL = 'http://YOURMOODEIP';

// Bind ONLY LAN calls (moOde) to eth0 IP to avoid dual-NIC oddities
const LOCAL_ADDRESS = 'YOURMOODEIP';
const lanHttpAgent = new http.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });
const lanHttpsAgent = new https.Agent({ keepAlive: true, localAddress: LOCAL_ADDRESS });

// Default agents (no local bind) — best for public internet (iTunes)
const defaultHttpAgent = new http.Agent({ keepAlive: true });
const defaultHttpsAgent = new https.Agent({ keepAlive: true });

// MPD file prefix and Pi4 mount point
const MOODE_USB_PREFIX = 'USB/SamsungMoode/';
const PI4_MOUNT_BASE = '/mnt/SamsungMoode';

// Tools
const METAFLAC = '/usr/bin/metaflac';

// iTunes Search (public, no auth)
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ITUNES_COUNTRY = 'us';
const ITUNES_TIMEOUT_MS = 2500;

const ITUNES_TTL_HIT_MS = 1000 * 60 * 60 * 12; // 12 hours
const ITUNES_TTL_MISS_MS = 1000 * 60 * 10;     // 10 minutes

/* =========================
 * Helpers
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

  // Unknown length but still structured-ish
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

function normalizeMoodeStatus(raw) {
  function val(n) {
    const s = raw?.[String(n)];
    if (!s || typeof s !== 'string') return '';
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1).trim() : s.trim();
  }

  const state = val(9);
  const timeStr = val(13);
  const elapsedStr = val(14);
  const durationStr = val(16);

  let elapsed = parseFloat(elapsedStr) || 0;
  let duration = parseFloat(durationStr) || 0;

  if ((!elapsed || !duration) && timeStr.includes(':')) {
    const [e, d] = timeStr.split(':');
    if (!elapsed) elapsed = parseFloat(e) || 0;
    if (!duration) duration = parseFloat(d) || 0;
  }

  const percent = duration > 0 ? Math.round((elapsed / duration) * 100) : 0;
  return { state, elapsed, duration, percent };
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
 * iTunes artwork for RADIO/AIRPLAY (optional)
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

    // Album name match
    if (albumNeedle && name === albumNeedle) score += 100;
    else if (albumNeedle && name.includes(albumNeedle)) score += 40;

    // Label match (iTunes doesn't filter by label; use copyright as a tie-break)
    if (labelNeedle && labelNeedle.length >= 3 && copyright.includes(labelNeedle)) score += 20;

    // Classical bias
    if (genre.includes('classical')) score += 5;

    // Prefer items with artwork
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
 * Route
 * ========================= */

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
    let airplayCoverUrl = '';
    let airplayFormat = '';

    // AIRPLAY: override fields from aplmeta.txt (matches moOde UI)
    if (airplay) {
      try {
        const aplText = await fetchText(`${MOODE_BASE_URL}/aplmeta.txt`);
        const ap = parseAplmeta(aplText);

        artist = ap.artist || artist || '';
        title = ap.title || title || '';
        album = ap.album || album || 'AirPlay Source';
        airplayCoverUrl = ap.coverUrl || '';
        airplayFormat = ap.format || '';

        // Prefer the cover from moOde’s airplay-covers
        altArtUrl = airplayCoverUrl;

        // moOde file-info line style: "ALAC/AAC"
        airplayInfoLine = airplayFormat || 'AirPlay';
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

      // Try both approaches:
      // 1) "Artist - Title" for pop stations
      const simple = splitArtistDashTitle(decodedTitle);

      // 2) Packed WFMT classical: "Composer - Work - Performers - Album - Label"
      const packed = parseDashPackedClassicalTitle(decodedTitle);

      debugRadioParsed = { simple, packed };

      // Prefer packed albumTerm if present (WFMT)
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
        // Fallback: song-style lookup (Classic FM, etc.)
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

      // Radio enrichment (UI can use these)
      radioAlbum,
      radioYear,

      // Extra radio enrichment (optional UI use later)
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`moOde now-playing server running on port ${PORT}`);
  console.log(`Endpoint: http://${LOCAL_ADDRESS}:${PORT}/now-playing`);
});
