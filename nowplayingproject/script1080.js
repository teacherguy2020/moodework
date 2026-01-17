// script1080.js -- DROP-IN (v1.3: background toggle + classical composer/work split + instrument abbrev expansion
//                       + radio redundancy trimming + radio personnel-at-bottom)
//
// Keeps your 1.0 behavior, with additions:
// 1) Classical formatting: if the "artist" side of an "A - B" split contains "Composer: Work",
//    show Composer on the top line, and Work on the 2nd line (followed by the rest).
// 2) Expands common orchestral instrument abbreviations (vi, vc, p, ob, etc.) anywhere we display text.
//    Also handles the case where abbreviations are followed by a separator hyphen (" p - Mozart").
//    And normalizes hyphen spacing to exactly " - " (your preference).
// 3) Background toggle: turn background art on/off in one place without changing HTML.
// 4) Radio UI cleanup:
//    - If iTunes-derived radio album/label info is present, trim redundant trailing segments on line 2.
//    - Move radio personnel to the bottom line (consistent with local tracks).
//
// Still includes:
// - Mode logo updated EVERY poll (radio station icon OR airplay.png)
// - AirPlay MPD state="stop" safe (won't clear UI)
// - Progress bar hidden for radio + AirPlay

const NEXT_UP_URL = 'http://10.0.0.233:3000/next-up';
const ENABLE_NEXT_UP = true;

let lastNextUpKey = '';
const NOW_PLAYING_URL = 'http://10.0.0.233:3000/now-playing';
const AIRPLAY_ICON_URL = 'http://10.0.0.233:8000/airplay.png?v=1';
// Pause "screensaver" behavior
const ENABLE_PAUSE_SCREENSAVER = true;
const PAUSE_ART_URL = 'http://10.0.0.254/images/default-album-cover.png'; // <-- set to your moOde default jpg/png
const PAUSE_MOVE_INTERVAL_MS = 8000; // move every 8s
const PAUSE_ART_MIN_MARGIN_PX = 20;  // keep away from edges a bit
// Delay before screensaver engages after PAUSE/STOP (ms)
const PAUSE_SCREENSAVER_DELAY_MS = 5000; // e.g. 5s (set to 0 for instant)
let pauseOrStopSinceTs = 0;
let pauseMode = false;
let lastPauseMoveTs = 0;
let justResumedFromPause = false;
let progressAnimRaf = 0;
let progressAnim = {
  t0: 0,
  baseElapsed: 0,
  duration: 0,
  running: false,
};

/* =========================
 * Feature toggles
 * ========================= */
const ENABLE_BACKGROUND_ART = true; // ← set false to disable background updates entirely

let currentTrackKey = '';
let lastAlbumArtUrl = '';
let lastPercent = -1;

// Radio memory (keyed by station/stream)
const radioState = {
  key: '',
  recentTitles: [],
};

window.addEventListener('load', () => {
  applyBackgroundToggleClass();
  attachClickEventToAlbumArt();

  // Don't start the 1s poll / don't show UI until first background art is ready
  bootThenStart();
});


async function bootThenStart() {
  // Get one snapshot
  const data = await fetch(NOW_PLAYING_URL, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);

  // If we couldn't fetch, fail-safe: show UI and start polling anyway
  if (!data) {
    document.body.classList.remove('booting');
    document.body.classList.add('ready');
    fetchNowPlaying();
    setInterval(fetchNowPlaying, 1000);
    return;
  }

  // Match the same art decision used in updateUI()
  const firstArtUrl =
    (data.altArtUrl && String(data.altArtUrl).trim())
      ? String(data.altArtUrl).trim()
      : (data.albumArtUrl || '');

  // If bg art disabled or no art available, don't wait
  if (!ENABLE_BACKGROUND_ART || !firstArtUrl) {
    updateUI(data);
    document.body.classList.remove('booting');
    document.body.classList.add('ready');
    setInterval(fetchNowPlaying, 1000);
    return;
  }

  // Preload the background image
  await preloadImage(firstArtUrl);

  // Apply background once before first paint
  const bgEl = document.getElementById('background-image');
  const artBgEl = document.getElementById('album-art-bg');
  if (bgEl) bgEl.style.backgroundImage = `url("${firstArtUrl}")`;
  if (artBgEl) {
    artBgEl.style.backgroundImage = `url("${firstArtUrl}")`;
    artBgEl.style.backgroundSize = 'cover';
    artBgEl.style.backgroundPosition = 'center';
  }

  // Now paint the rest of the UI
  updateUI(data);

  document.body.classList.remove('booting');
  document.body.classList.add('ready');

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
      // Only allow idle screensaver for local files + radio (NOT AirPlay)
      const screensaverEligible = !isAirplay;

      // ✅ Update bottom-right logo EVERY poll
      setModeLogo({
        isStream,
        isAirplay,
        stationLogoUrl: data.albumArtUrl || ''
      });

      // MPD state gate:
      // - For files/radio: require play/playing
      // - For AirPlay: allow even if MPD says stop
      const state = String(data.state || '').toLowerCase();
      const pauseOrStop = isPauseOrStopState(data);


      if (pauseOrStop && screensaverEligible) {
            if (!pauseOrStopSinceTs) pauseOrStopSinceTs = Date.now();

            const elapsed = Date.now() - pauseOrStopSinceTs;
            const delayMs = Number(PAUSE_SCREENSAVER_DELAY_MS) || 0;
            const delayPassed = elapsed >= delayMs;

            if (ENABLE_PAUSE_SCREENSAVER && delayPassed) {
                  if (!pauseMode) setPausedScreensaver(true);

                  setProgressVisibility(true); // hide progress bar
                  hideModeLogo();              // hide radio/airplay icon
                  movePauseArtRandomly(false); // drift default art
                  stopProgressAnimator();
                  return;
            }
      } else {
            // AirPlay, or not paused/stopped => reset + exit screensaver if needed
            pauseOrStopSinceTs = 0;

            if (pauseMode) {
                  setPausedScreensaver(false);
                  justResumedFromPause = true;
            }
      } 
      
      // Hide progress for radio and AirPlay
      setProgressVisibility(isStream || isAirplay);
      if (isStream || isAirplay) stopProgressAnimator();

      // Update progress for FILE playback only
      if (!isStream && !isAirplay) {
        const el = Number(data.elapsed);
        const dur = Number(data.duration);

        if (Number.isFinite(el) && Number.isFinite(dur) && dur > 0) {
          // Smooth: animate between polls using elapsed/duration
          startProgressAnimator(el, dur);
        } else if (typeof data.percent === 'number') {
          // Fallback (still smooth-ish if percent is fractional)
          updateProgressBarPercent(data.percent);
        }
      }
      
      if (ENABLE_NEXT_UP) {
        updateNextUp({ isAirplay, isStream });
      }

      // Track-change detection
      let baseKey = '';
      if (isAirplay) {
        baseKey = `airplay|${data.artist || ''}|${data.title || ''}|${data.album || ''}|${data.altArtUrl || ''}`;
      } else if (isStream) {
        baseKey = `${data.file}|${data.album || ''}`;
      } else {
        baseKey = data.file || `${data.artist}|${data.album}|${data.title}`;
      }

      // ----------------------------
      // Track-change detection
      // ----------------------------

      if (!isStream) {
            // Local files + AirPlay
            if (justResumedFromPause || baseKey !== currentTrackKey) {
                  currentTrackKey = baseKey;
                  updateUI(data);
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
    .catch(() => {
      // Quiet: avoid console spam during brief network hiccups
    });
}

/* =========================
 * Mode logo
 * ========================= */

function setModeLogo({ isStream, isAirplay, stationLogoUrl }) {
  const logoEl = document.getElementById('mode-logo');
  if (!logoEl) return;

  // Priority: AirPlay > Radio > none
  let url = '';
  if (isAirplay) {
    url = AIRPLAY_ICON_URL;
  } else if (isStream && stationLogoUrl) {
    url = stationLogoUrl;
  }

  if (!url) {
    logoEl.style.display = 'none';
    logoEl.removeAttribute('src');
    return;
  }

  // Only update src if changed (prevents flicker)
  if (logoEl.getAttribute('src') !== url) {
    logoEl.src = url;
  }
  logoEl.style.display = 'block';
}

/* =========================
 * Helpers
 * ========================= */
 
 function stopProgressAnimator() {
  progressAnim.running = false;
  if (progressAnimRaf) cancelAnimationFrame(progressAnimRaf);
  progressAnimRaf = 0;
}

function startProgressAnimator(baseElapsed, duration) {
  // guard
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

    // stop at end
    if (elapsedNow >= progressAnim.duration) {
      updateProgressBarPercent(100);
      stopProgressAnimator();
      return;
    }

    progressAnimRaf = requestAnimationFrame(tick);
  };

  // kick immediately
  progressAnimRaf = requestAnimationFrame(tick);
}
 
function updateNextUp({ isAirplay, isStream }) {
  const wrap = document.getElementById('next-up');
  const textEl = document.getElementById('next-up-text');
  const imgEl = document.getElementById('next-up-img');
  if (!wrap || !textEl || !imgEl) return;

  // Conditions where Next Up should never appear
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

      if (!title && !file) {
        textEl.textContent = '';
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');
        lastNextUpKey = '';
        return;
      }

      const key = `${next.songid || ''}|${artist}|${title}|${file}|${next.artUrl || ''}`;
      if (key === lastNextUpKey) return;
      lastNextUpKey = key;

      const showTitle  = title || file.split('/').pop() || file;
      const showArtist = artist ? ` • ${artist}` : '';

      textEl.textContent = `Next up: ${showTitle}${showArtist}`;

      const artUrl = String(next.artUrl || '').trim();
      if (artUrl) {
        imgEl.src = artUrl;
        imgEl.style.display = 'block';
      } else {
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');
      }
    })
    .catch(() => {
      // quiet failure
    });
}

 function hideModeLogo() {
  const logoEl = document.getElementById('mode-logo');
  if (!logoEl) return;
  logoEl.style.display = 'none';
  logoEl.removeAttribute('src');
}
 
function isPauseOrStopState(data) {
  const state = String(data.state || '').toLowerCase();
  return (state === 'pause' || state === 'paused' || state === 'stop' || state === 'stopped' || state === 'idle');
}

function setPausedScreensaver(on) {
  pauseMode = on;
  // Force full black backdrop during pause (prevents top-band bleed)
  document.body.style.backgroundColor = on ? '#000' : '';
  document.documentElement.style.backgroundColor = on ? '#000' : '';

  // Hide/show text + info areas (adjust IDs to match your HTML)
  const artistEl = document.getElementById('artist-name');
  const trackEl  = document.getElementById('track-title');
  const albumEl  = document.getElementById('album-link');
  const fileInfoText = document.getElementById('file-info-text');
  const hiresBadge = document.getElementById('hires-badge');
  const personnelEl = document.getElementById('personnel-info');
  const nextUpEl = document.getElementById('next-up');   // <-- ADD

  const show = !on;
  if (artistEl) artistEl.style.display = show ? '' : 'none';
  if (trackEl)  trackEl.style.display  = show ? '' : 'none';
  if (albumEl)  albumEl.style.display  = show ? '' : 'none';
  if (fileInfoText) fileInfoText.style.display = show ? '' : 'none';
  if (hiresBadge) hiresBadge.style.display = show ? '' : 'none';
  if (personnelEl) personnelEl.style.display = show ? '' : 'none';
  if (nextUpEl) nextUpEl.style.display = show ? '' : 'none'; // <-- ADD

  // Swap art to pause art
  const artEl = document.getElementById('album-art');
  if (artEl) {
    if (on) {
      artEl.src = PAUSE_ART_URL;

      // IMPORTANT: don't poison lastAlbumArtUrl with PAUSE_ART_URL.
      // Instead, force the next normal update to always re-apply real artwork.
      lastAlbumArtUrl = '';

      artEl.style.position = 'fixed';
      artEl.style.maxWidth = '40vw';
      artEl.style.maxHeight = '40vh';
      artEl.style.width = 'auto';
      artEl.style.height = 'auto';
      movePauseArtRandomly(true);
      artEl.style.opacity = '0.35';   // ← adjust to taste (0.4–0.75 is nice)
    } else {
    
      // restore styles; your CSS will take over again
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

  // Background: black during pause
  const bgEl = document.getElementById('background-image');
  const artBgEl = document.getElementById('album-art-bg');
  if (bgEl) bgEl.style.backgroundImage = 'none';
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

  // Use rendered size if available; otherwise estimate
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

function normalizeDashSpacing(s) {
  // Only normalize separator hyphens that already have spaces around them (or multiple spaces).
  // Avoid touching things like "(-)" inside parentheses.
  return String(s || '')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// If iTunes album/label is available, remove redundant trailing segments like:
// " ... - Mozart, Bruch - Aparte" because album+label appear on line 3 already.
function shortenRadioTitleIfRedundant(titleLine, radioAlbum, radioLabel) {
  let s = normalizeDashSpacing(titleLine);
  const ra = normalizeDashSpacing(radioAlbum);
  const rl = normalizeDashSpacing(radioLabel);

  // Strip trailing " - {radioLabel}" then " - {radioAlbum}" if present at end.
  if (rl) {
    const reLabel = new RegExp(`\\s-\\s${escapeRegExp(rl)}\\s*$`, 'i');
    s = s.replace(reLabel, '').trim();
  }
  if (ra) {
    const reAlbum = new RegExp(`\\s-\\s${escapeRegExp(ra)}\\s*$`, 'i');
    s = s.replace(reAlbum, '').trim();
  }

  // Clean trailing separators
  s = s.replace(/\s-\s*$/g, '').trim();

  return s;
}

// Radio personnel: prefer radioPerformers if provided; expand abbrevs and normalize separators.
function buildRadioPersonnelLine(data, displayTitle) {
  const raw = String(data.radioPerformers || '').trim();
  if (!raw) return '';

  const cleaned = expandInstrumentAbbrevs(decodeHtmlEntities(raw));
  const titleNorm = normalizeDashSpacing(displayTitle || '');
  const perfNorm  = normalizeDashSpacing(cleaned);

  // 1) If it's already in the title line, don't repeat it.
  if (perfNorm && titleNorm && titleNorm.toLowerCase().includes(perfNorm.toLowerCase())) {
    return '';
  }

  // 2) Heuristic: if it's just a movement marker (Roman numeral / tempo-ish) with no names,
  // treat it as "part of title", not personnel.
  const looksLikeMovementOnly =
    /^[IVXLCDM]+\.\s*/i.test(perfNorm) &&            // "I. ", "VI. "
    !/[;,]/.test(perfNorm) &&                        // no list delimiters
    !/\b(orchestra|ensemble|choir|quartet|trio|dir|conduct)\b/i.test(perfNorm) &&
    !/[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+/.test(perfNorm.replace(/^[IVXLCDM]+\.\s*/i, '').trim()); // no obvious name after numeral

  if (looksLikeMovementOnly) return '';

  return cleaned;
}

// Optional: if the title line contains "... - Patrick, cl; ... - Album - Label",
// remove the detailed instrument list from the title line by cutting at the first " - Name, xx;"
function removeInlinePersonnelFromTitleLine(titleLine) {
  const s = normalizeDashSpacing(titleLine);

  // Example: "Work - Patrick Messina, cl; Lise Berthaud, vi; ... - Mozart, Bruch - Aparte"
  const idx = s.search(/\s-\s[^-]+,\s*[a-z]{1,4}\s*;/i);
  if (idx >= 0) return s.slice(0, idx).trim();

  return s;
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

function splitArtistDashTitle(s) {
  const t = String(s || '').trim();
  const parts = t.split(' - ');
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return null;
}

/* =========================
 * Instrument abbreviation expansion
 * ========================= */

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
    // ⚠️ ambiguous; in your WFMT examples it's typically viola.
    ['vi', 'viola'],
    ['sop','soprano'],
    ['mez','mezzo-soprano'],
    ['alto','alto'],
    ['ten','tenor'],
    ['bar','baritone'],
    ['bs', 'bass'],
  ];

  // Expand only when it's a standalone token preceded by start/space/punct,
  // and followed by punctuation/end OR a separator hyphen.
  for (const [abbr, full] of reps) {
    const re = new RegExp(
      `(^|[\\s,;])${abbr}(?=\\s*(?:[;,)\\]]|\\-|$))`,
      'gi'
    );
    s = s.replace(re, `$1${full}`);
  }

  // Normalize only separator hyphens that already have whitespace around them.
  // This preserves things like "(-)".
  s = s.replace(/\s+-\s+/g, ' - ');

  // Collapse extra whitespace introduced by replacements
  s = s.replace(/\s{2,}/g, ' ').trim();

  return s;
}

/* =========================
 * Radio stabilization + classical split
 * ========================= */

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

  // First: try plain "A - B" split (what most stations do)
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
        return {
          artist: composer,
          title: right ? `${work} -- ${right}` : work
        };
      }
    }

    return dashSplit;
  }

  // Fallback logic for some classical station flip-flops
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
 * Background toggle (CSS class)
 * ========================= */

function applyBackgroundToggleClass() {
  if (!ENABLE_BACKGROUND_ART) {
    document.body.classList.add('no-bg');
  } else {
    document.body.classList.remove('no-bg');
  }
}

/* =========================
 * UI
 * ========================= */

function setProgressVisibility(hide) {
  const wrapper = document.getElementById('progress-bar-wrapper');
  if (!wrapper) return;
  wrapper.style.display = hide ? 'none' : 'block';
}

function updateUI(data) {
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

  const bgEl = document.getElementById('background-image');
  const artBgEl = document.getElementById('album-art-bg');

  let displayArtist = data.artist || '';
  let displayTitle  = data.title || '';

  if (isStream) {
    const stable = data._radioDisplay || stabilizeRadioDisplay(data);

    displayArtist = stable.artist || (data.album || 'Radio Stream');
    displayTitle  = stable.title || decodeHtmlEntities(data.title || '');

    // If we have iTunes album/label info, avoid repeating it on line 2.
    // Also keep long instrument personnel out of line 2 (we show it at the bottom now).
    const ra = String(data.radioAlbum || '').trim();
    const rl = String(data.radioLabel || '').trim();

    displayTitle = removeInlinePersonnelFromTitleLine(displayTitle);
    if (ra || rl) {
      displayTitle = shortenRadioTitleIfRedundant(displayTitle, ra, rl);
    }
  }

  if (isAirplay && !displayTitle) displayTitle = 'AirPlay';

  // Expand abbreviations for what we show
  displayArtist = expandInstrumentAbbrevs(displayArtist);
  displayTitle  = expandInstrumentAbbrevs(displayTitle);

  if (artistEl) artistEl.textContent = decodeHtmlEntities(displayArtist);
  if (trackEl)  trackEl.textContent  = decodeHtmlEntities(displayTitle);

  // ----------------------------
  // Album line
  // ----------------------------
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

  // ----------------------------
  // File info + Badge (moOde-ish)
  // ----------------------------
  if (fileInfoText && hiresBadge) {
    const parts = [];

    const encoded = String(data.encoded || '').trim();
    const outrate = String(data.outrate || '').trim();
    const bitrate = String(data.bitrate || '').trim();

    if (encoded) parts.push(encoded);

    // AirPlay: prefer parsed outrate bits (kHz + ch), fallback to outrate
    if (isAirplay && outrate) {
      const m = outrate.match(/(\d+(?:\.\d+)?)\s*kHz.*?(\d+ch)/i);
      if (m) {
        parts.push(`${m[1]}kHz`);
        parts.push(m[2]);
      } else {
        parts.push(outrate);
      }
    }

    // Radio: show bitrate + outrate
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

  // ----------------------------
  // Personnel (local + radio)
  // ----------------------------
  if (personnelEl) {
    if (isAirplay) {
      // AirPlay: no personnel
      personnelEl.textContent = '';
    } else if (isStream) {
      // Radio: show radioPerformers (if present) at bottom, consistent with local tracks.
      const radioPersonnel = buildRadioPersonnelLine(data, displayTitle);
      personnelEl.textContent = radioPersonnel ? decodeHtmlEntities(radioPersonnel) : '';
    } else {
      // Local files: unchanged behavior
      const personnel = Array.isArray(data.personnel) ? data.personnel : [];
      const producer = (data.producer && String(data.producer).trim())
        ? [`Producer: ${String(data.producer).trim()}`]
        : [];
      const combined = [...personnel, ...producer]
        .filter(Boolean)
        .map(expandInstrumentAbbrevs);

      personnelEl.textContent = combined.length ? decodeHtmlEntities(combined.join(' • ')) : '';
    }
  }

  // ----------------------------
  // Art (background toggle supported)
  // ----------------------------
  const newArtUrl =
    (data.altArtUrl && String(data.altArtUrl).trim())
      ? String(data.altArtUrl).trim()
      : (data.albumArtUrl || '');

  const artChanged = newArtUrl && newArtUrl !== lastAlbumArtUrl;

  if (artChanged) {
    lastAlbumArtUrl = newArtUrl;

    if (artEl) artEl.src = newArtUrl;

    if (ENABLE_BACKGROUND_ART) {
      if (bgEl) bgEl.style.backgroundImage = `url("${newArtUrl}")`;
      if (artBgEl) {
        artBgEl.style.backgroundImage = `url("${newArtUrl}")`;
        artBgEl.style.backgroundSize = 'cover';
        artBgEl.style.backgroundPosition = 'center';
      }
    } else {
      // Hard-disable background updates
      if (bgEl) bgEl.style.backgroundImage = 'none';
      if (artBgEl) artBgEl.style.backgroundImage = 'none';
    }
  }
}

function updateProgressBarPercent(percent) {
  const progressFill = document.getElementById('progress-fill');
  if (!progressFill) return;

  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));

  // IMPORTANT: do NOT short-circuit on equality
  lastPercent = clamped;

  // Use transform instead of width for smoother GPU rendering
  progressFill.style.transform = `scaleX(${clamped / 100})`;
}

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

function clearUI() {
  currentTrackKey = '';
  lastAlbumArtUrl = '';
  lastPercent = -1;

  radioState.key = '';
  radioState.recentTitles = [];

  const artistEl = document.getElementById('artist-name');
  const trackEl  = document.getElementById('track-title');
  const albumEl  = document.getElementById('album-link');
  const fileInfoText = document.getElementById('file-info-text');
  const hiresBadge = document.getElementById('hires-badge');
  const personnelEl = document.getElementById('personnel-info');
  const progressFill = document.getElementById('progress-fill');
  const bgEl = document.getElementById('background-image');
  const artBgEl = document.getElementById('album-art-bg');
  const logoEl = document.getElementById('mode-logo');

  if (artistEl) artistEl.textContent = '';
  if (trackEl)  trackEl.textContent  = '';
  if (albumEl)  albumEl.textContent  = '';
  if (fileInfoText) fileInfoText.textContent = '';
  if (hiresBadge) {
    hiresBadge.textContent = 'Lossless';
    hiresBadge.style.display = 'none';
  }
  if (personnelEl) personnelEl.textContent = '';
  if (progressFill) progressFill.style.transform = 'scaleX(0)';

  if (bgEl) bgEl.style.backgroundImage = 'none';
  if (artBgEl) artBgEl.style.backgroundImage = 'none';

  if (logoEl) {
    logoEl.style.display = 'none';
    logoEl.removeAttribute('src');
  }
}