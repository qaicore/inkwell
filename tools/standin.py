# DEV ONLY: the stand-in pose model, run in Python for browsers that can't
# give the page WebGL 2. Same model and settings as src/track/standin.ts. The dev
# server (tools/standin-server.ts) runs it as
#   python standin.py <clip> <model> <clip width> <clip height> <mask width> <mask height>
# and sends what it prints straight back to the page: a 4-byte length, a JSON
# header with each frame's body points, then every frame's mask.
import json
import os
import shutil
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

MODEL_URL = ('https://storage.googleapis.com/mediapipe-models/pose_landmarker/'
             'pose_landmarker_full/float16/latest/pose_landmarker_full.task')
# The landmarks that move with the body: head, shoulders and hips.
CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24]
FPS = 30

clip, model = sys.argv[1], Path(sys.argv[2])
width, height, mask_width, mask_height = map(int, sys.argv[3:7])
if not shutil.which('ffmpeg'):
    sys.exit('ffmpeg was not found on PATH. Install it, then restart the dev server.')
if not model.exists():
    # Download to a name of its own and rename, so a cut-off download (or two
    # at once) is never mistaken for the model. Give up on a stalled one.
    partial = model.with_name(f'{model.name}.{os.getpid()}.part')
    with urllib.request.urlopen(MODEL_URL, timeout=30) as response, open(partial, 'wb') as out:
        shutil.copyfileobj(response, out)
    partial.replace(model)

# The clip is Inkwell's converted one, exactly 30 fps, so every decoded frame
# is one app frame. ffmpeg's own errors go straight to stderr, which the dev
# server passes back to the page.
raw = subprocess.run(
    ['ffmpeg', '-v', 'error', '-i', clip, '-vf', f'scale={mask_width}:{mask_height}', '-fps_mode', 'passthrough',
     '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:'],
    check=True, stdout=subprocess.PIPE).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, mask_height, mask_width, 3)

options = vision.PoseLandmarkerOptions(
    # Passed as bytes: MediaPipe can't open a path with non-ASCII characters on Windows.
    base_options=mp_python.BaseOptions(model_asset_buffer=model.read_bytes()),
    running_mode=vision.RunningMode.VIDEO,
    num_poses=1,
    output_segmentation_masks=True,
)
bodies = []
has_mask = []
masks = np.zeros((len(frames), mask_height, mask_width), np.uint8)
with vision.PoseLandmarker.create_from_options(options) as landmarker:
    for i, frame in enumerate(frames):
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame))
        result = landmarker.detect_for_video(image, round(i * 1000 / FPS))
        if result.pose_landmarks:
            points = result.pose_landmarks[0]
            bodies.append({
                'x': [points[k].x * width for k in CORE],
                'y': [points[k].y * height for k in CORE],
                'c': [1.0 if points[k].visibility is None else points[k].visibility for k in CORE],
            })
        else:
            bodies.append(None)
        has_mask.append(bool(result.segmentation_masks))
        if result.segmentation_masks:
            values = result.segmentation_masks[0].numpy_view().reshape(mask_height, mask_width)
            # Same tightened edge as toMask() in src/track/standin.ts.
            masks[i] = np.clip((values - 0.45) / 0.1 * 255, 0, 255).round().astype(np.uint8)

header = json.dumps({'bodies': bodies, 'hasMask': has_mask}).encode()
sys.stdout.buffer.write(struct.pack('<I', len(header)) + header + masks.tobytes())
