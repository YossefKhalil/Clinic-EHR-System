// Falcon-OCR preprocessing. Port of processing_falcon_ocr.py + the ONNX export's
// token assembly. Kept allocation-light: reusable buffers where shapes allow.

const MEAN = [0.5, 0.5, 0.5];
const STD = [0.5, 0.5, 0.5];
const PATCH = 16;

// Smart resize to a multiple of `factor`, within [minPixels, maxPixels].
// Mirrors transformers' smart_resize with factor=16.
export function smartResize(h, w, factor = PATCH, minPixels = 64 * 64, maxPixels = 1024 * 1024) {
  let nh = Math.round(h / factor) * factor;
  let nw = Math.round(w / factor) * factor;
  if (nh * nw > maxPixels) {
    const beta = Math.sqrt((h * w) / maxPixels);
    nh = Math.floor(h / beta / factor) * factor;
    nw = Math.floor(w / beta / factor) * factor;
  } else if (nh * nw < minPixels) {
    const beta = Math.sqrt(minPixels / (h * w));
    nh = Math.ceil(h * beta / factor) * factor;
    nw = Math.ceil(w * beta / factor) * factor;
  }
  if (nh < factor) nh = factor;
  if (nw < factor) nw = factor;
  return { h: nh, w: nw };
}

// Canvas factory that works on the main thread and in a worker.
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Resize an ImageBitmap to target dimensions using high-quality smoothing.
export async function resizeBitmap(bitmap, w, h) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

// Convert a canvas to normalized patches [N, 768] in the model's order:
// (t h w) -> (t h w) with patch (pt ph pw c), pt=1.
export function canvasToPatches(canvas) {
  const { width: W, height: H } = canvas;
  const pH = H / PATCH;
  const pW = W / PATCH;
  const N = pH * pW;
  const patches = new Float32Array(N * 768);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H).data;
  // Pre-extract per-patch pixel block.
  let idx = 0;
  for (let py = 0; py < pH; py++) {
    for (let px = 0; px < pW; px++) {
      const base = idx * 768;
      let k = 0;
      for (let iy = 0; iy < PATCH; iy++) {
        for (let ix = 0; ix < PATCH; ix++) {
          const x = px * PATCH + ix;
          const y = py * PATCH + iy;
          const p = (y * W + x) * 4;
          patches[base + k++] = (img[p] / 255 - MEAN[0]) / STD[0];
          patches[base + k++] = (img[p + 1] / 255 - MEAN[1]) / STD[1];
          patches[base + k++] = (img[p + 2] / 255 - MEAN[2]) / STD[2];
        }
      }
      idx++;
    }
  }
  return { patches, pH, pW, H, W, N };
}

// Build pos_t (int64) and pos_hw (float) for a token sequence.
// Replicates _get_image_token_masks + the pos construction in the export.
export function buildPositions(tokens, imageMask, hPatches, wPatches) {
  const S = tokens.length;
  const posT = new BigInt64Array(S);
  const posHw = new Float32Array(S * 2);
  // no_increase: image_reg_1..4 (245-248), img_end (230), and spatial tokens (227)
  // image_cls (244) is NOT no_increase.
  const noIncrease = new Uint8Array(S);
  for (let i = 0; i < S; i++) {
    const t = tokens[i];
    if (t === 227 || (t >= 245 && t <= 248) || t === 230) noIncrease[i] = 1;
  }
  // spatial mask
  const spatial = new Uint8Array(S);
  for (let i = 0; i < S; i++) if (tokens[i] === 227) spatial[i] = 1;

  // tpos: start at 1 where not no_increase, cumsum-1
  let acc = 0;
  const tpos = new Int32Array(S);
  for (let i = 0; i < S; i++) {
    if (noIncrease[i]) {
      tpos[i] = acc; // stays same (0 increment)
    } else {
      acc += 1;
      tpos[i] = acc;
    }
  }
  for (let i = 0; i < S; i++) {
    posT[i] = BigInt(Math.max(0, tpos[i] - 1));
  }

  // pos_hw for spatial tokens
  const xlim = Math.sqrt(wPatches / hPatches);
  const ylim = Math.sqrt(hPatches / wPatches);
  const xpos = new Float32Array(wPatches);
  const ypos = new Float32Array(hPatches);
  for (let i = 0; i < wPatches; i++) xpos[i] = -xlim + (2 * xlim * i) / Math.max(1, wPatches - 1);
  for (let i = 0; i < hPatches; i++) ypos[i] = -ylim + (2 * ylim * i) / Math.max(1, hPatches - 1);

  // Fill spatial positions in row-major order matching patch order.
  let spatialIdx = 0;
  for (let i = 0; i < S; i++) {
    if (spatial[i]) {
      const py = Math.floor(spatialIdx / wPatches);
      const px = spatialIdx % wPatches;
      posHw[i * 2] = ypos[py];
      posHw[i * 2 + 1] = xpos[px];
      spatialIdx++;
    } else {
      posHw[i * 2] = Number.NaN;
      posHw[i * 2 + 1] = Number.NaN;
    }
  }
  return { posT, posHw };
}

// Build the hybrid attention mask: [1, S, S] bool.
// True if (q >= k) OR (both q,k are image/spatial tokens).
export function buildAttentionMask(S, spatialMask) {
  const mask = new Uint8Array(S * S); // 0/1, treated as bool
  for (let q = 0; q < S; q++) {
    for (let k = 0; k < S; k++) {
      const causal = q >= k;
      const bothImg = spatialMask[q] && spatialMask[k];
      if (causal || bothImg) mask[q * S + k] = 1;
    }
  }
  return mask;
}

// Assemble the full token array for one image from a text prompt.
// promptTokens: number[] from tokenizer for "<|image|>Extract the text content from this image.\n<|OCR_PLAIN|>"
// imageTokenCount: N
export function assembleTokens(promptTokens, imageTokenCount) {
  // Find the single image token (227) and replace with the image block.
  const out = [];
  let replaced = false;
  for (const t of promptTokens) {
    if (t === 227 && !replaced) {
      out.push(244, 245, 246, 247, 248);
      for (let i = 0; i < imageTokenCount; i++) out.push(227);
      out.push(230);
      replaced = true;
    } else {
      out.push(t);
    }
  }
  if (!replaced) {
    // Fallback: append block at end.
    out.push(244, 245, 246, 247, 248);
    for (let i = 0; i < imageTokenCount; i++) out.push(227);
    out.push(230);
  }
  return out;
}

// Strip an image into horizontal strips. The scaled full image is built once,
// then each strip is cropped from it — O(n), not O(n²).
export function makeStrips(canvas, stripW, stripH, overlap) {
  const { width: W, height: H } = canvas;
  const scale = stripW / W;
  const scaledH = Math.max(1, Math.round(H * scale));
  const full = makeCanvas(stripW, scaledH);
  const fctx = full.getContext('2d', { alpha: false });
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(canvas, 0, 0, stripW, scaledH);

  const strips = [];
  const step = Math.max(1, stripH - overlap);
  for (let y = 0; y < scaledH; y += step) {
    const h = Math.min(stripH, scaledH - y);
    if (h < 32) break;
    const c = makeCanvas(stripW, h);
    const ctx = c.getContext('2d', { alpha: false });
    ctx.drawImage(full, 0, y, stripW, h, 0, 0, stripW, h);
    strips.push({ canvas: c, y, h, scale });
    if (y + h >= scaledH) break;
  }
  return strips;
}
