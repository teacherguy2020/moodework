// script1080.js — DROP-IN (v1.1: classical composer/work split + instrument abbreviation expansion)
//
// Keeps your 1.0 behavior, with two additions:
// 1) Classical formatting: if the "artist" side of an "A - B" split contains "Composer: Work",
//    show Composer on the top line, and Work on the 2nd line (followed by the rest).
// 2) Expands common orchestral instrument abbreviations (vi, vc, p, ob, etc.) anywhere we display text.
//
// Still includes:
// - Mode logo updated EVERY poll (radio station icon OR airplay.png)
// - AirPlay MPD state="stop" safe (won't clear UI)
// - Progress bar hidden for radio + AirPlay

const NOW_PLAYING_URL = 'http://YOURFLASKSERVERIP:3000/now-playing';
const AIRPLAY_ICON_URL = 'http://YOURWEBSERVERIP:8000/airplay.png?v=1';

let currentTrackKey = '';
let lastAlbumArtUrl = '';
let lastPercent = -1;

// Radio memory (keyed by station/stream)
const radioState = {
  key: '',
  recentTitles: [],
};

window.addEventListener('load', () => {
  attachClickEventToAlbumArt();
  fetchNowPlaying();
  setInterval(fetchNowPlaying, 1000);
});

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
      const mpdPlaying = (state === 'play' || state === 'playing');

      if (!mpdPlaying && !isAirplay) {
        clearUI();
        return;
      }

      // Hide progress for radio and AirPlay
      setProgressVisibility(isStream || isAirplay);

      if (!isStream && !isAirplay) {
        if (typeof data.percent === 'number') {
          updateProgressBarPercent(data.percent);
        } else if (typeof data.elapsed === 'number' && typeof data.duration === 'number' && data.duration > 0) {
          updateProgressBarPercent(Math.round((data.elapsed / data.duration) * 100));
        }
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

      if (!isStream) {
        if (baseKey !== currentTrackKey) {
          currentTrackKey = baseKey;
          updateUI(data);
        }
        return;
      }

      const stabilized = stabilizeRadioDisplay(data);
      const radioKey = `${baseKey}|${stabilized.artist}|${stabilized.title}`;

      if (radioKey !== currentTrackKey) {
        currentTrackKey = radioKey;
        updateUI({ ...data, _radioDisplay: stabilized });
      }
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
    // Matches tokens like:
    // ", vi;"  ", vi)"  " vi;"  " vi,"  " vi" (end)  ", p -"  ", cl -"
    const re = new RegExp(
      `([,;\\s])${abbr}(?=\\s*(?:[;,)\\]]|\\-|$))`,
      'gi'
    );
    s = s.replace(re, `$1${full}`);
  }

  // Ensure exactly one space around separator hyphens
  // (prevents "p- Mozart" or "p -Mozart" variants)
  s = s.replace(/\s*-\s*/g, ' - ');

  // Optional: collapse any doubles created by replacements
  s = s.replace(/\s{2,}/g, ' ').trim();

  return s;
}

/* =========================
 * Radio stabilization + classical split
 * ========================= */

function stabilizeRadioDisplay(data) {
  const stationKey = `${data.file}|${data.album || ''}`;
  const incomingRaw = decodeHtmlEntities(String(data.title || '').trim());
  const incoming = incomingRaw; // (already decoded)

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
    // Classical nicety:
    // If left side contains "Composer: Work", split on first colon to make:
    // Artist = Composer, Title = Work — (rest of dashSplit.title)
    const left = dashSplit.artist || '';
    const right = dashSplit.title || '';

    const colonIdx = left.indexOf(':');
    if (colonIdx > 0) {
      const composer = left.slice(0, colonIdx).trim();
      const work = left.slice(colonIdx + 1).trim();

      // Heuristic: only do this when it looks like a real composer name (keeps pop stations unchanged)
      // (Composer names usually have at least 2 words and a capital start)
      const looksComposer = /^[A-ZÀ-ÖØ-Þ]/.test(composer) && composer.split(/\s+/).length >= 2;

      if (looksComposer && work) {
        return {
          artist: composer,
          title: right ? `${work} — ${right}` : work
        };
      }
    }

    return dashSplit;
  }

  // Fallback logic from your 1.0 (helpful for some classical station flip-flops)
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
  // Personnel (unchanged)
  // ----------------------------
  if (personnelEl) {
    if (isStream || isAirplay) {
      personnelEl.textContent = '';
    } else {
      const personnel = Array.isArray(data.personnel) ? data.personnel : [];
      const producer = (data.producer && String(data.producer).trim())
        ? [`Producer: ${String(data.producer).trim()}`]
        : [];
      const combined = [...personnel, ...producer].filter(Boolean)
        .map(expandInstrumentAbbrevs);
      personnelEl.textContent = combined.length ? decodeHtmlEntities(combined.join(' • ')) : '';
    }
  }

  // ----------------------------
  // Art (unchanged)
  // ----------------------------
  const newArtUrl =
    (data.altArtUrl && String(data.altArtUrl).trim())
      ? String(data.altArtUrl).trim()
      : (data.albumArtUrl || '');

  const artChanged = newArtUrl && newArtUrl !== lastAlbumArtUrl;

  if (artChanged) {
    lastAlbumArtUrl = newArtUrl;

    if (artEl) artEl.src = newArtUrl;
    if (bgEl) bgEl.style.backgroundImage = `url("${newArtUrl}")`;

    if (artBgEl) {
      artBgEl.style.backgroundImage = `url("${newArtUrl}")`;
      artBgEl.style.backgroundSize = 'cover';
      artBgEl.style.backgroundPosition = 'center';
    }
  }
}

function updateProgressBarPercent(percent) {
  const progressFill = document.getElementById('progress-fill');
  if (!progressFill) return;

  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  if (clamped === lastPercent) return;
  lastPercent = clamped;

  progressFill.style.width = `${clamped}%`;
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
  if (progressFill) progressFill.style.width = '0%';
  if (bgEl) bgEl.style.backgroundImage = 'none';
  if (artBgEl) artBgEl.style.backgroundImage = 'none';
  if (logoEl) {
    logoEl.style.display = 'none';
    logoEl.removeAttribute('src');
  }
}