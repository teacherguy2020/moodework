moOde “Now Playing”

A distributed, high-performance Now Playing display system for moOde Audio Player, designed for a dedicated full-screen 1080p display (or viewable from any device on your network).

This project intentionally separates audio playback, metadata processing, and display rendering across three Raspberry Pi devices for stability, performance, and flexibility.

⸻
```
System Architecture (Three Pis)

┌────────────────────────┐
│ Pi #1 — moOde Player   │
│ (Audio playback)       │
│                        │
│ • MPD / moOde          │
│ • Music storage        │
│ • /command API         │
└─────────┬──────────────┘
          │ HTTP (JSON)
          ▼
┌────────────────────────┐
│ Pi #2 — API + Web Host │
│ (Logic + Metadata)     │
│                        │
│ • server.mjs (Node)    │  ← Port 3000 (JSON API)
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

Port 3000 = data (JSON)
Port 8000 = pixels (HTML / JS)

The display never talks directly to moOde.
It only talks to Pi #2.

⸻

Roles of Each Raspberry Pi

⸻

Pi #1 — moOde Player (Audio Only)
	•	Runs moOde Audio Player
	•	Handles all audio playback
	•	Hosts the music library
	•	Exposes moOde APIs:
	•	/command/?cmd=get_currentsong
	•	/command/?cmd=status
	•	/aplmeta.txt (AirPlay)

This Pi runs no custom code for this project.
It just moOdes.

💡 Remember to set up Samba or NFS if Pi #2 needs access to the music files.

⸻

Pi #2 — API + Web Server (The Brains)

This is where all logic lives.

Responsibilities:
	•	Queries Pi #1 (moOde) for playback status
	•	Reads deep metadata directly from music files
	•	Normalizes output for:
	•	Local files
	•	Radio streams
	•	AirPlay
	•	Caches metadata and artwork
	•	Serves two things:
	•	JSON API → Port 3000
	•	Static web UI → Port 8000

Key components:
	•	server.mjs (Node / Express)
	•	metaflac
	•	A simple static web server

⸻

Pi #3 — Display / Kiosk (Optional)
	•	Connected to a TV or monitor
	•	Runs Chromium in kiosk mode
	•	Loads the UI from Pi #2:

http://<PI2_IP>:8000/index1080.html

	•	No metadata logic
	•	No audio
	•	No local files required

You can skip Pi #3 entirely and view the display from any computer or tablet.

⸻
```
Project Files

File             Location   Purpose
—————————————————
server.mjs       Pi #2      Aggregates moOde data + metadata
index1080.html   Pi #2      1080p fullscreen UI
script1080.js    Pi #2      UI logic, progress bar, caching
airplay.png      Pi #2      Fallback artwork for AirPlay
```
⸻

Networking Requirements

All devices must be on the same LAN.

⸻

Pi #2 Setup (API + Web Server)

Install Dependencies

sudo apt update
sudo apt install -y nodejs npm flac

Verify:
```
node —version
metaflac —version
```

⸻

Music Library Access (IMPORTANT)

Pi #2 must have read access to the same music files used by moOde.

Common approaches:
	•	USB drive attached to Pi #2
	•	Samba / NFS mount from Pi #1

server.mjs assumes:

MOODE_USB_PREFIX = ‘USB/YOURMUSICDRIVE/‘
PI4_MOUNT_BASE  = ‘/mnt/YOURMUSICDRIVE’

These must match how moOde reports file paths.

⸻

Configure IP Addresses

Edit server.mjs:

const MOODE_BASE_URL = ‘http://<PI1_MOODE_IP>’;
const LOCAL_ADDRESS = ‘<PI2_IP>’;


⸻

Start the API Server (Port 3000)

Run manually:

node server.mjs

Or use PM2 (recommended):

npm install -g pm2
pm2 start server.mjs —name moode-now-playing
pm2 save

Test:
```
  curl http://<PI2_IP>:3000/now-playing | jq 
```

⸻

About the Web Server (Port 8000)

What This Server Does

The web server only serves static files:
	•	index1080.html
	•	script1080.js
	•	images (e.g. airplay.png)

There is no backend logic here.

⸻

The Simplest (Recommended) Web Server

From the directory containing the UI files:
```
python3 -m http.server 8000

```
That’s it.

This:
	•	Uses almost no CPU
	•	Is stable for always-on displays
	•	Requires zero configuration
	•	Is perfectly adequate

Test:
```
curl http://<PI2_IP>:8000/index1080.html

```
⸻

Viewing the Display

From any device:

http://<PI2_IP>:8000/index1080.html

From the display Pi (Chromium kiosk):

```
   chromium \
  —kiosk \
  —disable-infobars \
  —noerrdialogs \
  —disable-session-crashed-bubble \
  http://<PI2_IP>:8000/index1080.html
  
```
Hide mouse cursor:

unclutter -idle 0 &


⸻

Common Pitfalls

⚠️ Avoid these mistakes
	•	Don’t open index1080.html via file://
	•	Don’t run the web server on Pi #3
	•	Don’t point the UI directly at moOde
	•	Don’t serve the UI from port 3000

⸻

Why Three Pis?

Stability
	•	Audio playback isolated from UI crashes

Performance
	•	No Chromium or heavy JS on the moOde Pi

Flexibility
	•	Display can reboot independently
	•	UI can be redesigned without touching playback

Silence
	•	No unnecessary services on the audio Pi

