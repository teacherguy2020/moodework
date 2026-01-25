# Alexa Skill + AWS Lambda  
## moOde Now Playing

This README describes how to build the **Alexa Skill** and deploy the **AWS Lambda** that powers **moOde Now Playing**.

The skill allows Alexa devices (Echo, Echo Show, etc.) to:

- Play music from a moOde / MPD queue
- Answer “what’s playing?”
- Support pause / resume / next
- Maintain **continuous playback**
- Stay correctly aligned with MPD’s queue using AudioPlayer lifecycle events

—

## 🧠 Core Design Principle (Read This First)

**MPD (via moOde) is the single authority for playback order.**

> **After each queue advance + prime, `GET /now-playing` always represents  
> the next correct track to play.**

As a result:
- Sequential playback works
- Shuffle is respected
- No queue-slot math is required
- Drift and skipped tracks are eliminated

Alexa **follows MPD** — not the other way around.

—

## ⚠️ Important: Skill Name vs Invocation Name

**Do not use “moode” as the invocation name.**

While it’s fine to name the skill *moOde*, the **invocation name** should **not** be “moode”.

### Why this matters

Alexa frequently mishears or ambiguously interprets:
- “moode”
- “mode”
- “mood”
- “mute”

This can cause:
- Skill launch failures
- Alexa triggering system actions instead of your skill
- Inconsistent behavior

### ✅ Recommended invocation name

Use something phonetically clear:

mood audio

### Example usage

Correct:
- “Alexa, open mood audio skill”
- “Alexa, ask mood audio skill what’s playing”
- “Alexa, tell mood audio skill to play”

—

## 1) Prerequisites

### Required infrastructure

- **moOde Audio Player (Pi #1)**
  - Hosts MPD
  - Maintains the authoritative queue

- **Node API (Pi #2)**  
  Publicly reachable over **HTTPS**, exposing:

  - `GET /now-playing`  
    - No key required  
    - Returns the *next* track MPD intends to play

  - `GET /track?file=...&k=...`  
    - Streams audio (FLAC, etc.)
    - Must be HTTPS with a valid certificate

  - `POST /queue/advance?k=...&pos0=...`  
    - Removes the current queue head
    - Primes MPD so `/now-playing` advances

Your public API base should look like:

https://moode.YOURDOMAINNAME.com

—

### AWS / Alexa accounts

- Amazon Developer account (Alexa Skills)
- AWS account (Lambda + CloudWatch)

—

### Why HTTPS matters

Echo devices **require**:
- HTTPS audio URLs
- Valid certificates
- Public reachability

Your `/track` endpoint must be:
- Fast
- Reliable
- TLS-valid

—

## 2) Create the Alexa Skill

### A) Create a new skill

1. Go to **Alexa Developer Console**
2. Click **Create Skill**
3. **Skill name:** `moOde` (cosmetic)
4. **Default language:** your choice
5. **Type:** `Custom`
6. **Hosting:** `Provision your own`
7. **Template:** `Start from scratch`

—

### B) Set the Invocation Name (Critical)

In **Build → Invocation**:

mood audio

Alexa will confirm validity.

—

### C) Enable AudioPlayer interface

In **Interfaces**:
- ✅ **Audio Player**

Required for:
- Streaming audio
- Playback lifecycle events

—

### D) Enable APL (optional but recommended)

In **Interfaces**:
- ✅ **Alexa Presentation Language (APL)**

Useful for Echo Show metadata display.

—

## 3) Define the Interaction Model

### Built-in intents

Add:
- `AMAZON.PauseIntent`
- `AMAZON.ResumeIntent`
- `AMAZON.NextIntent`
- `AMAZON.StopIntent`
- `AMAZON.CancelIntent`
- (optional) `AMAZON.HelpIntent`

—

### Custom intent: `NowPlayingIntent`

**Name:** `NowPlayingIntent`

Sample utterances:
- `what’s playing`
- `what is playing`
- `what song is this`
- `now playing`

—

### Launch behavior

The Lambda handles `LaunchRequest`, so users can say:

- “Alexa, open mood audio”
- “Alexa, launch mood audio”

—

## 4) Configure the Skill Endpoint

After creating the Lambda:

1. Go to **Build → Endpoint**
2. Select **AWS Lambda ARN**
3. Paste the ARN
4. Choose the correct region
5. Save

—

## 5) Create the AWS Lambda Function

### A) Create function

- Runtime: **Node.js 16+**
- Timeout: **6–10 seconds**
- Memory: **128–256 MB**

—

### B) Deploy code

Upload your Lambda code (and `node_modules` if needed).

Dependencies:
- `ask-sdk-core`
- Node standard libraries (`https`, etc.)

—

### C) Environment variables

**Required**

MOODE_API_BASE=https://moode.YOURDOMAINNAME.com
TRACK_KEY=your_shared_secret

**Optional**

NOW_PLAYING_PATH=/now-playing
TRACK_PATH=/track
QUEUE_ADVANCE_PATH=/queue/advance
META_STABLE_GAP_MS=250
NEXT_ENQUEUE_GAP_MS=5000

—

### D) Add Alexa Skills Kit trigger

Lambda → **Triggers** → Add **Alexa Skills Kit**

—

## 6) Playback Flow (Authoritative Model)

### 1) Skill launch

- Lambda calls `GET /now-playing`
- Issues `AudioPlayer.Play (REPLACE_ALL)`
- Alexa begins playback

—

### 2) PlaybackStarted

- Lambda calls `POST /queue/advance`
- MPD deletes the head of the queue
- MPD primes itself
- `/now-playing` now reflects the *next* track

—

### 3) PlaybackNearlyFinished

- Lambda calls `GET /now-playing`
- Builds `AudioPlayer.Play (ENQUEUE)` using that track
- (Recommended) Lambda immediately advances + primes MPD again  
  so `/now-playing` stays accurate for the next cycle

—

### 4) PlaybackFinished

- If an ENQUEUE was already issued: **no action**
- Playback continues seamlessly

—

### Key invariant

> At all times, the next track to enqueue is whatever  
> `/now-playing` reports **after** the most recent advance.

Lambda never reasons about:
- Queue slots
- Index math
- Shuffle order

—

## 7) Shuffle / Random Playback

Shuffle is **fully supported**.

When shuffle is enabled in moOde / MPD:
- MPD chooses the next track internally
- `/now-playing` reflects MPD’s choice
- Lambda enqueues exactly that

No Lambda changes are required.

**Important:**  
MPD must remain the system choosing order.  
Lambda must never attempt to reorder or predict.

—

## 8) Testing

### Voice tests

- “Alexa, open mood audio skill”
- “Alexa, ask mood audio skill what’s playing”
- “Alexa, next”
- “Alexa, pause”
- “Alexa, resume”

—

### Logs

Check **CloudWatch Logs** for:
- AudioPlayer lifecycle events
- `/now-playing` payloads
- queue advance + enqueue activity

Clean logs should show:
- One advance per track start
- One enqueue per NearlyFinished
- No duplicate advances

—

## 9) Common Pitfalls

### Skill launches but no audio
- `/track` must be HTTPS
- Certificate must be valid
- `TRACK_KEY` must be set

—

### Invocation launches the wrong thing
- Invocation name must be **mood audio**
- Avoid “moode”, “mode”, “mute”

—

### Skipped or repeated tracks
- Ensure MPD advance + prime is happening
- Ensure `/now-playing` reflects the next track
- Lambda should never calculate “next” itself

—

## 10) Quick Checklist

- [ ] Skill name set (cosmetic)
- [ ] Invocation name = **mood audio**
- [ ] AudioPlayer enabled
- [ ] Lambda deployed
- [ ] Environment variables set
- [ ] HTTPS working for `/track`
- [ ] CloudWatch logs clean
- [ ] Shuffle tested (optional)

—
