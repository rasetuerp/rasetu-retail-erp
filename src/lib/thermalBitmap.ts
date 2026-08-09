// Converts an uploaded image (data-URL) into a monochrome (1-bit) TSPL BITMAP
// payload — ported from GoBilling's createThermalBitmap()
// (gobilling-erp/src/components/pages/LabelDesigner.tsx). Runs here in the
// renderer, not in electron/printer-driver.ts, since that runs in Electron's
// main process with no canvas/Image API — see labelPrint.ts's
// buildPrinterTemplate().

const DOTS_PER_MM: Record<203 | 300, number> = { 203: 8, 300: 11.8 };

export type ThermalBitmap = { widthDots: number; heightDots: number; bytesPerRow: number; hex: string };

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

      ctx.clearRect(0, 0, widthDots, heightDots);
      ctx.drawImage(img, 0, 0, widthDots, heightDots);
      const pixels = ctx.getImageData(0, 0, widthDots, heightDots).data;
      const bytesPerRow = Math.ceil(widthDots / 8);
      const bytes: number[] = [];

      for (let y = 0; y < heightDots; y++) {
        for (let bx = 0; bx < bytesPerRow; bx++) {
          let value = 0;
          for (let bit = 0; bit < 8; bit++) {
            const x = bx * 8 + bit;
            if (x >= widthDots) continue;
            const idx = (y * widthDots + x) * 4;
            const alpha = pixels[idx + 3];
            const luminance = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
            if (alpha > 50 && luminance < 210) value |= 0x80 >> bit;
          }
          bytes.push(value);
        }
      }

      resolve({
        widthDots,
        heightDots,
        bytesPerRow,
        hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
      });
    };
    img.onerror = () => reject(new Error('Could not load image for thermal printing.'));
    img.src = dataUrl;
  });
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
