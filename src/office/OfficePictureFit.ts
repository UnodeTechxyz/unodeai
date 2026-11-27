export interface PictureRegion { x: number; y: number; w: number; h: number }
export interface PictureFit { fit: 'contain' | 'cover'; crop?: PictureRegion; focal_rect?: PictureRegion }
export interface PictureFrame { x: bigint; y: bigint; w: bigint; h: bigint }
const UNIT = 100000;
const round = (a: bigint, b: bigint) => (a + b / 2n) / b;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** OOXML crop fractions and integer EMUs. No resampling, stretching or claim of subject recognition. */
export function fitOfficePicture(frame: PictureFrame, width: number, height: number, spec: PictureFit) {
  const region = spec.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  let left = Math.round(region.x * UNIT); let top = Math.round(region.y * UNIT);
  let right = Math.round((region.x + region.w) * UNIT); let bottom = Math.round((region.y + region.h) * UNIT);
  // Keep even sub-percentage user regions representable at OOXML's integer precision.
  left = Math.min(left, UNIT - 1); top = Math.min(top, UNIT - 1);
  right = Math.max(left + 1, Math.min(UNIT, right)); bottom = Math.max(top + 1, Math.min(UNIT, bottom));
  const imageW = BigInt(width) * BigInt(right - left); const imageH = BigInt(height) * BigInt(bottom - top);
  const box = { ...frame };
  if (spec.fit === 'contain') {
    if (frame.w * imageH > frame.h * imageW) box.w = round(frame.h * imageW, imageH);
    else box.h = round(frame.w * imageH, imageW);
    if (box.w < 1n) box.w = 1n; if (box.h < 1n) box.h = 1n;
    box.x += (frame.w - box.w) / 2n; box.y += (frame.h - box.h) / 2n;
  } else {
    let viewW = right - left; let viewH = bottom - top;
    if (frame.w * imageH > frame.h * imageW) viewH = Math.max(1, Number(round(BigInt(width) * BigInt(viewW) * frame.h, BigInt(height) * frame.w)));
    else viewW = Math.max(1, Number(round(BigInt(height) * BigInt(viewH) * frame.w, BigInt(width) * frame.h)));
    const focus = spec.focal_rect;
    const origin = (low: number, high: number, view: number, start?: number, size?: number) => {
      const center = start === undefined ? (low + high) / 2 : (start + size! / 2) * UNIT;
      let at = clamp(center - view / 2, low, high - view);
      if (start !== undefined && size! * UNIT <= view) {
        const min = Math.max(low, (start + size!) * UNIT - view); const max = Math.min(high - view, start * UNIT);
        if (min <= max) at = clamp(at, min, max);
      }
      return Math.round(at);
    };
    left = origin(left, right, viewW, focus?.x, focus?.w); top = origin(top, bottom, viewH, focus?.y, focus?.h);
    right = left + viewW; bottom = top + viewH;
  }
  return { frame: box, crop: { l: left, t: top, r: UNIT - right, b: UNIT - bottom } };
}
