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

`samples/` and `renders/` are gitignored. Only clips you shot go in the demo.

## Built Oct 26 – Nov 4

- **Meta models:** SAM 3.1 and Muse Wonder. Neither is connected yet; they come next.
- **Open-source libraries** (from `package.json`):
  - [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT) turns points into the stroke outline.
  - [Mediabunny](https://mediabunny.dev) (MPL-2.0) decodes and encodes the video.
  - Dev only, not shipped: [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) (Apache-2.0), the pose model standing in for SAM 3.1 while SAM isn't connected; [@vitejs/plugin-basic-ssl](https://github.com/vitejs/vite-plugin-basic-ssl) (MIT) for phone mode; [Vite](https://vite.dev) (MIT); [Vitest](https://vitest.dev) (MIT) runs the tests; [TypeScript](https://www.typescriptlang.org) (Apache-2.0); @types/node (MIT).
- **Code:** written with Claude Code under Qai's direction, from Oct 27.
