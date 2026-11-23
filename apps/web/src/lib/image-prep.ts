/**
 * Receipt and document photos, prepared in the browser before upload:
 * rotated, cropped, and scaled so the long edge is at most {@link MAX_EDGE}
 * pixels — sharp enough that printed text stays readable — then encoded as
 * JPEG. Nothing here leaves the device.
 */

export const MAX_EDGE = 2400;
const TARGET_BYTES = 3_500_000;

/** A crop as fractions of the (rotated) image: 0..1 on each axis. */
export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };

export type Rotation = 0 | 90 | 180 | 270;

export function isImage(file: Blob): boolean {
  return /^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) || file.type === '';
}

export async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  // `from-image` honours the camera's EXIF orientation.
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/** The output size for a rotated, cropped bitmap, capped at {@link MAX_EDGE}. */
export function outputSize(
  width: number,
  height: number,
  rotation: Rotation,
  crop: Crop,
  maxEdge: number = MAX_EDGE,
): { width: number; height: number } {
  const turned = rotation === 90 || rotation === 270;
  const w = (turned ? height : width) * crop.w;
  const h = (turned ? width : height) * crop.h;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

/** Draw the bitmap rotated and cropped onto a new canvas. */
export function render(
  bitmap: ImageBitmap,
  rotation: Rotation,
  crop: Crop,
  options: { readonly maxEdge?: number; readonly transparent?: boolean } = {},
): HTMLCanvasElement {
  const turned = rotation === 90 || rotation === 270;
  const fullW = turned ? bitmap.height : bitmap.width;
  const fullH = turned ? bitmap.width : bitmap.height;
  const size = outputSize(bitmap.width, bitmap.height, rotation, crop, options.maxEdge);
  const scale = size.width / (fullW * crop.w);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  if (!options.transparent) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.width, size.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(-crop.x * fullW * scale, -crop.y * fullH * scale);
  ctx.scale(scale, scale);
  ctx.translate(fullW / 2, fullH / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('encode failed'));
      },
      'image/jpeg',
      quality,
    );
  });
}

/** JPEG at 0.86, stepping down only if the file would still be large. */
export async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  let blob = await toBlob(canvas, 0.86);
  for (const quality of [0.78, 0.7]) {
    if (blob.size <= TARGET_BYTES) break;
    blob = await toBlob(canvas, quality);
  }
  return blob;
}

/** A photo as it will be uploaded: oriented, cropped, scaled, JPEG. */
export async function preparePhoto(
  file: Blob,
  rotation: Rotation = 0,
  crop: Crop = FULL_CROP,
): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
  const bitmap = await loadBitmap(file);
  try {
    const canvas = render(bitmap, rotation, crop);
    return { blob: await encode(canvas), canvas };
  } finally {
    bitmap.close();
  }
}

/** A logo as it will be uploaded: oriented, cropped, at most 1024px, PNG with its transparency kept. */
export async function prepareLogo(
  file: Blob,
  rotation: Rotation = 0,
  crop: Crop = FULL_CROP,
): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
  const bitmap = await loadBitmap(file);
  try {
    const canvas = render(bitmap, rotation, crop, { maxEdge: 1024, transparent: true });
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png');
    });
    return { blob, canvas };
  } finally {
    bitmap.close();
  }
}
