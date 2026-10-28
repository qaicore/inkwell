// The marks on the frame Wonder sees for a plan call (SPEC §9): each stroke
// in its own color, numbered at its root. The app (in the browser) and
// scripts/live/plan.mjs (in Node) both draw with this, so a recorded call
// shows Wonder the same picture the app would.
import type { PlanStroke } from './plan.ts';

// The canvas calls used, met by both the browser's 2D context and
// @napi-rs/canvas's.
export interface MarkTarget {
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
}

export const PLAN_IMAGE_LONG_SIDE = 1024; // px; under the ~1280 px the image-token bound assumes

// Distinct, easy-to-name colors for the numbered strokes.
export const STROKE_COLORS = ['#ff2d55', '#00c2ff', '#ffd60a', '#30d158', '#bf5af2', '#ff9f0a', '#ffffff', '#5e5ce6'];

export const strokeColor = (index: number) => STROKE_COLORS[index % STROKE_COLORS.length];

// Draws on a frame already scaled by `fit` (frame px -> image px).
export function drawPlanMarks(c: MarkTarget, strokes: readonly PlanStroke[], fit: number, colorOf: (id: number, index: number) => string = (_, i) => strokeColor(i)) {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  strokes.forEach((s, index) => {
    const color = colorOf(s.id, index);
    c.strokeStyle = color;
    c.lineWidth = 6;
    c.beginPath();
    s.points.forEach(([x, y], i) => (i === 0 ? c.moveTo(x * fit, y * fit) : c.lineTo(x * fit, y * fit)));
    c.stroke();
    const [x, y] = s.points[0];
    c.fillStyle = color;
    c.beginPath();
    c.arc(x * fit, y * fit, 16, 0, 2 * Math.PI);
    c.fill();
    c.fillStyle = '#000000';
    c.font = 'bold 20px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(s.id), x * fit, y * fit + 1);
  });
}
