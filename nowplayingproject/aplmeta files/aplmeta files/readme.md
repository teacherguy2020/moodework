# moOde AirPlay Metadata + Artwork Pipeline (aplmeta.py)

This project improves moOde’s AirPlay metadata and cover-art handling by wiring **Shairport Sync metadata + cover cache** into a small pipeline that produces a single, stable **“Now Playing”** line file.

**Output file**
- `/var/local/www/aplmeta.txt`

**Format**

Title~~~Artist~~~Album~~~DurationMs~~~CoverUrl~~~CodecLabel

This file is consumed by:
- moOde’s AirPlay / Now Playing UI
- `index1080.html` display page
- Any external consumer that reads `aplmeta.txt`

—

## Goals

1. Reliable metadata across sources  
   (Apple Music, Podcasts, YouTube, Safari, etc.)
2. Reliable cover art  
   (no “flash then default”, no stale reuse)
3. Stable UI behavior  
   (no repeated restarts, no sudo prompts/errors)

—

## What Changed (Files)

—

## 1) `/etc/shairport-sync.conf`

### What changed

Explicitly enabled metadata output and cover-art caching:

```conf
metadata =
{
  enabled = “yes”;
  include_cover_art = “yes”;
  cover_art_cache_directory = “/var/local/www/imagesw/airplay-covers”;
  pipe_name = “/tmp/shairport-sync-metadata”;
};

AirPlay 2 remains on port 7000 (default, but may be explicit).

⸻

Why this was necessary (rationale)
	•	Enhanced aplmeta.py depends on the metadata pipe
/tmp/shairport-sync-metadata for:
	•	Title
	•	Artist
	•	Album
	•	Duration
	•	Picture events
	•	Shairport Sync exposes artwork through two paths:
	•	Metadata pipe → picture events
	•	Cover-art cache directory → cover-*.jpg files
	•	moOde’s stock behavior often appeared to work because:
	•	Metadata may have been enabled implicitly at compile time
	•	Some sources never required cover files
	•	moOde fell back gracefully to defaults
	•	The enhanced logic is stricter about:
	•	freshness
	•	timing
	•	PID reuse

Without explicitly enabling metadata + cover art, the pipeline becomes half-fed, causing default or stale artwork to appear.

⸻

Important notes
	•	If cover art does not appear:
	•	Check permissions on
/var/local/www/imagesw/airplay-covers
	•	If nqptp is missing:
	•	Ensure nqptp is installed and running
(required for AirPlay 2 timing)

⸻

2) /var/www/daemon/aplmeta-reader.sh

What it is

A shell pipeline that reads Shairport Sync metadata and feeds it into aplmeta.py.

Current flow

/tmp/shairport-sync-metadata
  → shairport-sync-metadata-reader
     → aplmeta.py
        → /var/local/www/aplmeta.txt
        (+ optional moOde FE update)


⸻

Why it exists (rationale)
	•	Shairport Sync writes structured metadata to a named pipe
	•	shairport-sync-metadata-reader converts it into readable lines like:
	•	Title: “...”
	•	Persistent ID: 0x...
	•	Picture received, length ... bytes.
	•	aplmeta.py consumes those lines and produces one stable output record

⸻

Key implementation details
	•	Uses a lock directory to prevent multiple pipelines
	•	Logs to:

/var/log/aplmeta-reader.log



⸻

3) /etc/systemd/system/aplmeta-reader.service

What it does

Runs the reader pipeline as a persistent systemd service.

Typical behavior
	•	Starts after:
	•	network
	•	shairport-sync
	•	nginx
	•	Automatically restarts if the pipeline exits

⸻

Why it matters (rationale)

moOde does not always start custom pipelines reliably on its own.

Using systemd provides:
	•	Reliable startup at boot
	•	Clean restarts
	•	Consistent logging and visibility

⸻

4) /var/www/util/aplmeta.py

What changed

This is the brains of the pipeline. Enhancements include:

⸻

A) Settle window
	•	Wait briefly after seeing Title before emitting
	•	Allows Artist, Album, PID, and Picture to arrive
	•	Reduces partial emits and artwork flashing

⸻

B) Fresh-cover rule
	•	Only use a cover file if its mtime is fresh relative to the track epoch
	•	Prevents Safari / YouTube from reusing old artwork

⸻

C) Cover-write grace poll
	•	If we’re about to emit default art only because the file isn’t written yet:
	•	Poll briefly for a fresh cover
	•	Fixes:
	•	first-track-after-reboot
	•	late-write cover scenarios

⸻

D) Sticky cover art
	•	Once artwork is locked for a track/session:
	•	Never downgrade to default due to ambiguous events
	•	Fixes:
	•	“Correct art appears briefly, then switches to default”

⸻

E) PID reuse / re-emit logic
	•	AirPlay can reuse persistent IDs on:
	•	resume
	•	reconnect
	•	Re-emits are allowed even if payload matches
	•	Lets the UI refresh correctly without artificial changes

⸻

Why this is better than stock behavior

Stock logic often worked for Apple Music and Podcasts because:
	•	Metadata ordering was consistent
	•	Events arrived together

But real-world AirPlay includes:
	•	Late-arriving artwork
	•	PID arriving after art
	•	Reconnects and resumes
	•	Incomplete metadata sources

This implementation explicitly handles timing and ordering issues.

⸻

Make Backups First!

⸻

Installation

1) Copy files into place

sudo cp shairport-sync.conf /etc/shairport-sync.conf

sudo cp aplmeta.py /var/www/util/aplmeta.py
sudo chmod +x /var/www/util/aplmeta.py

sudo cp aplmeta-reader.sh /var/www/daemon/aplmeta-reader.sh
sudo chmod +x /var/www/daemon/aplmeta-reader.sh

sudo cp aplmeta-reader.service /etc/systemd/system/aplmeta-reader.service


⸻

2) Reload systemd and restart services

sudo systemctl daemon-reload

sudo systemctl restart nqptp
sudo systemctl restart shairport-sync
sudo systemctl restart aplmeta-reader

sudo systemctl enable shairport-sync
sudo systemctl enable aplmeta-reader


⸻

Verification

Confirm AirPlay 2 listener

sudo ss -ltnp | grep -E ‘:7000\b’


⸻

Confirm pipeline processes

sudo systemctl status aplmeta-reader —no-pager
ps -o user,group,pid,cmd -C shairport-sync


⸻

Confirm metadata file updates

ls -l —time-style=full-iso /var/local/www/aplmeta.txt
tail -f /var/local/www/aplmeta.txt


⸻

Confirm Shairport metadata output

sudo cat /tmp/shairport-sync-metadata \
  | shairport-sync-metadata-reader -f \
  | head -n 40


⸻

Confirm cover cache writes

ls -l —time-style=full-iso /var/local/www/imagesw/airplay-covers | tail


