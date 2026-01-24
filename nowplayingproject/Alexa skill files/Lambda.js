'use strict';

const Alexa = require('ask-sdk-core');
const https = require('https');
const { URL } = require('url');
const QUEUE_ADVANCE_PATH = process.env.QUEUE_ADVANCE_PATH || '/queue/advance';

console.log('*** BOOT ***', new Date().toISOString(), 'version=', process.env.AWS_LAMBDA_FUNCTION_VERSION);

// --------------------
// Env / Config
// --------------------
const MOODE_API_BASE = process.env.MOODE_API_BASE || 'https://moode.brianwis.com';

// Node API endpoints (no key)
const NOW_PLAYING_PATH = process.env.NOW_PLAYING_PATH || '/now-playing';

// Track endpoint (needs key in querystring)
const TRACK_PATH = process.env.TRACK_PATH || '/track';
const TRACK_KEY  = process.env.TRACK_KEY  || process.env.MOODE_API_KEY || '1029384756';

const TRACK_TOKEN_PREFIX = 'moode-track';

const META_STABLE_GAP_MS = Number(process.env.META_STABLE_GAP_MS || '250');
const NEXT_ENQUEUE_GAP_MS = Number(process.env.NEXT_ENQUEUE_GAP_MS || '5000');

let lastEnqueueAt = 0;
let lastEnqueuedToken = '';
let lastAdvancedToken = '';
let lastAdvancedAt = 0;
let lastKnownOffsetMs = 0;
let lastKnownToken = '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------
// URL + token helpers
// --------------------

function buildPlayDirectiveEnqueueNextFromNowPlaying(next, finishedToken) {
  next = next || {};

  var nextFile = String(next.file || '').trim();

  var songposRaw =
    (next.songpos !== undefined && next.songpos !== null)
      ? String(next.songpos).trim()
      : '';

  var nextPos0 =
    (songposRaw !== '' && isFinite(Number(songposRaw)))
      ? Number(songposRaw)
      : null;

  var expectedPreviousToken = String(finishedToken || '').trim();

  if (!nextFile) return null;
  if (!expectedPreviousToken) return null;
  if (nextPos0 === null) return null;

  var nextToken = makeToken({ file: nextFile, pos0: nextPos0 });
  var url = buildTrackUrlFromFile(nextFile, 0);

  // Prefer per-track public HTTPS coverart (unique per file).
  // Fall back to altArtUrl / aplArtUrl (current_320) / albumArtUrl.
  var publicCover = '';
  if (nextFile && nextFile.indexOf('://') < 0 && nextFile.toLowerCase() !== 'airplay active') {
    publicCover = MOODE_API_BASE + '/coverart.php/' + strictEncodeURIComponent(nextFile);
  }

  var artUrl =
    (publicCover) ? publicCover :
    (next.altArtUrl && String(next.altArtUrl).trim()) ? String(next.altArtUrl).trim() :
    (next.aplArtUrl && String(next.aplArtUrl).trim()) ? String(next.aplArtUrl).trim() :
    (next.albumArtUrl && String(next.albumArtUrl).trim()) ? String(next.albumArtUrl).trim() :
    '';

  // If we end up using the "current" image, add a lightweight cache-buster.
  if (artUrl && artUrl.indexOf('/art/current_320.jpg') >= 0) {
    var v = String((next.songid !== undefined && next.songid !== null) ? next.songid : nextPos0);
    artUrl += (artUrl.indexOf('?') >= 0 ? '&' : '?') + 'v=' + strictEncodeURIComponent(v);
  }

  var title = String(next.title || '').trim();
  var subtitle = '';
  if (next.artist) subtitle += String(next.artist);
  if (next.album) subtitle += (subtitle ? ' -- ' : '') + String(next.album);
  subtitle = subtitle.trim();

  var audioItem = {
    stream: {
      token: nextToken,
      url: url,
      offsetInMilliseconds: 0,

      // Some devices require this here even if top-level exists
      expectedPreviousToken: expectedPreviousToken
    }
  };

  if (artUrl || title || subtitle) {
    audioItem.metadata = {
      title: title || '',
      subtitle: subtitle || ''
    };
    if (artUrl) {
      audioItem.metadata.art = { sources: [{ url: artUrl }] };
    }
  }

  // Keep top-level too (covers the other interpretation)
  return {
    type: 'AudioPlayer.Play',
    playBehavior: 'ENQUEUE',
    audioItem: audioItem,
    expectedPreviousToken: expectedPreviousToken
  };
}

function queueAdvance(pos0, file) {
  mustHaveEnv();

  const p = Number(pos0);
  const qsPos0 = isFinite(p) ? `&pos0=${encodeURIComponent(String(p))}` : '';

  // optional file echo (helps mismatch checks)
  const qsFile = file ? `&file=${encodeURIComponent(String(file))}` : '';

  return httpsJson({
    method: 'POST',
    url: MOODE_API_BASE + QUEUE_ADVANCE_PATH + '?k=' + strictEncodeURIComponent(TRACK_KEY) + qsPos0 + qsFile,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: { pos0: p, file: file || '' },
    timeoutMs: 3500,
  });
}


function strictEncodeURIComponent(s) {
  return encodeURIComponent(String(s))
    .replace(/[!'()*]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
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
  return TRACK_TOKEN_PREFIX + ':' + base64UrlEncode(JSON.stringify(obj || {}));
}

function parseToken(token) {
  try {
    const t = String(token || '').trim();
    const prefix = TRACK_TOKEN_PREFIX + ':';
    if (t.indexOf(prefix) !== 0) return null;
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
  if (s.indexOf('https://') === 0) return s;
  if (s.indexOf('http://') === 0) return s;
  if (s.charAt(0) === '/') return MOODE_API_BASE + s;
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

// --------------------
// HTTPS JSON helper
// --------------------
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
          resolve({ raw: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 6000, () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

// --------------------
// Node API calls (no key)
// --------------------
function getNowPlaying() {
  mustHaveEnv();
  return httpsJson({
    method: 'GET',
    url: MOODE_API_BASE + NOW_PLAYING_PATH,
    headers: { Accept: 'application/json' },
    timeoutMs: 3500,
  });
}

// --------------------
// Alexa AudioPlayer helpers
// --------------------
function getCurrentTokenBestEffort(handlerInput) {
  const req = handlerInput.requestEnvelope.request || {};
  if (req && typeof req.token === 'string' && req.token.trim()) return req.token.trim();

  const ctx = handlerInput.requestEnvelope.context || {};
  const ap = ctx.AudioPlayer || {};
  if (ap && typeof ap.token === 'string' && ap.token.trim()) return ap.token.trim();

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

function buildMetadataFromNowPlaying(d, fallbackTitle) {
  // ✅ Best: per-track public HTTPS art URL via Caddy (unique per file)
  var file = String((d && d.file) ? d.file : '').trim();

  var publicCover = '';
  if (file && file.indexOf('://') < 0 && file.toLowerCase() !== 'airplay active') {
    publicCover = MOODE_API_BASE + '/coverart.php/' + strictEncodeURIComponent(file);
  }

  // Fallback order
  var artUrl =
    (publicCover) ? publicCover :
    (d && d.altArtUrl && String(d.altArtUrl).trim()) ? String(d.altArtUrl).trim() :
    (d && d.aplArtUrl && String(d.aplArtUrl).trim()) ? String(d.aplArtUrl).trim() :
    (d && d.albumArtUrl && String(d.albumArtUrl).trim()) ? String(d.albumArtUrl).trim() :
    '';

  // OPTIONAL: if we fall back to the "current" image, add a cache-buster
  if (artUrl && artUrl.indexOf('/art/current_320.jpg') >= 0) {
    var v = String((d && d.songid) ? d.songid : (d && d.songpos) ? d.songpos : Date.now());
    artUrl += (artUrl.indexOf('?') >= 0 ? '&' : '?') + 'v=' + strictEncodeURIComponent(v);
  }

  var title = String((d && d.title) ? d.title : (fallbackTitle || 'Now Playing'));

  var subtitle = '';
  if (d && d.artist) subtitle += String(d.artist);
  if (d && d.album) subtitle += (subtitle ? ' -- ' : '') + String(d.album);
  subtitle = subtitle || 'moOde';

  var meta = { title: title, subtitle: subtitle };

  if (artUrl) {
    meta.art = { sources: [{ url: artUrl }] };
    meta.backgroundImage = { sources: [{ url: artUrl }] };
  }

  return meta;
}

function buildPlayDirectiveReplaceAllFromNowPlaying(d, offsetMs) {
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

function buildPlayDirectiveEnqueueFromNowPlaying(next, expectedPreviousToken) {
  const prev = String(expectedPreviousToken || '').trim();
  if (!prev) return null;

  const nextFile = String((next && next.file) ? next.file : '').trim();
  if (!nextFile) return null;

  const pos0raw = (next && next.songpos !== undefined && next.songpos !== null)
    ? String(next.songpos).trim()
    : '';
  const pos0 = (pos0raw !== '' && isFinite(Number(pos0raw))) ? Number(pos0raw) : null;

  // This is important for future cleanup flows (webserver will use it)
  if (pos0 === null) {
    console.log('ENQUEUE: missing songpos; refusing to enqueue without pos0');
    return null;
  }

  const nextToken = makeToken({ file: nextFile, pos0 });

  const url = buildTrackUrlFromFile(nextFile, 0);
  if (!url) return null;

  return {
    type: 'AudioPlayer.Play',
    playBehavior: 'ENQUEUE',
    audioItem: {
      stream: {
        token: nextToken,
        url,
        offsetInMilliseconds: 0,
        expectedPreviousToken: prev,
      },
      metadata: buildMetadataFromNowPlaying(next, 'Next track'),
    },
  };
}

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

// --------------------
// Request logging interceptor
// --------------------
const LogRequestInterceptor = {
  process(handlerInput) {
    try {
      const req = handlerInput.requestEnvelope.request || {};
      console.log('INCOMING request.type:', req.type);
      if (req.type === 'IntentRequest') console.log('INCOMING intent:', req.intent && req.intent.name);
    } catch (e) {
      console.log('INCOMING log failed:', (e && e.message) ? e.message : String(e));
    }
  },
};

// --------------------
// Handlers
// --------------------
const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },

  async handle(handlerInput) {
    try {
      const d = await getStableNowPlaying();
      console.log('DEBUG now-playing payload:', JSON.stringify(d, null, 2));

      const play = buildPlayDirectiveReplaceAllFromNowPlaying(d, 0);
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
        return handlerInput.responseBuilder.speak('Nothing is queued.').withShouldEndSession(true).getResponse();
      }

      const speech =
        'Now playing ' +
        (d.title ? d.title : 'a track') +
        (d.artist ? ' by ' + d.artist : '') +
        '.';

      return handlerInput.responseBuilder.speak(speech).withShouldEndSession(true).getResponse();
    } catch (e) {
      console.error('NowPlayingIntent error:', e);
      return handlerInput.responseBuilder.speak('Sorry, I could not get that.').withShouldEndSession(true).getResponse();
    }
  },
};

const PauseIntentHandler = {
  canHandle(handlerInput) {
    const r = handlerInput.requestEnvelope.request;
    return r &&
      r.type === 'IntentRequest' &&
      r.intent &&
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
    return r &&
      r.type === 'IntentRequest' &&
      r.intent &&
      (r.intent.name === 'AMAZON.ResumeIntent' || r.intent.name === 'ResumeIntent' || r.intent.name === 'AMAZON.PlayIntent');
  },

  async handle(handlerInput) {
    try {
      if (!lastKnownToken) {
        // Fallback: if we don't have a stored token, do what you do today
        const d = await getStableNowPlaying();
        const play = buildPlayDirectiveReplaceAllFromNowPlaying(d, 0);
        if (!play) return handlerInput.responseBuilder.speak('Nothing to play.').withShouldEndSession(true).getResponse();

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
            url: url,
            offsetInMilliseconds: offsetMs
          }
        }
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
    return r &&
      r.type === 'IntentRequest' &&
      r.intent &&
      (r.intent.name === 'AMAZON.NextIntent' || r.intent.name === 'NextIntent' || r.intent.name === 'SkipIntent');
  },

  async handle(handlerInput) {
    // No MPD mutation in Lambda anymore; webserver.mjs will clean queue.
    try {
      const d = await getStableNowPlaying();
      console.log('NextIntent: now-playing payload:', JSON.stringify(d, null, 2));

      const play = buildPlayDirectiveReplaceAllFromNowPlaying(d, 0);
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
      return handlerInput.responseBuilder.speak('Sorry, I could not skip.').withShouldEndSession(true).getResponse();
    }
  },
};

const StopHandler = {
  canHandle(handlerInput) {
    const r = handlerInput.requestEnvelope.request;
    return r &&
      r.type === 'IntentRequest' &&
      r.intent &&
      (r.intent.name === 'AMAZON.StopIntent' || r.intent.name === 'AMAZON.CancelIntent');
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder
      .addDirective({ type: 'AudioPlayer.Stop' })
      .withShouldEndSession(true)
      .getResponse();
  },
};

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

      if (req.type === 'PlaybackController.PlayCommandIssued') {
        const d = await getStableNowPlaying();
        const play = buildPlayDirectiveReplaceAllFromNowPlaying(d, 0);
        if (!play) return handlerInput.responseBuilder.getResponse();
        console.log('Play directive:', JSON.stringify(play, null, 2));
        return handlerInput.responseBuilder.addDirective(play).getResponse();
      }

      if (req.type === 'PlaybackController.NextCommandIssued') {
        const d = await getStableNowPlaying();
        const play = buildPlayDirectiveReplaceAllFromNowPlaying(d, 0);
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

// Globals this handler expects (near your other globals):
// let lastEnqueueAt = 0;
// let lastEnqueuedToken = '';
// let lastAdvancedToken = '';
// let lastAdvancedAt = 0;
//
// And a helper implemented elsewhere:
// async function queueAdvance(pos0) { ... calls /queue/advance ... }

const AudioPlayerEventHandler = {
  canHandle(handlerInput) {
    const req = handlerInput.requestEnvelope && handlerInput.requestEnvelope.request;
    return !!(req && req.type && String(req.type).startsWith('AudioPlayer.'));
  },

  async handle(handlerInput) {
    const req = handlerInput.requestEnvelope.request || {};
    const eventType = req.type;

    console.log('AudioPlayer event:', eventType);
    if (
      eventType === 'AudioPlayer.PlaybackStopped' ||
      eventType === 'AudioPlayer.PlaybackPaused'
    ) {
      lastKnownToken = String(req.token || getCurrentTokenBestEffort(handlerInput) || '').trim();
      lastKnownOffsetMs = Number(req.offsetInMilliseconds || 0) || 0;

      console.log('Stored resume state:', {
        token: lastKnownToken.slice(0, 80),
        offsetMs: lastKnownOffsetMs
      });

      return handlerInput.responseBuilder.getResponse();
    }
    // -------------------------------------------------
    // PlaybackStarted: tell server.mjs to ADVANCE the MPD queue.
    //  - This is the trigger that "Alexa has begun" so MPD can move on.
    //  - Idempotent guard (token-based) to avoid double-advances.
    // -------------------------------------------------
    if (eventType === 'AudioPlayer.PlaybackStarted') {
      try {
        const startedToken = String(req.token || getCurrentTokenBestEffort(handlerInput) || '').trim();
        const startedOffsetMs = Number(req.offsetInMilliseconds || 0) || 0;

        console.log('PlaybackStarted: token prefix:', startedToken.slice(0, 120));

        if (!startedToken) {
          console.log('PlaybackStarted: empty token; skipping advance');
          return handlerInput.responseBuilder.getResponse();
        }

        // 🔒 Resume guard: same token + non-zero offset → DO NOT advance MPD
        if (startedToken === lastKnownToken && startedOffsetMs > 0) {
          console.log('PlaybackStarted: resume detected; skipping queue advance', {
            startedOffsetMs,
            lastKnownOffsetMs
          });
          return handlerInput.responseBuilder.getResponse();
        }

        // Dedup: Alexa sometimes sends duplicate PlaybackStarted
        const now = Date.now();
        if (startedToken === lastAdvancedToken && (now - lastAdvancedAt) < 15000) {
          console.log('PlaybackStarted: skip duplicate advance for same token');
          return handlerInput.responseBuilder.getResponse();
        }

        const parsed = parseToken(startedToken) || {};
        const pos0 =
          (parsed.pos0 !== undefined && parsed.pos0 !== null && isFinite(Number(parsed.pos0)))
            ? Number(parsed.pos0)
            : null;

        console.log('PlaybackStarted: token parsed:', JSON.stringify(parsed, null, 2));

        if (pos0 === null) {
          console.log('PlaybackStarted: missing pos0 in token; cannot advance queue');
          return handlerInput.responseBuilder.getResponse();
        }

        await queueAdvance(pos0, parsed.file);
        lastAdvancedToken = startedToken;
        lastAdvancedAt = now;

        console.log('PlaybackStarted: queue advanced pos0=', pos0);
        console.log('PlaybackStarted: offsetInMilliseconds=', Number(req.offsetInMilliseconds || 0) || 0);
        return handlerInput.responseBuilder.getResponse();

      } catch (e1) {
        console.error(
          'PlaybackStarted handler failed:',
          (e1 && e1.message) ? e1.message : String(e1)
        );
        return handlerInput.responseBuilder.getResponse();
      }
    }

    // -------------------------------------------------
    // PlaybackStopped / PlaybackPaused / PlaybackFailed: store resume state
    // -------------------------------------------------
    if (
      eventType === 'AudioPlayer.PlaybackStopped' ||
      eventType === 'AudioPlayer.PlaybackPaused' ||
      eventType === 'AudioPlayer.PlaybackFailed'
    ) {
      lastKnownToken = String(req.token || getCurrentTokenBestEffort(handlerInput) || '').trim();
      lastKnownOffsetMs = Number(req.offsetInMilliseconds || 0) || 0;

      console.log('Stored resume state:', {
        token: lastKnownToken.slice(0, 80),
        offsetMs: lastKnownOffsetMs
      });

      return handlerInput.responseBuilder.getResponse();
    }

    // -------------------------------------------------
    // PlaybackNearlyFinished: ENQUEUE next ONLY.
    // server.mjs is the queue authority and keeps /now-playing correct.
    // -------------------------------------------------
    if (eventType === 'AudioPlayer.PlaybackNearlyFinished') {
      try {
        const finishedToken = String(req.token || getCurrentTokenBestEffort(handlerInput) || '').trim();

        if (!finishedToken) {
          console.log('NearlyFinished: missing finishedToken; cannot ENQUEUE');
          return handlerInput.responseBuilder.getResponse();
        }

        console.log('NearlyFinished: token prefix:', finishedToken.slice(0, 120));

        const next = await getStableNowPlaying();
        console.log('NearlyFinished: now-playing snapshot:', JSON.stringify(next, null, 2));

        const nextFile = (next && next.file) ? String(next.file).trim() : '';
        const nextPos0raw = (next && next.songpos !== undefined && next.songpos !== null) ? String(next.songpos).trim() : '';
        const nextPos0 = (nextPos0raw !== '' && isFinite(Number(nextPos0raw))) ? Number(nextPos0raw) : null;

        if (!nextFile) {
          console.log('NearlyFinished: empty now-playing.file; skipping enqueue');
          return handlerInput.responseBuilder.getResponse();
        }

        if (nextPos0 === null) {
          console.log('NearlyFinished: missing now-playing.songpos; refusing to enqueue without pos0');
          return handlerInput.responseBuilder.getResponse();
        }

        const parsedFinished = parseToken(finishedToken) || {};
        const finishedFile = parsedFinished.file ? String(parsedFinished.file).trim() : '';
        if (finishedFile && nextFile === finishedFile) {
          console.log('NearlyFinished: /now-playing still equals finished file; skipping enqueue this event');
          return handlerInput.responseBuilder.getResponse();
        }

        const candidateToken = makeToken({ file: nextFile, pos0: nextPos0 });

        const now = Date.now();
        if (candidateToken === lastEnqueuedToken && (now - lastEnqueueAt) < NEXT_ENQUEUE_GAP_MS) {
          console.log('NearlyFinished: skip duplicate enqueue token');
          return handlerInput.responseBuilder.getResponse();
        }

        const enq = buildPlayDirectiveEnqueueNextFromNowPlaying(next, finishedToken);
        if (!enq) {
          console.log('NearlyFinished: could not build ENQUEUE directive');
          console.log('NearlyFinished: debug finishedTokenLen=', String(finishedToken || '').length);
          console.log('NearlyFinished: debug next.file=', nextFile);
          console.log('NearlyFinished: debug next.songpos=', nextPos0raw);
          console.log('NearlyFinished: debug trackUrl=', buildTrackUrlFromFile(nextFile, 0));
          return handlerInput.responseBuilder.getResponse();
        }

        lastEnqueuedToken = candidateToken;
        lastEnqueueAt = now;

        console.log('NearlyFinished: ENQUEUE next:', nextFile, 'pos0=', nextPos0);
        console.log('NearlyFinished: enqueue directive:', JSON.stringify(enq, null, 2));

        return handlerInput.responseBuilder
          .addDirective(enq)
          .getResponse();

      } catch (e2) {
        console.error('NearlyFinished handler failed:', (e2 && e2.message) ? e2.message : String(e2));
        return handlerInput.responseBuilder.getResponse();
      }
    }

    // -------------------------------------------------
    // PlaybackFinished: no action (next should already be enqueued)
    // -------------------------------------------------
    if (eventType === 'AudioPlayer.PlaybackFinished') {
      console.log('PlaybackFinished: no action (next should already be enqueued)');
      return handlerInput.responseBuilder.getResponse();
    }

    // Optional: log other AudioPlayer events without acting
    if (eventType === 'AudioPlayer.PlaybackResumed') {
      console.log('AudioPlayer event (no action):', eventType);
      return handlerInput.responseBuilder.getResponse();
    }

    return handlerInput.responseBuilder.getResponse();
  }
};

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

// --------------------
// Skill builder
// --------------------
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