# moOde “Now Playing”

A distributed, high-performance **Now Playing** display and control system for **moOde Audio Player**, designed for a dedicated full-screen 1080p display — but viewable from **any device on your network**. (could use some help creating various @media views).

This project intentionally separates:

- **Audio playback**
- **Metadata processing**
- **UI rendering**
- **(Optionally) Alexa voice control**

across multiple Raspberry Pi nodes for **stability, performance, and flexibility**.

---

## One-Line Mental Model (Important)

- Web Host Pi **Port 3000 = data** (JSON, logic, metadata, art generation)
- Web Host Pi **Port 8000 = pixels** (HTML / JS only)

> The display never talks directly to moOde.  
> It only talks to the API node.

---
```
## System Architecture (Three Pis)

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
│ • moode-nowplaying-api │  ← Port 3000
│ • Artwork processing  │
│ • Metadata caching    │
│ • Static web server   │  ← Port 8000
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

Roles of Each Raspberry Pi

Pi #1 — moOde Player (Audio Only)
	•	Runs moOde Audio Player
	•	Handles all audio playback
	•	Hosts the music library
	•	Exposes:
	•	/command/?cmd=get_currentsong
	•	/command/?cmd=status
	•	/var/local/www/aplmeta.txt (AirPlay metadata + cover output)

This Pi runs no custom code for this project.
It just moOdes.

If Pi #2 needs file access, use USB, Samba, or NFS.

⸻

Pi #2 — API + Web Server (The Brains)

This is where all logic lives.

Responsibilities:
	•	Query moOde for playback state
	•	Read deep metadata from local audio files
	•	Normalize output for:
	•	local files
	•	radio streams
	•	UPnP
	•	AirPlay
	•	Resolve and cache album artwork
	•	Serve:
	•	JSON API → Port 3000
	•	Static UI → Port 8000
	•	(Optionally) act as the Alexa integration endpoint

Key components:
	•	moode-nowplaying-api.mjs (Node / Express)
	•	metaflac
	•	Static web server

⸻

Pi #3 — Display / Kiosk (Optional)
	•	Connected to a TV or monitor
	•	Runs Chromium in kiosk mode
	•	Loads the UI from Pi #2:

http://<PI2_IP>:8000/index1080.html

No metadata logic.
No audio.
No local files.

You can skip Pi #3 entirely and view the display from any browser.

⸻
```
Playback Modes & Behavior

| Mode    | Artwork Quality       | Ratings | Progress | Notes                              |
|---------|-----------------------|---------|----------|------------------------------------|
| Local   | Strongest             | ✅ Yes  | ✅ Yes   | Deep file metadata + MPD stickers  |
| Radio   | Strong                | Hidden  | Hidden   | iTunes art- album/year text        |
| UPnP    | Moderate              | Hidden  | Hidden   | Treated as stream                  |
| AirPlay | Strong                | Hidden  | Hidden   | LAN art + HTTPS-safe fallback      |
|---------|-----------------------|---------|----------|------------------------------------|
In all modes, the web display strives for a consistent presentation of metadata
```
⸻

Project Files

File	Runs On	Purpose
moode-nowplaying-api.mjs	Pi #2	Aggregates playback + metadata into JSON
index1080.html	Pi #2	Fullscreen 1080p UI
script1080.js	Pi #2	UI logic, polling, animation
images/*.png	Pi #2	Mode icons / fallback art


⸻

Networking Requirements

All Pis must be on the same LAN.

If Alexa integration is enabled:
	•	Pi #2 must also be reachable over HTTPS from the internet
	•	Use a domain you control or a secure tunnel

⸻

Pi #2 Setup (API + Web Server)

Install dependencies

sudo apt update
sudo apt install -y nodejs npm flac

Verify:

node --version
metaflac --version


⸻

Music Library Access (Important)

Pi #2 must have read access to the same files moOde plays.

Common setups:
	•	USB drive attached to Pi #2
	•	Samba / NFS mount from Pi #1

Paths reported by moOde (e.g. USB/Drive/...) must be mapped to Pi #2 mount paths in moode-nowplaying-api.mjs.

⸻

Configure IPs

Edit moode-nowplaying-api.mjs:
	•	MOODE_BASE_URL → http://<PI1_IP>
	•	Bind address → <PI2_IP>

⸻

Start the API (Port 3000)

Manual:

node moode-nowplaying-api.mjs

Recommended (PM2):

sudo npm install -g pm2
pm2 start moode-nowplaying-api.mjs --name moode-now-playing
pm2 save

Test:

curl http://<PI2_IP>:3000/now-playing | jq


⸻

Static Web Server (Port 8000)

The UI server serves static files only.

Recommended:

python3 -m http.server 8000

This is:
	•	Stable
	•	Low-CPU
	•	Perfect for kiosks

Test:

curl http://<PI2_IP>:8000/index1080.html


⸻

Display / Kiosk Mode

chromium \
  --kiosk \
  --disable-infobars \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  http://<PI2_IP>:8000/index1080.html

Hide cursor:

unclutter -idle 0 &


⸻

Optional: Alexa Skill Integration (First-Class Feature)

This project includes a fully supported Alexa Skill integration that allows Echo devices to:
	•	Play the current moOde track
	•	Answer “what’s playing?”
	•	Pause / resume
	•	Advance tracks
	•	Stay synchronized with MPD

Key Principle

Alexa never talks directly to moOde.
All coordination goes through Pi #2.

This keeps:
	•	MPD authoritative
	•	Alexa stateless
	•	Queue state correct
	•	Art + metadata aligned everywhere

⸻

Alexa Architecture

Echo Device
    │
    ▼
AWS Lambda (Alexa Skill)
    │ HTTPS
    ▼
Pi #2 — Node API
    │
    ▼
Pi #1 — moOde / MPD


⸻

Required API Endpoints (Pi #2)

Public
	•	GET /now-playing

Key-Protected
	•	GET /track?file=<mpd_file>&k=<key>[&t=<seconds>]
	•	POST /queue/advance?k=<key>&pos0=<pos0>[&file=<file>]

⸻

Token Design (Critical)

Tokens are base64url JSON:

{
  "file": "USB/Drive/Album/track.flac",
  "pos0": 128
}

Used to:
	•	Deduplicate Alexa events
	•	Detect resume vs fresh play
	•	Carry MPD queue position

⸻

HTTPS Requirement

Alexa requires HTTPS audio URLs.

Typical base:

https://moode.YOURDOMAIN.com


⸻

Lambda Environment Variables

Required:
	•	MOODE_API_BASE
	•	TRACK_KEY

Optional:
	•	META_STABLE_GAP_MS
	•	NEXT_ENQUEUE_GAP_MS

⸻

MPD Stickers (Required for Ratings)

Ratings use MPD stickers, not file tags.

Required config:

sticker_file "/var/lib/mpd/sticker.sql"

Ratings:
	•	Apply only to local files
	•	Never modify audio files
	•	Are hidden automatically for radio / AirPlay

⸻

Common Pitfalls
	•	Don’t open index1080.html via file://
	•	Don’t serve UI from port 3000
	•	Don’t point UI directly at moOde
	•	Don’t expect ratings on streams

⸻

Why This Architecture?
	•	Audio isolated from UI crashes
	•	No heavy JS on moOde Pi
	•	Displays can reboot independently
	•	Alexa stays sane

⸻
![Display](./now-playing.jpeg)
