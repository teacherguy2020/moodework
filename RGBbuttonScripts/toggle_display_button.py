#!/usr/bin/env python3
"""
GPIO17 momentary button -> toggle moOde display (WebUI <-> Peppy)

Wiring (BCM):
- GPIO17 (physical pin 11) -> button NO
- GND   (physical pin 6)   -> button COM
Uses internal pull-up.
"""

import time
import subprocess

from gpiozero import Button

BUTTON_GPIO = 17          # BCM numbering
DEBOUNCE_SEC = 0.08
COOLDOWN_SEC = 0.6        # prevent double toggles

last_press = 0.0

def toggle_display():
    global last_press
    now = time.time()
    if now - last_press < COOLDOWN_SEC:
        return
    last_press = now

    # moOde REST API: set_display webui|peppy|toggle
    subprocess.run(
        ["curl", "-sG", "--data-urlencode", "cmd=set_display toggle", "http://localhost/command/"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False
    )

def main():
    btn = Button(BUTTON_GPIO, pull_up=True, bounce_time=DEBOUNCE_SEC)
    btn.when_pressed = toggle_display

    print("Button service started: GPIO17 toggles moOde display")
    while True:
        time.sleep(1)

if __name__ == "__main__":
    main()
