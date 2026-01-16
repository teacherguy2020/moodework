moOde RGB Status Ring + Display Toggle Button (Raspberry Pi 5)

This project turns a Raspberry Pi running moOde into a polished “appliance” by adding:
	1.	RGB NeoPixel status ring that reflects playback / renderer state
	2.	Momentary hardware button that toggles the on-screen display between WebUI and PeppyMeter

Designed and tested on Raspberry Pi 5 with moOde, using a WS2812 (NeoPixel) driven via SPI. Make sure to get the momentary version and the wiring harness.

⸻

Features

🎨 RGB Status Ring (rgb_moode_service.py)

The RGB LED ring displays moOde’s current state:

Color	Meaning
Solid green	Local playback (MPD playing)
Pulsing green	Paused
Blue	Stopped / idle
Red / pink	Internet radio stream
Purple	AirPlay active
Dim amber	Screen blanked (DPMS off / standby)

Notes:
	•	AirPlay does not always report an MPD state, so it is detected independently.
	•	Screen blanking is detected via X11 DPMS (xset) and takes priority.

⸻

🔘 Display Toggle Button (toggle_display_button.py)

A momentary pushbutton connected to GPIO 17 toggles moOde’s display:
	•	Short press → toggle between:
	•	WebUI
	•	PeppyMeter

Uses moOde’s built-in REST API command:

set_display toggle

Includes:
	•	software debounce
	•	cooldown to prevent accidental double toggles

⸻

Hardware Components

Required
	•	Raspberry Pi (tested on Pi 5)
	•	moOde audio player
	•	WS2812 / NeoPixel (ring or button)
	•	Momentary pushbutton (or NeoPixel button with integrated switch)
	•	Jumper wires / harness

⸻

Wiring

Momentary Pushbutton (GPIO 17)

Uses the Pi’s internal pull-up resistor.

Wire color	Function	Pi pin
White	Switch common (C)	Physical pin 6 (GND)
Green	Switch NO	Physical pin 11 (GPIO 17, BCM)


⸻

RGB NeoPixel Ring (SPI-driven)

Wire color	Function	Pi pin
Black	+5 V (VDD)	Physical pin 4 (5V)
Yellow	Ground	Physical pin 9 (GND)
Red	DATA IN (DIN)	Physical pin 19 (GPIO10 / SPI MOSI)
Orange	DATA OUT (DOUT)	Not connected
Blue	—	Not used

Notes:
	•	Only DIN connects to the Pi.
	•	DOUT is only for chaining LEDs.
	•	SPI clock is implicit — no separate CLK wire is used.

⸻

Software Dependencies

System packages

sudo apt update
sudo apt install -y python3-gpiozero python3-spidev

Python libraries (Adafruit)

sudo pip3 install —break-system-packages \
  adafruit-blinka \
  adafruit-circuitpython-neopixel-spi

These provide:
	•	board / busio abstractions
	•	SPI-driven NeoPixel support

⸻

moOde Configuration (Important)

The RGB service reads playback state from:

http://localhost/command/?cmd=get_currentsong

This endpoint reads the file:

/var/local/www/currentsong.txt

You must enable this in moOde:

Configure → Audio → MPD Options → Enable “Metadata file”

If disabled, the API returns {} and the LED will not update correctly.

⸻

Enable SPI (Critical on fresh installs)

Edit:

sudo nano /boot/firmware/config.txt

Add:

dtparam=spi=on
dtoverlay=spi0-0cs

Reboot and confirm:

ls -l /dev/spidev0.0


⸻

Installation

Copy scripts

sudo cp rgb_moode_service.py /usr/local/bin/
sudo cp toggle_display_button.py /usr/local/bin/
sudo chmod +x /usr/local/bin/*.py

Install systemd services

sudo cp rgb_moode.service /etc/systemd/system/
sudo cp toggle_display_button.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable rgb_moode.service
sudo systemctl enable toggle_display_button.service

Start services

sudo systemctl restart rgb_moode.service
sudo systemctl restart toggle_display_button.service

Check status:

systemctl status rgb_moode.service
systemctl status toggle_display_button.service


⸻

Troubleshooting

LED does not light
	•	Check SPI enabled (/dev/spidev0.0)
	•	Confirm DIN (red wire) is on pin 19
	•	Verify Python libs:

sudo python3 -c “import board, neopixel_spi; print(‘OK’)”



LED stuck amber

Amber means screen blank detected.

Check DPMS:

DISPLAY=:0 xset -display :0 q | grep “Monitor is”

Check moOde state:

curl -s “http://localhost/command/?cmd=get_currentsong”

Button not toggling display
	•	Verify GPIO 17 wiring
	•	Check logs:

journalctl -u toggle_display_button.service -n 50 —no-pager


⸻

Files in This Repo
	•	rgb_moode_service.py – RGB NeoPixel status logic
	•	rgb_moode.service – systemd unit for RGB service
	•	toggle_display_button.py – GPIO button → display toggle
	•	toggle_display_button.service – systemd unit for button service

⸻

License

MIT (recommended for small utility projects)

⸻

If you want, I can:
	•	tailor this README to your exact repo name
	•	add a wiring diagram image
	•	generate a matching LICENSE file
	•	or help you write the first GitHub release notes

Just say the word.