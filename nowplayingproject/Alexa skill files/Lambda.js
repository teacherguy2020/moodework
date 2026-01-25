'use strict';

/**
 * moOde Alexa AudioPlayer Lambda (Node.js 16)
 *
 * Key design points:
 *  - Track tokens are base64url(JSON) with { file, pos0 } (pos0 is 0-based MPD playlist position)
 *  - PlaybackStarted advances MPD queue ONCE (idempotent) via POST /queue/advance
 *  - PlaybackNearlyFinished ENQUEUEs next track using GET /next-up (authoritative)
 *  - PlaybackFinished does NOTHING if we recently ENQUEUE'd for that finished token
 *    (prevents REPLACE_ALL from nuking the enqueued stream)
 *  - All artwork URLs in directives are PUBLIC (never IP address)
 *
 * Env:
 *  MOODE_API_BASE=https://moode.REPLACEWITHYOURPUBLICDOMAIN.com
 *  NOW_PLAYING_PATH=/now-playing
 *  NEXT_UP_PATH=/next-up
 *  TRACK_PATH=/track
 *  QUEUE_ADVANCE_PATH=/queue/advance
 *  TRACK_KEY=...
 */

const Alexa = require('ask-sdk-core');
const https = require('https');
const { URL } = require('url');

console.log('*** BOOT ***', new Date().toISOString(), 'version=', process.env.AWS_LAMBDA_FUNCTION_VERSION);

/* =========================
 * Config
 * ========================= */

const MOODE_API_BASE = process.env.MOODE_API_BASE || 'https://moode.REPLACEWITHYOURPUBLICDOMAIN.com';

const NOW_PLAYING_PATH = process.env.NOW_PLAYING_PATH || '/now-playing';
const NEXT_UP_PATH     = process.env.NEXT_UP_PATH     || '/next-up';

const TRACK_PATH       = process.env.TRACK_PATH       || '/track';
const QUEUE_ADVANCE_PATH = process.env.QUEUE_ADVANCE_PATH || '/queue/advance';

// Shared key (querystring) required by /track and /queue/advance
const TRACK_KEY = process.env.TRACK_KEY || process.env.MOODE_API_KEY || 'REPLACEWITHYOURCUSTOMTRACKKEY';

const META_STABLE_GAP_MS  = Number(process.env.META_STABLE_GAP_MS || '250');
const NEXT_ENQUEUE_GAP_MS = Number(process.env.NEXT_ENQUEUE_GAP_MS || '5000');

const TOKEN_PREFIX = 'moode-track';

// Dedup / idempotency
let lastKnownToken = '';
let lastKnownOffsetMs = 0;

let lastAdvancedToken = '';
let lastAdvancedAt = 0;

let lastEnqueuedToken = '';
let lastEnqueueAt = 0;

// Critical: used to suppress PlaybackFinished fallback when we ENQUEUE
let lastEnqueuePrevToken = '';
let lastEnqueuePrevAt = 0;

/* =========================
 * Small utils
 * ========================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function strictEncodeURIComponent(s) {
  return encodeURIComponent(String(s))
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function base64UrlEncode(str) {
  return Buffer.from(String(str || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(b64u) {
  const s = String(b64u || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = (s.length % 4) ? '='.repeat(4 - (s.length % 4)) : '';
  return Buffer.from(s + pad, 'base64').toString('utf8');
}

function makeToken(obj) {
  return TOKEN_PREFIX + ':' + base64UrlEncode(JSON.stringify(obj || {}));
}

function parseToken(token) {
  try {
    const t = String(token || '').trim();
    const prefix = TOKEN_PREFIX + ':';
    if (!t.startsWith(prefix)) return null;
    const json = base64UrlDecode(t.slice(prefix.length));
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function decodeHtmlEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function absolutizeMaybe(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';
  if (s.startsWith('https://') || s.startsWith('http://')) return s;
  if (s.startsWith('/')) return MOODE_API_BASE + s;
  return '';
}

function mustHaveEnv() {
  const missing = [];
  if (!MOODE_API_BASE) missing.push('MOODE_API_BASE');
  if (!TRACK_PATH) missing.push('TRACK_PATH');
  if (!TRACK_KEY) missing.push('TRACK_KEY');
  if (missing.length) {
    const err = new Error('Lambda misconfigured: missing env var(s): ' + missing.join(', '));
    err.code = 'CONFIG';
    throw err;
  }
}

/* =========================
 * HTTPS helper
 * ========================= */

function httpsJson(opts) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(opts.url);
    } catch (e) {
      return reject(new Error('Bad URL: ' + opts.url));
    }

    const reqOpts = {
      method: opts.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      headers: Object.assign({}, opts.headers || {}),
      family: 4,
    };

    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 400) {
          return reject(new Error('HTTP ' + status + ' from ' + opts.url + ': ' + data.slice(0, 300)));
        }
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          // Not JSON -- return raw for debugging, but do NOT throw
          resolve({ raw: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 6000, () => req.destroy(new Error('Request timeout')));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

/* =========================
 * API calls
 * ========================= */

function getNowPlaying() {
  mustHaveEnv();
  return httpsJson({
    method: 'GET',
    url: MOODE_API_BASE + NOW_PLAYING_PATH,
    headers: { Accept: 'application/json' },
    timeoutMs: 3500,
  });
}

function getNextUp() {
  mustHaveEnv();
  return httpsJson({
    method: 'GET',
    url: MOODE_API_BASE + NEXT_UP_PATH,
    headers: { Accept: 'application/json' },
    timeoutMs: 3500,
  });
}

function queueAdvance(pos0, file) {
  mustHaveEnv();

  const p = Number(pos0);
  const qsPos0 = isFinite(p) ? `&pos0=${encodeURIComponent(String(p))}` : '';
  const qsFile = file ? `&file=${encodeURIComponent(String(file))}` : '';

  return httpsJson({
    method: 'POST',
    url: MOODE_API_BASE + QUEUE_ADVANCE_PATH + '?k=' + strictEncodeURIComponent(TRACK_KEY) + qsPos0 + qsFile,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: { pos0: p, file: file || '' },
    timeoutMs: 3500,
  });
}

/* =========================
 * Alexa helpers
 * ========================= */

function getCurrentTokenBestEffort(handlerInput) {
  const req = handlerInput.requestEnvelope.request || {};
  if (typeof req.token === 'string' && req.token.trim()) return req.token.trim();

  const ctx = handlerInput.requestEnvelope.context || {};
  const ap = ctx.AudioPlayer || {};
  if (typeof ap.token === 'string' && ap.token.trim()) return ap.token.trim();

  return '';
}

function buildTrackUrlFromFile(file, offsetMs) {
  if (!file) return '';
  const encFile = strictEncodeURIComponent(file);
  const encKey  = strictEncodeURIComponent(TRACK_KEY);

  const ms = Number(offsetMs || 0);
  const sec = ms > 0 ? Math.floor(ms / 1000) : 0;

  let url = MOODE_API_BASE + TRACK_PATH + '?file=' + encFile + '&k=' + encKey;
  if (sec > 0) url += '&t=' + String(sec);
  return url;
}

/**
 * Always produce PUBLIC artwork URLs.
 * - Prefer already-public altArtUrl / aplArtUrl if present
 * - Otherwise build https://public/coverart.php/<mpdFile> for file playback
 */
function pickPublicArtUrl(d, mpdFile) {
  const cand = [
    d && d.altArtUrl,
    d && d.aplArtUrl,
    d && d.albumArtUrl, // may be LAN -- we will reject if it looks LAN
  ]
    .map((x) => absolutizeMaybe(x))
    .filter(Boolean);

  for (const u of cand) {
    // reject common LAN patterns
    if (u.startsWith('http://10.') || u.startsWith('http://192.168.') || u.startsWith('http://172.16.')) continue;
    return u;
  }

  if (mpdFile) {
    // Your server supports PUBLIC /coverart.php/<file> (per your /next-up artUrl)
    return MOODE_API_BASE + '/coverart.php/' + strictEncodeURIComponent(mpdFile);
  }

  return '';
}

function buildMetadataFromNowPlaying(d, fallbackTitle) {
  const title = String((d && d.title) ? d.title : (fallbackTitle || 'Now Playing'));
  let subtitle = '';
  if (d && d.artist) subtitle += String(d.artist);
  if (d && d.album) subtitle += (subtitle ? ' -- ' : '') + String(d.album);
  subtitle = subtitle || 'moOde';

  const meta = { title, subtitle };

  const artUrl = pickPublicArtUrl(d, d && d.file ? String(d.file).trim() : '');
  if (artUrl) {
    meta.art = { sources: [{ url: artUrl }] };
    meta.backgroundImage = { sources: [{ url: artUrl }] };
  }

  return meta;
}

function buildPlayReplaceAllFromNowPlaying(d, offsetMs) {
  const mpdFile = String((d && d.file) ? d.file : '').trim();
  if (!mpdFile) return null;

  const pos0raw = (d && d.songpos !== undefined && d.songpos !== null) ? String(d.songpos).trim() : '';
  const pos0 = (pos0raw !== '' && isFinite(Number(pos0raw))) ? Number(pos0raw) : null;

  const url = buildTrackUrlFromFile(mpdFile, offsetMs || 0);
  if (!url) return null;

  const tokenObj = { file: mpdFile };
  if (pos0 !== null) tokenObj.pos0 = pos0;

  const token = makeToken(tokenObj);

  return {
    type: 'AudioPlayer.Play',
    playBehavior: 'REPLACE_ALL',
    audioItem: {
      stream: {
        token,
        url,
        offsetInMilliseconds: offsetMs || 0,
      },
      metadata: buildMetadataFromNowPlaying(d, 'Now Playing'),
    },
  };
}

/**
 * ENQUEUE helper
 * - Requires next.file and next.songpos (pos0) and finishedToken
 * - Sets expectedPreviousToken at stream + top-level (Echo differences)
 */
function buildPlayEnqueue(next, finishedToken) {
  next = next || {};
  const nextFile = String(next.file || '').trim();

  const posRaw = (next.songpos !== undefined && next.songpos !== null)
    ? String(next.songpos).trim()
    : '';

  const nextPos0 = (posRaw !== '' && isFinite(Number(posRaw))) ? Number(posRaw) : null;
  const expectedPreviousToken = String(finishedToken || '').trim();

  if (!nextFile || nextPos0 === null || !expectedPreviousToken) return null;

  const nextToken = makeToken({ file: nextFile, pos0: nextPos0 });
  const url = buildTrackUrlFromFile(nextFile, 0);

  const meta = {
    title: String(next.title || '').trim(),
    subtitle: (() => {
      let s = '';
      if (next.artist) s += String(next.artist);
      if (next.album) s += (s ? ' -- ' : '') + String(next.album);
      return s.trim();
    })(),
  };

  const artUrl = pickPublicArtUrl(next, nextFile);
  if (artUrl) {
    meta.art = { sources: [{ url: artUrl }] };
    meta.backgroundImage = { sources: [{ url: artUrl }] };
  }

  return {
    type: 'AudioPlayer.Play',
    playBehavior: 'ENQUEUE',
    audioItem: {
      stream: {
        token: nextToken,
        url,
        offsetInMilliseconds: 0,
        expectedPreviousToken,
      },
      metadata: meta,
    },
    expectedPreviousToken,
  };
}

/* =========================
 * Stable snapshot (double fetch)
 * ========================= */

async function getStableNowPlaying() {
  await sleep(META_STABLE_GAP_MS);

  let a = null;
  let b = null;

  try { a = await getNowPlaying(); } catch (e) { a = null; }
  await sleep(120);
  try { b = await getNowPlaying(); } catch (e) { b = null; }

  const src = (b && b.file) ? b : (a && a.file) ? a : (b || a || null);
  if (!src) return null;

  return {
    title: decodeHtmlEntities(src.title || ''),
    artist: decodeHtmlEntities(src.artist || ''),
    album: decodeHtmlEntities(src.album || ''),
    file: String(src.file || '').trim(),
    songpos: (src.songpos !== undefined && src.songpos !== null) ? String(src.songpos).trim() : '',
    songid: (src.songid !== undefined && src.songid !== null) ? String(src.songid).trim() : '',
    aplArtUrl: absolutizeMaybe(src.aplArtUrl || ''),
    albumArtUrl: absolutizeMaybe(src.albumArtUrl || ''),
    altArtUrl: absolutizeMaybe(src.altArtUrl || ''),
    elapsedSec: Number(src.elapsed || 0),
    durationSec: Number(src.duration || 0),
  };
}

/* =========================
 * Queue advance idempotency
 * ========================= */

async function ensureQueueAdvancedForToken(token, offsetMs) {
  const startedToken = String(token || '').trim();
  const startedOffsetMs = Number(offsetMs || 0) || 0;

  if (!startedToken) return false;

  // Resume guard: same token + non-zero offset => do not advance
  if (startedToken === lastKnownToken && startedOffsetMs > 0) {
    console.log('ensureQueueAdvancedForToken: resume detected; skip advance', { startedOffsetMs, lastKnownOffsetMs });
    return false;
  }

  const now = Date.now();

  // Dedup: Alexa can duplicate events
  if (startedToken === lastAdvancedToken && (now - lastAdvancedAt) < 15000) {
    console.log('ensureQueueAdvancedForToken: skip duplicate advance for same token');
    return false;
  }

  const parsed = parseToken(startedToken) || {};
  const pos0 =
    (parsed.pos0 !== undefined && parsed.pos0 !== null && isFinite(Number(parsed.pos0)))
      ? Number(parsed.pos0)
      : null;

  if (pos0 === null) {
    console.log('ensureQueueAdvancedForToken: missing pos0; cannot advance');
    return false;
  }

  await queueAdvance(pos0, parsed.file);

  lastAdvancedToken = startedToken;
  lastAdvancedAt = now;

  console.log('ensureQueueAdvancedForToken: advanced pos0=', pos0);
  return true;
}

/* =========================
 * Logging interceptor
 * ========================= */

const LogRequestInterceptor = {
  process(handlerInput) {
    try {
      const req = handlerInput.requestEnvelope.request || {};
      console.log('INCOMING request.type:', req.type);
      if (req.type === 'IntentRequest') {
        console.log('INCOMING intent:', req.intent && req.intent.name);
      }
    } catch (e) {
      console.log('INCOMING log failed:', e && e.message ? e.message : String(e));
    }
  },
};

/* =========================
 * Handlers - Intents
 * ========================= */

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },

  async handle(handlerInput) {
    try {
      const d = await getStableNowPlaying();
      console.log('DEBUG /now-playing snapshot:', d ? JSON.stringify(d, null, 2) : null);

      const play = buildPlayReplaceAllFromNowPlaying(d, 0);
      if (!play) {
        return handlerInput.responseBuilder
          .speak('I cannot find the current track to play right now.')
          .withShouldEndSession(true)
          .getResponse();
      }

      return handlerInput.responseBuilder
        .speak('Starting moode.')
        .addDirective(play)
        .withShouldEndSession(true)
        .getResponse();
    } catch (e) {
      console.error('LaunchRequest error:', e);
      return handlerInput.responseBuilder
        .speak('Sorry, I could not start moode right now.')
        .withShouldEndSession(true)
        .getResponse();
    }
  },
};

const NowPlayingIntentHandler = {
  canHandle(handlerInput) {
    const r = handlerInput.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'NowPlayingIntent';
  },

  async handle(handlerInput) {
    try {
      const d = await getStableNowPlaying();
      if (!d || !d.title) {
        return handlerInput.responseBuilder
          .speak('Nothing is queued.')
          .withShouldEndSession(true)
          .getResponse();
      }

      const speech =
        'Now playing ' +
        (d.title ? d.title : 'a track') +
        (d.artist ? ' by ' + d.artist : '') +
        '.';

      return handlerInput.responseBuilder
        .speak(speech)
        .withShouldEndSession(true)
        .getResponse();
    } catch (e) {
      console.error('NowPlayingIntent error:', e);
      return handlerInput.responseBuilder
        .speak('Sorry, I could not get that.')
        .withShouldEndSession(true)
        .getResponse();
    }
  },
};

const PauseIntentHandler = {
  canHandle(handlerInput) {
    const r = handlerInput.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent &&
      (r.intent.name === 'AMAZON.PauseIntent' || r.intent.name === 'PauseIntent');
  },

  async handle(handlerInput) {
    return handlerInput.responseBuilder
      .addDirective({ type: 'AudioPlayer.Stop' })
      .withShouldEndSession(true)
      .getResponse();
  },
};

const ResumeIntentHandler = {
  canHandle(handlerInput) {
    const r = handlerInput.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent &&
      (r.intent.name === 'AMAZON.ResumeIntent' ||
       r.intent.name === 'ResumeIntent' ||
       r.intent.name === 'AMAZON.PlayIntent');
  },

  async handle(handlerInput) {
    try {
      // If no resume state, start fresh from stable /now-playing
      if (!lastKnownToken) {
        const d = await getStableNowPlaying();
        const play = buildPlayReplaceAllFromNowPlaying(d, 0);
        if (!play) {
          return handlerInput.responseBuilder.speak('Nothing to play.').withShouldEndSession(true).getResponse();
        }
        return handlerInput.responseBuilder
          .speak('Resuming.')
          .addDirective(play)
          .withShouldEndSession(true)
          .getResponse();
      }

      const parsed = parseToken(lastKnownToken) || {};
      const file = String(parsed.file || '').trim();
      const offsetMs = Number(lastKnownOffsetMs || 0) || 0;

      if (!file) {
        return handlerInput.responseBuilder.speak('Sorry, I could not resume.').withShouldEndSession(true).getResponse();
      }

      const url = buildTrackUrlFromFile(file, offsetMs);
      const directive = {
        type: 'AudioPlayer.Play',
        playBehavior: 'REPLACE_ALL',
        audioItem: {
          stream: {
            token: lastKnownToken,
            url,
            offsetInMilliseconds: offsetMs,
          },
        },
      };

      return handlerInput.responseBuilder
        .speak('Resuming.')
        .addDirective(directive)
        .withShouldEndSession(true)
        .getResponse();
    } catch (e) {
      console.error('Resume error:', e);
      return handlerInput.responseBuilder.speak('Sorry, I could not resume.').withShouldEndSession(true).getResponse();
    }
  },
};

const NextIntentHandler = {
  canHandle(handlerInput) {
    const r = handlerInput.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent &&
      (r.intent.name === 'AMAZON.NextIntent' || r.intent.name === 'NextIntent' || r.intent.name === 'SkipIntent');
  },

  async handle(handlerInput) {
    try {
      // "Next" for Alexa playback: just start the current /now-playing (which should already be the next file)
      const d = await getStableNowPlaying();
      console.log('NextIntent: /now-playing snapshot:', d ? JSON.stringify(d, null, 2) : null);

      const play = buildPlayReplaceAllFromNowPlaying(d, 0);
      if (!play) {
        return handlerInput.responseBuilder
          .speak('No next track found.')
          .withShouldEndSession(true)
          .getResponse();
      }

      return handlerInput.responseBuilder
        .speak('Skipping.')
        .addDirective(play)
        .withShouldEndSession(true)
        .getResponse();
    } catch (e) {
      console.error('NextIntent error:', e);
      return handlerInput.responseBuilder
        .speak('Sorry, I could not skip.')
        .withShouldEndSession(true)
        .getResponse();
    }
  },
};

const StopHandler = {
  canHandle(handlerInput) {
    const r = handlerInput.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent &&
      (r.intent.name === 'AMAZON.StopIntent' || r.intent.name === 'AMAZON.CancelIntent');
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder
      .addDirective({ type: 'AudioPlayer.Stop' })
      .withShouldEndSession(true)
      .getResponse();
  },
};

/* =========================
 * PlaybackController (buttons)
 * ========================= */

const PlaybackControllerEventHandler = {
  canHandle(handlerInput) {
    const req = handlerInput.requestEnvelope && handlerInput.requestEnvelope.request;
    return !!(req && req.type && String(req.type).indexOf('PlaybackController.') === 0);
  },

  async handle(handlerInput) {
    const req = handlerInput.requestEnvelope.request;
    console.log('PlaybackController event:', req.type);

    try {
      if (req.type === 'PlaybackController.PauseCommandIssued') {
        return handlerInput.responseBuilder.addDirective({ type: 'AudioPlayer.Stop' }).getResponse();
      }

      if (req.type === 'PlaybackController.PlayCommandIssued' || req.type === 'PlaybackController.NextCommandIssued') {
        const d = await getStableNowPlaying();
        const play = buildPlayReplaceAllFromNowPlaying(d, 0);
        if (!play) return handlerInput.responseBuilder.getResponse();
        console.log('Play directive:', JSON.stringify(play, null, 2));
        return handlerInput.responseBuilder.addDirective(play).getResponse();
      }

      return handlerInput.responseBuilder.getResponse();
    } catch (e) {
      console.error('PlaybackController handler error:', e);
      return handlerInput.responseBuilder.getResponse();
    }
  },
};

/* =========================
 * AudioPlayer events
 * ========================= */

const AudioPlayerEventHandler = {
  canHandle(handlerInput) {
    const req = handlerInput.requestEnvelope && handlerInput.requestEnvelope.request;
    return !!(req && req.type && String(req.type).startsWith('AudioPlayer.'));
  },

  async handle(handlerInput) {
    const req = handlerInput.requestEnvelope.request || {};
    const eventType = String(req.type || '');

    console.log('AudioPlayer event:', eventType);

    // Store resume state helper
    function storeResumeState() {
      lastKnownToken = String(req.token || getCurrentTokenBestEffort(handlerInput) || '').trim();
      lastKnownOffsetMs = Number(req.offsetInMilliseconds || 0) || 0;

      console.log('Stored resume state:', {
        tokenPrefix: lastKnownToken ? lastKnownToken.slice(0, 120) : '',
        offsetMs: lastKnownOffsetMs,
      });
    }

    // 1) Store resume state on stop/pause/fail
    if (
      eventType === 'AudioPlayer.PlaybackStopped' ||
      eventType === 'AudioPlayer.PlaybackPaused' ||
      eventType === 'AudioPlayer.PlaybackFailed'
    ) {
      storeResumeState();
      return handlerInput.responseBuilder.getResponse();
    }

    // 2) PlaybackStarted => advance MPD queue once
    if (eventType === 'AudioPlayer.PlaybackStarted') {
      try {
        const startedToken = String(req.token || getCurrentTokenBestEffort(handlerInput) || '').trim();
        const startedOffsetMs = Number(req.offsetInMilliseconds || 0) || 0;

        console.log('PlaybackStarted: token prefix:', startedToken.slice(0, 160));
        console.log('PlaybackStarted: offsetInMilliseconds=', startedOffsetMs);

        await ensureQueueAdvancedForToken(startedToken, startedOffsetMs);

        return handlerInput.responseBuilder.getResponse();
      } catch (e) {
        console.error('PlaybackStarted handler failed:', e && e.message ? e.message : String(e));
        return handlerInput.responseBuilder.getResponse();
      }
    }

    // 3) PlaybackNearlyFinished => ENQUEUE next via /next-up
    if (eventType === 'AudioPlayer.PlaybackNearlyFinished') {
        try {
            const finishedToken = String(req.token || getCurrentTokenBestEffort(handlerInput) || '').trim();
            if (!finishedToken) {
                console.log('NearlyFinished: missing finishedToken; cannot ENQUEUE');
                return handlerInput.responseBuilder.getResponse();
            }

            console.log('NearlyFinished: token prefix:', finishedToken.slice(0, 160));

            // Safety: make sure we advanced at least once for this token
            let advanced = false;
            try {
                advanced = await ensureQueueAdvancedForToken(finishedToken, 0);
            } catch (e) {
                advanced = false;
                console.log(
                    'NearlyFinished: ensureQueueAdvancedForToken failed:',
                    (e && e.message) ? e.message : String(e)
                );
            }
            console.log('NearlyFinished: ensureQueueAdvancedForToken =>', !!advanced);

            const nextUp = await getNextUp();
            console.log('NearlyFinished: /next-up payload:', nextUp ? JSON.stringify(nextUp, null, 2) : null);

            const next = (nextUp && nextUp.ok) ? nextUp.next : null;
            if (!next || !next.file) {
                console.log('NearlyFinished: no next from /next-up; skipping ENQUEUE');
                return handlerInput.responseBuilder.getResponse();
            }

            const nextFile = String(next.file || '').trim();

            const nextPos0raw =
                (next.songpos !== undefined && next.songpos !== null) ? String(next.songpos).trim() : '';

            const nextPos0 =
                (nextPos0raw !== '' && isFinite(Number(nextPos0raw))) ? Number(nextPos0raw) : null;

            if (!nextFile || nextPos0 === null) {
                console.log('NearlyFinished: missing nextFile or nextPos0; skipping ENQUEUE');
                return handlerInput.responseBuilder.getResponse();
            }

            // Dedup enqueues
            const candidateToken = makeToken({ file: nextFile, pos0: nextPos0 });
            const now = Date.now();
            if (candidateToken === lastEnqueuedToken && (now - lastEnqueueAt) < NEXT_ENQUEUE_GAP_MS) {
                console.log('NearlyFinished: skip duplicate enqueue token');
                return handlerInput.responseBuilder.getResponse();
            }

            const enq = buildPlayEnqueue({
                file: nextFile,
                songpos: nextPos0,
                title: decodeHtmlEntities(next.title || ''),
                artist: decodeHtmlEntities(next.artist || ''),
                album: decodeHtmlEntities(next.album || ''),
                // /next-up already gives public artUrl
                altArtUrl: absolutizeMaybe(next.artUrl || ''),
            }, finishedToken);

            if (!enq) {
                console.log('NearlyFinished: could not build ENQUEUE directive');
                return handlerInput.responseBuilder.getResponse();
            }

            lastEnqueuedToken = candidateToken;
            lastEnqueueAt = now;

            // Critical: mark that ENQUEUE happened for this finished token
            lastEnqueuePrevToken = finishedToken;
            lastEnqueuePrevAt = now;

            console.log('NearlyFinished: ENQUEUE next:', nextFile, 'pos0=', nextPos0);
            console.log('NearlyFinished: enqueue directive:', JSON.stringify(enq, null, 2));

            return handlerInput.responseBuilder
                .addDirective(enq)
                .getResponse();
        } catch (e) {
            console.error('NearlyFinished handler failed:', (e && e.message) ? e.message : String(e));
            return handlerInput.responseBuilder.getResponse();
        }
    }
    
    // 4) PlaybackFinished => ONLY fallback if we did NOT recently ENQUEUE for this token
    if (eventType === 'AudioPlayer.PlaybackFinished') {
      try {
        const finishedToken = String(req.token || getCurrentTokenBestEffort(handlerInput) || '').trim();
        const now = Date.now();

        // If we ENQUEUE'd for this exact finished token recently, DO NOTHING.
        if (
          finishedToken &&
          finishedToken === lastEnqueuePrevToken &&
          (now - lastEnqueuePrevAt) < 120000
        ) {
          console.log('PlaybackFinished: enqueue already issued; no action');
          return handlerInput.responseBuilder.getResponse();
        }

        console.log('PlaybackFinished: fallback continue (REPLACE_ALL)');

        // Fallback: start whatever /now-playing says is current
        const d = await getStableNowPlaying();
        console.log('PlaybackFinished: /now-playing snapshot:', d ? JSON.stringify(d, null, 2) : null);

        const play = buildPlayReplaceAllFromNowPlaying(d, 0);
        if (!play) {
          console.log('PlaybackFinished: no playable next track found; no action');
          return handlerInput.responseBuilder.getResponse();
        }

        console.log('PlaybackFinished: issuing REPLACE_ALL directive:', JSON.stringify(play, null, 2));
        return handlerInput.responseBuilder
          .addDirective(play)
          .getResponse();
      } catch (e) {
        console.error('PlaybackFinished fallback failed:', e && e.message ? e.message : String(e));
        return handlerInput.responseBuilder.getResponse();
      }
    }

    // 5) Other AudioPlayer events => no action
    return handlerInput.responseBuilder.getResponse();
  },
};

/* =========================
 * System.ExceptionEncountered
 * ========================= */

const SystemExceptionHandler = {
  canHandle(handlerInput) {
    const req = handlerInput.requestEnvelope && handlerInput.requestEnvelope.request;
    return !!(req && req.type === 'System.ExceptionEncountered');
  },

  handle(handlerInput) {
    const req = handlerInput.requestEnvelope.request;
    console.log('System.ExceptionEncountered:', JSON.stringify(req, null, 2));
    return handlerInput.responseBuilder.getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },

  handle(handlerInput) {
    console.log('Session ended:', JSON.stringify(handlerInput.requestEnvelope.request, null, 2));
    return handlerInput.responseBuilder.getResponse();
  },
};

const IntentReflectorHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
  },

  handle(handlerInput) {
    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
    console.log('IntentReflector hit for:', intentName);
    return handlerInput.responseBuilder
      .speak('I received ' + intentName + '.')
      .withShouldEndSession(true)
      .getResponse();
  },
};

const ErrorHandler = {
  canHandle() { return true; },

  handle(handlerInput, error) {
    console.error('Unhandled error:', error);
    return handlerInput.responseBuilder
      .speak('Sorry, something went wrong.')
      .withShouldEndSession(true)
      .getResponse();
  },
};

/* =========================
 * Skill builder
 * ========================= */

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestInterceptors(LogRequestInterceptor)
  .addRequestHandlers(
    LaunchRequestHandler,
    NowPlayingIntentHandler,
    NextIntentHandler,
    PauseIntentHandler,
    ResumeIntentHandler,
    StopHandler,

    PlaybackControllerEventHandler,
    AudioPlayerEventHandler,

    SystemExceptionHandler,
    SessionEndedRequestHandler,
    IntentReflectorHandler
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();