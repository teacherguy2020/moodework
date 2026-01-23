'use strict';

const express = require('express');
const path = require('path');
const http = require('http');

const app = express();
const PORT = 8000;

// ------------------------
// Middleware
// ------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ------------------------
// Config
// ------------------------
const MOODE_HOST = '10.0.0.254';
const MOODE_PATH = '/command/?cmd=';

// Set this in the environment when starting node:
// export WEB_API_KEY='long-random-string'
const API_KEY = process.env.WEB_API_KEY || '';

// ------------------------
// Simple API auth middleware
// ------------------------
app.use('/api', (req, res, next) => {
  // If you forgot to set the key, we fail closed for safety.
  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Server misconfigured: WEB_API_KEY env var is not set'
    });
  }

  const key = req.get('X-Api-Key');
  if (key !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// ------------------------
// moOde command helper
// ------------------------
function moodeCmd(cmd) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: MOODE_HOST,
        path: MOODE_PATH + encodeURIComponent(cmd),
        timeout: 4000
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`moOde HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('moOde request timeout')));
    req.end();
  });
}

async function getMoodeStatus() {
  // reads currentsong.txt (Audio Config -> MPD options -> Metadata file)
  return moodeCmd('get_currentsong');
}

// ------------------------
// API routes
// ------------------------

// Status
app.get('/api/moode/status', async (req, res) => {
  try {
    const status = await getMoodeStatus();
    res.json(status);
  } catch (e) {
    console.error('status error:', e);
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// Ensure playing (uses toggle only when needed)
app.post('/api/moode/ensure_playing', async (req, res) => {
  try {
    const status = await getMoodeStatus();
    const state = String(status.state || '').toLowerCase();

    if (state === 'play') {
      return res.json({ ok: true, action: 'noop', state });
    }

    const out = await moodeCmd('toggle_play_pause');
    return res.json({
      ok: true,
      action: 'toggle_play_pause',
      before: state || 'unknown',
      after: (out && out.state) ? out.state : 'unknown',
      out
    });
  } catch (e) {
    console.error('ensure_playing error:', e);
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// Ensure paused (uses toggle only when needed)
app.post('/api/moode/ensure_paused', async (req, res) => {
  try {
    const status = await getMoodeStatus();
    const state = String(status.state || '').toLowerCase();

    if (state !== 'play') {
      return res.json({ ok: true, action: 'noop', state: state || 'unknown' });
    }

    const out = await moodeCmd('toggle_play_pause');
    return res.json({
      ok: true,
      action: 'toggle_play_pause',
      before: state,
      after: (out && out.state) ? out.state : 'unknown',
      out
    });
  } catch (e) {
    console.error('ensure_paused error:', e);
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// NEXT track
app.post('/api/moode/next', async (req, res) => {
  try {
    const out = await moodeCmd('next'); // moOde returns {"0":"OK"} for next
    return res.json({ ok: true, action: 'next', out });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

// PREVIOUS track
app.post('/api/moode/prev', async (req, res) => {
  try {
    const out = await moodeCmd('prev');
    return res.json({ ok: true, action: 'prev', out });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

// Play item (Playlist / Album / Track / Radio)
// POST /api/moode/play_item
// Body: { "item": "Metheny Mornings" }
app.post('/api/moode/play_item', async (req, res) => {
  try {
    const item = (req.body && req.body.item ? String(req.body.item) : '').trim();
    if (!item) {
      return res.status(400).json({ ok: false, error: 'Missing item' });
    }

    const cmd = `play_item ${item}`;
    const out = await moodeCmd(cmd);

    return res.json({
      ok: true,
      action: 'play_item',
      item,
      out
    });
  } catch (err) {
    console.error('play_item error:', err);
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

// Health check (no auth)
app.get('/healthz', (req, res) => {
  res.type('text').send('OK');
});

// ------------------------
// Static site
// ------------------------
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ------------------------
// Listen
// ------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log('Album art web server running');
  console.log(`Site: http://10.0.0.233:${PORT}/index.html`);
  console.log(`API:  http://10.0.0.233:${PORT}/api/moode/status  (requires X-Api-Key)`);
});
