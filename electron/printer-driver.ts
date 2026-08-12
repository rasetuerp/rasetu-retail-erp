/**
 * TSC TTP-244 Pro thermal label printer driver.
 * Generates TSPL/TSPL2 commands, which is the native command language for
 * TSC label printers such as the TTP-244 Pro.
 */

export interface PrinterSettings {
  name: string;
  dpi: 203 | 300;
  labelWidth: number;
  labelHeight: number;
  printAreaWidth?: number;
  printAreaHeight?: number;
  printAreaOffsetX?: number;
  printAreaOffsetY?: number;
  orientation?: 'portrait' | 'landscape' | 'portrait-180' | 'landscape-180';
  gapLength: number;
  darknessFactor: number;
  autoGapDetection: boolean;
  marginTop: number;
  marginLeft: number;
  marginRight: number;
  marginBottom: number;
}

export interface LabelElement {
  type: 'text' | 'barcode' | 'qrcode' | 'image' | 'line' | 'rectangle';
  x: number;
  y: number;
  width: number;
  height: number;
  content?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
  labelPrefix?: string;
  labelPlacement?: 'inline' | 'split';
  barcodeType?: 'code128' | 'code39' | 'ean13' | 'upca';
  qrSize?: number;
  // Round 21 — 'image' elements arrive pre-dithered from the renderer (see
  // src/lib/thermalBitmap.ts / labelPrint.ts's buildPrinterTemplate()): this
  // process has no canvas/Image API to do that conversion itself.
  bitmap?: { widthDots: number; heightDots: number; bytesPerRow: number; hex: string };
}

export interface LabelTemplate {
  id: string;
  name: string;
  version: string;
  labelWidth: number;
  labelHeight: number;
  elements: LabelElement[];
  printerProfile: string;
  // Round 21 — per-template fine-tuning on top of the printer's own global
  // PrinterSettings (marginLeft/marginTop/darknessFactor above); see
  // buildLabel() below.
  xOffsetMm?: number;
  yOffsetMm?: number;
  gapMm?: number;
  darkness?: number;
}

export interface PrinterProfile {
  id: string;
  name: string;
  model: string;
  dpi: 203 | 300;
  maxWidth: number;
  maxHeight: number;
  gapDetection: boolean;
  tsplSupport: boolean;
  nativeDriverRequired: boolean;
}

const STANDARD_PROFILES: Record<string, PrinterProfile> = {
  'tsc-ttp244-203': {
    id: 'tsc-ttp244-203',
    name: 'TSC TTP-244 Pro (203 DPI)',
    model: 'TSC TTP-244 Pro',
    dpi: 203,
    maxWidth: 108,
    maxHeight: 1000,
    gapDetection: true,
    tsplSupport: true,
    nativeDriverRequired: false,
  },
  'tsc-ttp244-300': {
    id: 'tsc-ttp244-300',
    name: 'TSC TTP-244 Pro (300 DPI)',
    model: 'TSC TTP-244 Pro',
    dpi: 300,
    maxWidth: 108,
    maxHeight: 1000,
    gapDetection: true,
    tsplSupport: true,
    nativeDriverRequired: false,
  },
};

const DEFAULT_SETTINGS: PrinterSettings = {
  name: 'TSC TTP-244 Pro',
  dpi: 203,
  labelWidth: 101.6,
  labelHeight: 100,
  printAreaWidth: 101.6,
  printAreaHeight: 100,
  printAreaOffsetX: 0,
  printAreaOffsetY: 0,
  orientation: 'portrait',
  gapLength: 3.5,
  darknessFactor: 5,
  autoGapDetection: true,
  marginTop: 2,
  marginLeft: 2,
  marginRight: 2,
  marginBottom: 2,
};

function mmToDots(mm: number, dpi: number): number {
  return Math.max(0, Math.round((mm / 25.4) * dpi));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveContent(element: LabelElement, data: Record<string, string | number>): string {
  const keyOrValue = element.content || '';
  const value = data[keyOrValue];
  return String(value ?? keyOrValue).replace(/[\r\n]+/g, ' ').trim();
}

function tsplQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function barcodeTypeToTspl(type?: LabelElement['barcodeType']): string {
  switch (type) {
    case 'code39':
      return '39';
    case 'ean13':
      return 'EAN13';
    case 'upca':
      return 'UPCA';
    case 'code128':
    default:
      return '128';
  }
}

function fontForSize(sizePt = 10): string {
  if (sizePt <= 8) return '1';
  if (sizePt <= 10) return '2';
  if (sizePt <= 14) return '3';
  return '4';
}

function textWidthDots(value: string, font: string): number {
  const perChar = font === '1' ? 8 : font === '2' ? 12 : font === '3' ? 16 : 24;
  return Math.max(0, value.length * perChar);
}

function estimateBarcodeModules(value: string, type: LabelElement['barcodeType'] = 'code128'): number {
  const contentLength = Math.max(1, value.length);
  switch (type) {
    case 'ean13':
    case 'upca':
      return 95;
    case 'code39':
      return contentLength * 13 + 25;
    case 'code128':
    default:
      return (contentLength + 3) * 11 + 2;
  }
}

function barcodeNarrowWidth(widthMm: number, value: string, type: LabelElement['barcodeType'] | undefined, dpi: number): number {
  const targetDots = Math.max(1, mmToDots(widthMm, dpi));
  return clamp(Math.floor(targetDots / estimateBarcodeModules(value, type ?? 'code128')), 1, 10);
}

function rotationForOrientation(orientation: PrinterSettings['orientation']): 0 | 90 | 180 | 270 {
  switch (orientation) {
    case 'landscape':
      return 90;
    case 'portrait-180':
      return 180;
    case 'landscape-180':
      return 270;
    case 'portrait':
    default:
      return 0;
  }
}

function transformElement(
  element: LabelElement,
  settings: PrinterSettings
): { x: number; y: number; rotation: 0 | 90 | 180 | 270 } {
  const areaWidth = settings.printAreaWidth || settings.labelWidth;
  const areaHeight = settings.printAreaHeight || settings.labelHeight;
  const offsetX = settings.printAreaOffsetX || 0;
  const offsetY = settings.printAreaOffsetY || 0;
  const rotation = rotationForOrientation(settings.orientation);

  if (rotation === 90) {
    return {
      x: offsetX + areaWidth - element.y - element.height,
      y: offsetY + element.x,
      rotation,
    };
  }

  if (rotation === 180) {
    return {
      x: offsetX + areaWidth - element.x - element.width,
      y: offsetY + areaHeight - element.y - element.height,
      rotation,
    };
  }

  if (rotation === 270) {
    return {
      x: offsetX + element.y,
      y: offsetY + areaHeight - element.x - element.width,
      rotation,
    };
  }

  return {
    x: offsetX + element.x,
    y: offsetY + element.y,
    rotation,
  };
}

export class TscPrinterDriver {
  private settings: PrinterSettings;
  private profile: PrinterProfile;

  constructor(settings: Partial<PrinterSettings> = {}, profileId: string = 'tsc-ttp244-203') {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.profile = STANDARD_PROFILES[profileId] || STANDARD_PROFILES['tsc-ttp244-203'];
  }

  generateTestLabel(): Buffer {
    const printWidth = this.settings.printAreaWidth || this.settings.labelWidth;
    const printHeight = this.settings.printAreaHeight || this.settings.labelHeight;
    const template: LabelTemplate = {
      id: 'printer-test',
      name: 'Printer Test',
      version: '1.0',
      labelWidth: this.settings.labelWidth,
      labelHeight: this.settings.labelHeight,
      printerProfile: this.profile.id,
      elements: [
        { type: 'text', x: 1, y: 1, width: Math.max(20, printWidth - 2), height: 3, content: 'title', fontSize: printHeight <= 15 ? 7 : 10, fontWeight: 'bold' },
        { type: 'text', x: 1, y: Math.max(4, printHeight / 2), width: Math.max(20, printWidth - 2), height: 3, content: 'code', fontSize: printHeight <= 15 ? 6 : 8 },
      ],
    };

    return this.buildLabel(template, {
      title: 'GOBILLING TEST',
      printer: this.settings.name,
      code: `TEST${Date.now().toString().slice(-6)}`,
    });
  }

  buildLabel(template: LabelTemplate, data: Record<string, string | number>, copies = 1): Buffer {
    const width = template.labelWidth || this.settings.labelWidth;
    const height = template.labelHeight || this.settings.labelHeight;
    const gap = template.gapMm ?? this.settings.gapLength;
    // Round 21 — per-template calibration nudge on top of the printer's own
    // global margins/darkness (LabelDesignerPage.tsx's Print Calibration
    // panel); templates saved before this round have xOffsetMm/yOffsetMm: 0
    // and no darkness override, so they print exactly as before.
    const effectiveMarginLeft = this.settings.marginLeft + (template.xOffsetMm ?? 0);
    const effectiveMarginTop = this.settings.marginTop + (template.yOffsetMm ?? 0);
    const effectiveDarkness = template.darkness ?? this.settings.darknessFactor;
    const lines: string[] = [
      `SIZE ${width.toFixed(1)} mm,${height.toFixed(1)} mm`,
      `GAP ${gap.toFixed(1)} mm,0 mm`,
      'CODEPAGE UTF-8',
      'DIRECTION 0',
      'REFERENCE 0,0',
      `DENSITY ${clamp(effectiveDarkness, 0, 15)}`,
      'SPEED 4',
      'CLS',
    ];

    for (const element of template.elements) {
      const transformed = transformElement(element, this.settings);
      const x = mmToDots(transformed.x + effectiveMarginLeft, this.profile.dpi);
      const y = mmToDots(transformed.y + effectiveMarginTop, this.profile.dpi);

      if (element.type === 'text') {
        const rawContent = resolveContent(element, data);
        const labelPrefix = element.labelPrefix?.trim();
        const textValue = labelPrefix && element.labelPlacement !== 'split' ? `${labelPrefix}: ${rawContent}` : rawContent;
        const content = tsplQuote(textValue);
        if (!content && !labelPrefix) continue;

        const font = fontForSize(element.fontSize);
        const boxWidthDots = mmToDots(element.width || 0, this.profile.dpi);
        if (labelPrefix && element.labelPlacement === 'split') {
          lines.push(`TEXT ${x},${y},"${font}",${transformed.rotation},1,1,"${tsplQuote(`${labelPrefix}:`)}"`);
        }
        const rawTextWidth = textWidthDots(textValue, font);
        const alignedX =
          element.align === 'right'
            ? x + Math.max(0, boxWidthDots - rawTextWidth)
            : element.align === 'center'
              ? x + Math.max(0, Math.round((boxWidthDots - rawTextWidth) / 2))
              : x;
        lines.push(`TEXT ${alignedX},${y},"${font}",${transformed.rotation},1,1,"${content}"`);
        continue;
      }

      if (element.type === 'barcode') {
        const content = tsplQuote(resolveContent(element, data));
        if (!content) continue;

        const rawContent = resolveContent(element, data);
        const heightDots = Math.max(24, mmToDots(element.height || 10, this.profile.dpi));
        const narrow = barcodeNarrowWidth(element.width || 30, rawContent, element.barcodeType, this.profile.dpi);
        const wide = clamp(narrow * 2, narrow, 10);
        lines.push(`BARCODE ${x},${y},"${barcodeTypeToTspl(element.barcodeType)}",${heightDots},1,${transformed.rotation},${narrow},${wide},"${content}"`);
        continue;
      }

      if (element.type === 'qrcode') {
        const content = tsplQuote(resolveContent(element, data));
        if (!content) continue;

        const qrSize = clamp(element.qrSize || Math.round((element.width || 20) / 4), 1, 10);
        lines.push(`QRCODE ${x},${y},L,${qrSize},A,${transformed.rotation},"${content}"`);
        continue;
      }

      if (element.type === 'image') {
        if (!element.bitmap) continue;
        const { heightDots, bytesPerRow, hex } = element.bitmap;
        const rowHexChars = bytesPerRow * 2;
        const rowsPerBand = 16;
        for (let row = 0; row < heightDots; row += rowsPerBand) {
          const bandRows = Math.min(rowsPerBand, heightDots - row);
          const bandHex = hex.slice(row * rowHexChars, (row + bandRows) * rowHexChars);
          lines.push(`BITMAP ${x},${y + row},${bytesPerRow},${bandRows},0,${bandHex}`);
        }
        continue;
      }

      if (element.type === 'line' || element.type === 'rectangle') {
        const widthDots = Math.max(1, mmToDots(element.width, this.profile.dpi));
        const heightDots = Math.max(1, mmToDots(element.height, this.profile.dpi));
        lines.push(`BAR ${x},${y},${widthDots},${heightDots}`);
      }
    }

    lines.push(`PRINT ${Math.max(1, copies)}`);
    return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
  }

  getSettings(): PrinterSettings {
    return { ...this.settings };
  }

  updateSettings(settings: Partial<PrinterSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  getProfile(): PrinterProfile {
    return STANDARD_PROFILES[this.profile.id] || this.profile;
  }
}

export { STANDARD_PROFILES, DEFAULT_SETTINGS };
