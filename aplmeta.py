#!/usr/bin/python3
#
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2014 The moOde audio player project / Tim Curtis
#
# Caller: After starting shairport-sync
#   cat /tmp/shairport-sync-metadata | shairport-sync-metadata-reader | /var/www/util/aplmeta.py
#
# DEBUG
#   /var/www/util/aplmeta.py 1
#
# Shairport-sync.conf (relevant bits)
#   metadata = {
#     enabled = "yes";
#     include_cover_art = "yes";
#     cover_art_cache_directory = "/var/local/www/imagesw/airplay-covers";
#     pipe_name = "/tmp/shairport-sync-metadata";
#     diagnostics = { retain_cover_art = "no"; }
#   }
#
# -------------------------------------------------------------------
# This is a drop-in replacement for the original aplmeta.py.
#
# Original behavior (baseline):
# - Emit immediately when Title arrives.
# - Sleep 1 second to allow shairport-sync time to write cover art.
# - Read "the" cover art file (assumes only one exists when retain_cover_art="no").
# - Send metadata to the front-end and reset globals.
#
# Why changes were made:
# - Some sources (Safari/YouTube) may NOT provide new artwork for a track. If we simply
#   reuse the newest cover file, the UI can get "stuck" showing the previous track's art.
# - Apple Music can deliver metadata in surprising orders:
#     * cover art can arrive before Persistent ID changes,
#     * the same track can be "re-announced" with a new PID when opening Now Playing.
# - Cover art can land slightly after the Title event, producing a "default -> cover" flash
#   or (worse) a default cover if we check too early.
# - Garbage/decoded binary fragments sometimes appear in Album/Artist/Title and can overwrite
#   good metadata unless filtered.
#
# Key strategies in this version:
# - "Settle window": do NOT emit immediately on Title. Wait briefly so metadata/cover can arrive,
#   then emit ONCE (reduces flashing).
# - "Fresh-cover rule": only use a cover file if it is fresh for the current track (mtime >= epoch - grace).
#   This prevents Safari/YouTube from reusing previous track art when no art is provided.
# - Late PID tolerance: if PID changes shortly after we started settling (or just emitted) and the Title
#   hasn't changed, treat it as a correction rather than a new track (prevents unnecessary resets/emits).
# - Optional late refresh: if we emitted default but art appears shortly afterwards for the same PID,
#   re-emit once with the cover.
# - NEW cover-write grace poll: right before emitting, if we'd use DEFAULT only because the cover isn't
#   fresh yet, briefly poll for a fresh cover to appear (helps first track after reboot and occasional late writes).
# -------------------------------------------------------------------
#
# aplmeta.py "settle-window + fresh-cover + pid-aware fragments + late-PID tolerant (+ cover-write grace poll)"
#
# Goals:
# - Reduce cover flashing by waiting briefly ("settle window") before emitting.
# - Prevent Safari/YouTube from reusing prior track art when no art is provided (fresh-cover rule).
# - Handle odd Apple Music ordering (art before PID; PID corrections when opening Now Playing).
# - NEW: when we are about to emit DEFAULT only because the newest cover is stale, briefly poll
#        for a fresh cover file to appear (helps first track after reboot and occasional late writes).
#
# Pipeline:
#   cat /tmp/shairport-sync-metadata | shairport-sync-metadata-reader | /var/www/util/aplmeta.py [DEBUG]
#

import sys
import subprocess
import re
import os
import glob
import time
import select
from datetime import datetime

PGM_VERSION = "1.8.3-settlewindow-freshcover-latepid-coverpoll"
DEBUG = 0

COVERS_LOCAL_ROOT = "/var/local/www/imagesw/airplay-covers/"
COVERS_WEB_ROOT = "imagesw/airplay-covers/"
APLMETA_FILE = "/var/local/www/aplmeta.txt"
DEFAULT_COVER_WEB = "images/default-album-cover.png"

# -------- Tuning knobs --------
SETTLE_WINDOW_SEC = 1.3            # wait this long after Title before emitting
MAX_WAIT_FOR_ART_SEC = 1.0         # if art seems to be arriving, allow settle to extend up to this from Title
LATE_REFRESH_CUTOFF_SEC = 2.00     # if we emitted default, only refresh to art within this many seconds after emit
TRACK_EPOCH_GRACE_SEC = 2.50       # allow cover file mtime to be slightly older than epoch due to write timing

# Late PID tolerance (Apple Music PID corrections / re-announces)
LATE_PID_WINDOW_SEC = 3.0

# NEW: cover-write grace poll (helps first track after reboot / late cover writes)
COVER_POLL_MAX_SEC = 1.2           # total time to poll for a fresh cover right before emitting
COVER_POLL_STEP_SEC = 0.10         # poll interval
# ------------------------------

# ---- Current track state ----
artist = None
title = None
album = None
duration = "0"
persistent_id = None
picture_bytes = None  # None unknown, 0 none, >0 provided

# Epoch used to decide whether a cover file is "for this track"
# track_epoch is set at Persistent ID (normal) or first Title (fallback).
track_epoch = 0.0  # seconds since epoch

# Pending emit state (settle window)
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

# Track last emitted fields (so we can optionally re-emit with art)
last_emit_title = None
last_emit_artist = None
last_emit_album = None
last_emit_duration = None


def debug_msg(msg: str) -> None:
    if DEBUG > 0:
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{ts} DEBUG: {msg}", flush=True)


def safe_decode(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace") if raw else ""


def get_metadata(line: str):
    m = re.match(r'^(Title|Artist|Album Name):\s*"(.*?)"\.$', line)
    if m:
        return m.group(1), m.group(2)

    m = re.match(r'^(Track length):\s*(.*?)\.$', line)
    if m:
        return m.group(1), m.group(2).split(" ")[0]

    # Added: Persistent ID (track boundary / late PID corrections)
    m = re.match(r'^(Persistent ID):\s*(0x[0-9a-fA-F]+)\.$', line)
    if m:
        return m.group(1), m.group(2)

    # Added: Picture bytes (explicit "no art" signal and "art is coming" hint)
    m = re.match(r'^Picture received,\s*length\s*(\d+)\s*bytes\.$', line)
    if m:
        return "PictureBytes", m.group(1)

    return None, None


def cache_bust(url: str) -> str:
    # Stable per PID: reduces unnecessary UI churn compared to a timestamp.
    pid = persistent_id or "0x0"
    return f"{url}?v={pid}"


def looks_garbage(s: str) -> bool:
    """
    Heuristic guard against decode/control-char junk overwriting good metadata.
    This is needed because we have observed occasional binary/garbled strings in
    Album/Artist/Title from some sources.
    """
    if s is None:
        return True
    if s == "":
        return False

    # Pure numeric junk (we've seen artist/album become huge integers)
    if s.isdigit() and len(s) >= 6:
        return True

    # Too many replacement chars from decode errors
    if s.count("�") >= 2:
        return True

    # Too many non-printable control chars
    bad = 0
    for ch in s:
        o = ord(ch)
        if (o < 32 and ch not in "\t\n\r") or o == 127:
            bad += 1
    if bad >= 2:
        return True

    return False


def newest_cover_path() -> str:
    covers = glob.glob(os.path.join(COVERS_LOCAL_ROOT, "cover-*.jpg"))
    if not covers:
        return ""
    return max(covers, key=os.path.getmtime)


def newest_cover_path_fresh() -> str:
    """
    Fresh-cover rule:
    Return newest cover path only if it is "fresh" for this track:
      mtime >= (track_epoch - grace)

    Rationale:
    - Prevent Safari/YouTube (and other sources) from reusing the previous track's cover
      when no new art is provided. Even if a cover file exists, we treat it as invalid
      for this track unless it is recent relative to this track's epoch.
    """
    newest = newest_cover_path()
    if not newest:
        return ""

    try:
        mtime = os.path.getmtime(newest)
    except Exception:
        return ""

    if track_epoch <= 0:
        return ""

    if mtime >= (track_epoch - TRACK_EPOCH_GRACE_SEC):
        return newest

    debug_msg(f"Newest cover is stale (mtime={mtime:.3f} < epoch={track_epoch:.3f}); forcing default")
    return ""


def cover_url_from_path(p: str) -> str:
    return cache_bust(COVERS_WEB_ROOT + os.path.basename(p))


def default_cover_url() -> str:
    return cache_bust(DEFAULT_COVER_WEB)


def choose_cover_url_no_poll() -> str:
    """
    Cover selection:
    - PictureBytes==0 => source explicitly indicates no picture for this item -> default
    - otherwise use fresh cover if present, else default
    """
    if picture_bytes == 0:
        debug_msg("PictureBytes==0 -> forcing default cover")
        return default_cover_url()

    p = newest_cover_path_fresh()
    if p:
        return cover_url_from_path(p)

    return default_cover_url()


def maybe_poll_for_fresh_cover(reason: str) -> str:
    """
    NEW: If we are about to use DEFAULT only because the cover is not fresh yet,
    briefly poll for a fresh cover file to appear.

    Rationale:
    - The original script used a fixed 1s sleep to allow shairport-sync time to write cover art.
      With the fresh-cover rule, a slightly late write can incorrectly look "stale" (especially on
      the first track after reboot if an older cover file exists).
    - Polling is bounded and still requires freshness, so it does not reintroduce
      "stuck previous cover" behavior.

    Safety:
    - If PictureBytes==0, do NOT poll (source explicitly says no art).
    - We only accept a cover if newest_cover_path_fresh() considers it fresh.
    """
    if picture_bytes == 0:
        return default_cover_url()

    # If we already have a fresh cover, return immediately.
    p = newest_cover_path_fresh()
    if p:
        return cover_url_from_path(p)

    deadline = time.time() + COVER_POLL_MAX_SEC
    while time.time() < deadline:
        time.sleep(COVER_POLL_STEP_SEC)
        p = newest_cover_path_fresh()
        if p:
            debug_msg(f"Cover poll ({reason}): fresh cover appeared -> using it")
            return cover_url_from_path(p)

    return default_cover_url()


def write_aplmeta_file(metadata_line: str) -> None:
    # Use atomic replace to avoid partial reads.
    os.makedirs(os.path.dirname(APLMETA_FILE), exist_ok=True)
    tmp = APLMETA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(metadata_line + "\n")
    os.replace(tmp, APLMETA_FILE)


def send_fe_update(metadata_line: str) -> None:
    try:
        rc = subprocess.call(
            ["/var/www/util/send-fecmd.php", "update_aplmeta," + metadata_line],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        debug_msg(f"send-fecmd rc={rc}")
    except Exception as e:
        debug_msg(f"send-fecmd exception: {e}")


def reset_track_state() -> None:
    """
    Reset per-track globals.

    Note:
    - In the original script, globals reset after each emit.
    - Here, we also reset pending settle-window state and the fields used for a possible
      late refresh.
    """
    global artist, title, album, duration, picture_bytes
    global pending, pending_start, pending_deadline, pending_pid, pending_title_at_start
    global last_emit_title, last_emit_artist, last_emit_album, last_emit_duration
    global last_emit_used_default

    artist = None
    title = None
    album = None
    duration = "0"
    picture_bytes = None

    pending = False
    pending_start = 0.0
    pending_deadline = 0.0
    pending_pid = None
    pending_title_at_start = None

    last_emit_title = None
    last_emit_artist = None
    last_emit_album = None
    last_emit_duration = None
    last_emit_used_default = False


def is_tiny_title_fragment(new_title: str) -> bool:
    """
    PID-aware tiny-title fragment filter.

    Rationale:
    - Some sources can transiently emit short Title fragments.
    - We only suppress a short title if it occurs right after an emit AND is for the same PID.
      This avoids suppressing legitimate short titles (e.g. "Red") across track changes.
    """
    if not new_title:
        return False
    if len(new_title.strip()) >= 6:
        return False
    if (time.time() - last_emit_ts) >= 2.0:
        return False
    if persistent_id and last_emit_pid and persistent_id == last_emit_pid:
        return True
    return False


def emit_payload(reason: str, t: str, a: str, al: str, dur: str, cover_url: str) -> None:
    global last_emitted, last_emit_ts, last_emit_pid, last_emit_used_default
    global last_emit_title, last_emit_artist, last_emit_album, last_emit_duration

    # Match the original output format (title~~~artist~~~album~~~duration~~~cover_url~~~format)
    metadata = f"{t}~~~{a}~~~{al}~~~{dur}~~~{cover_url}~~~ALAC/AAC"

    # Dedupe: avoid spamming FE with identical payloads.
    if metadata == last_emitted:
        debug_msg(f"Emit({reason}) deduped (unchanged)")
        return

    debug_msg(f"EMIT ({reason}) cover='{cover_url}' title='{t}' artist='{a}' album='{al}'")
    write_aplmeta_file(metadata)
    send_fe_update(metadata)

    last_emitted = metadata
    last_emit_ts = time.time()
    last_emit_pid = persistent_id
    last_emit_used_default = cover_url.startswith(DEFAULT_COVER_WEB)

    last_emit_title = t
    last_emit_artist = a
    last_emit_album = al
    last_emit_duration = dur


def start_settle_window(reason: str) -> None:
    """
    Start (or restart) the settle window.

    Rationale:
    - The original script sleeps 1s and emits as soon as Title is set.
    - Instead, we delay emission briefly after Title so Album/Artist/Duration/Picture can arrive
      and we can emit ONCE with a stable payload, reducing flashing.
    """
    global pending, pending_start, pending_deadline, pending_pid, pending_title_at_start
    now = time.time()

    if not pending:
        pending = True
        pending_start = now
        pending_pid = persistent_id
        pending_deadline = now + SETTLE_WINDOW_SEC
        pending_title_at_start = title
        debug_msg(f"Settle window started ({reason}) deadline={pending_deadline:.3f}")
        return

    if pending_pid != persistent_id:
        pending_start = now
        pending_pid = persistent_id
        pending_deadline = now + SETTLE_WINDOW_SEC
        pending_title_at_start = title
        debug_msg(f"Settle window restarted (pid change) deadline={pending_deadline:.3f}")


def maybe_extend_deadline_for_art(reason: str) -> None:
    """
    If PictureBytes indicates art is arriving during the settle window, extend slightly
    (bounded by MAX_WAIT_FOR_ART_SEC from the start) to reduce 'default -> cover' flashes.
    """
    global pending_deadline
    if not pending:
        return
    now = time.time()
    hard_cap = pending_start + MAX_WAIT_FOR_ART_SEC
    if now >= hard_cap:
        return
    new_deadline = min(hard_cap, max(pending_deadline, now + 0.35))
    if new_deadline > pending_deadline + 0.05:
        pending_deadline = new_deadline
        debug_msg(f"Extended settle deadline for art ({reason}) -> {pending_deadline:.3f}")


def emit_pending(reason: str) -> None:
    global pending, pending_start, pending_deadline, pending_pid, pending_title_at_start
    if not pending:
        return

    if pending_pid != persistent_id:
        debug_msg("Pending emit canceled due to PID change")
        pending = False
        return

    if not title:
        debug_msg("Pending emit canceled (no title)")
        pending = False
        return

    # Normalize like the original script.
    t = title
    al = album if album else "AirPlay Source"
    a = artist if artist else ""
    dur = duration if duration else "0"

    # Choose cover. If it would be DEFAULT due to freshness timing, poll briefly.
    cover_url = choose_cover_url_no_poll()
    if cover_url.startswith(DEFAULT_COVER_WEB) and picture_bytes != 0:
        cover_url = maybe_poll_for_fresh_cover("pre-emit")

    emit_payload(reason, t, a, al, dur, cover_url)

    pending = False
    pending_start = 0.0
    pending_deadline = 0.0
    pending_pid = None
    pending_title_at_start = None


def maybe_late_refresh_on_art(reason: str) -> None:
    """
    Optional late refresh:
    If we emitted default for this PID and art arrives shortly after, re-emit once with art.

    Rationale:
    - Some sources deliver PictureBytes slightly after our settle deadline.
    - This keeps transitions smooth without blocking indefinitely.
    """
    if not persistent_id:
        return
    if not last_emit_pid or persistent_id != last_emit_pid:
        return
    if not last_emit_used_default:
        return
    if (time.time() - last_emit_ts) > LATE_REFRESH_CUTOFF_SEC:
        return
    if picture_bytes == 0:
        return

    p = newest_cover_path_fresh()
    if not p:
        return

    cover_url = cover_url_from_path(p)
    debug_msg(f"Late refresh ({reason}): fresh cover now available -> re-emit")

    t = last_emit_title or (title or "")
    a = last_emit_artist or (artist or "")
    al = last_emit_album or (album or "AirPlay Source")
    dur = last_emit_duration or (duration or "0")

    if not t:
        return

    emit_payload(f"refresh-{reason}", t, a, al, dur, cover_url)


def is_late_pid_update(new_pid: str) -> bool:
    """
    Late PID tolerance:
    Apple Music sometimes changes PID after cover/metadata for the same track
    (especially when opening Now Playing). If Title hasn't changed and the PID change
    is within a short window, treat it as a correction rather than a new track.
    """
    now = time.time()

    if pending and pending_title_at_start and title and title == pending_title_at_start:
        if (now - pending_start) <= LATE_PID_WINDOW_SEC:
            return True

    if last_emit_title and title and title == last_emit_title:
        if (now - last_emit_ts) <= LATE_PID_WINDOW_SEC:
            return True

    return False


def main() -> None:
    global DEBUG, artist, title, album, duration, persistent_id, picture_bytes, track_epoch
    global pending_pid

    # Get debug level (kept compatible with original style)
    if len(sys.argv) > 1:
        if sys.argv[1] == "--version":
            print("aplmeta.py version " + PGM_VERSION)
            return
        try:
            DEBUG = int(sys.argv[1])
        except Exception:
            DEBUG = 0

    debug_msg("Entering while loop...")

    while True:
        # When settling, wake up at the deadline to emit. Otherwise read normally.
        timeout = 0.25
        if pending:
            now = time.time()
            timeout = max(0.0, min(0.25, pending_deadline - now))

        r, _, _ = select.select([sys.stdin.buffer], [], [], timeout)

        if not r:
            if pending and time.time() >= pending_deadline:
                emit_pending("settle-deadline")
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

        if key == "Persistent ID":
            if val != persistent_id:
                # Late PID tolerance: do not reset epoch/state if this looks like the same track.
                if persistent_id is not None and is_late_pid_update(val):
                    debug_msg(f"Late PID update detected ({persistent_id} -> {val}); keeping epoch/state")
                    persistent_id = val
                    # Keep track_epoch as-is; do not reset metadata.
                    # Ensure pending_pid follows new PID so pending emit isn't canceled.
                    if pending:
                        pending_pid = persistent_id
                    continue

                # New track boundary
                persistent_id = val
                track_epoch = time.time()
                debug_msg(f"PID updated (pid={persistent_id}) track_epoch={track_epoch:.3f}")
                reset_track_state()
            continue

        if key == "PictureBytes":
            try:
                picture_bytes = int(val)
            except Exception:
                picture_bytes = None
            debug_msg(f"PictureBytes parsed={picture_bytes}")

            # If we're waiting to emit and art seems to be arriving, extend slightly.
            if pending and picture_bytes and picture_bytes > 0:
                maybe_extend_deadline_for_art("picturebytes")

            # If we already emitted default, allow a short late refresh.
            if picture_bytes and picture_bytes > 0:
                maybe_late_refresh_on_art("picturebytes")
            continue

        if key == "Artist":
            if not looks_garbage(val):
                artist = val
            else:
                debug_msg(f"Reject garbage artist='{val}'")
            continue

        if key == "Album Name":
            if not looks_garbage(val):
                album = val
            else:
                debug_msg(f"Reject garbage album='{val}'")
            continue

        if key == "Track length":
            if not looks_garbage(val):
                duration = val
            continue

        if key == "Title":
            if looks_garbage(val):
                debug_msg(f"Reject garbage title='{val}'")
                continue

            # Fallback: if PID didn't arrive yet, establish an epoch at first Title.
            # This keeps the fresh-cover rule functional even when ordering is unusual.
            if track_epoch <= 0:
                track_epoch = time.time()
                debug_msg(f"track_epoch set from Title={track_epoch:.3f}")

            if is_tiny_title_fragment(val):
                debug_msg(f"Ignoring tiny title fragment '{val}'")
                continue

            title = val
            start_settle_window("title")
            continue


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.stdout.flush()
        print("")
