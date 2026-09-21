# EDITOR_STYLE — reference edit study

Source: 5 long-form YouTube videos from the user's own channel (Dr. Odell Miller), studied frame by frame
(contact sheets every 2 s, dense 10 fps strips around every transition type, auto-transcript lined up to picture,
ffmpeg scene-cut detection). Timestamps are `VIDEO mm:ss`. Video keys:

| Key | URL | Length | Weight |
|---|---|---|---|
| **BEST** | youtu.be/rUDr4zC5_vY "6 Numbers keeping you from 100k/month" | 13:55 | highest |
| **D** | DReCfd7nTj8 "If you have enough money..." | 12:38 | normal |
| **U** | rUa5DPgrkbM "Why you're stuck at $100k/Month" | 10:07 | normal |
| **H** | HaGGuHAd3zo "If I had to start my $860K+ business over" | 9:03 | normal |
| **Q** | Q9SRdVn_-zc "How to make $100k/month as a PT" | 6:47 | high (same editor as BEST) |

There are two editing "families":
- **Studio family (BEST, Q)**: tripod camera, speaker seated or standing, yellow sentence captions the whole time,
  iPad whiteboard + circle PIP, designed motion-graphic cards. This is the one to copy first.
- **Vlog family (D, U, H)**: selfie cam walking/sitting outdoors, no running captions, giant behind-the-head
  keywords, white/black minimal text cards, inset B-roll.

Note on the phone request: none of the five shows a literal phone screen recording. The screen-share they do
use is a **tablet whiteboard recording (iPad notes app, toolbar visible) with the speaker in a circle PIP**. The
phone-demo layout in this spec is that same system applied to a 9:19.5 phone recording (see O2b).

---

## 1. Per-video summary

**BEST (rUDr4zC5_vY)**. 16:9. Seated on a high-rise balcony, medium-wide shot, warm/neutral grade. About 48% of the
runtime is the iPad whiteboard: a dark "slide" of 8 metric tiles (CPL, BOOK %, SHOW %, CLOSE %, CAC, LTV, ROAS,
LTGP) with live red-pen annotations, and the speaker in a circle bottom-right. The intro (0:00–1:18) has
a new graphic every 3–6 s: text cards, icon motion graphics, B-roll insets, a subscribe animation. After that it
alternates between whiteboard and full-screen speaker in 2–60 s blocks. Yellow sentence captions run the whole time.

**Q (Q9SRdVn_-zc)**. 16:9. Same editor and system as BEST: standing in front of greenery, iPad in hand. "$100K/Month
Flywheel" whiteboard + circle PIP, cream motion-graphic cards with orange icons (1:02–1:06 orbit, 1:26–1:30
clock → X / check), a giant "1" behind "PROVIDE RESULTS" with a green highlighter swipe (1:14). This is the fastest cut
of the five (about 25 cuts/min in the first 6 min). The outro has a social-handles lower third over B-roll (6:40).

**D (DReCfd7nTj8)**. 16:9. Selfie vlog walking through a resort, bright saturated daylight. No running captions.
Emphasis comes from **huge white keywords behind the head** ("MARKETING" 0:55, "SALES TEAM" 0:58, "BIG GAPS"
1:06) and a **green "$650k" behind the head** (1:30). It also uses black cards with small glowing white quote text
(0:26, 1:52), white cards with black shadowed caps ("THAT IS THE GOAL" 0:38), and B-roll insets (0:16, 0:32).

**U (rUa5DPgrkbM)**. 16:9. Same vlog system as D. It adds a red "FEAR" keyword behind the head (0:18) and a
wide-spaced white name title (0:02). There is a **rounded-rect reveal**: a black quote card, then the speaker video
pops back as a small rounded card and scales up before the cut to full frame (3:18–3:21). There is also a
typewriter word card on black (6:02).

**H (HaGGuHAd3zo)**. 16:9. Seated selfie under a palapa. Minimal overlays: a green glowing "EASIER THAN EVER!"
card (0:10), white caps cards ("IT IS VERY BASIC!" 0:31, "DM FUNNEL" 0:54, "ATTRACT CONVERT" 8:00), and a
concentric-ring black card that reveals "ATTRACT / CONVERT / DELIVER" (0:33). It ends with a light-leak flash into
B-roll with a "THANK YOU FOR WATCHING!" title (8:55).

---

## 2. Overlay catalogue

All geometry is a % of the 16:9 canvas (x from left, y from top). Durations were measured at 10 fps (±0.1 s).

### O1. Whiteboard slide + circle PIP ("slide pops up")  (main slide format)
- **When**: the speaker starts a list or framework, or says a number to track. BEST 1:18 is "we're gonna dive
  right in" → "number one". BEST 2:08 is "let's say your cost per lead is $75" (he writes "$75" on the tile). BEST 6:30
  zooms into the CPL tile on "I'll zoom in and see what's going on". Q 0:48 is "understand this flywheel".
- **Geometry**:
  - Background: near-black (#0e0e10 to #141416) with a very subtle radial lift.
  - Slide/board window: x 4.7–72%, y 5–95%. Rounded top corners (~1.5% of width). A thin light tool bar
    across the top (the app toolbar, ~3% tall). The board is dark charcoal with faint tile borders.
  - Slide content: small orange letter-spaced kicker ("MARKETING NUMBERS YOU MUST TRACK"), a serif white title,
    a tile grid with orange serif labels and a grey sub-label, and italic orange footnotes.
  - Speaker PIP: a **circle**, diameter ~29% of width (52% of height), centre at about x 84%, y 67%. It
    overlaps the board's right edge by ~10% and bleeds almost to the bottom and right edges (right edge 98.5%, bottom ~92%).
    No border, no visible shadow. The speaker is re-cropped face-and-chest inside the circle, live video.
  - Captions stay on top at y ~86%.
- **Speaker treatment**: the full-frame shot is replaced by the circle crop. It does not shrink with a
  visible scale move; it is a cut.
- **IN**: a light-leak/film-burn flash (orange-yellow flare wipes across, ~0.5 s, BEST 1:18.1–1:18.6). During
  the flash the board and circle are already there underneath. On later entries (after the first) it is
  mostly a **hard cut** (BEST 1:25, 1:47, 2:08).
- **OUT**: a hard cut back to full-frame speaker, or a hard cut to a dark text card (BEST 1:21.0→1:21.1).
- **Inside-slide motion**:
  - Live pen annotations are drawn over time (circling a tile, writing numbers).
  - **Zoom punch into the board**: an instant cut to ~1.6x crop on the tile being discussed while the PIP
    circle stays fixed (BEST 6:30.0→6:30.1). Hold ~8–15 s, then cut back to the full board.
- **On-screen time**: 2–66 s per block. Median ~9 s. Long blocks happen while he calculates (BEST 3:37 46 s,
  7:17 66 s).
- **Frequency**: BEST ~29 blocks in 14 min (≈2/min), covering about half the runtime. Q ≈3.5/min with shorter
  blocks (median ~4 s). Blocks alternate with 2–10 s of full-frame speaker so the face keeps coming back.

### O2. Split layout for phone demo  (derived; implement for the user's request)
- **O2a, observed basis**: O1 (screen content left and large, live speaker in a circle bottom-right) plus the
  rounded-rect scale-in from U 3:20 (O8).
- **O2b, phone spec**:
  - Background: the same near-black.
  - Phone screen recording: height 88%, centred at x 30%, inside a phone-shaped rounded rect (radius ~6%
    of phone width) with a 1px light border at 15% opacity and a soft drop shadow.
  - Speaker: moves to the right half as a rounded rect (x 55–95%, y 12–88%, radius ~2.5% of canvas
    width). Keep the circle-PIP variant (O1 geometry) for demos longer than 15 s.
- **IN**:
  - The speaker full-frame scales down to its box and slides right over 0.35 s. Easing: ease-out cubic
    with ~4% overshoot (matches the U 3:20 pop).
  - The phone rises from y +15% with fade in over 0.35 s, starting 0.1 s after the speaker move.
  - Optional light-leak flash on the very first demo only (matches O1's first-entry flash).
- **OUT**: hard cut back to full-frame (the reference editors never animate out), or the reverse of IN at
  0.25 s if the demo ends mid-sentence.
- **Stay**: while the speaker refers to the screen ("look at this", "here", "I click"). Max 20 s before
  a 2–4 s full-frame speaker beat (O1 pattern).

### O3. Full-screen text card  (most frequent graphic)
Five skins. Pick by section mood.
| Skin | Background | Text | Example |
|---|---|---|---|
| Cream | warm off-white #efe9df, strong dark vignette | heavy extended caps, orange-red #f0582a, 2 lines centred, cap height ~7% | BEST 0:19 "YOUR BUSINESS WILL GROW", 0:46, 1:12 |
| Dark gradient | charcoal radial #2a2a2c→#0c0c0e | heavy caps white, one keyword in neon green #39ff14 or orange #f7a21b | BEST 0:26 "YOUR BUSINESS WILL **GROW!**", 1:21 "COST PER LEAD", Q 1:38 |
| White minimal | #f6f4f8 flat | heavy black caps with a soft blurred drop shadow, cap height ~5% | H 0:12, 0:31, 0:54; U 8:04; D 0:38 |
| Black quote | pure black | small (≈3% height) white lowercase with a soft glow, centred | D 0:26, 1:52; U 0:22, 3:18 |
| Black neon | pure black | neon green heavy caps with glow, small white sub-line | H 0:10 "EASIER THAN EVER!" |
- **When**: a punchline, a promise, a section keyword, or a re-stated number. The words on the card are a
  2–6 word compression of what is being said (not verbatim). Appears 0–0.3 s after the key word.
- **IN**: blur-to-sharp plus fade plus slight scale-down (≈1.08→1.0) over **0.3–0.4 s**, ease-out (BEST
  0:25.7–0.26.1, 1:21.1–1:21.5). The black-quote skin fades in over ~0.3 s. The cream card sometimes has a
  sub-label typed in word by word (Q 0:45.6).
- **Extras**: a red highlight box behind part of a line (BEST 2:06 "they all have a cost to it"), and a green
  highlighter swipe left→right behind a phrase over 0.6 s (Q 1:14.0–1:14.6). A giant faded "1" numeral
  sits behind the text for numbered points (Q 1:13).
- **OUT**: hard cut (all references). Sometimes the next card follows directly (BEST 0:20→0:21→0:22 chain).
- **Stay**: 1.2–2.5 s (BEST 0:25.7–27.1 = 1.4 s; Q 0:44.5–46.2 = 1.7 s; H 0:31.2–32.5 = 1.3 s; quote cards
  1.5–2 s).
- **Frequency**: intro (first 75 s) is 1 every 5–8 s. Body is 1 every 30–90 s (BEST), 1 every 20–40 s (Q, H).

### O4. Behind-the-head keyword (emphasis caption)  (the "big bold glowing text behind the person")
- **When**: a section keyword or a big number the speaker hits: "marketing" (D 0:55), "sales team" (D 0:58),
  "big gaps" (D 1:06), "$650k cash collected" (D 1:29), "fear" (U 0:18).
- **Geometry**:
  - Text sits **between background and person** (subject matte). Head and shoulders occlude letters, e.g.
    "MAR█TING" (D 0:56).
  - One word spans ~95% of canvas width, centred around y 40%, cap height ~16% of height.
  - Two words stack on 2 lines at x 5–95%, y 18–70%, cap height ~22% per line (D 0:58, 1:06).
  - Numbers sit lower (y 55–70%, D 1:30) so the face stays clear.
- **Style**:
  - Heavy geometric/extended sans in all caps (Montserrat Black / Clash Display Bold feel).
  - Colour is white (#fff) by default, neon green #39ff14 for money, red #e0141e for negative/fear.
  - Soft outer glow/shadow: ~10 px blur at 25–35% opacity (glow is subtle, not neon).
  - A small white lowercase sub-caption sits on top (in front of the person) at y ~60%, ~2.5% height,
    repeating the spoken phrase ("marketing: creatives and other marketing details").
- **IN**: U "FEAR" scales from ~80%→100% with a slight overshoot over 0.2 s (U 18.5–18.6). D keywords are a
  hard cut in (D 55.5→55.6).
- **OUT**: hard cut. Or it is replaced directly by the next keyword (D 58.2→58.3).
- **Stay**: 2.5–4 s (D 55.6–58.2 = 2.6 s; D 58.3–~61.5 ≈ 3.2 s; $650k 29.6–~33 ≈ 3.5 s).
- **Frequency**: bursts of 2–3 during a list, then none for minutes. About 4 in the first 2 min of D, 1 in U's
  first minute, 0 in H. Treat as ≤ 1 per 20 s and ≤ 3 per minute.

### O5. B-roll inset ("floating" cutaway)
- **When**: the speaker mentions a real place, people, or proof. BEST 0:33 "I graduated PT school 3 years ago"
  shows the clinic exterior. BEST 0:35 "650K cash collected" shows the clinic floor and team. D 0:16 shows a
  workshop audience, D 0:32 a lifestyle clip, U 0:10 a client call.
- **Geometry**: video scaled to **80%** (x 9.8–90%, y 9.8–90%), centred on near-black #0d0d0f. Square
  corners or tiny radius (<0.5%), no border. Captions over it at y ~86%.
- **IN/OUT**: hard cut in and out. Inside a run, consecutive B-roll clips hard cut every 1.5–2.5 s (BEST
  0:33–0:40: 4 clips in 7 s).
- **Stay**: 1.5–4 s per clip, 2–4 clips per run.
- **Frequency**: 2–4 runs in the first 90 s, rare afterwards (≤1 per 2 min).
- A full-frame B-roll variant (no inset) is used for the outro (Q 6:40, H 8:56).

### O6. Icon motion-graphic card
- **When**: abstract concepts in the intro or list items. BEST 0:04 "no matter what funnel you choose" shows an
  orange medical cross with orbit rings and flying icons. BEST 0:50–0:56 "workshops, paid ads, VSLs, DMs" shows
  icons wired by circuit traces to a glowing centre chip. BEST 1:00–1:02 "internal/external referrals" shows
  orange arrows feeding a black funnel labelled "MARKETING CHANNELS". Q 1:26–1:30 "time vs results" shows a
  clock, then X, then an orange check.
- **Style**: cream background (#efe9df, vignette), flat black line icons, orange #f0582a accents with a soft
  glow on the "active" element. Captions stay on.
- **IN**: elements build over 1–2 s (scale-pop 0.2 s each, spring, staggered ~0.15 s). Traces draw on.
  A zoom-into-card (scale 1→1.15 over ~2 s) is common.
- **OUT**: hard cut. **Stay**: 2–6 s. **Frequency**: 3–5 in the intro minute, rare afterwards.

### O7. Lower thirds / titles
- **Name title** (BEST 0:02.2–0:02.9, Q 0:02):
  - "DR. ODELL MILLER" in heavy extended orange-red caps, x 10–90% at y ~57%, cap height ~6%, soft glow.
  - IN: left→right reveal wipe over 0.3–0.4 s. OUT: cut after ~0.7 s (it lasts under 1 s).
  - Vlog version (U 0:02): white, wide letter-spacing, stays ~1.5 s.
- **Subscribe button** (BEST 0:30.8–0:33.1, Q 0:14, Q 6:36):
  - The white word "SUBSCRIBE" sits at bottom centre (x 44–56%, y ~83%). It morphs into an orange #f0582a
    rounded button (~22% wide, ~6% tall).
  - A cursor clicks it and a white check mark pops. Total ~2.3 s. Triggered on the words "subscribe" /
    "if you're new to my channel".
- **Social handles** (Q 6:40): IG / FB / Skool icons with white bold handles stacked at left (x 7%, y 60–72%)
  over outro B-roll, ~3 s.
- **Channel page screenshot** (BEST 0:40, Q 0:06): a YouTube channel page tilted in perspective, full-frame, on
  "on this channel" / "for those of you who are new".

### O8. Rounded-rect reveal (return from a card)  (U 3:18–3:21)
- A black quote card (1.5 s). Then the speaker video appears as a small rounded rect (33% width, radius ~10% of
  box height) at centre. It scales to 55% width in 0.2–0.3 s with a slight overshoot and holds ~0.9 s on black,
  then hard cuts to full frame.
- Use it as the "come back to the face" transition after a quote card. This is the source of O2's speaker-box motion.

### O9. Typewriter word card (U 6:02.5–6:04)
- Black background. Small white bold words ("admin", "delivery", ...) appear letter by letter at ~10 chars/s,
  spaced horizontally as a list is spoken. Use it for rapid lists of 3+ nouns.

### O10. Concentric-ring reveal card (H 0:33)
- Black background with 3–4 thin grey concentric circles drifting, and a small white sphere at bottom-left.
  A white glowing caps word appears in the centre ring ("ATTRACT"), then stacks to 3 words. IN is a fade/scale
  0.2 s, hold 1.5–3 s, hard cut out.

### O11. Transitions
- **Light-leak / film-burn flash**: orange-yellow flare over 0.4–0.6 s. Used for (a) the first switch into the
  whiteboard (BEST 1:18), (b) intro → body (Q 0:46.9), (c) the outro (H 8:54.9–8:55.6, Q 6:38). About 2–4 per video.
- Everything else is a **hard cut**. No slides, whips, or cross-dissolves between talking shots.

---

## 3. Captions

### Regular captions (studio family only: BEST, Q)
- **Font**: rounded geometric sans, Bold/SemiBold (Poppins SemiBold look), **lowercase**, no terminal punctuation.
- **Size**: cap/x-height ≈ 3.2% of frame height (about 34 px on 1080p). Single line.
- **Position**: centred, baseline at y ≈ 87%. Stays there over every layout, including over the whiteboard and
  over B-roll insets.
- **Colour**: yellow #f2c21b, thin dark outline/shadow for contrast. No box.
- **Grouping**: a phrase-level line of 4–10 words (roughly one clause, e.g. "so make sure you watch all the
  way through"). It is replaced as a whole. **No per-word karaoke highlight** in the references.
- Vlog family (D, U, H) has **no running captions**. Text appears only via O3/O4.

### Emphasis captions
- **Primary**: O4 behind-the-head keyword (white / green / red, 16–22% cap height, subtle glow, 2.5–4 s).
- **Secondary**: O3 full-screen text card when the matte is poor or the speaker is small in frame (studio
  family uses cards instead of behind-head text).
- **Frequency**: ≤ 1 every 20 s, clustered on list headings and money numbers. Never two back-to-back unless
  they are items of the same list (D 0:55→0:58→1:06).

---

## 4. Motion and pacing

- **Detected cuts** (scene detection, first 6 min): BEST 15/min (median shot 1.9 s), Q 25/min (1.7 s),
  H 17/min (2.8 s), U 12/min (3.4 s), D 7/min (3.4 s). Jump cuts inside the same framing are extra.
- **Talking-head punch zoom**: jump cuts alternate between wide (1.0x) and tight (~1.25x crop, face centred at
  y ~35%). This happens every 1–3 cuts, on the start of a new sentence or on a stressed word (BEST 0:14 wide →
  0:16 tight; BEST 1:17.5→1:17.6 tight→wide). Instant, no animated ease.
- **Board punch zoom**: 1.6x into the discussed tile (BEST 6:30). The PIP stays unscaled.
- **Structure**:
  - Hook (0–20 s) is the talking head plus 3–5 cards (promise lines).
  - Intro/credibility (20–75 s) is the name title, subscribe button, a B-roll run, and the channel screenshot.
  - The body alternates whiteboard blocks with full-frame speaker.
  - Outro is a light-leak flash, a subscribe button, then B-roll with thank-you/social titles.
- **Sound design** (inferred from visuals, not audible in this study):
  - Likely whoosh or riser on light-leak flashes.
  - Likely soft pop/impact on card and keyword hits (0.2 s scale/blur-in).
  - Likely mouse click on the subscribe cursor.
  - Likely typewriter ticks on O9.
  - Low music bed in the intro and outro (transcript shows [music] at BEST 13:50).

---

## 5. Colour and typography palette

| Token | Value (approx) | Use |
|---|---|---|
| ink-black | #0d0d0f | whiteboard / inset background |
| charcoal-grad | #2a2a2c → #0c0c0e radial | dark text cards |
| cream | #efe9df + dark vignette | cream cards, icon graphics |
| paper-white | #f6f4f8 | minimal white cards |
| accent-orange | #f0582a | headlines on cream, name title, subscribe button, icons |
| accent-amber | #f7a21b | board tile labels, dark-card keyword |
| money-green | #39ff14 | money numbers, "GROW!", highlighter swipe |
| alert-red | #e0141e | FEAR / negative keyword, pen annotations (#d62b2b) |
| caption-yellow | #f2c21b | running captions |

- **Headline font**: heavy extended grotesk caps (Clash Display Bold / Montserrat Black / Archivo Expanded
  Black feel), tight tracking, 2-line stacks.
- **Caption font**: Poppins SemiBold lowercase.
- **Slide font**: serif display for titles (Playfair/DM Serif feel), orange serif tile labels, small grey
  sans sub-labels, orange italic footnotes, letter-spaced orange kicker.
- **Grade**: bright, warm, saturated daylight. Skin slightly warm, greens pushed (D/U/H). The studio family is
  slightly lower contrast and neutral.
- For our app, map these to `public/theme.css` tokens (the design session owns hex values); use this table
  as the intended look.

---

## 6. Rules for our AI director

1. **Slide trigger**: open a whiteboard/slide (O1) when the transcript starts a framework, list, or set of numbers
   ("number one", "let's say your X is $N", "the N things"). Place it at the start of that sentence, never before.
2. **Slide content follows speech**: the slide stays up while its subject is being discussed. Reveal or annotate
   the item being named within 0.3 s of the word (circle the tile, write the number).
3. **Slide length**: ≥ 2 s and ≤ 20 s per block when nothing on it changes. If the speaker stays on the topic,
   break it with a 2–5 s full-frame speaker beat, then return. Only calculation/walkthrough segments may run to 60 s.
4. **Face budget**: during slide-heavy sections, the speaker is full-frame at least once every 25 s. Overall,
   slides and cards cover ≤ 55% of runtime.
5. **Phone/screen demo**: on "look at this", "on my phone", "here's the app", or a screen recording on the
   timeline, switch to O2b. Speaker box scales/slides out in 0.35 s with a small overshoot, phone rises 0.1 s
   later. Speaker returns full-frame within 1 s of the last screen reference, and at most 20 s after entry.
6. **First entry gets a flash**: the first slide or demo of a video enters through a 0.5 s light-leak.
   Later entries hard cut. Max 4 light-leaks per video (first slide, intro→body, outro, one spare).
7. **Emphasis keyword (O4)**: only on a section heading word or a money/percent number. ≤ 1 per 20 s, ≤ 3 per minute.
   Exception: consecutive items of one spoken list may chain directly. Hold 2.5–4 s. Place behind the person
   when a subject matte is available, otherwise use an O3 dark card.
8. **Keyword colour**: green for money/growth, red for fear/loss/mistakes, white for everything else.
   Never more than one accent colour per card.
9. **Text cards (O3)**: a 2–6 word compression of the line, hold 1.2–2.5 s, blur+fade+scale-in 0.35 s, hard cut out.
   Intro (first 75 s) is one every 5–8 s. Body is at most one every 30 s.
10. **Hook density**: in the first 20 s, change something visually at least every 4 s (card, punch zoom, B-roll).
11. **Punch zooms**: on every jump cut, alternate 1.0x ↔ 1.25x. Never apply two consecutive shots at the same
    scale for more than 3 cuts. No animated zoom on the talking head.
12. **B-roll (O5)**: use it when the speaker names a place, team, clients, event, or result. 80% inset on black,
    1.5–4 s per clip, 2–4 clips per run, hard cuts. Keep captions on.
13. **Captions (studio mode)**: yellow lowercase phrase lines of 4–10 words at y 87%, always visible over every
    layout. They never overlap an O4 keyword's sub-caption zone. Hide running captions during full-screen
    cards only if the card text is the same sentence verbatim.
14. **Name title and subscribe**: name title (0.35 s wipe, 0.7–1.5 s hold) within the first 5 s when the speaker
    says their name. Subscribe animation (2.3 s) exactly on the word "subscribe". Max 2 per video (intro and outro).
15. **Transitions**: talking-head to talking-head is always a hard cut. No cross-dissolves anywhere.
16. **Quote cards**: when the speaker delivers a reflective one-liner (definition, principle), use the black
    glow-text card (1.5–2 s). Return to the speaker through the O8 rounded-rect pop (0.25 s) at most once per 2 min.
17. **Numbered points**: when saying "number one/two/three", show a card with a giant faded numeral behind the
    point text, with a green highlighter swipe (0.6 s L→R) on the key phrase.
18. **Outro**: on the sign-off ("catch you in the next one", "peace out"), play a light-leak flash, then full-frame
    B-roll with a centred white caps "THANK YOU FOR WATCHING!" and social handles lower-left, 3–5 s.
19. **Sound cues**: whoosh on light-leaks, soft pop on card/keyword IN (0.2 s before the visual peak), click on
    subscribe, ticks on typewriter cards. Music bed only under intro/outro graphics, ducked under voice.
20. **Style mode**: tripod/studio footage uses the studio family (captions, whiteboard, cream/orange cards).
    Handheld selfie footage uses the vlog family (no running captions, behind-head keywords, white/black minimal cards).
