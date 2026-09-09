import { expect, test } from "bun:test";
import { isSupportedImageMime, optimizeImageBuffer } from "./image-optimizer";

const sharpModule = await import("sharp").catch(() => null);
const hasSharp = Boolean(sharpModule);
const sharp: any = hasSharp
  ? ((sharpModule as any).default ?? sharpModule)
  : null;

/** sharp 0.34 has no .create() — build images from raw buffers instead. */
function rawSharp(width: number, height: number, background = "#fff") {
  return sharp().create
    ? sharp().create({ width, height, channels: 4, background })
    : // fill a raw RGBA buffer
      (() => {
        const buf = Buffer.alloc(width * height * 4);
        const hex = background.replace("#", "");
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        for (let i = 0; i < buf.length; i += 4) {
          buf[i] = r;
          buf[i + 1] = g;
          buf[i + 2] = b;
          buf[i + 3] = 255;
        }
        return sharp(buf, { raw: { width, height, channels: 4 } });
      })();
}

test("isSupportedImageMime covers png/jpeg/gif/webp", () => {
  expect(isSupportedImageMime("image/png")).toBe(true);
  expect(isSupportedImageMime("image/JPEG")).toBe(true);
  expect(isSupportedImageMime("image/gif")).toBe(true);
  expect(isSupportedImageMime("image/webp")).toBe(true);
  expect(isSupportedImageMime("text/plain")).toBe(false);
  expect(isSupportedImageMime("")).toBe(false);
});

test("optimizeImageBuffer: small image passes through (null)", async () => {
  if (!sharp) {
    console.log("sharp not installed — skipping optimizeImageBuffer tests");
    return;
  }
  const small = await rawSharp(100, 100).png().toBuffer();
  expect(await optimizeImageBuffer(small, "image/png")).toBeNull();
});

test("optimizeImageBuffer: oversized image resized under 2000px", async () => {
  if (!sharp) return;
  const big = await rawSharp(3000, 3000).png().toBuffer();
  const result = await optimizeImageBuffer(big, "image/png");
  expect(result).not.toBeNull();
  const meta = await sharp(result?.buffer).metadata();
  expect(meta.width).toBeLessThanOrEqual(2000);
  expect(meta.height).toBeLessThanOrEqual(2000);
  expect(result?.mime).toBe("image/png");
});

test("optimizeImageBuffer: oversized jpeg resized and under 4MB", async () => {
  if (!sharp) return;
  const jpeg = await rawSharp(2500, 2500, "#808080")
    .jpeg({ quality: 100, mozjpeg: true })
    .toBuffer();
  const result = await optimizeImageBuffer(jpeg, "image/jpeg");
  expect(result).not.toBeNull(); // 2500px > 2000px always resizes
  expect(result?.buffer.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(result?.mime).toBe("image/jpeg");
});
