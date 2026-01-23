# Alexa Skill + AWS Lambda (moOde Now Playing)

This README describes how to build the **Alexa Skill** and deploy the **AWS Lambda** that powers it.

The Skill:
- Plays the current moOde track on Echo devices (AudioPlayer)
- Answers “what’s playing?”
- Supports pause / resume / next
- Uses AudioPlayer lifecycle events to keep MPD’s queue aligned via your Node API

Your public API base should look like:

https://moode.YOURDOMAINNAME.com

—

## ⚠️ Important: Skill Name vs Invocation Name

**Do not use “moode” as the invocation name.**

While it’s fine to name the skill *moOde Now Playing*, the **invocation name** should **not** be “moode”.

### Why this matters

Alexa frequently mishears or ambiguously interprets:
- “moode”
- “mode”
- “mood”
- “mute”

As a result:
- Alexa may fail to launch the skill
- Alexa may interpret commands as system actions instead of a skill
- Invocation reliability becomes inconsistent

### ✅ Recommended invocation name

Use something phonetically clear and stable:

mood audio

This works well because:
- It’s easy to pronounce
- It’s two common words Alexa already recognizes
- It avoids collisions with system commands

### Example usage

Correct:

Alexa, open mood audio
Alexa, ask mood audio what’s playing
Alexa, tell mood audio to play

Avoid:

Alexa, open moode
Alexa, ask moode what’s playing

—

## 1) Prerequisites

### Required infrastructure
- **Node API (Pi #2)** reachable over the internet via **HTTPS**
  - Must expose endpoints like:
    - `GET /now-playing` (no key)
    - `GET /track?file=...&k=...` (key required)
    - `POST /queue/advance?k=...&pos0=...` (key required)

### AWS / Alexa accounts
- Amazon Developer account (Alexa Skills)
- AWS account (Lambda)

### Why HTTPS matters
Echo devices require the audio stream URL to be **HTTPS** with a valid certificate.  
Your `/track` endpoint must be publicly reachable and fast.

—

## 2) Create the Alexa Skill

### A) Create a new skill
1. Go to **Alexa Developer Console** → **Create Skill**
2. **Skill name:** `moOde Now Playing` (name is cosmetic)
3. **Default language:** your choice
4. **Type:** `Custom`
5. **Hosting:** `Provision your own`
6. **Template:** `Start from scratch`

—

### B) Set the Invocation Name (Critical)

In **Build → Invocation**:

Set:

mood audio

Alexa will confirm if it’s valid.

—

### C) Enable AudioPlayer interface

In **Interfaces**:
- ✅ **Audio Player**

Required for streaming audio and playback events.

—

### D) Enable APL (optional, recommended)

In **Interfaces**:
- ✅ **Alexa Presentation Language (APL)**

Not required for audio playback, but useful for Echo Show devices.

—

## 3) Define the Interaction Model (Intents)

### Built-in intents
Add:
- `AMAZON.PauseIntent`
- `AMAZON.ResumeIntent`
- `AMAZON.NextIntent`
- `AMAZON.StopIntent`
- `AMAZON.CancelIntent`
- (optional) `AMAZON.HelpIntent`

—

### Custom intent: NowPlayingIntent

Create:
- **Name:** `NowPlayingIntent`

Sample utterances:
- `what’s playing`
- `what is playing`
- `what song is this`
- `now playing`

—

### Launch behavior

Your Lambda handles `LaunchRequest`, so users can say:

Alexa, open mood audio
Alexa, launch mood audio

—

## 4) Configure the Skill Endpoint (Lambda ARN)

After creating Lambda:
1. **Build → Endpoint**
2. Choose **AWS Lambda ARN**
3. Paste the ARN
4. Select the correct region
5. Save

—

## 5) Create the AWS Lambda Function

### A) Create function
- Runtime: **Node.js (18+)**
- Timeout: **6–10 seconds**
- Memory: **128–256 MB**

—

### B) Deploy code
Upload your Lambda code (and `node_modules` if needed).

Dependencies:
- `ask-sdk-core`
- Node standard libs

—

### C) Environment variables

Required:

MOODE_API_BASE=https://moode.YOURDOMAINNAME.com
TRACK_KEY=your_shared_secret

Optional:

NOW_PLAYING_PATH=/now-playing
TRACK_PATH=/track
QUEUE_ADVANCE_PATH=/queue/advance
META_STABLE_GAP_MS=250
NEXT_ENQUEUE_GAP_MS=5000

—

### D) Add Alexa Skills Kit trigger
Lambda → **Triggers** → Add **Alexa Skills Kit**

—

## 6) Playback Flow (Mental Model)

- **LaunchRequest**
  - Lambda queries `/now-playing`
  - Sends `AudioPlayer.Play (REPLACE_ALL)`

- **PlaybackStarted**
  - Lambda calls `/queue/advance`
  - MPD stays aligned with Alexa

- **PlaybackNearlyFinished**
  - Lambda enqueues next track
  - Gapless playback

—

## 7) Testing

### Voice tests

Alexa, open mood audio
Alexa, ask mood audio what’s playing
Alexa, tell mood audio next
Alexa, pause
Alexa, resume

### Logs
Check **CloudWatch Logs** for:
- AudioPlayer events
- `/now-playing` payloads
- enqueue / advance activity

—

## 8) Common pitfalls

### Invocation fails or launches the wrong thing
- Ensure invocation name is **mood audio**
- Avoid “moode”, “mode”, or “mute”

### No audio
- `/track` must be HTTPS
- Certificate must be valid
- Endpoint must be reachable from the internet

—

## 9) Quick checklist

- [ ] Skill name set (cosmetic)
- [ ] Invocation name = **mood audio**
- [ ] AudioPlayer enabled
- [ ] Lambda deployed
- [ ] Env vars set
- [ ] HTTPS working for `/track`
- [ ] CloudWatch logs clean

—

If you want, next we can:
	•	add a short “Why Alexa is the queue master” section
	•	document token structure for debugging
	•	or add a troubleshooting flowchart for enqueue/advance issues