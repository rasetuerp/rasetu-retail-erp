// Shared label-template types + print-time conversion — infrastructure, not a
// page (same exemption as invoicePrint.ts/api.ts). Used by
// LabelDesignerPage.tsx (author/edit), LabelsPage.tsx (quick single-item
// print), and BulkStockEntryPage.tsx (batch print) so the "authored template
// -> real printer-driver.ts LabelTemplate + per-item data" conversion exists
// exactly once.

export type ElementType = 'text' | 'barcode' | 'qrcode' | 'line' | 'rectangle' | 'image';

export type DesignElement = {
  id: string;
  type: ElementType;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  fontSize?: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  // 'text'/'barcode'/'qrcode' bound to real data resolve against this key at
  // print time (see FIELD_OPTIONS below); a 'text' element with no sourceKey
  // is plain static text, edited directly via `content`. An 'image' element
  // has no sourceKey — `content` holds its data-URL directly (Round 21).
  sourceKey?: string;
  content?: string;
  showLabel?: boolean;
  displayLabel?: string;
  barcodeType?: 'code128' | 'code39' | 'ean13' | 'upca';
};

// Round 21 — xOffsetMm/yOffsetMm/darkness existed here since the templates
// were first saved but were never surfaced in the UI or read by
// printer-driver.ts; LabelDesignerPage.tsx's new Print Calibration panel
// finally edits them, and buildPrinterTemplate() below finally forwards them.
// loopZone is new: a design-time keep-clear guide for pre-punched swing-tag
// stock (see PRESET_GALLERY's 'swing-tag' entry) — purely visual, not sent to
// the printer, since the physical hole is already part of the tag stock.
export type PrintConfig = {
  darkness: number;
  gapMm: number;
  xOffsetMm: number;
  yOffsetMm: number;
  dpi: 203 | 300;
  loopZone?: { edge: 'top' | 'bottom' | 'left' | 'right'; sizeMm: number };
};

export type LabelTemplateDto = {
  id: string;
  name: string;
  isDefault: boolean;
  widthMm: number;
  heightMm: number;
  elements: DesignElement[];
  printConfig: PrintConfig;
};

export type LabelPrintItem = {
  id: string;
  sku: string;
  barcode: string | null;
  hsn: string | null;
  category: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  unit: string;
  purchaseRate: string;
  mrp: string;
  sellingRate: string;
  gstRate: string;
  stockQty: string;
  minStock: string;
  // Round 10 — legal-metrology label fields (docs/SCHEMA.md's Round 10 entry).
  commodity: string | null;
  itemType: string | null;
  brandCode: string | null;
  styleCode: string | null;
  mfgDate: string | null; // ISO date string from the API, formatted at print time (see resolveFieldValue)
  netQtyLabel: string | null;
  // Round 14 — shop-added custom fields (Settings → Item Fields, same
  // customFields blob ItemMasterPage.tsx/BulkStockEntryPage.tsx already
  // read/write). Optional since only pages that actually fetch it populate
  // it — see resolveFieldValue's 'itemCustom' scope below.
  customFields?: Record<string, string> | null;
};

export type LabelPrintCompany = { name: string; address: string | null; phone: string | null; gstin: string | null };

// Generalizes "Show HSN and other details" to any Item/Company field rather
// than a fixed list — the dropdown a shop owner picks from in the designer.
export const FIELD_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'item.sku', label: 'SKU' },
  { key: 'item.barcode', label: 'Barcode value' },
  { key: 'item.hsn', label: 'HSN' },
  { key: 'item.category', label: 'Category' },
  { key: 'item.brand', label: 'Brand' },
  { key: 'item.size', label: 'Size' },
  { key: 'item.color', label: 'Color' },
  { key: 'item.unit', label: 'Unit' },
  { key: 'item.purchaseRate', label: 'Purchase Rate' },
  { key: 'item.mrp', label: 'MRP' },
  { key: 'item.sellingRate', label: 'Selling Rate' },
  { key: 'item.gstRate', label: 'GST %' },
  { key: 'item.stockQty', label: 'Stock Qty' },
  { key: 'item.minStock', label: 'Min Stock' },
  { key: 'item.commodity', label: 'Commodity' },
  { key: 'item.itemType', label: 'Type' },
  { key: 'item.brandCode', label: 'Brand Code' },
  { key: 'item.styleCode', label: 'Style Code' },
  { key: 'item.mfgDate', label: 'MFG Date' },
  { key: 'item.netQtyLabel', label: 'Net Qty' },
  { key: 'company.name', label: 'Company Name' },
  { key: 'company.address', label: 'Company Address' },
  { key: 'company.phone', label: 'Company Phone' },
  { key: 'company.gstin', label: 'Company GSTIN' },
];

export function resolveFieldValue(sourceKey: string, item: LabelPrintItem | null, company: LabelPrintCompany | null): string {
  if (!sourceKey.includes('.')) return sourceKey;
  const [scope, ...rest] = sourceKey.split('.');
  const field = rest.join('.');
  if (scope === 'item' && item) {
    if (field === 'mrp') return `₹${Number(item.mrp).toLocaleString('en-IN')}`;
    if (field === 'sellingRate') return `₹${Number(item.sellingRate).toLocaleString('en-IN')}`;
    if (field === 'purchaseRate') return `₹${Number(item.purchaseRate).toLocaleString('en-IN')}`;
    if (field === 'gstRate') return `${item.gstRate}%`;
    if (field === 'barcode') return item.barcode ?? item.sku;
    // "September 2025" — month+year only, matching the legal-metrology label
    // sample this round was built from (day-of-month isn't printed).
    if (field === 'mfgDate') return item.mfgDate ? new Date(item.mfgDate).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : '';
    const value = (item as unknown as Record<string, string | null>)[field];
    return value ?? '';
  }
  // Round 14 — shop-added custom fields, keyed separately from 'item' so a
  // custom field name can never collide with a real Item column.
  if (scope === 'itemCustom' && item) {
    return item.customFields?.[field] ?? '';
  }
  if (scope === 'company' && company) {
    const value = (company as unknown as Record<string, string | null>)[field];
    return value ?? '';
  }
  return '';
}

// Round 14 — the field picker used to be a fixed list with no way to bind a
// shop's own custom item fields (Settings → Item Fields), even though every
// other item-creation surface (Item Master, Bulk Stock Entry, Billing) had
// already been brought into sync with each other. `customAttrs` is the same
// `{ key, label }` shape ItemMasterPage.tsx/BulkStockEntryPage.tsx already
// fetch from GET /companies/:id/items/fields (filtered to `custom: true`).
export function tsplFontPreviewPx(sizePt = 10): number {
  if (sizePt <= 8) return 6;
  if (sizePt <= 10) return 10;
  if (sizePt <= 14) return 12;
  return 16;
}

export function estimateBarcodeModules(value: string, type: DesignElement['barcodeType'] = 'code128'): number {
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

export function barcodePreviewModulePx(
  widthMm: number,
  value: string,
  type: DesignElement['barcodeType'] = 'code128',
  pxPerMm = 4,
  dpi = 203
): number {
  const targetDots = Math.max(1, Math.round((Math.max(0.1, widthMm) / 25.4) * dpi));
  const narrowDots = Math.max(1, Math.floor(targetDots / estimateBarcodeModules(value, type)));
  return (narrowDots / dpi) * 25.4 * pxPerMm;
}

export function buildFieldOptions(customAttrs: Array<{ key: string; label: string }> = []): Array<{ key: string; label: string }> {
  if (customAttrs.length === 0) return FIELD_OPTIONS;
  return [...FIELD_OPTIONS, ...customAttrs.map((a) => ({ key: `itemCustom.${a.key}`, label: a.label }))];
}

// Round 14 — a size preset used to only change widthMm/heightMm, leaving a
// fresh template's canvas empty (or an existing one's elements un-rescaled).
// This gives every size a real, consistent starting layout instead of a
// blank/random one: a single-row SKU+price+barcode for short tags, or a
// category/SKU/price header over a barcode band for anything taller — scales
// to any width/height, not just the fixed presets, so a custom size typed
// into the Width/Height fields gets the same treatment.
export function defaultElementsForSize(widthMm: number, heightMm: number): DesignElement[] {
  const mk = (partial: Omit<DesignElement, 'id'>): DesignElement => ({
    id: `el-${Date.now()}-${Math.round(Math.random() * 100000)}`,
    ...partial,
  });
  if (heightMm < 15) {
    return [
      mk({ type: 'text', xMm: 1, yMm: 1, widthMm: widthMm * 0.5, heightMm: heightMm * 0.42, fontSize: 6, sourceKey: 'item.sku' }),
      mk({ type: 'text', xMm: 1, yMm: heightMm * 0.48, widthMm: widthMm * 0.5, heightMm: heightMm * 0.42, fontSize: 7, bold: true, sourceKey: 'item.mrp' }),
      mk({ type: 'barcode', xMm: widthMm * 0.53, yMm: 1, widthMm: widthMm * 0.45, heightMm: heightMm - 2, sourceKey: 'item.sku', barcodeType: 'code128' }),
    ];
  }
  const pad = Math.max(2, widthMm * 0.06);
  const rowH = Math.max(4, Math.min(6, heightMm * 0.08));
  const labelW = Math.max(17, widthMm * 0.34);
  const valueX = pad + labelW;
  const valueW = widthMm - valueX - pad;
  const headerH = Math.max(7, heightMm * 0.12);
  const lineY1 = headerH + 4;
  const rowStart = lineY1 + 3;
  const mrpY = Math.min(heightMm - 25, rowStart + rowH * 5.15);
  const barcodeY = Math.min(heightMm - 15, mrpY + Math.max(10, heightMm * 0.16));
  return [
    mk({ type: 'text', xMm: pad, yMm: 2, widthMm: widthMm - pad * 2, heightMm: headerH, fontSize: 14, bold: true, align: 'center', sourceKey: 'item.brand' }),
    mk({ type: 'line', xMm: pad, yMm: lineY1, widthMm: widthMm - pad * 2, heightMm: 0.35 }),
    mk({ type: 'text', xMm: pad, yMm: rowStart, widthMm: labelW, heightMm: rowH, fontSize: 8, bold: true, content: 'Category:' }),
    mk({ type: 'text', xMm: valueX, yMm: rowStart, widthMm: valueW, heightMm: rowH, fontSize: 8, align: 'right', sourceKey: 'item.category' }),
    mk({ type: 'text', xMm: pad, yMm: rowStart + rowH, widthMm: labelW, heightMm: rowH, fontSize: 8, bold: true, content: 'Type:' }),
    mk({ type: 'text', xMm: valueX, yMm: rowStart + rowH, widthMm: valueW, heightMm: rowH, fontSize: 8, align: 'right', sourceKey: 'item.itemType' }),
    mk({ type: 'text', xMm: pad, yMm: rowStart + rowH * 2, widthMm: labelW, heightMm: rowH, fontSize: 8, bold: true, content: 'Size:' }),
    mk({ type: 'text', xMm: valueX, yMm: rowStart + rowH * 2, widthMm: valueW, heightMm: rowH, fontSize: 10, align: 'right', sourceKey: 'item.size' }),
    mk({ type: 'text', xMm: pad, yMm: rowStart + rowH * 3, widthMm: labelW, heightMm: rowH, fontSize: 8, bold: true, content: 'Color:' }),
    mk({ type: 'text', xMm: valueX, yMm: rowStart + rowH * 3, widthMm: valueW, heightMm: rowH, fontSize: 8, align: 'right', sourceKey: 'item.color' }),
    mk({ type: 'line', xMm: pad, yMm: rowStart + rowH * 4.45, widthMm: widthMm - pad * 2, heightMm: 0.25 }),
    mk({ type: 'text', xMm: pad, yMm: mrpY, widthMm: widthMm - pad * 2, heightMm: Math.max(7, heightMm * 0.12), fontSize: 14, bold: true, align: 'center', showLabel: true, displayLabel: 'MRP', sourceKey: 'item.mrp' }),
    mk({ type: 'text', xMm: pad, yMm: mrpY + Math.max(7, heightMm * 0.12), widthMm: widthMm - pad * 2, heightMm: 4, fontSize: 6, align: 'center', content: '(Incl. of all taxes)' }),
    mk({ type: 'barcode', xMm: pad, yMm: barcodeY, widthMm: widthMm - pad * 2, heightMm: Math.max(10, heightMm - barcodeY - 3), sourceKey: 'item.sku', barcodeType: 'code128' }),
  ];
}

// Round 20 — defaultElementsForSize gives every size *some* starting layout,
// but only one, auto-generated from a width/height ratio; it's not a design.
// PRESET_GALLERY is a real, curated set of standard Indian garment-retail tag
// designs a shop can browse and start from — grounded in actual retail
// conventions and the legal-metrology fields this app already collects
// (docs/SCHEMA.md Round 10), not arbitrary layouts. Each entry owns its own
// widthMm/heightMm (independent of SIZE_PRESETS in LabelDesignerPage.tsx,
// though the two lists overlap) and a fresh-id element builder, same
// re-id-per-call approach as defaultElementsForSize above.
export type PresetTemplate = {
  id: string;
  name: string;
  description: string;
  widthMm: number;
  heightMm: number;
  buildElements: () => DesignElement[];
  loopZone?: NonNullable<PrintConfig['loopZone']>;
};

export const PRESET_GALLERY: PresetTemplate[] = [
  {
    id: 'professional-mrp-label',
    name: 'Professional MRP Label',
    description: 'Reference-style garment label with centered brand, aligned details, large MRP with rupee symbol, tax note and barcode.',
    widthMm: 50,
    heightMm: 75,
    buildElements: () => defaultElementsForSize(50, 75),
  },
  {
    id: 'compact-barcode',
    name: 'Compact Barcode Tag',
    description: 'SKU, bold MRP, barcode with code beneath — the standard small price sticker.',
    widthMm: 50,
    heightMm: 25,
    buildElements: () => {
      const mk = (partial: Omit<DesignElement, 'id'>): DesignElement => ({ id: `el-${Date.now()}-${Math.round(Math.random() * 100000)}`, ...partial });
      return [
        mk({ type: 'text', xMm: 1, yMm: 1, widthMm: 30, heightMm: 6, fontSize: 6, sourceKey: 'item.sku' }),
        mk({ type: 'text', xMm: 32, yMm: 1, widthMm: 17, heightMm: 6, fontSize: 7, bold: true, align: 'right', sourceKey: 'item.mrp' }),
        mk({ type: 'barcode', xMm: 2, yMm: 8, widthMm: 46, heightMm: 15, sourceKey: 'item.sku', barcodeType: 'code128' }),
      ];
    },
  },
  {
    id: 'mini-tag',
    name: 'Mini Tag',
    description: 'SKU + barcode only — the tightest jewellery-style tags.',
    widthMm: 63,
    heightMm: 11,
    buildElements: () => defaultElementsForSize(63, 11),
  },
  {
    id: 'swing-tag',
    name: 'Standard Swing Tag',
    description: 'Shop header, category, SKU, size/color, large MRP, barcode — the classic hanging garment price tag.',
    widthMm: 50,
    heightMm: 75,
    // Pre-punched swing-tag stock has a string hole near the top edge —
    // marked here so the canvas shows a keep-clear guide by default.
    loopZone: { edge: 'top', sizeMm: 8 },
    buildElements: () => {
      const mk = (partial: Omit<DesignElement, 'id'>): DesignElement => ({ id: `el-${Date.now()}-${Math.round(Math.random() * 100000)}`, ...partial });
      return [
        mk({ type: 'text', xMm: 2, yMm: 2, widthMm: 46, heightMm: 8, fontSize: 8, bold: true, align: 'center', sourceKey: 'company.name' }),
        mk({ type: 'text', xMm: 2, yMm: 11, widthMm: 46, heightMm: 6, fontSize: 6, align: 'center', sourceKey: 'item.category' }),
        mk({ type: 'text', xMm: 2, yMm: 18, widthMm: 30, heightMm: 6, fontSize: 7, sourceKey: 'item.sku' }),
        mk({ type: 'text', xMm: 2, yMm: 25, widthMm: 22, heightMm: 6, fontSize: 6, showLabel: true, displayLabel: 'Size', sourceKey: 'item.size' }),
        mk({ type: 'text', xMm: 26, yMm: 25, widthMm: 22, heightMm: 6, fontSize: 6, showLabel: true, displayLabel: 'Color', sourceKey: 'item.color' }),
        mk({ type: 'text', xMm: 2, yMm: 36, widthMm: 46, heightMm: 12, fontSize: 14, bold: true, align: 'center', sourceKey: 'item.mrp' }),
        mk({ type: 'rectangle', xMm: 2, yMm: 50, widthMm: 46, heightMm: 0.5 }),
        mk({ type: 'barcode', xMm: 4, yMm: 54, widthMm: 42, heightMm: 18, sourceKey: 'item.sku', barcodeType: 'code128' }),
      ];
    },
  },
  {
    id: 'shelf-label',
    name: 'Shelf / Rack Label',
    description: 'Brand, category, size/color, large MRP, barcode — sized for a rack-edge strip.',
    widthMm: 100,
    heightMm: 50,
    buildElements: () => {
      const mk = (partial: Omit<DesignElement, 'id'>): DesignElement => ({ id: `el-${Date.now()}-${Math.round(Math.random() * 100000)}`, ...partial });
      return [
        mk({ type: 'text', xMm: 2, yMm: 2, widthMm: 58, heightMm: 8, fontSize: 8, bold: true, sourceKey: 'item.brand' }),
        mk({ type: 'text', xMm: 2, yMm: 10, widthMm: 58, heightMm: 6, fontSize: 6, sourceKey: 'item.category' }),
        mk({ type: 'text', xMm: 2, yMm: 17, widthMm: 28, heightMm: 6, fontSize: 6, showLabel: true, displayLabel: 'Size', sourceKey: 'item.size' }),
        mk({ type: 'text', xMm: 32, yMm: 17, widthMm: 28, heightMm: 6, fontSize: 6, showLabel: true, displayLabel: 'Color', sourceKey: 'item.color' }),
        mk({ type: 'text', xMm: 62, yMm: 2, widthMm: 36, heightMm: 16, fontSize: 16, bold: true, align: 'right', sourceKey: 'item.mrp' }),
        mk({ type: 'barcode', xMm: 2, yMm: 26, widthMm: 96, heightMm: 20, sourceKey: 'item.sku', barcodeType: 'code128' }),
      ];
    },
  },
  {
    id: 'legal-metrology',
    name: 'Legal Metrology Tag',
    description: 'Commodity, MRP (incl. of all taxes), net quantity, mfg date, style/brand code, barcode — matches Legal Metrology (Packaged Commodities) Rules fields.',
    widthMm: 75,
    heightMm: 50,
    buildElements: () => {
      const mk = (partial: Omit<DesignElement, 'id'>): DesignElement => ({ id: `el-${Date.now()}-${Math.round(Math.random() * 100000)}`, ...partial });
      return [
        mk({ type: 'text', xMm: 2, yMm: 2, widthMm: 71, heightMm: 6, fontSize: 7, bold: true, sourceKey: 'item.commodity' }),
        mk({ type: 'text', xMm: 2, yMm: 9, widthMm: 71, heightMm: 8, fontSize: 8, bold: true, showLabel: true, displayLabel: 'MRP (incl. of all taxes)', sourceKey: 'item.mrp' }),
        mk({ type: 'text', xMm: 2, yMm: 18, widthMm: 35, heightMm: 6, fontSize: 6, showLabel: true, displayLabel: 'Net Qty', sourceKey: 'item.netQtyLabel' }),
        mk({ type: 'text', xMm: 38, yMm: 18, widthMm: 35, heightMm: 6, fontSize: 6, showLabel: true, displayLabel: 'Mfg', sourceKey: 'item.mfgDate' }),
        mk({ type: 'text', xMm: 2, yMm: 25, widthMm: 35, heightMm: 6, fontSize: 6, showLabel: true, displayLabel: 'Style', sourceKey: 'item.styleCode' }),
        mk({ type: 'text', xMm: 38, yMm: 25, widthMm: 35, heightMm: 6, fontSize: 6, showLabel: true, displayLabel: 'Brand Code', sourceKey: 'item.brandCode' }),
        mk({ type: 'barcode', xMm: 4, yMm: 33, widthMm: 67, heightMm: 15, sourceKey: 'item.sku', barcodeType: 'code128' }),
      ];
    },
  },
  {
    id: 'qr-price-tag',
    name: 'QR + Price Tag',
    description: 'SKU, bold MRP, QR code — link a garment to a WhatsApp/Instagram catalog entry.',
    widthMm: 50,
    heightMm: 50,
    buildElements: () => {
      const mk = (partial: Omit<DesignElement, 'id'>): DesignElement => ({ id: `el-${Date.now()}-${Math.round(Math.random() * 100000)}`, ...partial });
      return [
        mk({ type: 'text', xMm: 2, yMm: 2, widthMm: 46, heightMm: 6, fontSize: 6, sourceKey: 'item.sku' }),
        mk({ type: 'text', xMm: 2, yMm: 9, widthMm: 46, heightMm: 10, fontSize: 12, bold: true, align: 'center', sourceKey: 'item.mrp' }),
        // No sourceKey — a QR catalog/social link is shop-wide, not per-item;
        // the shop fills in the actual link once via the new "Custom value" mode.
        mk({ type: 'qrcode', xMm: 13, yMm: 21, widthMm: 24, heightMm: 24, content: '' }),
      ];
    },
  },
  {
    id: 'variant-strip',
    name: 'Size/Color Variant Strip',
    description: 'SKU, size, color, small barcode — for racks carrying many size/color variants of one style.',
    widthMm: 85,
    heightMm: 12,
    buildElements: () => {
      const mk = (partial: Omit<DesignElement, 'id'>): DesignElement => ({ id: `el-${Date.now()}-${Math.round(Math.random() * 100000)}`, ...partial });
      return [
        mk({ type: 'text', xMm: 1, yMm: 1, widthMm: 30, heightMm: 5, fontSize: 6, sourceKey: 'item.sku' }),
        mk({ type: 'text', xMm: 1, yMm: 6.5, widthMm: 14, heightMm: 5, fontSize: 6, sourceKey: 'item.size' }),
        mk({ type: 'text', xMm: 16, yMm: 6.5, widthMm: 16, heightMm: 5, fontSize: 6, sourceKey: 'item.color' }),
        mk({ type: 'barcode', xMm: 33, yMm: 1, widthMm: 50, heightMm: 10, sourceKey: 'item.sku', barcodeType: 'code128' }),
      ];
    },
  },
];

/**
 * Matches electron/printer-driver.ts's LabelTemplate interface exactly —
 * buildLabel() expects this shape. Async since Round 21's 'image' elements
 * need to be dithered into a thermal bitmap here in the renderer (see
 * thermalBitmap.ts — printer-driver.ts runs in Electron's main process with
 * no canvas/Image API) before the payload is handed to the print bridge.
 */
export async function buildPrinterTemplate(draft: LabelTemplateDto) {
  const elements = await Promise.all(
    draft.elements.map(async (el) => {
      const base = {
        type: el.type,
        x: el.xMm,
        y: el.yMm,
        width: el.widthMm,
        height: el.heightMm,
        content: el.sourceKey ?? el.content ?? '',
        fontSize: el.fontSize,
        fontWeight: el.bold ? ('bold' as const) : ('normal' as const),
        align: el.align,
        barcodeType: el.barcodeType,
        qrSize: el.type === 'qrcode' ? Math.max(1, Math.round(el.widthMm / 4)) : undefined,
      };
      if (el.type !== 'image' || !el.content) return base;
      const { imageToThermalBitmap } = await import('./thermalBitmap');
      try {
        const bitmap = await imageToThermalBitmap(el.content, el.widthMm, el.heightMm, draft.printConfig.dpi);
        return { ...base, bitmap };
      } catch {
        return base;
      }
    })
  );
  return {
    id: draft.id || 'draft',
    name: draft.name,
    version: '1.0',
    labelWidth: draft.widthMm,
    labelHeight: draft.heightMm,
    elements,
    printerProfile: draft.printConfig.dpi === 300 ? 'tsc-ttp244-300' : 'tsc-ttp244-203',
    xOffsetMm: draft.printConfig.xOffsetMm,
    yOffsetMm: draft.printConfig.yOffsetMm,
    gapMm: draft.printConfig.gapMm,
    darkness: draft.printConfig.darkness,
  };
}

/** Per-item data record for printer-driver.ts's buildLabel(template, data) — resolves every sourceKey against this one item/company right now. */
export function buildDataForItem(draft: LabelTemplateDto, item: LabelPrintItem, company: LabelPrintCompany | null): Record<string, string | number> {
  const data: Record<string, string | number> = {};
  for (const el of draft.elements) {
    if (!el.sourceKey) continue;
    const value = resolveFieldValue(el.sourceKey, item, company);
    data[el.sourceKey] = el.type === 'text' && el.showLabel && el.displayLabel ? `${el.displayLabel}: ${value}` : value;
  }
  return data;
}
