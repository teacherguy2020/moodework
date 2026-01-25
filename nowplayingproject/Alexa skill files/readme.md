Alexa Skill + AWS Lambda (relies upon established “now-playing” project)

moOde Now Playing

This repository describes how to build the Alexa Skill and deploy the AWS Lambda that powers moOde Now Playing.

The skill allows Alexa devices (Echo, Echo Show, etc.) to:
	•	Play music from a moOde / MPD queue
	•	Answer “what’s playing?”
	•	Support pause / resume / next
	•	Maintain continuous, gapless playback
	•	Stay correctly aligned with MPD’s queue using AudioPlayer lifecycle events

⸻

🧠 Core Design Principle (Read This First)

MPD (via moOde) is the single authority for playback order.

After each queue advance + prime, GET /now-playing always represents
the next correct track to play.

As a result:
	•	Sequential playback works
	•	Shuffle is respected
	•	No queue-slot math is required
	•	Drift, skips, and double-plays are eliminated

Alexa follows MPD — not the other way around.

⸻

⚠️ Important: Skill Name vs Invocation Name

Do not use “moode” as the invocation name.

While it’s fine to name the skill moOde, the invocation name should not be “moode”.

Why this matters

Alexa frequently mishears or ambiguously interprets:
	•	“moode”
	•	“mode”
	•	“mood”
	•	“mute”

This can cause:
	•	Skill launch failures
	•	Alexa triggering system actions instead of your skill
	•	Inconsistent behavior

✅ Recommended invocation name

Use something phonetically clear and stable:

mood audio

Example usage

Correct:
	•	“Alexa, open mood audio”
	•	“Alexa, ask mood audio what’s playing”
	•	“Alexa, tell mood audio to play”

Avoid:
	•	“Alexa, open moode”
	•	“Alexa, ask moode what’s playing”

⸻

1) Prerequisites

Required infrastructure

moOde Audio Player (Pi #1)
	•	Hosts MPD
	•	Maintains the authoritative playback queue

Node API (Pi #2)
Publicly reachable over HTTPS, exposing:
	•	GET /now-playing
	•	No key required
	•	Returns the next track MPD intends to play
	•	GET /track?file=...&k=...
	•	Streams audio (FLAC, etc.)
	•	Must be HTTPS with a valid certificate
	•	POST /queue/advance
	•	Authenticated via header or query key
	•	Removes the current queue head
	•	Primes MPD so /now-playing advances

Your public API base should look like:

https://moode.YOURDOMAINNAME.com


⸻

AWS / Alexa accounts
	•	Amazon Developer account (Alexa Skills)
	•	AWS account (Lambda + CloudWatch)

⸻

Why HTTPS matters

Echo devices require:
	•	HTTPS audio URLs
	•	Valid certificates
	•	Public reachability

Your /track endpoint must be:
	•	Fast
	•	Reliable
	•	TLS-valid

⸻

2) Create the Alexa Skill

A) Create a new skill
	1.	Go to Alexa Developer Console
	2.	Click Create Skill
	3.	Skill name: moOde (cosmetic)
	4.	Default language: your choice
	5.	Type: Custom
	6.	Hosting: Provision your own
	7.	Template: Start from scratch

⸻

B) Set the Invocation Name (Critical)

In Build → Invocation:

mood audio

Alexa will confirm if it’s valid.

⸻

C) Enable AudioPlayer interface

In Interfaces:
	•	✅ Audio Player

Required for:
	•	Streaming audio
	•	Playback lifecycle events

⸻

D) Enable APL (optional but recommended)

In Interfaces:
	•	✅ Alexa Presentation Language (APL)

Useful for metadata display on Echo Show devices.

⸻

3) Define the Interaction Model

Built-in intents

Add:
	•	AMAZON.PauseIntent
	•	AMAZON.ResumeIntent
	•	AMAZON.NextIntent
	•	AMAZON.StopIntent
	•	AMAZON.CancelIntent
	•	(optional) AMAZON.HelpIntent
	•	(optional) AMAZON.FallbackIntent

⸻

Custom intent: NowPlayingIntent

Name: NowPlayingIntent

Sample utterances:
	•	what’s playing
	•	what is playing
	•	what song is this
	•	now playing

⸻

Here is a json that you can drop in (look in the Build section of the Developer Console under “Interaction Model”

```{
  “interactionModel”: {
    “languageModel”: {
      “invocationName”: “mood audio”,
      “intents”: [
        {
          “name”: “AMAZON.CancelIntent”,
          “samples”: []
        },
        {
          “name”: “AMAZON.HelpIntent”,
          “samples”: []
        },
        {
          “name”: “AMAZON.StopIntent”,
          “samples”: []
        },
        {
          “name”: “AMAZON.FallbackIntent”,
          “samples”: []
        },
        {
          “name”: “AMAZON.PauseIntent”,
          “samples”: []
        },
        {
          “name”: “AMAZON.ResumeIntent”,
          “samples”: []
        },
        {
          “name”: “AMAZON.NextIntent”,
          “samples”: []
        },
        {
          “name”: “AMAZON.NavigateHomeIntent”,
          “samples”: []
        },
        {
          “name”: “NowPlayingIntent”,
          “slots”: [],
          “samples”: [
            “what’s playing”,
            “what is playing”,
            “what song is this”,
            “what track is this”,
            “what’s this”,
            “what song is playing”,
            “what track is playing”,
            “name the song”,
            “name the track”,
            “who is this”,
            “who is singing”
          ]
        },
        {
          “name”: “PlayAlbumIntent”,
          “slots”: [
            {
              “name”: “album”,
              “type”: “AMAZON.SearchQuery”
            }
          ],
          “samples”: [
            “play album {album}”,
            “play the album {album}”,
            “start album {album}”,
            “queue album {album}”,
            “queue the album {album}”,
            “play the album called {album}”,
            “start the album called {album}”
          ]
        },
        {
          “name”: “PlayPlaylistIntent”,
          “slots”: [
            {
              “name”: “playlist”,
              “type”: “AMAZON.SearchQuery”
            }
          ],
          “samples”: [
            “play playlist {playlist}”,
            “play the playlist {playlist}”,
            “start playlist {playlist}”,
            “start the playlist {playlist}”,
            “queue playlist {playlist}”,
            “queue the playlist {playlist}”,
            “play my playlist {playlist}”,
            “start my playlist {playlist}”,
            “play the playlist called {playlist}”,
            “start the playlist called {playlist}”
          ]
        }
      ],
      “types”: []
    }
  }
}
```

Launch behavior

The Lambda handles LaunchRequest, so users can say:
	•	“Alexa, open mood audio”
	•	“Alexa, launch mood audio”

⸻

4) Configure the Skill Endpoint

After creating the Lambda:
	1.	Go to Build → Endpoint
	2.	Select AWS Lambda ARN
	3.	Paste the ARN
	4.	Choose the correct region
	5.	Save

⸻

5) Create the AWS Lambda Function

A) Create function
	•	Runtime: Node.js 16+
	•	Timeout: 6–10 seconds
	•	Memory: 128–256 MB

⸻

B) Deploy code

Upload your Lambda code (and node_modules if needed).

Dependencies:
	•	ask-sdk-core
	•	Node standard libraries (https, etc.)

⸻

C) Environment variables

Required

API_BASE=https://moode.YOURDOMAINNAME.com
TRACK_KEY=your_shared_secret

Optional / advanced

PUBLIC_TRACK_BASE=https://moode.YOURDOMAINNAME.com
HTTP_TIMEOUT_MS=6000
ADVANCE_GUARD_MS=8000
ENQUEUE_GUARD_MS=5000


⸻

D) Add Alexa Skills Kit trigger

Lambda → Triggers → Add Alexa Skills Kit

⸻

6) Playback Flow (Authoritative Model)

1) Skill launch
	•	Lambda calls GET /now-playing
	•	Issues AudioPlayer.Play (REPLACE_ALL)
	•	Alexa begins playback

⸻

2) PlaybackStarted
	•	Lambda calls POST /queue/advance
	•	MPD deletes the queue head
	•	MPD primes itself
	•	/now-playing now reflects the next track

⸻

3) PlaybackNearlyFinished
	•	Lambda calls GET /now-playing
	•	Builds AudioPlayer.Play (ENQUEUE) using that track
	•	Lambda immediately advances + primes MPD again
so /now-playing stays accurate for the next cycle

⸻

4) PlaybackFinished
	•	If an ENQUEUE was already issued: no action
	•	Playback continues seamlessly

⸻

Key invariant

At all times, the next track to enqueue is whatever
/now-playing reports after the most recent advance.

Lambda never reasons about:
	•	Queue slots
	•	Index math
	•	Shuffle order

⸻

7) Pause / Resume (Offset-Safe)

Pause and resume are handled without breaking queue alignment.
	•	On AudioPlayer.PlaybackStopped, Lambda records:
	•	token
	•	offsetInMilliseconds
	•	On AMAZON.ResumeIntent:
	•	The same stream is replayed
	•	The saved offset is used
	•	No queue advance occurs

When playback resumes:
	•	The same track continues
	•	MPD remains aligned
	•	No unintended skips occur

⸻

8) Shuffle / Random Playback

Shuffle is fully supported.

When shuffle is enabled in moOde / MPD:
	•	MPD chooses the next track internally
	•	/now-playing reflects MPD’s choice
	•	Lambda enqueues exactly that

No Lambda changes are required.

MPD chooses order.
Lambda follows.

⸻

9) Testing

Voice tests
	•	“Alexa, open mood audio”
	•	“Alexa, ask mood audio what’s playing”
	•	“Alexa, next”
	•	“Alexa, pause”
	•	“Alexa, resume”

⸻

Logs

Check CloudWatch Logs for:
	•	AudioPlayer lifecycle events
	•	/now-playing payloads
	•	queue advance + enqueue activity

Clean logs should show:
	•	One advance per track start
	•	One enqueue per NearlyFinished
	•	No duplicate advances
	•	No advances on resume

⸻

10) Common Pitfalls

Skill launches but no audio
	•	/track must be HTTPS
	•	Certificate must be valid
	•	TRACK_KEY must be set correctly

⸻

Invocation launches the wrong thing
	•	Invocation name must be mood audio
	•	Avoid “moode”, “mode”, or “mute”

⸻

Skipped or repeated tracks
	•	Ensure MPD advance + prime is happening
	•	Ensure /now-playing reflects the next track
	•	Lambda must never calculate “next” itself

⸻

11) Quick Checklist
	•	Skill name set (cosmetic)
	•	Invocation name = mood audio
	•	AudioPlayer enabled
	•	Lambda deployed
	•	Environment variables set
	•	HTTPS working for /track
	•	CloudWatch logs clean
	•	Shuffle tested (optional)

⸻

If you want next, we can add:
	•	Token structure documentation (for debugging)
	•	Sequence diagrams (Launch → NearlyFinished → Enqueue)
	•	A troubleshooting decision tree
	•	Or extract this into a public GitHub README + blog post

This is very solid work.