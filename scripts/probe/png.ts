// A small PNG writer (8-bit RGB, no filtering), so the probe's strip needs
// no image library. PNG is a signature plus chunks; each chunk is length,
// type, data and a CRC-32 of type + data. IDAT is zlib-deflated scanlines,
// each prefixed with its filter byte (0 = none).
import { crc32, deflateSync } from 'node:zlib';

export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array; // width * height * 3 bytes, row-major
}

export function createImage(width: number, height: number, fill: [number, number, number] = [0, 0, 0]): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) data.set(fill, i);
  return { width, height, data };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(image: RgbImage): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 3) throw new Error(`encodePng: expected ${width * height * 3} bytes, got ${data.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0;
    raw.set(data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
