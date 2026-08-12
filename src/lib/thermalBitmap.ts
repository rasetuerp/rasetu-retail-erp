// Converts an uploaded image (data-URL) into a monochrome (1-bit) TSPL BITMAP
// payload — ported from GoBilling's createThermalBitmap()
// (gobilling-erp/src/components/pages/LabelDesigner.tsx). Runs here in the
// renderer, not in electron/printer-driver.ts, since that runs in Electron's
// main process with no canvas/Image API — see labelPrint.ts's
// buildPrinterTemplate().

const DOTS_PER_MM: Record<203 | 300, number> = { 203: 8, 300: 11.8 };

export type ThermalBitmap = { widthDots: number; heightDots: number; bytesPerRow: number; hex: string };

export function textToThermalBitmap(
  text: string,
  widthMm: number,
  heightMm: number,
  options: { dpi?: 203 | 300; fontSize?: number; bold?: boolean; align?: 'left' | 'center' | 'right' } = {}
): ThermalBitmap {
  const dpi = options.dpi ?? 203;
  const dotsPerMm = DOTS_PER_MM[dpi];
  const widthDots = Math.max(8, Math.round(widthMm * dotsPerMm));
  const heightDots = Math.max(8, Math.round(heightMm * dotsPerMm));
  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not prepare text for thermal printing.');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.fillStyle = '#000';
  const fontPx = Math.max(8, Math.round((options.fontSize ?? 10) * (dpi / 72) * 1.08));
  ctx.font = `${options.bold ? '700 ' : ''}${fontPx}px Arial, Noto Sans, Segoe UI, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = options.align ?? 'left';
  const x = options.align === 'right' ? widthDots - 1 : options.align === 'center' ? widthDots / 2 : 0;
  ctx.fillText(text, x, heightDots / 2, widthDots);

  return pixelsToThermalBitmap(ctx.getImageData(0, 0, widthDots, heightDots).data, widthDots, heightDots, 180);
}

export function imageToThermalBitmap(dataUrl: string, widthMm: number, heightMm: number, dpi: 203 | 300 = 203): Promise<ThermalBitmap> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const dotsPerMm = DOTS_PER_MM[dpi];
      const widthDots = Math.max(8, Math.round(widthMm * dotsPerMm));
      const heightDots = Math.max(8, Math.round(heightMm * dotsPerMm));
      const canvas = document.createElement('canvas');
      canvas.width = widthDots;
      canvas.height = heightDots;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        reject(new Error('Could not prepare image for thermal printing.'));
        return;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, widthDots, heightDots);
      ctx.drawImage(img, 0, 0, widthDots, heightDots);
      const pixels = ctx.getImageData(0, 0, widthDots, heightDots).data;
      const background = estimateCornerBackground(pixels, widthDots, heightDots);
      const stripBackground = background ? colorDistance(background, [255, 255, 255]) > 70 : false;
      const gray = new Float32Array(widthDots * heightDots);

      for (let y = 0; y < heightDots; y++) {
        for (let x = 0; x < widthDots; x++) {
          const idx = (y * widthDots + x) * 4;
          const alpha = pixels[idx + 3];
          const rgb: [number, number, number] = [pixels[idx], pixels[idx + 1], pixels[idx + 2]];
          if (alpha < 50 || (stripBackground && background && colorDistance(background, rgb) < 95)) {
            gray[y * widthDots + x] = 255;
            continue;
          }
          const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
          gray[y * widthDots + x] = clampByte((luminance - 128) * 1.25 + 128);
        }
      }

      resolve(grayToThermalBitmap(gray, widthDots, heightDots, 168));
    };
    img.onerror = () => reject(new Error('Could not load image for thermal printing.'));
    img.src = dataUrl;
  });
}

function pixelsToThermalBitmap(pixels: Uint8ClampedArray, widthDots: number, heightDots: number, threshold: number): ThermalBitmap {
  const gray = new Float32Array(widthDots * heightDots);
  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < widthDots; x++) {
      const idx = (y * widthDots + x) * 4;
      const alpha = pixels[idx + 3];
      gray[y * widthDots + x] = alpha < 50 ? 255 : 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
    }
  }
  return grayToThermalBitmap(gray, widthDots, heightDots, threshold);
}

function grayToThermalBitmap(gray: Float32Array, widthDots: number, heightDots: number, threshold: number): ThermalBitmap {
  const bytesPerRow = Math.ceil(widthDots / 8);
  const bytes: number[] = [];
  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < widthDots; x++) {
      const idx = y * widthDots + x;
      const old = gray[idx];
      const next = old < threshold ? 0 : 255;
      const error = old - next;
      gray[idx] = next;
      distributeDitherError(gray, widthDots, heightDots, x + 1, y, error * 7 / 16);
      distributeDitherError(gray, widthDots, heightDots, x - 1, y + 1, error * 3 / 16);
      distributeDitherError(gray, widthDots, heightDots, x, y + 1, error * 5 / 16);
      distributeDitherError(gray, widthDots, heightDots, x + 1, y + 1, error * 1 / 16);
    }
  }
  for (let y = 0; y < heightDots; y++) {
    for (let bx = 0; bx < bytesPerRow; bx++) {
      let value = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        if (x >= widthDots) continue;
        if (gray[y * widthDots + x] === 0) value |= 0x80 >> bit;
      }
      bytes.push(value);
    }
  }
  return {
    widthDots,
    heightDots,
    bytesPerRow,
    hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
  };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function distributeDitherError(gray: Float32Array, width: number, height: number, x: number, y: number, error: number): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const idx = y * width + x;
  gray[idx] = clampByte(gray[idx] + error);
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function estimateCornerBackground(pixels: Uint8ClampedArray, width: number, height: number): [number, number, number] | null {
  const samples: Array<[number, number, number]> = [];
  const radius = Math.max(2, Math.min(8, Math.floor(Math.min(width, height) / 12)));
  const corners = [
    [0, 0],
    [width - radius, 0],
    [0, height - radius],
    [width - radius, height - radius],
  ];
  for (const [startX, startY] of corners) {
    for (let y = startY; y < Math.min(height, startY + radius); y++) {
      for (let x = startX; x < Math.min(width, startX + radius); x++) {
        const idx = (y * width + x) * 4;
        if (pixels[idx + 3] < 50) continue;
        samples.push([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
      }
    }
  }
  if (!samples.length) return null;
  const totals = samples.reduce<[number, number, number]>((sum, rgb) => [sum[0] + rgb[0], sum[1] + rgb[1], sum[2] + rgb[2]], [0, 0, 0]);
  return [totals[0] / samples.length, totals[1] / samples.length, totals[2] / samples.length];
}

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 750 * 1024;

/** Validated data-URL read for a label image element — reused by LabelDesignerPage.tsx's file input. */
export function readLabelImageFile(file: File): Promise<string> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return Promise.reject(new Error('Use a PNG, JPG, or WEBP image file.'));
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Promise.reject(new Error('Image must be below 750 KB so labels print reliably.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}
