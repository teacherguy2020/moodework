#!/bin/bash
set -u

LOCKDIR="/run/aplmeta-reader.lock"
LOGFILE="/var/log/aplmeta-reader.log"
PIPE="/tmp/shairport-sync-metadata"

if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "$(date '+%F %T') aplmeta-reader: already running; exiting" >>"$LOGFILE"
  exit 0
fi

cleanup() { rmdir "$LOCKDIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "$(date '+%F %T') aplmeta-reader: starting" >>"$LOGFILE"

while true; do
  # Wait for shairport FIFO to exist
  while [ ! -p "$PIPE" ]; do
    echo "$(date '+%F %T') aplmeta-reader: waiting for FIFO $PIPE" >>"$LOGFILE"
    sleep 1
  done

  # Attach pipeline. If shairport closes the FIFO, this will exit and we re-loop.
  cat "$PIPE" \
    | shairport-sync-metadata-reader \
    | /var/www/util/aplmeta.py 1 \
    >>"$LOGFILE" 2>&1

  echo "$(date '+%F %T') aplmeta-reader: pipeline ended; restarting in 1s" >>"$LOGFILE"
  sleep 1
done