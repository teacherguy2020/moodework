#!/bin/bash
set -u

LOCKDIR="/run/aplmeta-reader.lock"
LOGFILE="/var/log/aplmeta-reader.log"

# Acquire lock (atomic)
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "$(date '+%F %T') aplmeta-reader: already running; exiting" >>"$LOGFILE"
  exit 0
fi

cleanup() { rmdir "$LOCKDIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "$(date '+%F %T') aplmeta-reader: starting" >>"$LOGFILE"

# Pipeline
cat /tmp/shairport-sync-metadata \
  | shairport-sync-metadata-reader \
  | /var/www/util/aplmeta.py 1 \
  >>"$LOGFILE" 2>&1