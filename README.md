# HBA Content Backend

Turn any long video into posts: captioned talking clips with hook titles, beat-synced "dope edits" of the best-looking moments, and a stack of titles and hooks — then schedule them to your accounts.

```
upload / link ─► probe ─► transcribe (Whisper) ─► analyze (Claude) ─► clips + titles & hooks
                   │                                                      │
                   └─► scan footage ─► pick shots ─► beat grid ─► edits   │
                                                                          ▼
                     live preview (HyperFrames player) ─► render (HyperFrames) ─► schedule / publish
```

## What it does

- **Import** — drag in a video file or paste a YouTube (or TikTok, Instagram…) link.
- **Clips** — Claude picks the strongest standalone moments; each gets an on-screen hook, post copy, hashtags and highlight words. **Preview & edit** plays the clip live before rendering: aspect ratio (9:16, 4:5, 1:1, 16:9), style (Podcast Frame is the default, Bold Pop, Clean Minimal), title, caption font/size/position/colors, crop, zoom and trim.
- **Titles & hooks** — viral post titles, YouTube titles, fire hooks and the key messages of the video (with jump-to-moment), each with ♥/✕ to teach it your taste.
- **Dope edits** — HyperFrames cuts the video's best-looking moments to a track from your sound library in a style learned from your Study reels:
  - **Cinematic smooth** (xpeleu, ashtinvonge, santiagogua1, vellar.jp, Arsh): held shots on the bar lines, slow pushes with a subtle handheld float, dissolves, a light leak, and a dark warm film grade with a slow-mo hero shot.
  - **Story promo** (Aldo's reels): opens on a spoken hook line with big word-by-word captions and ducked music, then beat cuts with punch-ins, flash hits, a black-and-white hit frame, letterbox bars and a hook title.

  The footage gets HyperFrames color grading, and the camera moves, handheld shake, flash cuts and light leaks are HyperFrames registry pieces. **Preview & tweak** updates grade strength, crop, bars, title, captions and accent live; changing style, length or format re-cuts it, and **New cut** picks different moments in the same style. Older director-planned and classic edits still open, preview and render.
- **Quality, all free and on this Mac** —
  - **Auto-frame:** when landscape footage is cropped for Reels/TikTok, Apple's on-device Vision finds faces, people and the main object, and the crop glides to keep them in view (clips and every Dope edit shot; switch it off in the editor to place the crop by hand).
  - **Working copy:** each import makes a light 1440p/30fps copy used for previews, analysis and tracking, so the editor plays smoothly. Final renders still take picture from the original, cut with the Mac's hardware encoder (~4× faster than before).
  - **Cleaner sound:** dialogue gets a rumble cut, gentle denoise and even loudness between quiet and loud stretches.
  - **Caption accuracy:** pick Standard / High / Best when importing, or **Improve captions** on a project to redo its transcript with a bigger local Whisper model (High and Best download once).
- **Study** — paste links or upload videos you admire and say what you like about them. Taste profiles (you, a friend, a client) feed into every analysis. **Analyze style** downloads a reel and measures its cuts, shot length, brightness, contrast, color and letterboxing (with a contact sheet); those numbers tune the Dope edit styles modeled on it.
- **Sounds** — upload music or import a folder; every track gets its tempo and beats mapped.
- **Scheduler** — review finished clips and edits, schedule them to multiple accounts on a week calendar. Instagram accounts connected under **Connect Instagram** post automatically; other posts become "Due now" with their file and caption ready.
- Renders run one at a time and can be stopped; projects can be deleted.

## Setup

```bash
npm install
cp .env.example .env   # paste your ANTHROPIC_API_KEY (the account needs API credits)
npm start              # → http://localhost:5173
```

Requirements: Node 22+ and Google Chrome. FFmpeg and ffprobe come bundled from npm. With Homebrew:

```bash
brew install cmake     # one-time whisper.cpp build on first transcription (or: brew install whisper-cpp)
brew install yt-dlp    # video links
```

Without a working Claude key (missing, or out of credits) clips and titles fall back to a keyword heuristic and the app says so; everything else still works.

## Project layout

```
server.js            Express API + static UI
public/              UI (vanilla JS, no build step)
lib/pipeline.js      import → transcribe → analyze, and the render queue (clips + edits)
lib/analyze.js       Claude structured-output analysis (plus demo heuristic)
lib/compose.js       clip composition (styles, aspect ratios, live preview)
lib/hfstyles.js      editing styles learned from studied reels (pacing, camera, transitions, HyperFrames grade, text)
lib/hfplan.js        HyperFrames edits: shots on the music grid, hook lines, transitions, preview proxy
lib/hfedit.js        HyperFrames edit composition (grading, registry camera moves/shake, flash + light-leak blocks)
lib/reelstyle.js     measures a studied reel: cuts, shot length, tone, color, letterbox, contact sheet
lib/subject.js       auto-frame: finds faces/people/objects (Apple Vision, lib/vision/track.swift → data/bin/vision-track) and keeps them in the crop
lib/work.js          the light working copy (work.mp4: ≤1440p, 30fps, cleaned dialogue) used for previews, analysis and tracking
lib/media.js         probe, fast cuts (Mac hardware encoder, x264 fallback), working copy, dialogue cleanup filter
assets/registry/     vendored HyperFrames registry items (editorial-flash-overlay, organic-light-leak-overlay, camera-shake, yt-camera-move)
lib/dope.js          director-planned edits: bridges the project page to the edits/ planner (plan, live preview, tweaks, render)
lib/editplan.js      edit-plan/1 → staged segments + HyperFrames composition (shared/EDIT_PLAN.md)
edits/               the edit planner/director (mounted at /edits; maintained by the Dope Clips session)
lib/edit.js          classic dope-edit composition (older edits made before the director)
lib/edits.js         classic edit planning: moments → shots → beat grid → preview proxy
lib/visual.js        visual moment scanning      lib/beats.js   tempo + beat detection
lib/sounds.js        sound library               lib/study.js   references + taste profiles
lib/youtube.js       yt-dlp metadata + downloads lib/scheduler.js accounts, posts, publishing tick
lib/transcribe.js    Whisper via HyperFrames     lib/render.js  hyperframes render wrapper
instagram/           Instagram publishing (see shared/CONTRACT.md)
titles/              title taste (see titles/README.md)
projects/<id>/       source video, transcript, compositions/, edits/, renders/
data/                scheduler, study, sounds and Instagram data (keep out of git)
```

Useful env vars: `PORT`, `WHISPER_MODEL` (`base.en` is faster; `medium.en` handles noisy audio better), `YTDLP_PATH`.
