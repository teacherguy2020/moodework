#!/usr/bin/python3
#
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2014 The moOde audio player project / Tim Curtis
#
# aplmeta.py
# settle-window + fresh-cover + pid-aware + late-PID tolerant
# + cover-write grace poll
# + STICKY COVER ART (no downgrade within session)
#

import sys
import subprocess
import re
import os
import glob
import time
import select
from datetime import datetime

PGM_VERSION = "1.8.4-settlewindow-stickycover"
DEBUG = 0

COVERS_LOCAL_ROOT = "/var/local/www/imagesw/airplay-covers/"
COVERS_WEB_ROOT = "imagesw/airplay-covers/"
APLMETA_FILE = "/var/local/www/aplmeta.txt"
DEFAULT_COVER_WEB = "images/default-album-cover.png"

# -------- Tuning knobs --------
SETTLE_WINDOW_SEC = 1.3
MAX_WAIT_FOR_ART_SEC = 1.0
LATE_REFRESH_CUTOFF_SEC = 2.0
TRACK_EPOCH_GRACE_SEC = 2.5
LATE_PID_WINDOW_SEC = 3.0

COVER_POLL_MAX_SEC = 1.2
COVER_POLL_STEP_SEC = 0.10
# ------------------------------

# ---- Current track state ----
artist = None
title = None
album = None
duration = "0"
persistent_id = None
picture_bytes = None

track_epoch = 0.0

# NEW: sticky cover state
have_cover_art = False

# Pending emit
pending = False
pending_start = 0.0
pending_deadline = 0.0
pending_pid = None
pending_title_at_start = None

# Emit bookkeeping
last_emitted = ""
last_emit_ts = 0.0
last_emit_pid = None
last_emit_used_default = False

last_emit_title = None
last_emit_artist = None
last_emit_album = None
last_emit_duration = None


def debug_msg(msg):
    if DEBUG:
        print(f"{datetime.now():%H:%M:%S} DEBUG: {msg}", flush=True)


def safe_decode(b):
    return b.decode("utf-8", errors="replace") if b else ""


def get_metadata(line):
    for k in ("Title", "Artist", "Album Name"):
        m = re.match(rf'^{k}:\s*"(.*?)"\.$', line)
        if m:
            return k, m.group(1)

    m = re.match(r'^Track length:\s*(.*?)\.$', line)
    if m:
        return "Track length", m.group(1).split(" ")[0]

    m = re.match(r'^Persistent ID:\s*(0x[0-9a-fA-F]+)\.$', line)
    if m:
        return "Persistent ID", m.group(1)

    m = re.match(r'^Picture received,\s*length\s*(\d+)\s*bytes\.$', line)
    if m:
        return "PictureBytes", m.group(1)

    return None, None


def cache_bust(url):
    return f"{url}?v={persistent_id or '0x0'}"


def newest_cover_path():
    covers = glob.glob(os.path.join(COVERS_LOCAL_ROOT, "cover-*.jpg"))
    return max(covers, key=os.path.getmtime) if covers else ""


def newest_cover_path_fresh():
    p = newest_cover_path()
    if not p or track_epoch <= 0:
        return ""
    try:
        if os.path.getmtime(p) >= (track_epoch - TRACK_EPOCH_GRACE_SEC):
            return p
    except Exception:
        pass
    return ""


def cover_url_from_path(p):
    return cache_bust(COVERS_WEB_ROOT + os.path.basename(p))


def default_cover_url():
    return cache_bust(DEFAULT_COVER_WEB)


def choose_cover_url():
    global have_cover_art

    # If the source explicitly says "no picture", don't downgrade if we already have art.
    if picture_bytes == 0:
        if have_cover_art and last_emitted:
            try:
                return last_emitted.split("~~~")[4]
            except Exception:
                pass
        return default_cover_url()

    # Prefer a fresh cover file
    p = newest_cover_path_fresh()
    if p:
        have_cover_art = True
        return cover_url_from_path(p)

    # Sticky: once we’ve had art, never downgrade to default during the session
    if have_cover_art and last_emitted:
        try:
            return last_emitted.split("~~~")[4]
        except Exception:
            pass

    return default_cover_url()

def maybe_poll_for_fresh_cover():
    global have_cover_art

    deadline = time.time() + COVER_POLL_MAX_SEC
    while time.time() < deadline:
        p = newest_cover_path_fresh()
        if p:
            have_cover_art = True
            return cover_url_from_path(p)
        time.sleep(COVER_POLL_STEP_SEC)

    return default_cover_url()


def write_aplmeta_file(line):
    os.makedirs(os.path.dirname(APLMETA_FILE), exist_ok=True)

    tmp = APLMETA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(line + "\n")

    os.replace(tmp, APLMETA_FILE)
    
def send_fe_update(metadata_line):
    try:
        subprocess.call(
            ["/var/www/util/send-fecmd.php", "update_aplmeta," + metadata_line],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        debug_msg(f"send-fe-update failed: {e}")

def emit(reason, t, a, al, dur, cover):
    global last_emitted, last_emit_ts, last_emit_pid
    global last_emit_used_default
    global last_emit_title, last_emit_artist, last_emit_album, last_emit_duration

    payload = f"{t}~~~{a}~~~{al}~~~{dur}~~~{cover}~~~ALAC/AAC"

    if payload == last_emitted:
        # AirPlay can reuse Persistent IDs across resumes / reconnects.
        # If PID matches, allow re-emit so UI can refresh.
        if persistent_id and last_emit_pid == persistent_id:
            debug_msg(f"Emit({reason}) forcing re-emit for AirPlay PID reuse")
        else:
            debug_msg(f"Emit({reason}) deduped (unchanged)")
            return

    debug_msg(
        f"EMIT ({reason}) cover='{cover}' title='{t}' artist='{a}' album='{al}'"
    )

    write_aplmeta_file(payload)
    send_fe_update(payload)

    last_emitted = payload
    last_emit_ts = time.time()
    last_emit_pid = persistent_id
    last_emit_used_default = cover.startswith(DEFAULT_COVER_WEB)

    last_emit_title = t
    last_emit_artist = a
    last_emit_album = al
    last_emit_duration = dur

def reset_track_state():
    global artist, title, album, duration, picture_bytes
    global pending, have_cover_art

    artist = title = album = None
    duration = "0"
    picture_bytes = None
    pending = False
    have_cover_art = False


def main():
    global DEBUG
    global artist, title, album, duration
    global persistent_id, picture_bytes, track_epoch
    global pending, pending_start, pending_deadline, pending_pid, pending_title_at_start
    global have_cover_art

    # ---- argv / debug ----
    if len(sys.argv) > 1:
        if sys.argv[1] == "--version":
            print("aplmeta.py version", PGM_VERSION)
            return
        try:
            DEBUG = int(sys.argv[1])
        except Exception:
            DEBUG = 0

    debug_msg("Entering while loop...")

    while True:
        # Wake up in time to emit pending
        timeout = 0.25
        if pending:
            timeout = max(0.0, min(0.25, pending_deadline - time.time()))

        r, _, _ = select.select([sys.stdin.buffer], [], [], timeout)

        # ---- settle window expired ----
        if not r:
            if pending and time.time() >= pending_deadline:
                if title and (pending_pid is None or pending_pid == persistent_id):
                    cover = choose_cover_url()
                    if cover.startswith(DEFAULT_COVER_WEB) and picture_bytes != 0:
                        cover = maybe_poll_for_fresh_cover()

                    # 🔒 LOCK STICKY COVER IF NON-DEFAULT
                    if cover and not cover.startswith(DEFAULT_COVER_WEB):
                        have_cover_art = True

                    emit(
                        "settle-deadline",
                        title,
                        artist or "",
                        album or "AirPlay Source",
                        duration or "0",
                        cover,
                    )
                else:
                    debug_msg("Pending emit canceled (missing title or PID changed)")
                pending = False
            continue

        raw = sys.stdin.buffer.readline()
        if not raw:
            time.sleep(0.05)
            continue

        line = safe_decode(raw).strip()
        if not line:
            continue

        key, val = get_metadata(line)
        if not key:
            continue

        debug_msg(f"key={key} val={val}")

        # ---- Persistent ID = new track/session ----
        if key == "Persistent ID":
            if val != persistent_id:
                persistent_id = val
                track_epoch = time.time()
                reset_track_state()

                pending = False
                pending_pid = persistent_id
                pending_title_at_start = None

                debug_msg(f"PID updated: {persistent_id}")
            continue

        # ---- PictureBytes (art arrival) ----
        if key == "PictureBytes":
            try:
                picture_bytes = int(val)
            except Exception:
                picture_bytes = None

            # Late art refresh if we already emitted default
            if (
                picture_bytes
                and picture_bytes > 0
                and title
                and last_emit_pid == persistent_id
                and last_emit_used_default
            ):
                cover = choose_cover_url()
                if not cover.startswith(DEFAULT_COVER_WEB):
                    have_cover_art = True  # 🔒 LOCK
                    emit(
                        "late-art",
                        title,
                        artist or "",
                        album or "AirPlay Source",
                        duration or "0",
                        cover,
                    )

            # Extend settle window slightly if art arrives during pending
            if pending and picture_bytes and picture_bytes > 0:
                now = time.time()
                hard_cap = pending_start + MAX_WAIT_FOR_ART_SEC
                if now < hard_cap:
                    pending_deadline = min(
                        hard_cap, max(pending_deadline, now + 0.35)
                    )
                    debug_msg(f"Extended settle deadline -> {pending_deadline:.3f}")

            continue

        # ---- Simple fields ----
        if key == "Artist":
            artist = val
            continue

        if key == "Album Name":
            album = val
            continue

        if key == "Track length":
            duration = val
            continue

        # ---- Title triggers settle window ----
        if key == "Title":
            title = val

            if track_epoch <= 0:
                track_epoch = time.time()

            pending = True
            pending_pid = persistent_id
            pending_title_at_start = title
            pending_start = time.time()
            pending_deadline = pending_start + SETTLE_WINDOW_SEC

            debug_msg(f"Settle window started deadline={pending_deadline:.3f}")
            continue


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass