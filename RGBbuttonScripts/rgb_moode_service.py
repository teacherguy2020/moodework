#!/usr/bin/env python3
#!/usr/bin/env python3
"""
moOde RGB LED + Button Service
=============================

This service drives a WS2812 (NeoPixel) RGB LED ring via SPI and
reflects moOde playback state (MPD, AirPlay, Radio) with color.

------------------------------------------------------------
HARDWARE WIRING
------------------------------------------------------------

Momentary pushbutton (GPIO 17, internal pull-up enabled in software):
-------------------------------------------------------------------
• White wire  -> Switch Common (C) -> Pi physical pin 6  (GND)
• Green wire  -> Switch NO         -> Pi physical pin 11 (GPIO 17, BCM)

RGB LED Ring (WS2812 / NeoPixel, SPI-driven):
--------------------------------------------
• Black wire  -> VDD (+5V)         -> Pi physical pin 4  (5V)
• Yellow wire -> GND               -> Pi physical pin 9  (GND)
• Red wire    -> DATA IN (DIN)     -> Pi physical pin 19 (GPIO 10 / SPI MOSI)
• Orange wire -> DATA OUT (DOUT)   -> NOT CONNECTED (only for chaining LEDs)
• Blue wire   -> NOT USED          -> Leave unconnected

NOTES:
- This uses SPI NeoPixel mode (neopixel_spi), not single-wire GPIO timing.
- Only DIN is ever connected to the Pi. DOUT is unused unless chaining LEDs.
- SPI clock is implicit in the SPI data stream; no separate CLK wire is used.

------------------------------------------------------------
LED COLOR MEANINGS
------------------------------------------------------------

• Solid GREEN        -> Local playback (MPD playing)
• Pulsing GREEN      -> Paused
• BLUE               -> Stopped / idle
• RED / PINK         -> Internet radio stream
• PURPLE             -> AirPlay active
• DIM AMBER          -> Screen blanked (DPMS off)

------------------------------------------------------------
SOFTWARE DEPENDENCIES
------------------------------------------------------------

Required Python packages (system-wide):
• adafruit-blinka
• adafruit-circuitpython-neopixel-spi
• python3-spidev

SPI must be enabled at boot.

------------------------------------------------------------
CRITICAL moOde SETTINGS
------------------------------------------------------------

In moOde Web UI:
Configure → Audio → MPD Options
✔ Enable "Metadata file"

This generates:
  /var/local/www/currentsong.txt

The REST endpoint:
  http://localhost/command/?cmd=get_currentsong
reads this file. If it is disabled, the API returns {} and the LED
will not update correctly.

------------------------------------------------------------
RECOVERY STEPS AFTER A REFRESH / REFLASH
------------------------------------------------------------

If the LED stops working after reinstalling moOde:

1) Enable SPI
   Edit /boot/firmware/config.txt and add:
     dtparam=spi=on
     dtoverlay=spi0-0cs

   Reboot, then confirm:
     ls -l /dev/spidev0.0

2) Install required Python libraries
   sudo apt install python3-spidev
   sudo pip3 install --break-system-packages \
        adafruit-blinka \
        adafruit-circuitpython-neopixel-spi

3) Enable MPD "Metadata file" (see above)

4) Verify wiring (especially RED wire on pin 19)

5) Restart the service
   sudo systemctl daemon-reload
   sudo systemctl restart rgb_moode.service
   systemctl status rgb_moode.service

------------------------------------------------------------
"""
import time
import subprocess
import math
import json
import board
import neopixel_spi as neopixel

# =========================
# NeoPixel configuration
# =========================
PIXEL_COUNT = 1

# Use default SPI device (/dev/spidev0.0)
SPI = board.SPI()

pixels = neopixel.NeoPixel_SPI(
    SPI,
    PIXEL_COUNT,
    brightness=0.6,
    auto_write=False,
    pixel_order=neopixel.GRB
)

# =========================
# LED COLOR MEANINGS (R, G, B)
# =========================
COLOR_PLAYING = (0, 255, 0)        # Solid green  -> Local playback (MPD play)
COLOR_RADIO   = (255, 20, 30)      # Red/pink     -> Internet radio stream
COLOR_STOPPED = (0, 100, 255)      # Blue         -> Stopped / idle
COLOR_AIRPLAY = (150, 0, 200)      # Purple       -> AirPlay active
COLOR_BLANKED = (80, 30, 0)        # Dim amber    -> Screen blanked (DPMS off)

# =========================
# LED helpers
# =========================
def set_color(color):
    pixels[0] = color
    pixels.show()

def pulse_green(phase):
    """
    Smooth pulsing green for paused state.
    Intentionally never fully dark or fully bright.
    """
    raw = (math.sin(phase) + 1) / 2          # 0..1
    intensity = 0.3 + (raw * 0.5)            # clamp to 30%–80%

    r = int(20 * intensity)
    g = int(255 * intensity)
    b = int(30 * intensity)

    set_color((r, g, b))
    return (phase + 0.08) % (2 * math.pi)

# =========================
# moOde REST API
# =========================
def get_currentsong():
    """
    Reads /var/local/www/currentsong.txt via moOde REST API.
    Requires 'Metadata file' to be enabled in MPD options.
    """
    try:
        out = subprocess.check_output(
            ["curl", "-s", "http://localhost/command/?cmd=get_currentsong"],
            text=True
        )
        return json.loads(out)
    except Exception:
        return {}

# =========================
# State detection helpers
# =========================
def is_airplay_active(song):
    return song.get("file") == "AirPlay Active"

def is_radio_active(song):
    file = song.get("file", "")
    return file.startswith("http")

def is_mpd_playing(song):
    return song.get("state") == "play" and not is_radio_active(song)

def is_mpd_paused(song):
    return song.get("state") == "pause"

def is_mpd_stopped(song):
    return song.get("state") == "stop"

# =========================
# Screen blank detection (DPMS)
# =========================
def screen_is_blank():
    """
    Uses X11 DPMS state.
    Returns True only when display is actually blank/off.
    """
    try:
        out = subprocess.check_output(
            ["bash", "-c", "DISPLAY=:0 xset -display :0 q | grep 'Monitor is'"],
            text=True
        )
        return "Off" in out or "Standby" in out or "Suspend" in out
    except Exception:
        return False

# =========================
# Main loop
# =========================
print("moOde RGB service started -- SPI + metadata OK")

phase = 0

try:
    while True:
        song = get_currentsong()

        # If we truly got nothing back, just wait and try again.
        if not song:
            time.sleep(1)
            continue

        # Screen blank ALWAYS wins (amber only when DPMS is blank/off).
        if screen_is_blank():
            set_color(COLOR_BLANKED)
            time.sleep(2)
            continue

        # AirPlay payload often does NOT include "state" -- handle it first.
        if is_airplay_active(song):
            set_color(COLOR_AIRPLAY)
            time.sleep(2)
            continue

        # Radio payload should include "state", but if it doesn't, we can still
        # reliably detect it from the URL.
        if is_radio_active(song):
            set_color(COLOR_RADIO)
            time.sleep(2)
            continue

        # From here on, we need MPD state.
        if "state" not in song:
            time.sleep(1)
            continue

        if is_mpd_playing(song):
            set_color(COLOR_PLAYING)

        elif is_mpd_paused(song):
            phase = pulse_green(phase)
            time.sleep(0.05)
            continue

        elif is_mpd_stopped(song):
            set_color(COLOR_STOPPED)

        time.sleep(2)

except KeyboardInterrupt:
    set_color((0, 0, 0))
    pixels.deinit()
