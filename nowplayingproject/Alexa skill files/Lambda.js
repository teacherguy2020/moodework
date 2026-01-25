'use strict';

/* =========================
 * Config
 * ========================= */

const Alexa = require('ask-sdk-core');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const VERSION = 1; // bump when you deploy
const API_BASE = String(process.env.API_BASE || 'https://moode.CHANGE TO YOUR DOMAIN NAM.com').replace(/\/+$/, '');
const TRACK_KEY = String(process.env.TRACK_KEY || 'PUT YOUR TRACK KEY HERE').trim();
const PUBLIC_TRACK_BASE = String(process.env.PUBLIC_TRACK_BASE || API_BASE).replace(/\/+$/, ''); // usually same as API_BASE

// Tuneables
const HTTP_TIMEOUT_MS = 6000;

// Dedupe / idempotency windows
const ADVANCE_GUARD_MS = 8000;       // avoid double-advancing same token
const ENQUEUE_GUARD_MS = 5000;       // avoid duplicate ENQUEUE spam
const PRIME_START_OFFSET_MS = 0;     // no resume yet

/* =========================
 * Small utils
 * ========================= */

function nowMs() { return Date.now(); }

function safeStr(x) {
  return String(x === undefined || x === null ? '' : x).trim();
}

function safeNum(x, fallback) {
  const n = Number.parseInt(String(x === undefined || x === null ? '' : x).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function decodeHtmlEntities(str) {
  const s = safeStr(str);
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function b64ToJson(b64) {
  try {
    const txt = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

function parseTokenB64(token) {
  // token format: "moode-track:<base64json>"
  const s = safeStr(token);
  const i = s.indexOf(':');
  if (i < 0) return null;
  const b64 = s.slice(i + 1);
  const obj = b64ToJson(b64);
  return obj && typeof obj === 'object' ? obj : null;
}

function makeToken(obj) {
  const payload = JSON.stringify(obj || {});
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  return 'moode-track:' + b64;
}

function absolutizeMaybe(urlStr) {
  const s = safeStr(urlStr);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return API_BASE + s;
  return API_BASE + '/' + s;
}

function getEventType(handlerInput) {
  const req = handlerInput.requestEnvelope && handlerInput.requestEnvelope.request;
  return req && req.type ? String(req.type) : '';
}

function getAudioPlayerToken(handlerInput) {
  const req = handlerInput.requestEnvelope && handlerInput.requestEnvelope.request;
  // AudioPlayer events usually put token here
  if (req && req.token) return String(req.token);
  // Some paths might keep it in context
  try {
    const t = handlerInput.requestEnvelope.context.AudioPlayer.token;
    return t ? String(t) : '';
  } catch (e) {
    return '';
  }
}

function speak(handlerInput, text) {
  return handlerInput.responseBuilder
    .speak(text)
    .withShouldEndSession(false)
    .getResponse();
}

/* =========================
 * HTTPS helper
 * ========================= */

function httpRequestJson(method, urlStr, opts) {
  opts = opts || {};
  const headers = opts.headers || {};
  const bodyObj = opts.bodyObj || null;
  const timeoutMs = opts.timeoutMs || HTTP_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;

    const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: method,
        headers: Object.assign(
          {
            'Accept': 'application/json',
          },
          body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {},
          headers
        ),
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');

        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const status = res.statusCode || 0;
          const ok = status >= 200 && status < 300;

          if (!ok) {
            return reject(new Error('HTTP ' + status + ' ' + method + ' ' + urlStr + ': ' + String(data).slice(0, 200)));
          }

          const t = String(data || '').trim();
          if (!t) return resolve(null);

          try {
            resolve(JSON.parse(t));
          } catch (e) {
            reject(new Error('Bad JSON from ' + urlStr + ': ' + e.message + '. Body: ' + t.slice(0, 200)));
          }
        });
      }
    );

    req.on('timeout', () => {
      try { req.destroy(new Error('timeout')); } catch (e) {}
    });

    req.on('error', (err) => reject(err));

    if (body) req.write(body);
    req.end();
  });
}

/* =========================
 * API calls
 * ========================= */

async function apiNowPlaying() {
  const url = API_BASE + '/now-playing';
  return httpRequestJson('GET', url, { timeoutMs: HTTP_TIMEOUT_MS });
}

async function apiQueueAdvance(pos0, file) {
  const url = API_BASE + '/queue/advance';
  const headers = TRACK_KEY ? { 'x-track-key': TRACK_KEY } : {};
  return httpRequestJson('POST', url, {
    headers: headers,
    bodyObj: { pos0: pos0, file: file },
    timeoutMs: HTTP_TIMEOUT_MS,
  });
}

/* =========================
 * Alexa helpers
 * ========================= */

function buildPlayReplaceAll(track, spokenTitle) {
  // track fields from /now-playing:
  // { file, title, artist, album, albumArtUrl?, ... , songpos, ... }
  const file = safeStr(track.file);
  const pos0 = safeNum(track.songpos, 0);

  const token = makeToken({ file: file, pos0: pos0 });

  const title = safeStr(track.title);
  const artist = safeStr(track.artist);
  const album = safeStr(track.album);
  const artUrl = absolutizeMaybe(track.albumArtUrl || track.altArtUrl || '');

  const url =
    PUBLIC_TRACK_BASE +
    '/track?file=' + encodeURIComponent(file) +
    (TRACK_KEY ? '&k=' + encodeURIComponent(TRACK_KEY) : '');

  const directive = {
    type: 'AudioPlayer.Play',
    playBehavior: 'REPLACE_ALL',
    audioItem: {
      stream: {
        token: token,
        url: url,
        offsetInMilliseconds: PRIME_START_OFFSET_MS,
      },
      metadata: {
        title: title || spokenTitle || 'Now playing',
        subtitle: (artist ? artist : '') + (album ? ' -- ' + album : ''),
        art: artUrl ? { sources: [{ url: artUrl }] } : undefined,
        backgroundImage: artUrl ? { sources: [{ url: artUrl }] } : undefined,
      },
    },
  };

  return directive;
}

function buildPlayEnqueue(track, expectedPreviousToken) {
  const file = safeStr(track.file);
  const pos0 = safeNum(track.songpos, null);
  if (!file || pos0 === null) return null;

  const token = makeToken({ file: file, pos0: pos0 });

  const title = safeStr(track.title);
  const artist = safeStr(track.artist);
  const album = safeStr(track.album);
  const artUrl = absolutizeMaybe(track.albumArtUrl || track.altArtUrl || '');

  const url =
    PUBLIC_TRACK_BASE +
    '/track?file=' + encodeURIComponent(file) +
    (TRACK_KEY ? '&k=' + encodeURIComponent(TRACK_KEY) : '');

  const directive = {
    type: 'AudioPlayer.Play',
    playBehavior: 'ENQUEUE',
    audioItem: {
      stream: {
        token: token,
        url: url,
        offsetInMilliseconds: 0,
        expectedPreviousToken: expectedPreviousToken || undefined,
      },
      metadata: {
        title: title || 'Up next',
        subtitle: (artist ? artist : '') + (album ? ' -- ' + album : ''),
        art: artUrl ? { sources: [{ url: artUrl }] } : undefined,
        backgroundImage: artUrl ? { sources: [{ url: artUrl }] } : undefined,
      },
    },
    expectedPreviousToken: expectedPreviousToken || undefined,
  };

  return directive;
}

/* =========================
 * Stable snapshot (double fetch)
 * ========================= */

async function getStableNowPlayingSnapshot() {
  // Double fetch: if queue is mid-mutation, the second read is often the "truth".
  // If either fails, throw up to caller.
  const a = await apiNowPlaying();
  const b = await apiNowPlaying();

  // Prefer non-null
  const pick = b || a;

  // Normalize
  if (!pick || !pick.file) return null;

  // Ensure songpos numeric-ish; moode endpoint returns string sometimes
  pick.songpos = safeStr(pick.songpos);
  return pick;
}

/* =========================
 * Queue advance idempotency
 * ========================= */

let lastAdvancedToken = '';
let lastAdvancedAt = 0;

let lastEnqueuedToken = '';
let lastEnqueueAt = 0;

let lastEnqueuePrevToken = '';
let lastEnqueuePrevAt = 0;

function recentlyAdvancedForToken(token) {
  const t = safeStr(token);
  if (!t) return false;
  if (t !== lastAdvancedToken) return false;
  return (nowMs() - lastAdvancedAt) < ADVANCE_GUARD_MS;
}

function markAdvancedForToken(token) {
  lastAdvancedToken = safeStr(token);
  lastAdvancedAt = nowMs();
}

function recentlyEnqueuedToken(token) {
  const t = safeStr(token);
  if (!t) return false;
  if (t !== lastEnqueuedToken) return false;
  return (nowMs() - lastEnqueueAt) < ENQUEUE_GUARD_MS;
}

function markEnqueuedToken(token, prevToken) {
  lastEnqueuedToken = safeStr(token);
  lastEnqueueAt = nowMs();
  lastEnqueuePrevToken = safeStr(prevToken);
  lastEnqueuePrevAt = nowMs();
}

function enqueueAlreadyIssuedForPrevToken(prevToken) {
  const p = safeStr(prevToken);
  if (!p) return false;
  if (p !== lastEnqueuePrevToken) return false;
  // small window is fine; we just need to suppress immediate fallback
  return (nowMs() - lastEnqueuePrevAt) < (ADVANCE_GUARD_MS + 2000);
}

async function advanceFromTokenIfNeeded(token) {
  const tok = safeStr(token);
  if (!tok) return false;

  if (recentlyAdvancedForToken(tok)) {
    return false;
  }

  const parsed = parseTokenB64(tok);
  if (!parsed) return false;

  const file = safeStr(parsed.file);
  const pos0 = safeNum(parsed.pos0, null);

  if (!file || pos0 === null) return false;

  await apiQueueAdvance(pos0, file);
  markAdvancedForToken(tok);
  return true;
}

/* =========================
 * Logging interceptor
 * ========================= */

const LogRequestInterceptor = {
  process(handlerInput) {
    try {
      const req = handlerInput.requestEnvelope && handlerInput.requestEnvelope.request;
      const t = req && req.type ? req.type : 'unknown';
      console.log('INCOMING request.type:', t);
      console.log('VERSION:', VERSION);
    } catch (e) {
      console.log('LogRequestInterceptor failed:', e && e.message ? e.message : String(e));
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
      // Optional but nice: fail fast if TRACK_KEY is missing and you expect it.
      // We’re delaying this per your note, but leaving the guard here commented.
      // if (!TRACK_KEY) return speak(handlerInput, 'Check authorization key.');

      const snap = await getStableNowPlayingSnapshot();
      if (!snap || !snap.file) {
        return speak(handlerInput, 'I cannot find the current track to play right now.');
      }

      const directive = buildPlayReplaceAll(snap, 'Starting playback');

      // After we start the session’s first REPLACE, immediately advance MPD head so /now-playing becomes next track.
      // Use the token we just issued, since it encodes {file,pos0}.
      const issuedToken = directive.audioItem.stream.token;

      try {
        await advanceFromTokenIfNeeded(issuedToken);
        console.log('Launch: advanced MPD head for first track');
      } catch (e) {
        console.log('Launch: advance failed:', e && e.message ? e.message : String(e));
      }

      return handlerInput.responseBuilder
        .speak('Playing.')
        .addDirective(directive)
        .getResponse();
    } catch (e) {
      console.log('Launch error:', e && e.message ? e.message : String(e));
      return speak(handlerInput, 'I cannot start playback right now.');
    }
  },
};

// Minimal "Stop" / "Cancel"
const StopHandler = {
  canHandle(handlerInput) {
    const t = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (t !== 'IntentRequest') return false;
    const name = Alexa.getIntentName(handlerInput.requestEnvelope);
    return name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent';
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
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'PlaybackController.NextCommandIssued'
      || Alexa.getRequestType(handlerInput.requestEnvelope) === 'PlaybackController.PreviousCommandIssued';
  },
  handle(handlerInput) {
    // Keep it simple: let AudioPlayer events drive queue.
    return handlerInput.responseBuilder.getResponse();
  },
};

/* =========================
 * AudioPlayer events
 * ========================= */

const AudioPlayerEventHandler = {
  canHandle(handlerInput) {
    const t = Alexa.getRequestType(handlerInput.requestEnvelope);
    return t && String(t).startsWith('AudioPlayer.');
  },

  async handle(handlerInput) {
    const eventType = getEventType(handlerInput);
    const token = getAudioPlayerToken(handlerInput);

    // 1) PlaybackStarted => ensure we have advanced for this token (idempotent)
    if (eventType === 'AudioPlayer.PlaybackStarted') {
      try {
        console.log('AudioPlayer event:', eventType);
        console.log('PlaybackStarted: token prefix:', safeStr(token).slice(0, 160));

        try {
          const advanced = await advanceFromTokenIfNeeded(token);
          if (advanced) console.log('PlaybackStarted: advanced queue for this token');
        } catch (e) {
          console.log('PlaybackStarted: advance failed:', e && e.message ? e.message : String(e));
        }

        return handlerInput.responseBuilder.getResponse();
      } catch (e) {
        console.log('PlaybackStarted handler failed:', e && e.message ? e.message : String(e));
        return handlerInput.responseBuilder.getResponse();
      }
    }

    // 2) PlaybackNearlyFinished => ENQUEUE next based on /now-playing (after prior advance)
    if (eventType === 'AudioPlayer.PlaybackNearlyFinished') {
      try {
        console.log('AudioPlayer event:', eventType);
        const finishedToken = safeStr(token);

        if (!finishedToken) {
          console.log('NearlyFinished: missing finishedToken; cannot ENQUEUE');
          return handlerInput.responseBuilder.getResponse();
        }

        console.log('NearlyFinished: token prefix:', finishedToken.slice(0, 160));

        // Snapshot of "what should play next" is always /now-playing (because we advanced earlier)
        const snap = await getStableNowPlayingSnapshot();
        console.log('NearlyFinished: /now-playing snapshot:', snap ? JSON.stringify(snap, null, 2) : null);

        if (!snap || !snap.file) {
          console.log('NearlyFinished: no next from /now-playing; skipping ENQUEUE');
          return handlerInput.responseBuilder.getResponse();
        }

        const nextFile = safeStr(snap.file);
        const nextPos0 = safeNum(snap.songpos, null);

        if (!nextFile || nextPos0 === null) {
          console.log('NearlyFinished: missing nextFile or nextPos0; skipping ENQUEUE');
          return handlerInput.responseBuilder.getResponse();
        }

        const candidateToken = makeToken({ file: nextFile, pos0: nextPos0 });

        // Dedup ENQUEUE
        if (recentlyEnqueuedToken(candidateToken)) {
          console.log('NearlyFinished: skip duplicate enqueue token');
          return handlerInput.responseBuilder.getResponse();
        }

        const enq = buildPlayEnqueue(
          {
            file: nextFile,
            songpos: String(nextPos0),
            title: decodeHtmlEntities(snap.title || ''),
            artist: decodeHtmlEntities(snap.artist || ''),
            album: decodeHtmlEntities(snap.album || ''),
            albumArtUrl: absolutizeMaybe(snap.albumArtUrl || ''),
            altArtUrl: absolutizeMaybe(snap.altArtUrl || ''),
          },
          finishedToken
        );

        if (!enq) {
          console.log('NearlyFinished: could not build ENQUEUE directive');
          return handlerInput.responseBuilder.getResponse();
        }

        // After we ENQUEUE this track, immediately advance MPD head for that enqueued token
        // so /now-playing becomes the NEXT next.
        try {
          await advanceFromTokenIfNeeded(candidateToken);
          console.log('NearlyFinished: advanced MPD head for enqueued track pos0=', nextPos0);
        } catch (e) {
          console.log('NearlyFinished: advance after enqueue failed:', e && e.message ? e.message : String(e));
        }

        markEnqueuedToken(candidateToken, finishedToken);

        console.log('NearlyFinished: ENQUEUE next:', nextFile, 'pos0=', nextPos0);
        console.log('NearlyFinished: enqueue directive:', JSON.stringify(enq, null, 2));

        return handlerInput.responseBuilder
          .addDirective(enq)
          .getResponse();

      } catch (e) {
        console.log('NearlyFinished handler failed:', e && e.message ? e.message : String(e));
        return handlerInput.responseBuilder.getResponse();
      }
    }

    // 3) PlaybackFinished => do nothing if we already enqueued for this finished token
    if (eventType === 'AudioPlayer.PlaybackFinished') {
      try {
        console.log('AudioPlayer event:', eventType);

        if (enqueueAlreadyIssuedForPrevToken(token)) {
          console.log('PlaybackFinished: enqueue already issued; no action');
          return handlerInput.responseBuilder.getResponse();
        }

        // Fallback: if no enqueue happened, we can do a safe REPLACE_ALL from /now-playing.
        // (You can remove this fallback once you trust NearlyFinished always arrives.)
        console.log('PlaybackFinished: fallback continue (REPLACE_ALL)');
        const snap = await getStableNowPlayingSnapshot();
        if (!snap || !snap.file) return handlerInput.responseBuilder.getResponse();

        const directive = buildPlayReplaceAll(snap, 'Continuing playback');

        // And advance immediately so /now-playing stays "next"
        try {
          await advanceFromTokenIfNeeded(directive.audioItem.stream.token);
        } catch (e) {}

        return handlerInput.responseBuilder
          .addDirective(directive)
          .getResponse();

      } catch (e) {
        console.log('PlaybackFinished handler failed:', e && e.message ? e.message : String(e));
        return handlerInput.responseBuilder.getResponse();
      }
    }

    // Default: ignore
    return handlerInput.responseBuilder.getResponse();
  },
};

/* =========================
 * System.ExceptionEncountered
 * ========================= */

const SystemExceptionHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'System.ExceptionEncountered';
  },
  handle(handlerInput) {
    console.log('System.ExceptionEncountered');
    return handlerInput.responseBuilder.getResponse();
  },
};

/* =========================
 * Skill builder
 * ========================= */

const ErrorHandler = {
  canHandle() { return true; },
  handle(handlerInput, error) {
    console.log('ErrorHandler:', error && error.message ? error.message : String(error));
    return handlerInput.responseBuilder.getResponse();
  },
};

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestInterceptors(LogRequestInterceptor)
  .addRequestHandlers(
    LaunchRequestHandler,
    StopHandler,

    PlaybackControllerEventHandler,
    AudioPlayerEventHandler,

    SystemExceptionHandler
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();