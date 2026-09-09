// Oversized image optimization.
//
// Ported from kimaki's image-optimizer-plugin (vendored from
// kargnas/opencode-large-image-optimizer). Prevents "image dimensions exceed
// max allowed" errors from LLM APIs by resizing images > 2000px and
// compressing images > 4MB before they reach the model.
//
// sharp is an optionalDependency — it is lazy-loaded so the channel still
// works (without optimization) when the native binding is missing.

// Conservative safe floor for many-image requests (20+ images = 2000px limit).
const MAX_DIMENSION = 2000;
// 4MB safe margin under the 5MB per-image limit.
const MAX_FILE_SIZE = 4 * 1024 * 1024;

export const SUPPORTED_IMAGE_MIMES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime.trim().toLowerCase());
}

// sharp is optional — keep the import type-free so tsc passes without it.
type Sharp = any;
type SharpFactory = (input?: Buffer | string) => Sharp;

let sharpFactory: SharpFactory | null | undefined;

async function getSharp(): Promise<SharpFactory | null> {
  if (sharpFactory !== undefined) {
    return sharpFactory;
  }
  try {
    const mod = await import("sharp");
    // sharp uses `export =` so it lands on .default in ESM interop.
    const fn =
      typeof mod === "function"
        ? (mod as SharpFactory)
        : (mod as { default?: SharpFactory }).default;
    sharpFactory = typeof fn === "function" ? fn : null;
  } catch {
    sharpFactory = null;
  }
  return sharpFactory;
}

export interface OptimizedImage {
  buffer: Buffer;
  mime: string;
}

/**
 * Optimize an in-memory image. Returns a resized/compressed buffer when the
 * image exceeds the dimension or size limits, and `null` when no change is
 * needed or sharp is unavailable (caller keeps the original).
 */
export async function optimizeImageBuffer(
  buffer: Buffer,
  mime: string,
): Promise<OptimizedImage | null> {
  const sharp = await getSharp();
  if (!sharp) {
    return null;
  }
  if (buffer.length === 0) {
    return null;
  }

  const metadata = await sharp(buffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (width === 0 || height === 0) {
    return null;
  }

  const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
  const needsCompress = buffer.length > MAX_FILE_SIZE;
  if (!needsResize && !needsCompress) {
    return null;
  }

  let pipeline = sharp(buffer);
  let outputMime = mime;

  if (needsResize) {
    pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  let outputBuffer: Buffer = await pipeline.toBuffer();

  // If still over 4MB, convert to JPEG with progressive quality reduction.
  if (outputBuffer.length > MAX_FILE_SIZE) {
    for (const quality of [100, 90, 80, 70]) {
      outputBuffer = await sharp(outputBuffer)
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      outputMime = "image/jpeg";
      if (outputBuffer.length <= MAX_FILE_SIZE) {
        break;
      }
    }
  }

  return { buffer: outputBuffer, mime: outputMime };
}
