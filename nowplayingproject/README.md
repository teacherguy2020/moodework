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


⸻

One-Line Mental Model (Important)
	•	Port 3000 = data (JSON)
	•	Port 8000 = pixels (HTML / JS)

The display never talks directly to moOde.
It only talks to Pi #2.

⸻

Roles of Each Raspberry Pi

Pi #1 — moOde Player (Audio Only)
	•	Runs moOde Audio Player
	•	Handles all audio playback
	•	Hosts the music library
	•	Exposes moOde APIs used by Pi #2:
	•	/command/?cmd=get_currentsong
	•	/command/?cmd=status
	•	/var/local/www/aplmeta.txt (AirPlay metadata/cover pipeline output)

This Pi runs no custom code for this project. It just moOdes.

If Pi #2 needs access to local files, set up Samba or NFS (or attach the library to Pi #2).

⸻

Pi #2 — API + Web Server (The Brains)

This is where all logic lives.

Responsibilities:
	•	Queries Pi #1 (moOde) for playback status
	•	Reads deep metadata directly from music files (when applicable)
	•	Normalizes output for:
	•	local files
	•	radio streams
	•	AirPlay
	•	Caches metadata and artwork
	•	Serves two things:
	•	JSON API → Port 3000
	•	Static web UI → Port 8000

Key components:
	•	moode-nowplaying-api.mjs (Node / Express) (renamed from webserver.mjs)
	•	metaflac
	•	A simple static web server

⸻

Pi #3 — Display / Kiosk (Optional)
	•	Connected to a TV or monitor
	•	Runs Chromium in kiosk mode
	•	Loads the UI from Pi #2:

http://<PI2_IP>:8000/index1080.html

No metadata logic, no audio, no local files required.

You can skip Pi #3 entirely and view the display from any computer, tablet, or phone.

⸻

Project Files

File                          Runs on   Purpose
—————————————————————————————————————————————————————————————
moode-nowplaying-api.mjs       Pi #2     Aggregates moOde state + metadata into JSON
index1080.html                 Pi #2     1080p fullscreen UI
script1080.js                  Pi #2     UI logic (polling, progress bar, caching)
images/airplay.png             Pi #2     Fallback/branding artwork (optional)


⸻

Networking Requirements

All devices must be on the same LAN for the 3-Pi display stack.

If you enable the optional Alexa integration (below), Pi #2 must also be reachable over HTTPS from the internet at a domain you control (or via a secure tunnel).

⸻

Pi #2 Setup (API + Web Server)

Install dependencies

sudo apt update
sudo apt install -y nodejs npm flac

Verify:

node —version
metaflac —version


⸻

Music library access (IMPORTANT)

Pi #2 must have read access to the same music files used by moOde.

Common approaches:
	•	USB drive attached to Pi #2
	•	Samba / NFS mount from Pi #1

The Node service needs to map moOde-reported paths (e.g., USB/YourDrive/...) to Pi #2 mount paths (e.g., /mnt/YourDrive/...). Configure this in moode-nowplaying-api.mjs.

⸻

Configure IP addresses

Edit moode-nowplaying-api.mjs:
	•	MOODE_BASE_URL → http://<PI1_MOODE_IP>
	•	any bind/address settings → <PI2_IP>

⸻

Start the API server (Port 3000)

Run manually:

node moode-nowplaying-api.mjs

Or use PM2 (recommended):

sudo npm install -g pm2
pm2 start moode-nowplaying-api.mjs —name moode-now-playing
pm2 save

Test:

curl http://<PI2_IP>:3000/now-playing | jq


⸻

About the Web Server (Port 8000)

What this server does

The web server serves only static files:
	•	index1080.html
	•	script1080.js
	•	images

There is no backend logic in the static server.

⸻

The simplest (recommended) web server

From the directory containing the UI files:

python3 -m http.server 8000

This:
	•	uses almost no CPU
	•	is stable for always-on displays
	•	requires zero configuration
	•	is perfectly adequate

Test:

curl http://<PI2_IP>:8000/index1080.html


⸻

Viewing the Display

From any device:

http://<PI2_IP>:8000/index1080.html

From the display Pi (Chromium kiosk):

chromium \
  —kiosk \
  —disable-infobars \
  —noerrdialogs \
  —disable-session-crashed-bubble \
  http://<PI2_IP>:8000/index1080.html

Hide mouse cursor:

unclutter -idle 0 &


⸻

Common Pitfalls

Avoid these mistakes:
	•	Don’t open index1080.html via file://
	•	Don’t run the web server on Pi #3
	•	Don’t point the UI directly at moOde
	•	Don’t serve the UI from port 3000

⸻

Why Three Pis?

Stability
	•	Audio playback isolated from UI crashes

Performance
	•	No heavy JS on the moOde Pi

Flexibility
	•	Display can reboot independently
	•	UI can be redesigned without touching playback

⸻

Optional: Alexa Skill + AWS Lambda (Voice Control + Echo Playback)

This project can optionally include an Alexa Skill backed by AWS Lambda to:
	•	play the current moOde track on an Echo device,
	•	answer “what’s playing?”,
	•	handle pause/resume/next,
	•	and coordinate MPD queue advancement so Alexa playback stays aligned.

High-level idea
	•	Pi #2 hosts the public-facing API used by Alexa (HTTPS).
	•	AWS Lambda runs the Alexa Skill logic.
	•	Lambda calls Pi #2 endpoints such as:
	•	GET /now-playing (no key)
	•	GET /track?file=...&k=... (requires key; returns an audio stream URL)
	•	POST /queue/advance?k=...&pos0=... (advances MPD queue when Alexa starts playback)

This keeps Lambda “stateless-ish” and keeps queue authority in the Node service on Pi #2.

Alexa devices generally require HTTPS for audio URLs.
Typical base: https://moode.YOURDOMAINNAME.com

⸻

Required endpoints on Pi #2 (Node API)

Public / no key
	•	GET /now-playing
Returns normalized “Now Playing” JSON (title/artist/album/file/songpos/art URLs/etc).

Key required
	•	GET /track?file=<mpd_file>&k=<key>[&t=<seconds>]
Produces an HTTPS stream that Alexa can play.
	•	POST /queue/advance?k=<key>&pos0=<pos0>[&file=<file>]
Tells the server to advance the MPD queue to keep the “next” logic correct.

⸻

Lambda environment variables

Set these in the Lambda console (Configuration → Environment variables):

Core:
	•	MOODE_API_BASE
Example: https://moode.YOURDOMAINNAME.com

Optional paths:
	•	NOW_PLAYING_PATH (default /now-playing)
	•	TRACK_PATH (default /track)
	•	QUEUE_ADVANCE_PATH (default /queue/advance)

Secret:
	•	TRACK_KEY (required)
Shared secret used by /track and /queue/advance.

Timing / tuning (optional):
	•	META_STABLE_GAP_MS (default 250)
	•	NEXT_ENQUEUE_GAP_MS (default 5000)

⸻

What the Alexa Skill does (behavior)

LaunchRequest (“Alexa, open moode”)
	1.	Lambda calls GET /now-playing
	2.	Builds AudioPlayer.Play with REPLACE_ALL
	3.	Points Alexa to /track?file=...&k=...
	4.	Includes metadata/art (title/subtitle/art sources)

NowPlayingIntent (“Alexa, what’s playing?”)
	1.	Lambda calls GET /now-playing
	2.	Speaks: “Now playing  by ”

Pause / Stop
	•	Sends AudioPlayer.Stop

Resume
	•	If Lambda has a stored token/offset → resumes using the same token + offset
	•	Otherwise falls back to “play current now-playing from 0”

Next
	•	Currently implemented as a “play the current now-playing snapshot” (REPLACE_ALL)
	•	Queue mutation is handled via the playback event flow below

⸻

AudioPlayer event flow (the important part)

Alexa sends playback lifecycle events. This Skill uses them to keep MPD aligned.

PlaybackStarted → advance MPD

When Alexa actually begins playing a track, Lambda:
	1.	Parses the token to extract pos0 and file
	2.	Calls:
POST /queue/advance?k=...&pos0=...&file=...
	3.	Deduplicates advances (token + time guard)

Also includes a resume guard:
	•	If the started token equals the last known token and offset > 0, it treats it as a resume and does not advance MPD.

PlaybackNearlyFinished → enqueue next

Before a track ends, Alexa emits NearlyFinished. Lambda:
	1.	Calls GET /now-playing (snapshot)
	2.	Builds AudioPlayer.Play with ENQUEUE
	3.	Sets expectedPreviousToken to the finished token
(both top-level and inside stream.expectedPreviousToken for device compatibility)
	4.	Deduplicates enqueues via NEXT_ENQUEUE_GAP_MS

PlaybackFinished
	•	No action (next should already be enqueued)

PlaybackStopped / PlaybackPaused / PlaybackFailed
	•	Stores token + offset for resume

⸻

Token format (why it exists)

Tokens are used to:
	•	deduplicate events (Alexa can send duplicates),
	•	detect resume vs fresh play,
	•	carry MPD queue position (pos0) so the server can advance correctly.

Token payload is base64url JSON:
	•	Prefix: moode-track:
	•	JSON example:

{ “file”: “USB/Drive/Album/track.flac”, “pos0”: 128 }



⸻

Security note

The /track endpoint includes a key in the query string because:
	•	Alexa must fetch an audio URL directly
	•	and it must be reliable across devices

Treat TRACK_KEY like a password:
	•	do not commit it to GitHub
	•	keep it in Lambda env vars (and on the server side)

⸻

Troubleshooting (common)
	•	Alexa plays nothing
	•	Confirm /track?... is reachable via HTTPS from the public internet
	•	Confirm certificate is valid
	•	Confirm the key matches
	•	Queue gets out of sync
	•	Confirm PlaybackStarted calls /queue/advance
	•	Confirm tokens include pos0
	•	Check for duplicate PlaybackStarted events (dedup window)
	•	Art/metadata missing on Echo
	•	Some devices require art in audioItem.metadata.art.sources
	•	Prefer per-track art URLs over “current/now-playing” art when possible

IMG_6007.jpeg