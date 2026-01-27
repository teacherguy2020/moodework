⸻


# moOde “Now Playing”

A distributed, high-performance **Now Playing** display system for **moOde Audio Player**, designed for a dedicated full-screen 1080p display (or viewable from any device on your network).

This project intentionally separates **audio playback**, **metadata processing**, and **display rendering** across three Raspberry Pi devices for stability, performance, and flexibility.

—

## System Architecture (Three Pis)

```text
┌────────────────────────┐
│ Pi #1 — moOde Player   │
│ (Audio playback)       │
│                        │
│ • MPD / moOde          │
│ • Music storage        │
│ • /command API         │
│ • aplmeta.txt (AirPlay)│
└─────────┬──────────────┘
          │ HTTP (JSON)
          ▼
┌────────────────────────┐
│ Pi #2 — API + Web Host │
│ (Logic + Metadata)     │
│                        │
│ • moode-nowplaying-api │  ← Port 3000 (JSON API)
│ • metaflac             │
│ • Metadata caching     │
│ • Static web server    │  ← Port 8000 (HTML / JS)
└─────────┬──────────────┘
          │ HTTP (HTML/JS)
          ▼
┌────────────────────────┐
│ Pi #3 — Display Node   │
│ (TV / Monitor)         │
│                        │
│ • Chromium kiosk       │
│ • index1080.html       │
│ • script1080.js        │
└────────────────────────┘
```

⸻

One-Line Mental Model (Important)
	•	Port 3000 = data (JSON)
	•	Port 8000 = pixels (HTML / JS)

The display never talks directly to moOde.
It only talks to Pi #2.

⸻
```
Playback Modes & Behavior

Mode	Source	Album Art (Primary → Fallback)	Ratings	Progress	Notes
Local	MPD file	Embedded → folder → coverart.php	✅ Yes	✅ Yes	Full metadata + stickers
Radio	Stream URL	iTunes lookup → station logo	❌ No	❌ No	Album/year from iTunes
UPnP	MPD stream	Resolved local file → coverart.php	❌ No	❌ No	Treated as stream
AirPlay	Shairplay	aplmeta cover → API proxy / fallback	❌ No	❌ No	LAN-only raw art

This behavior is intentional and enforced consistently by both the API and UI.
```
⸻

Roles of Each Raspberry Pi

Pi #1 — moOde Player (Audio Only)
	•	Runs moOde Audio Player
	•	Handles all audio playback
	•	Hosts the music library
	•	Exposes moOde APIs used by Pi #2:
	•	/command/?cmd=get_currentsong
	•	/command/?cmd=status
	•	/var/local/www/aplmeta.txt (AirPlay metadata/art pipeline output)

This Pi runs no custom code for this project.
It just moOdes.

If Pi #2 needs access to local files, use Samba or NFS, or attach storage directly.

⸻

Pi #2 — API + Web Server (The Brains)

This is where all logic lives.

Responsibilities:
	•	Queries Pi #1 for playback state
	•	Reads deep metadata directly from audio files
	•	Normalizes output across:
	•	local files
	•	radio streams
	•	UPnP
	•	AirPlay
	•	Caches metadata and artwork
	•	Serves:
	•	JSON API → Port 3000
	•	Static UI → Port 8000

Key components:
	•	moode-nowplaying-api.mjs (Node / Express)
	•	metaflac
	•	Static web server (no backend logic)

⸻

Pi #3 — Display / Kiosk (Optional)
	•	Connected to a TV or monitor
	•	Runs Chromium in kiosk mode
	•	Loads UI from Pi #2:

http://<PI2_IP>:8000/index1080.html

No metadata logic.
No audio.
No local files required.

You may skip Pi #3 entirely and view the display from any device.

⸻

Project Files

File	Runs on	Purpose
moode-nowplaying-api.mjs	Pi #2	Aggregates moOde + metadata into JSON
index1080.html	Pi #2	1080p fullscreen UI
script1080.js	Pi #2	UI logic (polling, art, progress, cache)
images/airplay.png	Pi #2	Branding / fallback art


⸻

Networking Requirements
	•	All Pis must be on the same LAN
	•	Optional Alexa integration requires:
	•	HTTPS
	•	Public domain or secure tunnel to Pi #2

⸻

Pi #2 Setup (API + Web Server)

Install dependencies

sudo apt update
sudo apt install -y nodejs npm flac

Verify:

node —version
metaflac —version


⸻

Music Library Access (Important)

Pi #2 must have read access to the same music files used by moOde.

Common approaches:
	•	USB drive attached to Pi #2
	•	Samba / NFS mount from Pi #1

The API maps moOde paths (e.g. USB/Drive/...) to Pi #2 paths (e.g. /mnt/Drive/...).
Configure this mapping in moode-nowplaying-api.mjs.

⸻

Configure IP Addresses

Edit moode-nowplaying-api.mjs:
	•	MOODE_BASE_URL → http://<PI1_IP>
	•	Bind/listen address → <PI2_IP>

⸻

Start API Server (Port 3000)

Manual:

node moode-nowplaying-api.mjs

With PM2 (recommended):

sudo npm install -g pm2
pm2 start moode-nowplaying-api.mjs —name moode-now-playing
pm2 save

Test:

curl http://<PI2_IP>:3000/now-playing | jq


⸻

Web Server (Port 8000)

Recommended Static Server

python3 -m http.server 8000

Why:
	•	near-zero CPU
	•	no configuration
	•	stable for kiosk use

Test:

curl http://<PI2_IP>:8000/index1080.html

⚠️ Do not serve the UI from port 3000
Port 3000 is a JSON API only. Subtle browser failures will occur.

⸻

Viewing the Display

Any device:

http://<PI2_IP>:8000/index1080.html

Chromium kiosk:

chromium \
  —kiosk \
  —disable-infobars \
  —noerrdialogs \
  —disable-session-crashed-bubble \
  http://<PI2_IP>:8000/index1080.html

Hide mouse:

unclutter -idle 0 &


⸻

AirPlay Artwork (Important)

AirPlay metadata and cover art are produced by moOde via:

/var/local/www/aplmeta.txt

Behavior:
	•	LAN access: UI may load AirPlay cover images directly
	•	Public HTTPS access: raw AirPlay URLs are blocked (mixed content)

In public mode:
	•	Art is proxied and normalized via Pi #2 when possible
	•	Otherwise the UI falls back gracefully

This behavior is intentional.

⸻

MPD Stickers (Required for Track Ratings)

Ratings are stored using MPD stickers.

Why:
	•	Persistent
	•	File-scoped
	•	No audio file modification

Required MPD config:

sticker_file “/var/lib/mpd/sticker.sql”

Verify:

ls -l /var/lib/mpd/sticker.sql

Sticker key used:

rating (0–5)

Examples:

mpc sticker set song “/path/file.flac” rating 4
mpc sticker get song “/path/file.flac” rating

Ratings are automatically disabled for:
	•	Radio
	•	UPnP
	•	AirPlay

⭐ Audio files are never modified.

⸻

Why Three Pis?

Stability
Audio playback isolated from UI crashes

Performance
No JS load on moOde Pi

Flexibility
UI and display can reboot independently

⸻

Tested With
	•	moOde Audio Player 8.x
	•	Raspberry Pi 3B+, 4, 5
	•	Chromium kiosk (ARM)
	•	Safari (iOS)
	•	Chrome (desktop)
	•	Local FLAC, Radio, UPnP, AirPlay

⸻

Troubleshooting (Common)
	•	Alexa plays nothing
	•	Verify HTTPS
	•	Verify /track endpoint
	•	Verify key
	•	Queue out of sync
	•	Confirm PlaybackStarted calls /queue/advance
	•	Check dedup timing
	•	Missing art on Echo
	•	Some devices require audioItem.metadata.art.sources
	•	Prefer per-track URLs over “current” art

⸻
