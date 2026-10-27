# Inkwell

Draw on one frame of a clip, and the drawing lives in the footage.

Built for the Meta Global AI Developer Hackathon (Oct 26 to Nov 4, 2026), Indie Developer track, theme "Build for Your World". The plan: Muse Wonder reads each stroke and decides what it attaches to, SAM 3.1 tracks those anchors along with your body and face, and Inkwell's own physics moves the strokes.

## Status (Oct 27)

Works now:

- Open a clip with the file picker, drag and drop, or `?clip=<url>`. The browser converts it to H.264 at a constant 30 fps, keeps the first 15 s and scales it to 1920 px on the long side. Frame N in the app is frame N in that file, which is the file SAM will get.
- Pause on any frame and draw with one ink brush: pen pressure, three colors, a size slider, undo and clear.
- Play it back at 30 fps, with a hand-drawn wobble redrawn 12 times a second.
- Export an MP4 (H.264, constant 30 fps, original audio). In dev, each export is also saved to `renders/`.
- Tracking, with a stand-in until SAM 3.1 is connected. Each stroke's root (its first point) rides the body on every frame, and the stroke turns and scales with it. Strokes set to Behind are tucked behind the person, using a person mask.
  - The stand-in is MediaPipe's pose model, run in the browser. It only loads in dev (`npm run dev`) and is left out of production builds.
  - It needs WebGL 2. When the browser won't give the page WebGL 2, the dev server runs the same model in Python instead. Set that up once with `npm run standin:setup`, which makes `.venv/` and installs MediaPipe. It also needs ffmpeg on your PATH.
  - **Follow: body points** follows the head, shoulder and hip landmarks nearest each root.
  - **Follow: body mask, like SAM** uses only the person mask: its centre, lean and size. That's what SAM's "person" prompt will give. Everything after the mask (`src/tracking.ts`, `src/render.ts`) is what SAM's masks will feed.
  - **Show tracking** tints the mask and rings each stroke's root.

Not built yet: SAM 3.1 itself, stroke planning (Muse Wonder) and physics. Strokes move stiffly with the body for now; the rope physics will bend them.

Built for the API, not run yet (the key hasn't arrived):

- `npm run probe` runs SAM 3.1 (`person`, `face`, one point on the back) and Muse Wonder's facing labels on `fixtures/probe/clip.mp4`, and writes `fixtures/probe/report.md` and `strip.png`. It costs money: it prints the cost and waits for a typed `yes`. For a 10 s clip that's at most $0.44, likely about $0.25.
- `functions/` is the Cloudflare Pages Function the app will call: it holds the key, needs the passcode for uploads, and refuses calls past `DAILY_SPEND_CAP_USD` for the day.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5174. To open a test clip straight away, put it in `samples/` and go to `http://localhost:5174/?clip=/samples/<file>.mp4`.

Keys: Space plays and pauses, the arrow keys step one frame, and Ctrl+Z undoes.

### On your phone

```bash
npm run dev:phone
```

This serves the app over HTTPS on your Wi-Fi at port 5175; Vite prints the address as "Network", for example `https://192.168.1.74:5175`. Safari only allows video encoding on HTTPS pages, so phone mode uses a self-signed certificate. The first time, Safari warns that the connection isn't private: tap Show Details, then "visit this website". The phone and the computer must be on the same Wi-Fi. It runs alongside `npm run dev`.

## Files

- `src/clip.ts` opens a clip and converts it to H.264 at 30 fps. Decoded frames go straight to the encoder, which shrinks them itself. Clips with a rotation flag go through a canvas instead, which is slower but turns the pixels upright.
- `src/brush.ts` is the brush: the perfect-freehand settings and the wobble.
- `src/tracking.ts` turns masks or body points into each stroke's pose on every frame, then fills gaps and smooths out jitter.
- `src/render.ts` draws a finished frame, with Behind strokes under the person. The preview and the export both use it.
- `src/standin.ts` is the dev-only stand-in for SAM 3.1. `tools/standin.py` and `tools/standin-server.ts` are its Python fallback for browsers without WebGL 2, and `tools/setup-standin.mjs` sets that up.
- `src/export.ts` re-encodes the clip with the strokes drawn in.
- `src/main.ts` is the page: drawing, scrubbing, playback, tracking and controls.
- `vite.config.ts` runs the dev server and saves exports to `renders/`.
- `functions/` is the Pages Function: `_lib/proxy.ts` is its logic (passcode, spend cap), `_lib/spend.ts` keeps the day's spend in a D1 database bound as `SPEND_DB`, `_lib/pricing.ts` has the Meta API prices, and `api/[[path]].ts` wires them to the real API.
- `scripts/live/` holds the only scripts that make paid calls: `probe.mjs`, and `meta.mjs`, which every paid call goes through (key, spend caps, the typed `yes`). `scripts/probe/` is the probe's free part: decoding masks, the numbers, the report and the strip.
- `scripts/verify.mjs`, `scripts/golden-accept.mjs`, `scripts/scan-secrets.mjs` and `scripts/tree-hash.mjs` are the checking pipeline (below).

`samples/` and `renders/` are gitignored. Only clips you shot go in the demo.

## Checks

```bash
npm run check:fast
npm run verify
node scripts/scan-secrets.mjs
```

`check:fast` typechecks and runs `tests/unit/` (it runs after every code edit). `verify` stamps the tree hash, then typechecks and runs the acceptance tests in `tests/M*/` up to the milestone in `verify/ACTIVE`, writing the evidence to `verify/out/`. `scan-secrets` looks for the values in `.env` and `.dev.vars` in every file and the whole git history, and prints only where, never the value. None of them touch the network.

## Built Oct 26 – Nov 4

- **Meta models:** SAM 3.1 and Muse Wonder. Neither is in the app yet; `npm run probe` is the first call to both.
- **Open-source libraries** (from `package.json`):
  - [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT) turns points into the stroke outline.
  - [Mediabunny](https://mediabunny.dev) (MPL-2.0) decodes and encodes the video.
  - Dev only, not shipped: [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) (Apache-2.0), the pose model standing in for SAM 3.1 while SAM isn't connected; [@meta-sam/parser](https://www.npmjs.com/package/@meta-sam/parser) (SAM License) reads SAM 3.1's streamed masks in the probe; the [OpenAI SDK](https://github.com/openai/openai-node) (`openai`, Apache-2.0), pointed at Meta's API, makes the probe's calls; [@vitejs/plugin-basic-ssl](https://github.com/vitejs/vite-plugin-basic-ssl) (MIT) for phone mode; [Vite](https://vite.dev) (MIT); [Vitest](https://vitest.dev) (MIT) runs the tests; [TypeScript](https://www.typescriptlang.org) (Apache-2.0); @types/node (MIT).
- **Code:** written with Claude Code under Qai's direction, from Oct 27.
