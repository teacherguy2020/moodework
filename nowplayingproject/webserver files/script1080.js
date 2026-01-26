/* =========================
 * Debug
 * ========================= */

const DEBUG = false;
const dlog = DEBUG ? console.log.bind(console) : () => {};

/* =========================
 * URL routing (LAN vs Public)
 * =========================
 *
 * Rules:
 * - When UI is served from https://moode.YOURDOMAINNAME.com:


 *
 * - When UI is served on LAN (e.g. http://YOURSERVERIP:8000):
 *     • Use direct LAN endpoints for lowest latency
 */

const HOST = location.hostname.replace(/^www\./, '');
const IS_PUBLIC = (HOST === 'moode.YOURDOMAINNAME.com');

// API (JSON + generated art)
const API_BASE = IS_PUBLIC
  ? 'https://moode.YOURDOMAINNAME.com'
  : 'http://YOURSERVERIP:3000';

// Static assets (HTML / JS / CSS / icons)
const STATIC_BASE = IS_PUBLIC
  ? 'https://moode.YOURDOMAINNAME.com'
  : 'http://YOURSERVERIP:8000';

// API endpoints
const NOW_PLAYING_URL = `${API_BASE}/now-playing`;
const NEXT_UP_URL     = `${API_BASE}/next-up`;
const RATING_URL      = `${API_BASE}/rating/current`;

// Static icons
const AIRPLAY_ICON_URL = `${STATIC_BASE}/airplay.png?v=3`;
const UPNP_ICON_URL    = `${STATIC_BASE}/upnp.png?v=1`;

// moOde player (LAN-only; used for pause-cover fallback image)
const MOODE_BASE_URL = 'http://10.0.0.254';

/* =========================
 * Feature toggles
 * ========================= */

const ENABLE_NEXT_UP = true;
const ENABLE_BACKGROUND_ART = true; // set false to disable background updates entirely

/* =========================
 * Timers / refresh intervals
 * ========================= */

const NOW_PLAYING_POLL_MS  = 1000;
const NEXT_UP_REFRESH_MS   = 5000;  // refresh Next Up every 5s
const RATING_REFRESH_MS    = 1000;

/* =========================
 * State: Next Up / art / bg
 * ========================= */

let lastNextUpKey = '';
let lastNextUpFetchTs = 0;

let lastAlbumArtKey = '';
let lastAlbumArtUrl = '';

let bgKeyFront = '';
let bgLoadingKey = '';

// Background crossfade state
let bgFront = 'a';     // 'a' or 'b'
let bgUrlFront = '';   // currently shown URL
let bgLoadingUrl = ''; // URL currently being loaded (race guard)

/* =========================
 * State: track / progress / favorites
 * ========================= */

let currentTrackKey = '';
let lastPercent = -1;
let currentIsFavorite = false;

// Progress animator (smooth between polls)
let progressAnimRaf = 0;
let progressAnim = {
  t0: 0,
  baseElapsed: 0,
  duration: 0,
  running: false,
};

/* =========================
 * Stream mode helpers
 * ========================= */

function getStreamKind(data) {
  return String(data?.streamKind || '').trim().toLowerCase();
}

function isUpnpMode(data) {
  return (data?.isStream === true) &&
         (data?.isUpnp === true || getStreamKind(data) === 'upnp');
}

function isRadioMode(data) {
  return (data?.isStream === true) && !isUpnpMode(data);
}

/* =========================
 * Ratings (MPD stickers via server)
 * ========================= */

const RATINGS_ENABLED = true;
const RATINGS_BASE_URL = API_BASE;

let currentRating = 0;
let ratingDisabled = true;
let lastRatingFile = '';
let lastRatingFetchTs = 0;

// Rating request guard + current mode flags
let ratingReqToken = 0;
let currentIsStream = false;
let currentIsAirplay = false;

/* =========================
 * Pause "screensaver"
 * ========================= */

const ENABLE_PAUSE_SCREENSAVER = true;
const PAUSE_ART_URL = `${MOODE_BASE_URL}/images/default-album-cover.png`;
const PAUSE_MOVE_INTERVAL_MS = 8000;
const PAUSE_ART_MIN_MARGIN_PX = 20;
const PAUSE_SCREENSAVER_DELAY_MS = 5000;

let pauseOrStopSinceTs = 0;
let pauseMode = false;
let lastPauseMoveTs = 0;
let justResumedFromPause = false;

/* =========================
 * Polling control
 * ========================= */

let nowPlayingTimer = 0;

function startNowPlayingPoll() {
  if (nowPlayingTimer) return;
  nowPlayingTimer = setInterval(fetchNowPlaying, NOW_PLAYING_POLL_MS);
}

function stopNowPlayingPoll() {
  if (!nowPlayingTimer) return;
  clearInterval(nowPlayingTimer);
  nowPlayingTimer = 0;
}

/* =========================
 * Radio memory (keyed by station/stream)
 * ========================= */

const radioState = {
  key: '',
  recentTitles: [],
};

/* =========================
 * Boot
 * ========================= */

function applyBackgroundToggleClass() {
  if (!ENABLE_BACKGROUND_ART) document.body.classList.add('no-bg');
  else document.body.classList.remove('no-bg');
}

window.addEventListener('load', () => {
  applyBackgroundToggleClass();
  attachClickEventToAlbumArt();
  bindFavoriteUIOnce();
  attachRatingsClickHandler();
  bootThenStart();
});


/* =========================
 * Boot gating
 * ========================= */

async function bootThenStart() {
  const data = await fetch(NOW_PLAYING_URL, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);

  // Fail-safe: show UI + start polling anyway
  if (!data) {
    markReadyOnce();
    fetchNowPlaying();     // kick once
    startNowPlayingPoll(); // then steady poll
    return;
  }

  const firstArtUrl =
    (data.altArtUrl && String(data.altArtUrl).trim())
      ? String(data.altArtUrl).trim()
      : (data.albumArtUrl || '');

  // If bg disabled or no art, don't wait
  if (!ENABLE_BACKGROUND_ART || !firstArtUrl) {
    updateUI(data);
    if (!data.isStream && !data.isAirplay) loadCurrentRating();
    else clearStars();
    markReadyOnce();
    startNowPlayingPoll();
    return;
  }

  // Preload first background image
  await preloadImage(firstArtUrl);

  // Snap first bg in place WITHOUT fading (prevents black flash)
  const a = document.getElementById('background-a');
  const b = document.getElementById('background-b');
  if (a && b) {
    const aPrevTrans = a.style.transition;
    const bPrevTrans = b.style.transition;

    a.style.transition = 'none';
    b.style.transition = 'none';

    a.style.backgroundImage = `url("${firstArtUrl}")`;
    b.style.backgroundImage = 'none';

    a.style.opacity = '1';
    b.style.opacity = '0';

    bgFront = 'a';
    bgUrlFront = firstArtUrl;
    bgLoadingUrl = '';

    requestAnimationFrame(() => {
      a.style.transition = aPrevTrans || '';
      b.style.transition = bPrevTrans || '';
    });
  }

  // Album-art glow background (cheap)
  const artBgEl = document.getElementById('album-art-bg');
  if (artBgEl) {
    artBgEl.style.backgroundImage = `url("${firstArtUrl}")`;
    artBgEl.style.backgroundSize = 'cover';
    artBgEl.style.backgroundPosition = 'center';
  }

  updateUI(data);
  markReadyOnce();
  startNowPlayingPoll();
}

function preloadImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

function markReadyOnce() {
  const body = document.body;
  if (!body || body.classList.contains('ready')) return;
  body.classList.remove('booting');
  body.classList.add('ready');
}

/* =========================
 * Background crossfade
 * ========================= */

function setBackgroundCrossfade(url) {
  const a = document.getElementById('background-a');
  const b = document.getElementById('background-b');
  if (!a || !b) return;

  const nextUrl = String(url || '').trim();
  const nextKey = normalizeArtKey(nextUrl);

  if (!nextKey) {
    a.style.backgroundImage = 'none';
    b.style.backgroundImage = 'none';
    a.style.opacity = '1';
    b.style.opacity = '0';
    bgFront = 'a';
    bgUrlFront = '';
    bgKeyFront = '';
    bgLoadingUrl = '';
    bgLoadingKey = '';
    return;
  }

  // ✅ compare by key, not raw URL
  if (nextKey === bgKeyFront) return;
  if (nextKey === bgLoadingKey) return;

  bgLoadingUrl = nextUrl;
  bgLoadingKey = nextKey;

  const img = new Image();
  img.onload = () => {
    if (bgLoadingKey !== nextKey) return;

    const frontEl = (bgFront === 'a') ? a : b;
    const backEl  = (bgFront === 'a') ? b : a;

    backEl.style.backgroundImage = `url("${nextUrl}")`;
    frontEl.style.opacity = '1';
    backEl.style.opacity = '0';

    requestAnimationFrame(() => {
      backEl.style.opacity = '1';
      frontEl.style.opacity = '0';

      bgFront = (bgFront === 'a') ? 'b' : 'a';
      bgUrlFront = nextUrl;
      bgKeyFront = nextKey;
      bgLoadingUrl = '';
      bgLoadingKey = '';
    });
  };

  img.onerror = () => {
    if (bgLoadingKey === nextKey) {
      bgLoadingUrl = '';
      bgLoadingKey = '';
    }
  };

  img.src = nextUrl;
}

function renderStars(rating) {
  const el = document.getElementById('ratingStars');
  if (!el) return;

  if (!RATINGS_ENABLED || ratingDisabled) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  el.style.display = 'inline-block';
  el.innerHTML = '';

  const r = Math.max(0, Math.min(5, Number(rating) || 0));
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('span');
    s.textContent = '★';
    s.dataset.value = String(i);

    // ✅ add filled vs dim class
    s.className = (i <= r) ? 'filled' : 'dim';

    el.appendChild(s);
  }
}

function clearStars() {
  currentRating = 0;
  ratingDisabled = true;
  lastRatingFile = '';
  renderStars(0);
}

let lastRatingKey = '';

async function loadCurrentRating() {
  const ratingEl = document.getElementById('ratingStars');
  if (!ratingEl) return;

  // 🚫 ratings never apply to radio or AirPlay
  if (currentIsStream || currentIsAirplay) {
    clearStars();
    return;
  }

  // token to invalidate stale responses
  const myToken = ++ratingReqToken;

  try {
    const r = await fetch(RATING_URL, { cache: 'no-store' });
    const j = await r.json();

    // ⛔ stale response -- another request started after this one
    if (myToken !== ratingReqToken) return;

    // ⛔ mode changed while request was in-flight
    if (currentIsStream || currentIsAirplay) {
      clearStars();
      return;
    }

    if (!j || j.ok !== true || j.disabled) {
      clearStars();
      return;
    }

    const file = String(j.file || '').trim();
    const rating = Math.max(0, Math.min(5, Number(j.rating) || 0));

    ratingDisabled = false;
    lastRatingFile = file;
    currentRating = rating;

    renderStars(rating);
  } catch {
    clearStars();
  }
}

async function setCurrentRating(n) {
  if (!RATINGS_ENABLED) return;

  const r = Math.max(0, Math.min(5, Number(n) || 0));

  try {
    const resp = await fetch(`${RATINGS_BASE_URL}/rating/current`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: r }),
    });

    const j = await resp.json();

    ratingDisabled = !!j.disabled || !j.file;
    lastRatingFile = String(j.file || '');
    currentRating = Number(j.rating) || 0;

    renderStars(currentRating);
  } catch {
    // no-op
  }
}

function attachRatingsClickHandler() {
  if (!RATINGS_ENABLED) return;

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.dataset || !t.dataset.value) return;

    // only react if user clicked inside ratingStars
    const wrap = document.getElementById('ratingStars');
    if (!wrap || ratingDisabled) return;
    if (!wrap.contains(t)) return;

    const n = parseInt(t.dataset.value, 10);
    if (!Number.isFinite(n)) return;

    // click same star again -> toggle off (0)
    setCurrentRating(n === currentRating ? 0 : n);
  });
}


/* =========================
 * Poller
 * ========================= */

function fetchNowPlaying() {
  fetch(NOW_PLAYING_URL, { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error(`now-playing HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      if (!data) return;

      const isAirplay = data.isAirplay === true;
      const isStream  = data.isStream === true;

      const isUpnp  = isStream && ((data.isUpnp === true) || (String(data.streamKind || '') === 'upnp'));
      const isRadio = isStream && !isUpnp;

      if (ENABLE_NEXT_UP && (pauseMode || isAirplay || isStream)) {
        clearNextUpUI();
      }
            // Track key (used for change detection)
      let baseKey = '';
      if (isAirplay) {
        baseKey = `airplay|${data.artist || ''}|${data.title || ''}|${data.album || ''}|${data.altArtUrl || ''}`;
      } else if (isStream) {
        baseKey = `${data.file}|${data.album || ''}`;
      } else {
        baseKey = data.file || `${data.artist}|${data.album}|${data.title}`;
      }

      const trackChanged = justResumedFromPause || baseKey !== currentTrackKey;

      // Update bottom-right logo EVERY poll
      setModeLogo({ isAirplay, isUpnp });

      /* =========================
       * Pause / screensaver logic
       * ========================= */

      const pauseOrStop = isPauseOrStopState(data);
      const screensaverEligible = !isAirplay;

      if (pauseOrStop && screensaverEligible) {
        if (!pauseOrStopSinceTs) pauseOrStopSinceTs = Date.now();

        const elapsed = Date.now() - pauseOrStopSinceTs;
        const delayMs = Number(PAUSE_SCREENSAVER_DELAY_MS) || 0;

        if (ENABLE_PAUSE_SCREENSAVER && elapsed >= delayMs) {
          if (!pauseMode) {
            setPausedScreensaver(true);
            // IMPORTANT: keep polling so we can detect when playback resumes
            // stopNowPlayingPoll();
          }

          setProgressVisibility(true); // hide progress bar
          hideModeLogo();
          movePauseArtRandomly(false);
          stopProgressAnimator();
          return; // stay in screensaver
        }
      } else {
        pauseOrStopSinceTs = 0;

        if (pauseMode) {
          setPausedScreensaver(false);

          // ✅ Force a repaint right now with the current payload
          updateUI(data);

          justResumedFromPause = true;
          stopProgressAnimator(); // hard reset on resume
        }
      }

      /* =========================
       * Progress bar control
       * ========================= */

      // Radio + AirPlay: never animate
      setProgressVisibility(isStream || isAirplay);
      if (isStream || isAirplay) stopProgressAnimator();
      // ✅ Favorites: refresh every poll (like ratings)
      if (!isStream && !isAirplay) {
        if (currentIsFavorite !== data.isFavorite) {
          currentIsFavorite = data.isFavorite === true;
          setFavoriteHeart(currentIsFavorite);
        }
      }

      // Local files only
      if (!isStream && !isAirplay) {
        let el  = Number(data.elapsed);
        let dur = Number(data.duration);

        // ✅ normalize units (sometimes duration/elapsed can come through in ms)
        // Heuristic: if value is huge, treat it as milliseconds.
        if (Number.isFinite(dur) && dur > 0 && dur > 24 * 60 * 60) dur = dur / 1000;
        if (Number.isFinite(el)  && el  > 0 && el  > 24 * 60 * 60) el  = el  / 1000;

        if (Number.isFinite(el) && Number.isFinite(dur) && dur > 0) {
          if (trackChanged || !progressAnim.running) {
            startProgressAnimator(el, dur);
          } else {
            const now = performance.now();
            const expected =
              progressAnim.baseElapsed + (now - progressAnim.t0) / 1000;

            if (el > expected - 0.25) {
              progressAnim.baseElapsed = el;
              progressAnim.t0 = now;
            }
          }
        } else {
          stopProgressAnimator();
          updateProgressBarPercent(0);
        }
      }

      /* =========================
       * Track-change driven UI
       * ========================= */

      // Local files + AirPlay path
      if (!isStream) {
        if (trackChanged) {
          currentTrackKey = baseKey;
          updateUI(data);

          // ✅ Ratings: only for local files (not AirPlay)
          if (!isAirplay) loadCurrentRating();
          else clearStars();
        }

        // ✅ Ratings: refresh periodically during playback (so Shortcut changes show live)
        if (!pauseMode && !isAirplay && RATINGS_ENABLED) {
          const now = Date.now();
          if ((now - (lastRatingFetchTs || 0)) >= RATING_REFRESH_MS) {
            lastRatingFetchTs = now;
            loadCurrentRating();
          }
        }

        // Next Up: refresh on change OR periodic
        if (ENABLE_NEXT_UP && !pauseMode && !isAirplay && !isStream) {
          const now = Date.now();
          const due = (now - (lastNextUpFetchTs || 0)) >= NEXT_UP_REFRESH_MS;

          if (trackChanged || due) {
            lastNextUpFetchTs = now;
            updateNextUp({ isAirplay, isStream });
          }
        }

        justResumedFromPause = false;
        return;
      }

      // Radio streams
      const stabilized = stabilizeRadioDisplay(data);
      const radioKey = `${baseKey}|${stabilized.artist}|${stabilized.title}`;

      if (justResumedFromPause || radioKey !== currentTrackKey) {
        currentTrackKey = radioKey;
        updateUI({ ...data, _radioDisplay: stabilized });
      }

      justResumedFromPause = false;
    })
    .catch(() => {});
}

/* =========================
 * Mode logo
 * ========================= */

function setModeLogo({ isAirplay = false, isUpnp = false }) {
  const logoEl = document.getElementById('mode-logo');
  if (!logoEl) return;

  let url = '';

  if (isAirplay === true) {
    url = AIRPLAY_ICON_URL;
  } else if (isUpnp === true) {
    url = UPNP_ICON_URL;
  }

  // Nothing to show → fully clear
  if (!url) {
    if (logoEl.style.display !== 'none') {
      logoEl.style.display = 'none';
      logoEl.removeAttribute('src');
    }
    return;
  }

  // Only update src if it actually changed (prevents reload/flicker)
  if (logoEl.getAttribute('src') !== url) {
    logoEl.src = url;
  }

  logoEl.style.display = 'block';
}

function hideModeLogo() {
  const logoEl = document.getElementById('mode-logo');
  if (!logoEl) return;
  logoEl.style.display = 'none';
  logoEl.removeAttribute('src');
}

/* =========================
 * Progress animator
 * ========================= */

function stopProgressAnimator() {
  progressAnim.running = false;
  if (progressAnimRaf) cancelAnimationFrame(progressAnimRaf);
  progressAnimRaf = 0;
}

function startProgressAnimator(baseElapsed, duration) {
  if (!Number.isFinite(baseElapsed) || !Number.isFinite(duration) || duration <= 0) {
    stopProgressAnimator();
    return;
  }

  progressAnim.t0 = performance.now();
  progressAnim.baseElapsed = baseElapsed;
  progressAnim.duration = duration;
  progressAnim.running = true;

  const tick = () => {
    if (!progressAnim.running) return;

    const now = performance.now();
    const elapsedNow = progressAnim.baseElapsed + (now - progressAnim.t0) / 1000;

    const pct = (elapsedNow / progressAnim.duration) * 100;
    updateProgressBarPercent(pct);

    if (elapsedNow >= progressAnim.duration) {
      updateProgressBarPercent(100);
      stopProgressAnimator();
      return;
    }

    progressAnimRaf = requestAnimationFrame(tick);
  };

  progressAnimRaf = requestAnimationFrame(tick);
}

function updateProgressBarPercent(percent) {
  const progressFill = document.getElementById('progress-fill');
  if (!progressFill) return;

  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  lastPercent = clamped;

  progressFill.style.transform = `scaleX(${clamped / 100})`;
}

function setProgressVisibility(hide) {
  const wrapper = document.getElementById('progress-bar-wrapper');
  if (!wrapper) return;
  wrapper.style.display = hide ? 'none' : 'block';
}

/* =========================
 * Next Up (text + thumbnail)
 * ========================= */

function updateNextUp({ isAirplay, isStream }) {
  const wrap   = document.getElementById('next-up');
  const textEl = document.getElementById('next-up-text');
  const imgEl  = document.getElementById('next-up-img');

  // allow text even if image element is missing
  if (!wrap || !textEl) return;

  if (pauseMode || isAirplay || isStream) {
    textEl.textContent = '';
    if (imgEl) {
      imgEl.style.display = 'none';
      imgEl.removeAttribute('src');
      imgEl.dataset.lastUrl = '';
    }
    lastNextUpKey = '';
    return;
  }

  dlog('NextUp fetch ->', NEXT_UP_URL);
  fetch(NEXT_UP_URL, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(x => {
      dlog('NextUp response <-', x);

      if (!x || x.ok !== true || !x.next) {
        textEl.textContent = '';
        if (imgEl) {
          imgEl.style.display = 'none';
          imgEl.removeAttribute('src');
          imgEl.dataset.lastUrl = '';
        }
        lastNextUpKey = '';
        return;
      }

      const next   = x.next;
      const title  = String(next.title || '').trim();
      const file   = String(next.file || '').trim();
      const artist = String(next.artist || '').trim();

      // API may return "/art/current_320.jpg" (relative). That must be resolved against API_BASE,
      // NOT the page origin (STATIC_BASE / port 8000).
      const artUrlRaw = String(next.artUrl || '').trim();
      const artUrl = artUrlRaw.startsWith('/')
        ? `${API_BASE}${artUrlRaw}`
        : artUrlRaw;

      if (!title && !file) {
        textEl.textContent = '';
        if (imgEl) {
          imgEl.style.display = 'none';
          imgEl.removeAttribute('src');
          imgEl.dataset.lastUrl = '';
        }
        lastNextUpKey = '';
        return;
      }

      const key = `${next.songid || ''}|${artist}|${title}|${file}|${artUrl}`;
      const same = (key === lastNextUpKey);
      lastNextUpKey = key;

      const showTitle  = title || file.split('/').pop() || file;
      const showArtist = artist ? ` • ${artist}` : '';
      textEl.textContent = `Next up: ${showTitle}${showArtist}`;

      wrap.style.display = 'flex';
      wrap.style.visibility = 'visible';
      wrap.style.opacity = '1';

      dlog('NextUp painted:', { sameKey: same, artUrl });

      // image optional
      if (!imgEl || !artUrl) {
        if (imgEl) {
          imgEl.style.display = 'none';
          imgEl.removeAttribute('src');
          imgEl.dataset.lastUrl = '';
        }
        return;
      }

      // prevent flashing: only update <img> if URL changed
      const lastUrl = imgEl.dataset.lastUrl || '';
      if (artUrl !== lastUrl) {
        imgEl.dataset.lastUrl = artUrl;
        imgEl.src = artUrl;
      }

      imgEl.style.display = 'block';
    })
    .catch(() => {});
}

function clearNextUpUI() {
  const wrap = document.getElementById('next-up');
  const textEl = document.getElementById('next-up-text');
  const imgEl = document.getElementById('next-up-img');

  if (textEl) textEl.textContent = '';
  if (imgEl) {
    imgEl.style.display = 'none';
    imgEl.removeAttribute('src');
    imgEl.dataset.lastUrl = '';
  }
  if (wrap) {
    // optional: hide the whole row so it doesn’t occupy/overlay anything
    wrap.style.display = 'none';
  }

  lastNextUpKey = '';
}

/* =========================
 * Pause screensaver
 * ========================= */

function isPauseOrStopState(data) {
  const state = String(data.state || '').toLowerCase();
  return (state === 'pause' || state === 'paused' || state === 'stop' || state === 'stopped' || state === 'idle');
}

function setPausedScreensaver(on) {
  pauseMode = on;
  if (on) clearStars(); // ✅ entering pause screensaver: hide/clear stars

  document.body.style.backgroundColor = on ? '#000' : '';
  document.documentElement.style.backgroundColor = on ? '#000' : '';

  const artistEl = document.getElementById('artist-name');
  const trackEl  = document.getElementById('track-title');
  const ratingEl = document.getElementById('ratingStars');
  const albumEl  = document.getElementById('album-link');
  const fileInfoText = document.getElementById('file-info-text');
  const hiresBadge = document.getElementById('hires-badge');
  const personnelEl = document.getElementById('personnel-info');
  const nextUpEl = document.getElementById('next-up');

  const show = !on;
  if (artistEl) artistEl.style.display = show ? '' : 'none';
  if (trackEl)  trackEl.style.display  = show ? '' : 'none';
  if (ratingEl) ratingEl.style.display = show ? '' : 'none';
  if (albumEl)  albumEl.style.display  = show ? '' : 'none';
  if (fileInfoText) fileInfoText.style.display = show ? '' : 'none';
  if (hiresBadge) hiresBadge.style.display = show ? '' : 'none';
  if (personnelEl) personnelEl.style.display = show ? '' : 'none';
  if (nextUpEl) nextUpEl.style.display = show ? '' : 'none';

  const artEl = document.getElementById('album-art');
  if (artEl) {
    if (on) {
      artEl.src = PAUSE_ART_URL;
      lastAlbumArtUrl = '';

      artEl.style.position = 'fixed';
      artEl.style.maxWidth = '40vw';
      artEl.style.maxHeight = '40vh';
      artEl.style.width = 'auto';
      artEl.style.height = 'auto';
      movePauseArtRandomly(true);
      artEl.style.opacity = '0.35';
    } else {
      artEl.style.position = '';
      artEl.style.left = '';
      artEl.style.top = '';
      artEl.style.transform = '';
      artEl.style.maxWidth = '';
      artEl.style.maxHeight = '';
      artEl.style.width = '';
      artEl.style.height = '';
      artEl.style.opacity = '';
      
      // ✅ Coming out of pause: force artwork to repaint even if track didn't change
      lastAlbumArtKey = '';
      lastAlbumArtUrl = '';
    }
  }

  const artBgEl = document.getElementById('album-art-bg');
  setBackgroundCrossfade('');
  if (artBgEl) artBgEl.style.backgroundImage = 'none';
}

function movePauseArtRandomly(force = false) {
  if (!pauseMode) return;

  const now = Date.now();
  if (!force && (now - lastPauseMoveTs) < PAUSE_MOVE_INTERVAL_MS) return;
  lastPauseMoveTs = now;

  const artEl = document.getElementById('album-art');
  if (!artEl) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const rect = artEl.getBoundingClientRect();
  const w = rect.width || Math.min(400, vw * 0.4);
  const h = rect.height || Math.min(400, vh * 0.4);

  const minX = PAUSE_ART_MIN_MARGIN_PX;
  const minY = PAUSE_ART_MIN_MARGIN_PX;
  const maxX = Math.max(minX, vw - w - PAUSE_ART_MIN_MARGIN_PX);
  const maxY = Math.max(minY, vh - h - PAUSE_ART_MIN_MARGIN_PX);

  const x = minX + Math.random() * (maxX - minX);
  const y = minY + Math.random() * (maxY - minY);

  artEl.style.left = `${x}px`;
  artEl.style.top = `${y}px`;
  artEl.style.transform = 'none';
}

/* =========================
 * Text helpers (radio/classical/abbrevs)
 * ========================= */
 
function normalizeArtKey(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  // ignore cache-busters and fragments so equality is stable
  return s.split('#')[0].split('?')[0];
}
 

function normalizeDashSpacing(s) {
  return String(s || '')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

function parseKbps(bitrateStr) {
  const s = String(bitrateStr || '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*kbps/i);
  return m ? parseFloat(m[1]) : 0;
}

function getBadgeInfo(data) {
  const encoded = String(data.encoded || '').trim();
  const outrate = String(data.outrate || '').trim();
  const kbps = parseKbps(data.bitrate);

  const trulyLossless =
    /FLAC|ALAC|WAV|AIFF/i.test(encoded) ||
    (!encoded && /PCM/i.test(outrate));

  if (trulyLossless) return { show: true, text: 'Lossless' };

  if (data.isStream) {
    const isMp3Aac = /(MP3|AAC)/i.test(encoded);
    const isOpus = /OPUS/i.test(encoded);
    const isHq = (isMp3Aac && kbps >= 256) || (isOpus && kbps >= 128);
    if (isHq) return { show: true, text: 'HQ' };
  }

  return { show: false, text: '' };
}

function splitArtistDashTitle(s) {
  const t = String(s || '').trim();
  const parts = t.split(' - ');
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return null;
}

function looksLikeComposerWork(s) {
  const t = String(s || '').toLowerCase();
  if (/sinfonie|symphon(y|ie)|concerto|sonat(e|a)|quartett|quintett|opus|op\.\s*\d|hob\./i.test(s)) return true;
  if (t.includes(' - ') && t.split(' - ')[0].trim().split(/\s+/).length >= 2) return true;
  return false;
}

function looksLikeEnsembleConductor(s) {
  const t = String(s || '').toLowerCase();
  if (t.includes(' / ')) return true;
  if (/orchester|orchestra|ensemble|kammerorchester|phil(harm|harmon)|choir|chor|quartet|quintet|dirig|conduct/i.test(t)) return true;
  return false;
}

function shortenRadioTitleIfRedundant(titleLine, radioAlbum, radioLabel) {
  let s = normalizeDashSpacing(titleLine);
  const ra = normalizeDashSpacing(radioAlbum);
  const rl = normalizeDashSpacing(radioLabel);

  if (rl) {
    const reLabel = new RegExp(`\\s-\\s${escapeRegExp(rl)}\\s*$`, 'i');
    s = s.replace(reLabel, '').trim();
  }
  if (ra) {
    const reAlbum = new RegExp(`\\s-\\s${escapeRegExp(ra)}\\s*$`, 'i');
    s = s.replace(reAlbum, '').trim();
  }

  s = s.replace(/\s-\s*$/g, '').trim();
  return s;
}

function removeInlinePersonnelFromTitleLine(titleLine) {
  const s = normalizeDashSpacing(titleLine);
  const idx = s.search(/\s-\s[^-]+,\s*[a-z]{1,4}\s*;/i);
  if (idx >= 0) return s.slice(0, idx).trim();
  return s;
}

function buildRadioPersonnelLine(data, displayTitle) {
  const raw = String(data.radioPerformers || '').trim();
  if (!raw) return '';

  const cleaned = expandInstrumentAbbrevs(decodeHtmlEntities(raw));
  const titleNorm = normalizeDashSpacing(displayTitle || '');
  const perfNorm  = normalizeDashSpacing(cleaned);

  if (perfNorm && titleNorm && titleNorm.toLowerCase().includes(perfNorm.toLowerCase())) {
    return '';
  }

  const looksLikeMovementOnly =
    /^[IVXLCDM]+\.\s*/i.test(perfNorm) &&
    !/[;,]/.test(perfNorm) &&
    !/\b(orchestra|ensemble|choir|quartet|trio|dir|conduct)\b/i.test(perfNorm) &&
    !/[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+/.test(perfNorm.replace(/^[IVXLCDM]+\.\s*/i, '').trim());

  if (looksLikeMovementOnly) return '';
  return cleaned;
}

function expandInstrumentAbbrevs(input) {
  let s = String(input || '');
  if (!s) return s;

  const reps = [
    ['vc', 'cello'],
    ['db', 'double bass'],
    ['cb', 'double bass'],
    ['p',  'piano'],
    ['hp', 'harp'],
    ['ob', 'oboe'],
    ['eh', 'english horn'],
    ['cl', 'clarinet'],
    ['bcl','bass clarinet'],
    ['fl', 'flute'],
    ['fh', 'horn'],
    ['g',  'guitar'],
    ['pic', 'piccolo'],
    ['bn', 'bassoon'],
    ['cbsn', 'contrabassoon'],
    ['hn', 'horn'],
    ['tpt','trumpet'],
    ['tp', 'trumpet'],
    ['tbn','trombone'],
    ['tb', 'trombone'],
    ['tba','tuba'],
    ['perc','percussion'],
    ['timp','timpani'],
    ['vln','violin'],
    ['vn', 'violin'],
    ['v',  'violin'],
    ['vla','viola'],
    ['va', 'viola'],
    ['vi', 'viola'],
    ['sop','soprano'],
    ['mez','mezzo-soprano'],
    ['alto','alto'],
    ['ten','tenor'],
    ['bar','baritone'],
    ['bs', 'bass'],
  ];

  for (const [abbr, full] of reps) {
    const re = new RegExp(`(^|[\\s,;])${abbr}(?=\\s*(?:[;,)\\]]|\\-|$))`, 'gi');
    s = s.replace(re, `$1${full}`);
  }

  s = s.replace(/\s+-\s+/g, ' - ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function stabilizeRadioDisplay(data) {
  const stationKey = `${data.file}|${data.album || ''}`;
  const incomingRaw = decodeHtmlEntities(String(data.title || '').trim());
  const incoming = incomingRaw;

  if (radioState.key !== stationKey) {
    radioState.key = stationKey;
    radioState.recentTitles = [];
  }

  if (incoming) {
    const last = radioState.recentTitles[radioState.recentTitles.length - 1];
    if (incoming !== last) {
      radioState.recentTitles.push(incoming);
      if (radioState.recentTitles.length > 3) radioState.recentTitles.shift();
    }
  }

  const dashSplit = splitArtistDashTitle(incoming);
  if (dashSplit) {
    const left = dashSplit.artist || '';
    const right = dashSplit.title || '';

    const colonIdx = left.indexOf(':');
    if (colonIdx > 0) {
      const composer = left.slice(0, colonIdx).trim();
      const work = left.slice(colonIdx + 1).trim();
      const looksComposer = /^[A-ZÀ-ÖØ-Þ]/.test(composer) && composer.split(/\s+/).length >= 2;

      if (looksComposer && work) {
        return { artist: composer, title: right ? `${work} -- ${right}` : work };
      }
    }
    return dashSplit;
  }

  const uniq = [...new Set(radioState.recentTitles)].slice(-2);
  if (uniq.length === 2) {
    const [a, b] = uniq;
    let work = '';
    let perf = '';

    if (looksLikeComposerWork(a) && looksLikeEnsembleConductor(b)) { work = a; perf = b; }
    else if (looksLikeComposerWork(b) && looksLikeEnsembleConductor(a)) { work = b; perf = a; }
    else if (looksLikeComposerWork(a) && !looksLikeComposerWork(b)) { work = a; perf = b; }
    else if (looksLikeComposerWork(b) && !looksLikeComposerWork(a)) { work = b; perf = a; }
    else {
      const station = data.album || 'Radio Stream';
      return { artist: station, title: incoming };
    }

    return { artist: perf || (data.album || 'Radio Stream'), title: work || incoming };
  }

  const station = data.album || 'Radio Stream';
  return { artist: station, title: incoming };
}

function setFavoriteHeart(isFav) {
  const el = document.getElementById('fav-heart');
  if (!el) return;
  el.classList.toggle('on', !!isFav);
}  
// --- Favorites toggle (local files only) ---
let currentFile = '';

async function toggleFavorite() {
  if (!currentFile || currentIsStream || currentIsAirplay) return;

  try {
    const res = await fetch('http://10.0.0.233:3000/favorites/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();

    currentIsFavorite = j.isFavorite === true;
    setFavoriteHeart(currentIsFavorite);
  } catch (e) {
    console.warn('favorites toggle failed:', e);
  }
}

function bindFavoriteUIOnce() {
  const heart = document.getElementById('fav-heart');
  if (!heart) return;

  heart.style.pointerEvents = 'auto';
  heart.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(); });
  heart.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(); }, { passive: false });
}

/* =========================
 * Art helpers
 * ========================= */

function toBgUrl(artUrl) {
  const key = normalizeArtKey(artUrl);
  return key ? `http://10.0.0.233:8000/art/current_bg_640_blur.jpg?v=${encodeURIComponent(key)}` : '';
}

function toUiArtUrl(artUrl) {
  const key = normalizeArtKey(artUrl);
  return key ? `http://10.0.0.233:8000/art/current_320.jpg?v=${encodeURIComponent(key)}` : '';
}


/* =========================
 * UI update
 * ========================= */

function updateUI(data) {
  if (pauseMode) return;

  const isStream  = data.isStream === true;
  const isAirplay = data.isAirplay === true;

  // --- Core state ---
  currentFile = data.file || '';
  currentIsStream = isStream;
  currentIsAirplay = isAirplay;
  currentIsFavorite = (!isStream && !isAirplay && data.isFavorite === true);

  setFavoriteHeart(currentIsFavorite);

  // --- Elements ---
  const artistEl    = document.getElementById('artist-name');
  const titleEl     = document.getElementById('track-title');
  const albumTextEl = document.getElementById('album-text');
  const fileInfoEl  = document.getElementById('file-info-text');
  const hiresBadge  = document.getElementById('hires-badge');
  const personnelEl = document.getElementById('personnel-info');
  const artEl       = document.getElementById('album-art');
  const artBgEl     = document.getElementById('album-art-bg');

  // =========================
  // Artist / Title
  // =========================

  let displayArtist = data.artist || '';
  let displayTitle  = data.title  || '';

  if (isAirplay && !displayTitle) displayTitle = 'AirPlay';

  displayArtist = expandInstrumentAbbrevs(displayArtist);
  displayTitle  = expandInstrumentAbbrevs(displayTitle);

  if (artistEl) artistEl.textContent = decodeHtmlEntities(displayArtist);
  if (titleEl)  titleEl.textContent  = decodeHtmlEntities(displayTitle);

  // =========================
  // Album line
  // =========================

  if (albumTextEl) {
    const album = decodeHtmlEntities(String(data.album || ''));
    const year  = String(data.year || '').trim();
    albumTextEl.textContent = album ? `${album}${year ? ` (${year})` : ''}` : '';
  }

  // =========================
  // File info + badge
  // =========================

  if (fileInfoEl && hiresBadge) {
    const parts = [];
    if (data.encoded) parts.push(data.encoded);
    if (data.outrate) parts.push(data.outrate);

    fileInfoEl.textContent = parts.join(' • ');

    const badge = getBadgeInfo(data);
    if (badge.show) {
      hiresBadge.textContent = badge.text;
      hiresBadge.style.display = 'inline-block';
    } else {
      hiresBadge.style.display = 'none';
    }
  }

  // =========================
  // Personnel
  // =========================

  if (personnelEl) {
    if (isAirplay || isStream) {
      personnelEl.textContent = '';
    } else {
      const personnel = Array.isArray(data.personnel) ? data.personnel : [];
      personnelEl.textContent = personnel.length
        ? personnel.map(expandInstrumentAbbrevs).join(' • ')
        : '';
    }
  }

  // =========================
  // Album Art (THE ONLY PLACE)
  // =========================

  const rawArtUrl =
    (data.altArtUrl && String(data.altArtUrl).trim())
      ? String(data.altArtUrl).trim()
      : (data.albumArtUrl || '');

  const artKey = normalizeArtKey(rawArtUrl);

  const needsInitialPaint =
    artEl &&
    (
      !artEl.getAttribute('src') ||
      artEl.getAttribute('src').startsWith('data:image')
    );

  const artChanged =
    artKey && (artKey !== lastAlbumArtKey || needsInitialPaint);

  const uiArt640Url = artKey
    ? `${API_BASE}/art/current_640.jpg?v=${encodeURIComponent(artKey)}`
    : '';

  const bgArtUrl =
    (ENABLE_BACKGROUND_ART && artKey)
      ? `${API_BASE}/art/current_bg_640_blur.jpg?v=${encodeURIComponent(artKey)}`
      : '';

  if (artChanged) {
    lastAlbumArtKey = artKey;
    lastAlbumArtUrl = rawArtUrl;

    // Foreground (640)
    if (artEl && uiArt640Url) {
      artEl.src = uiArt640Url;
    }

    // Background
    if (ENABLE_BACKGROUND_ART) {
      setBackgroundCrossfade(bgArtUrl);

      if (artBgEl) {
        artBgEl.style.backgroundImage =
          `url("${API_BASE}/art/current_320.jpg?v=${encodeURIComponent(artKey)}")`;
        artBgEl.style.backgroundSize = 'cover';
        artBgEl.style.backgroundPosition = 'center';
      }
    } else {
      setBackgroundCrossfade('');
      if (artBgEl) artBgEl.style.backgroundImage = 'none';
    }
  }

  dlog('[ART]', {
    artKey,
    artChanged,
    needsInitialPaint,
    uiArt640Url
  });
}



/* =========================
 * Album art click modal
 * ========================= */

function attachClickEventToAlbumArt() {
  const art = document.getElementById('album-art');
  const modal = document.getElementById('artist-details-container');
  if (!art || !modal) return;

  art.addEventListener('click', e => {
    e.stopPropagation();
    modal.style.display = (modal.style.display === 'block' || modal.style.display === 'flex')
      ? 'none'
      : 'block';
  });

  document.addEventListener('click', () => {
    if (modal.style.display !== 'none') modal.style.display = 'none';
  });
}

/* =========================
 * Clear UI (optional)
 * ========================= */

function clearUI() {
  currentTrackKey = '';
  lastAlbumArtUrl = '';
  lastPercent = -1;
  lastNextUpKey = '';

  radioState.key = '';
  radioState.recentTitles = [];

  stopProgressAnimator();

  const artistEl = document.getElementById('artist-name');
  const trackEl  = document.getElementById('track-title');
  const albumEl  = document.getElementById('album-link');
  const albumTextEl = document.getElementById('album-text');
  const fileInfoText = document.getElementById('file-info-text');
  const hiresBadge = document.getElementById('hires-badge');
  const personnelEl = document.getElementById('personnel-info');

  const nextText = document.getElementById('next-up-text');
  const nextImg  = document.getElementById('next-up-img');

  const progressFill = document.getElementById('progress-fill');
  const artBgEl = document.getElementById('album-art-bg');
  const logoEl = document.getElementById('mode-logo');
  const artEl = document.getElementById('album-art');

  if (artistEl) artistEl.textContent = '';
  if (trackEl)  trackEl.textContent  = '';
  if (albumTextEl) albumTextEl.textContent = '';
  else if (albumEl) albumEl.textContent = '';
  if (fileInfoText) fileInfoText.textContent = '';
  if (hiresBadge) {
    hiresBadge.textContent = 'Lossless';
    hiresBadge.style.display = 'none';
  }
  if (personnelEl) personnelEl.textContent = '';

  if (nextText) nextText.textContent = '';
  if (nextImg) {
    nextImg.style.display = 'none';
    nextImg.removeAttribute('src');
  }

  if (progressFill) progressFill.style.transform = 'scaleX(0)';

  if (artEl) artEl.removeAttribute('src');
  if (artBgEl) artBgEl.style.backgroundImage = 'none';
  setBackgroundCrossfade('');

  if (logoEl) {
    logoEl.style.display = 'none';
    logoEl.removeAttribute('src');
  }
  clearStars();
}