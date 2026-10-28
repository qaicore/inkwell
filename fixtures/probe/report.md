# Probe report

Clip: `fixtures/probe/clip.mp4` (sha256 63af25471d5f), 1920x1080, 254 frames at 30 fps after conversion to H.264 CFR.
Generated 2026-10-28T01:45:32.721Z by `npm run probe`. Read it against the table in docs/SPEC.md §9.

## Centroid jump, frame to frame

As % of that frame's body height (person-mask bounding box). Only pairs of consecutive frames that both have a mask count.

| Prompt | Frames with a mask | Median | p95 | Pairs | Longest gap (frames) | Median confidence | Stream |
|---|---|---|---|---|---|---|---|
| `person` | 209/254 | 0.94% | 4.43% | 208 | 45 | 0.96 | completed |
| `face` | 162/254 | 1.33% | 5.63% | 160 | 91 | 0.87 | completed |
| back point | 209/254 | 0.93% | 4.18% | 208 | 45 | 0.97 | completed |

## Face-present timeline

One character per 5 frames: `#` face present, `.` no face. Each `|` marks one second.

```
######|######|######|######|######|###...|......|......|...
```

- frames 0-59 (2.0 s): face
- frames 60-60 (0.0 s): no face
- frames 61-162 (3.4 s): face
- frames 163-253 (3.0 s): no face

## Back point

Placed at (900, 400) on frame 60: placed by hand (--back-frame, --back-xy). Propagated in both directions.
While his back was turned, the back point had a mask on 47 of 92 no-face frames.

## Wonder's facing labels

| Frame | Wonder says | Confidence | Face track at that frame |
|---|---|---|---|
| 0 | front | 0.70 | face |
| 36 | front | 0.95 | face |
| 72 | left | 0.60 | face |
| 108 | front | 0.85 | face |
| 145 | front | 0.90 | face |
| 181 | front | 0.70 | no face |
| 217 | front | 0.00 | no face |
| 253 | front | 0.00 | no face |

## Strip

`fixtures/probe/strip.png`: every 10th frame, numbered. Blue is `person`, yellow is `face`, magenta is the back point's track; the white cross is where the back point was placed.

## Spend

| Call | USD | Billed |
|---|---|---|
| SAM person | $0.0508 | 254 frames |
| SAM face | $0.0508 | 254 frames |
| SAM back point | $0.0508 | 254 frames |
| Wonder facing, try 1 | $0.0472 | 3479 in, 1663 out |
| **Total** | **$0.1996** | |
