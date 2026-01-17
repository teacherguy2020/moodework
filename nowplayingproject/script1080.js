// script1080.js -- DROP-IN (v1.4)
//
// Includes:
// - Double-buffer blurred background crossfade (background-a/background-b)
// - Boot gating: wait for first bg art, snap it in place, then show UI
// - Next Up (text + 75x75 art)
// - Pause screensaver logic
// - Radio stabilization + classical composer/work formatting
// - Instrument abbrev expansion
// - Lossless/HQ badge logic
//
// Notes:
// - After boot, JS owns background-a/background-b opacity.
// - CSS should NOT force background opacity in body.ready rules.

const NEXT_UP_URL = 'http://10.0.0.233:3000/next-up';
const ENABLE_NEXT_UP = true;

const NOW_PLAYING_URL = 'http://10.0.0.233:3000/now-playing';
const AIRPLAY_ICON_URL = 'http://10.0.0.233:8000/airplay.png?v=1';

const ENABLE_BACKGROUND_ART = true; // set false to disable background updates entirely

// Pause "screensaver" behavior
const ENABLE_PAUSE_SCREENSAVER = true;
const PAUSE_ART_URL = 'http://10.0.0.254/images/default-album-cover.png';
const PAUSE_MOVE_INTERVAL_MS = 8000;
const PAUSE_ART_MIN_MARGIN_PX = 20;
const PAUSE_SCREENSAVER_DELAY_MS = 5000;

let lastNextUpKey = '';

let pauseOrStopSinceTs = 0;
let pauseMode = false;
let lastPauseMoveTs = 0;
let justResumedFromPause = false;

// Progress animator (smooth between polls)
let progressAnimRaf = 0;
let progressAnim = {
  t0: 0,
  baseElapsed: 0,
  duration: 0,
  running: false,
};

// Background crossfade state
let bgFront = 'a';     // 'a' or 'b'
let bgUrlFront = '';   // currently shown URL
let bgLoadingUrl = ''; // URL currently being loaded (race guard)

// Track state
let currentTrackKey = '';
let lastAlbumArtUrl = '';
let lastPercent = -1;

// Radio memory (keyed by station/stream)
const radioState = {
  key: '',
  recentTitles: [],
};

function applyBackgroundToggleClass() {
  if (!ENABLE_BACKGROUND_ART) document.body.classList.add('no-bg');
  else document.body.classList.remove('no-bg');
}

window.addEventListener('load', () => {
  applyBackgroundToggleClass();
  attachClickEventToAlbumArt();
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
    fetchNowPlaying();
    setInterval(fetchNowPlaying, 1000);
    return;
  }

  const firstArtUrl =
    (data.altArtUrl && String(data.altArtUrl).trim())
      ? String(data.altArtUrl).trim()
      : (data.albumArtUrl || '');

  // If bg disabled or no art, don't wait
  if (!ENABLE_BACKGROUND_ART || !firstArtUrl) {
    updateUI(data);
    markReadyOnce();
    setInterval(fetchNowPlaying, 1000);
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
  setInterval(fetchNowPlaying, 1000);
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

  // Clear request: blank both cleanly
  if (!nextUrl) {
    a.style.backgroundImage = 'none';
    b.style.backgroundImage = 'none';
    a.style.opacity = '1';
    b.style.opacity = '0';
    bgFront = 'a';
    bgUrlFront = '';
    bgLoadingUrl = '';
    return;
  }

  // Same as current? do nothing
  if (nextUrl === bgUrlFront) return;

  // Already loading this? do nothing
  if (nextUrl === bgLoadingUrl) return;
  bgLoadingUrl = nextUrl;

  const img = new Image();
  img.onload = () => {
    if (bgLoadingUrl !== nextUrl) return;

    const frontEl = (bgFront === 'a') ? a : b;
    const backEl  = (bgFront === 'a') ? b : a;

    backEl.style.backgroundImage = `url("${nextUrl}")`;

    // Ensure front is visible BEFORE fade
    frontEl.style.opacity = '1';
    backEl.style.opacity = '0';

    requestAnimationFrame(() => {
      backEl.style.opacity = '1';
      frontEl.style.opacity = '0';

      bgFront = (bgFront === 'a') ? 'b' : 'a';
      bgUrlFront = nextUrl;
      bgLoadingUrl = '';
    });
  };

  img.onerror = () => {
    if (bgLoadingUrl === nextUrl) bgLoadingUrl = '';
  };

  img.src = nextUrl;
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
      const isStream = data.isStream === true;

      // Update bottom-right logo EVERY poll
      setModeLogo({
        isStream,
        isAirplay,
        stationLogoUrl: data.albumArtUrl || '',
      });

      const pauseOrStop = isPauseOrStopState(data);
      const screensaverEligible = !isAirplay;

      if (pauseOrStop && screensaverEligible) {
        if (!pauseOrStopSinceTs) pauseOrStopSinceTs = Date.now();

        const elapsed = Date.now() - pauseOrStopSinceTs;
        const delayMs = Number(PAUSE_SCREENSAVER_DELAY_MS) || 0;

        if (ENABLE_PAUSE_SCREENSAVER && elapsed >= delayMs) {
          if (!pauseMode) setPausedScreensaver(true);

          setProgressVisibility(true); // hide progress bar
          hideModeLogo();
          movePauseArtRandomly(false);
          stopProgressAnimator();
          return;
        }
      } else {
        pauseOrStopSinceTs = 0;

        if (pauseMode) {
          setPausedScreensaver(false);
          justResumedFromPause = true;
        }
      }

      // Hide progress for radio + AirPlay
      setProgressVisibility(isStream || isAirplay);
      if (isStream || isAirplay) stopProgressAnimator();

      // Progress for files only
      if (!isStream && !isAirplay) {
        const el = Number(data.elapsed);
        const dur = Number(data.duration);

        if (Number.isFinite(el) && Number.isFinite(dur) && dur > 0) {
          startProgressAnimator(el, dur);
        } else if (typeof data.percent === 'number') {
          updateProgressBarPercent(data.percent);
        }
      }

      // Track key
      let baseKey = '';
      if (isAirplay) {
        baseKey = `airplay|${data.artist || ''}|${data.title || ''}|${data.album || ''}|${data.altArtUrl || ''}`;
      } else if (isStream) {
        baseKey = `${data.file}|${data.album || ''}`;
      } else {
        baseKey = data.file || `${data.artist}|${data.album}|${data.title}`;
      }

      // Local files + AirPlay
      if (!isStream) {
        if (justResumedFromPause || baseKey !== currentTrackKey) {
          currentTrackKey = baseKey;
          updateUI(data);

          if (ENABLE_NEXT_UP) updateNextUp({ isAirplay, isStream });
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

function setModeLogo({ isStream, isAirplay, stationLogoUrl }) {
  const logoEl = document.getElementById('mode-logo');
  if (!logoEl) return;

  let url = '';
  if (isAirplay) url = AIRPLAY_ICON_URL;
  else if (isStream && stationLogoUrl) url = stationLogoUrl;

  if (!url) {
    logoEl.style.display = 'none';
    logoEl.removeAttribute('src');
    return;
  }

  if (logoEl.getAttribute('src') !== url) logoEl.src = url;
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
  const wrap = document.getElementById('next-up');
  const textEl = document.getElementById('next-up-text');
  const imgEl = document.getElementById('next-up-img');
  if (!wrap || !textEl || !imgEl) return;

  if (pauseMode || isAirplay || isStream) {
    textEl.textContent = '';
    imgEl.style.display = 'none';
    imgEl.removeAttribute('src');
    lastNextUpKey = '';
    return;
  }

  fetch(NEXT_UP_URL, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(x => {
      if (!x || x.ok !== true || !x.next) {
        textEl.textContent = '';
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');
        lastNextUpKey = '';
        return;
      }

      const next = x.next;
      const title  = String(next.title || '').trim();
      const file   = String(next.file || '').trim();
      const artist = String(next.artist || '').trim();
      const artUrl = String(next.artUrl || '').trim();

      if (!title && !file) {
        textEl.textContent = '';
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');
        lastNextUpKey = '';
        return;
      }

      const key = `${next.songid || ''}|${artist}|${title}|${file}|${artUrl}`;
      if (key === lastNextUpKey) return;
      lastNextUpKey = key;

      const showTitle  = title || file.split('/').pop() || file;
      const showArtist = artist ? ` • ${artist}` : '';
      textEl.textContent = `Next up: ${showTitle}${showArtist}`;

      if (!artUrl) {
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');
        return;
      }

      // Force reliable refresh:
      // 1) show box immediately (prevents layout race)
      // 2) clear src, then set new src
      // 3) only keep visible once loaded (avoids stale art sticking)
      imgEl.style.display = 'block';
      imgEl.onload = () => { imgEl.style.display = 'block'; };
      imgEl.onerror = () => {
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');
      };

      imgEl.removeAttribute('src');
      imgEl.src = artUrl;
    })
    .catch(() => {});
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

  document.body.style.backgroundColor = on ? '#000' : '';
  document.documentElement.style.backgroundColor = on ? '#000' : '';

  const artistEl = document.getElementById('artist-name');
  const trackEl  = document.getElementById('track-title');
  const albumEl  = document.getElementById('album-link');
  const fileInfoText = document.getElementById('file-info-text');
  const hiresBadge = document.getElementById('hires-badge');
  const personnelEl = document.getElementById('personnel-info');
  const nextUpEl = document.getElementById('next-up');

  const show = !on;
  if (artistEl) artistEl.style.display = show ? '' : 'none';
  if (trackEl)  trackEl.style.display  = show ? '' : 'none';
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

/* =========================
 * UI update
 * ========================= */

function updateUI(data) {
  if (pauseMode) return; // don’t update UI while in pause screensaver

  const isStream = data.isStream === true;
  const isAirplay = data.isAirplay === true;

  setProgressVisibility(isStream || isAirplay);
  if (isStream || isAirplay) stopProgressAnimator();

  const artistEl = document.getElementById('artist-name');
  const trackEl  = document.getElementById('track-title');
  const albumEl  = document.getElementById('album-link');
  const fileInfoText = document.getElementById('file-info-text');
  const hiresBadge = document.getElementById('hires-badge');
  const artEl = document.getElementById('album-art');
  const personnelEl = document.getElementById('personnel-info');
  const artBgEl = document.getElementById('album-art-bg');

  let displayArtist = data.artist || '';
  let displayTitle  = data.title || '';

  if (isStream) {
    const stable = data._radioDisplay || stabilizeRadioDisplay(data);

    displayArtist = stable.artist || (data.album || 'Radio Stream');
    displayTitle  = stable.title || decodeHtmlEntities(data.title || '');

    const ra = String(data.radioAlbum || '').trim();
    const rl = String(data.radioLabel || '').trim();

    displayTitle = removeInlinePersonnelFromTitleLine(displayTitle);
    if (ra || rl) displayTitle = shortenRadioTitleIfRedundant(displayTitle, ra, rl);
  }

  if (isAirplay && !displayTitle) displayTitle = 'AirPlay';

  displayArtist = expandInstrumentAbbrevs(displayArtist);
  displayTitle  = expandInstrumentAbbrevs(displayTitle);

  if (artistEl) artistEl.textContent = decodeHtmlEntities(displayArtist);
  if (trackEl)  trackEl.textContent  = decodeHtmlEntities(displayTitle);

  // Album line
  if (albumEl) {
    const albumTextEl = document.getElementById('album-text');

    if (isStream) {
      const station = decodeHtmlEntities(String(data.album || 'Radio Stream'));
      const raRaw = String(data.radioAlbum || '').trim();
      const ry = String(data.radioYear || '').trim();

      const text = raRaw
        ? `${expandInstrumentAbbrevs(decodeHtmlEntities(raRaw))}${ry ? ` (${ry})` : ''}`
        : station;

      if (albumTextEl) albumTextEl.textContent = text;
      else albumEl.textContent = text;
    } else {
      const albumName = expandInstrumentAbbrevs(decodeHtmlEntities(String(data.airplayAlbum || data.album || '')));
      const year = String(data.airplayYear || data.year || '').trim();
      const albumText = albumName ? `${albumName}${year ? ` (${year})` : ''}` : '';

      if (albumTextEl) albumTextEl.textContent = albumText;
      else albumEl.textContent = albumText;
    }
  }

  // File info + badge
  if (fileInfoText && hiresBadge) {
    const parts = [];
    const encoded = String(data.encoded || '').trim();
    const outrate = String(data.outrate || '').trim();
    const bitrate = String(data.bitrate || '').trim();

    if (encoded) parts.push(encoded);

    if (isAirplay && outrate) {
      const m = outrate.match(/(\d+(?:\.\d+)?)\s*kHz.*?(\d+ch)/i);
      if (m) {
        parts.push(`${m[1]}kHz`);
        parts.push(m[2]);
      } else {
        parts.push(outrate);
      }
    }

    if (isStream) {
      if (bitrate) parts.push(bitrate);
      if (outrate) parts.push(outrate);
    }

    fileInfoText.textContent = parts.join(' • ');

    const badge = getBadgeInfo(data);
    if (badge.show) {
      hiresBadge.textContent = badge.text;
      hiresBadge.style.display = 'inline-block';
    } else {
      hiresBadge.style.display = 'none';
    }
  }

  // Personnel
  if (personnelEl) {
    if (isAirplay) {
      personnelEl.textContent = '';
    } else if (isStream) {
      const radioPersonnel = buildRadioPersonnelLine(data, displayTitle);
      personnelEl.textContent = radioPersonnel ? decodeHtmlEntities(radioPersonnel) : '';
    } else {
      const personnel = Array.isArray(data.personnel) ? data.personnel : [];
      const producer = (data.producer && String(data.producer).trim())
        ? [`Producer: ${String(data.producer).trim()}`]
        : [];
      const combined = [...personnel, ...producer].filter(Boolean).map(expandInstrumentAbbrevs);
      personnelEl.textContent = combined.length ? decodeHtmlEntities(combined.join(' • ')) : '';
    }
  }

  // Art
  const newArtUrl =
    (data.altArtUrl && String(data.altArtUrl).trim())
      ? String(data.altArtUrl).trim()
      : (data.albumArtUrl || '');

  const artChanged = newArtUrl && newArtUrl !== lastAlbumArtUrl;

  if (artChanged) {
    lastAlbumArtUrl = newArtUrl;

    if (artEl) artEl.src = newArtUrl;

    if (ENABLE_BACKGROUND_ART) {
      setBackgroundCrossfade(newArtUrl);

      if (artBgEl) {
        artBgEl.style.backgroundImage = `url("${newArtUrl}")`;
        artBgEl.style.backgroundSize = 'cover';
        artBgEl.style.backgroundPosition = 'center';
      }
    } else {
      setBackgroundCrossfade('');
      if (artBgEl) artBgEl.style.backgroundImage = 'none';
    }
  }
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
}