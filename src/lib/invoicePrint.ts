// Print layouts (docs/SCOPE.md #5, docs/SPRINT_PLAN.md Step 13) — infrastructure,
// same exemption as exportUtils.ts. Template-First rule (docs/RULES.md): exactly
// 3 thermal layouts + 2 A4/A5 layouts, fixed — no drag-and-drop designer in v1.

export type PrintableInvoice = {
  number: string;
  date: string;
  // Optional — not read by any of the print builders below, only used by
  // pages (e.g. InvoicesPage.tsx) that need to know the document's lifecycle
  // state, such as whether an Estimate can still be converted to a real bill.
  status?: 'DRAFT' | 'HELD' | 'ESTIMATE' | 'POSTED' | 'CANCELLED';
  party: { name: string; phone: string | null; gstin: string | null; address: string | null } | null;
  items: Array<{
    // Round 10 — needed to submit a Sales Return (POST /credit-notes' items
    // array); always present on the raw GET /invoices/:id row (a real
    // InvoiceItem column), just not previously declared on this print-only type.
    itemId: string;
    qty: string;
    rate: string;
    gstRate: string;
    amount: string;
    item: { sku: string; hsn: string | null; category: string | null; brand: string | null; size: string | null; color: string | null };
  }>;
  subtotal: string;
  discountPct: string;
  discountAmt: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  total: string;
  // Round 6 — receipt-header fields joined server-side (GET /invoices/:id)
  // from the catalog database + the CREATE audit-log entry; optional/null
  // since only that one endpoint populates them.
  company?: { name: string; address: string | null; phone: string | null; gstin: string | null } | null;
  cashierName?: string | null;
  payments?: Array<{ mode: string; amount: string; date: string; refNumber?: string | null }>;
  dueDate?: string | null;
  // Round 6 — needed to compute/record Amount Due against a posted invoice
  // from Invoice History, after the cashier has navigated away from Billing.
  partyId?: string | null;
  newBalance?: string;
};

// Round 7 — the 'receipt' layout's sections are individually toggleable and
// reorderable (a text-only analog of a "section catalog" — true x/y drag
// positioning doesn't apply to a monospace text receipt, order is the right
// primitive here). 'items'/'totals' are locked: a receipt without its line
// items or total isn't a receipt, so they stay enabled regardless of config.
export type ReceiptSectionKey =
  | 'header'
  | 'cashierCustomer'
  | 'items'
  | 'totals'
  | 'paidLine'
  | 'amountInWords'
  | 'gstBreakup'
  | 'savingsLine'
  | 'exchangePolicy'
  | 'customMessage'
  | 'paymentInfo'
  | 'qrPlaceholder'
  | 'cashier'
  | 'footer';
export type ReceiptSectionConfig = { key: ReceiptSectionKey; enabled: boolean; order: number };
export const LOCKED_RECEIPT_SECTIONS: ReceiptSectionKey[] = ['items', 'totals'];
export const RECEIPT_SECTION_LABELS: Record<ReceiptSectionKey, string> = {
  header: 'Shop header & bill info',
  cashierCustomer: 'Customer details',
  items: 'Item lines (always shown)',
  totals: 'Totals - Taxable/GST/Total (always shown)',
  paidLine: 'Paid amount',
  amountInWords: 'Amount in words',
  gstBreakup: 'GST rate-wise breakup table',
  savingsLine: '"You saved" line',
  exchangePolicy: 'Exchange policy text',
  customMessage: 'Custom message / terms & offers',
  paymentInfo: 'Payment / UPI details (also shown as the QR/pay note)',
  qrPlaceholder: 'Scan-to-pay note (from Payment / UPI details above)',
  // Round 14 — split out of the old combined "Cashier & customer" section
  // (now just 'cashierCustomer', customer-only) so a shop can place the
  // cashier/staff name wherever they like; defaults near the bottom.
  cashier: 'Cashier / staff name',
  footer: 'Footer / thank-you text',
};
export const DEFAULT_RECEIPT_SECTIONS: ReceiptSectionConfig[] = (Object.keys(RECEIPT_SECTION_LABELS) as ReceiptSectionKey[]).map((key, order) => ({
  key,
  enabled: true,
  order,
}));

// Round 6 — shop-configurable text shown on the thermal receipt footer;
// mirrors backend/src/routes/invoices.ts's receiptSettingsSchema defaults.
export type ReceiptSettings = {
  receiptLogoImage: string;
  receiptLogoWidthMm: number;
  shopNameText: string;
  shopNameFontSize: number;
  localShopNameText: string;
  localShopNameFontSize: number;
  headerLine1Text: string;
  headerLine1FontSize: number;
  headerLine2Text: string;
  headerLine2FontSize: number;
  headerLine3Text: string;
  headerLine3FontSize: number;
  headerOrder: ReceiptHeaderKey[];
  exchangePolicyText: string;
  footerText: string;
  customMessageText: string;
  paymentInfoText: string;
  showSavingsLine: boolean;
  sections: ReceiptSectionConfig[];
  columns: number;
  marginLeftChars: number;
  marginRightChars: number;
  endFeedLines: number;
  receiptPrintableWidthMm: number;
  receiptLeftMarginMm: number;
  receiptBodyFontPx: number;
};

export type ReceiptHeaderKey = 'logo' | 'shopName' | 'localShopName' | 'headerLine1' | 'headerLine2' | 'headerLine3';
export const RECEIPT_HEADER_LABELS: Record<ReceiptHeaderKey, string> = {
  logo: 'Shop logo',
  shopName: 'Shop name',
  localShopName: 'Local language shop name',
  headerLine1: 'Header line 1',
  headerLine2: 'Business details',
  headerLine3: 'Header line 3',
};
export const DEFAULT_RECEIPT_HEADER_ORDER: ReceiptHeaderKey[] = ['logo', 'shopName', 'localShopName', 'headerLine1', 'headerLine2', 'headerLine3'];

const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
  receiptLogoImage: '',
  receiptLogoWidthMm: 18,
  shopNameText: '',
  shopNameFontSize: 16,
  localShopNameText: '',
  localShopNameFontSize: 16,
  headerLine1Text: '',
  headerLine1FontSize: 12,
  headerLine2Text: '',
  headerLine2FontSize: 10,
  headerLine3Text: '',
  headerLine3FontSize: 10,
  headerOrder: DEFAULT_RECEIPT_HEADER_ORDER,
  exchangePolicyText: 'Exchange within 7 days with bill. No exchange on sale items and altered garments.',
  footerText: 'Thank you! Visit again',
  // Round 10 — free-form, multi-line (unlike exchangePolicyText/footerText):
  // custom message, terms & conditions, or a promotional offer.
  customMessageText: '',
  // Round 12 — a real printed payment line (e.g. "Pay via UPI: shop@bank"),
  // distinct from qrPlaceholder below which is a deliberate text-only stand-in
  // (the ESC/POS pipeline can't print an actual QR image).
  paymentInfoText: '',
  showSavingsLine: true,
  sections: DEFAULT_RECEIPT_SECTIONS,
  // Round 17 — physical roll width in characters (58mm ≈ 32 cols, 80mm ≈ 48
  // cols at standard thermal font). Drives every thermal layout below.
  columns: 32,
  marginLeftChars: 0,
  marginRightChars: 0,
  endFeedLines: 0,
  receiptPrintableWidthMm: 0,
  receiptLeftMarginMm: 0,
  receiptBodyFontPx: 0,
};

function money(v: string | number): string {
  return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}

function threeDigitWords(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? twoDigitWords(rest) : ''].filter(Boolean).join(' ');
}

/**
 * GST receipts conventionally spell the total in Indian numbering (lakh/crore,
 * not thousand/million) — "Rupees Six Thousand Three Hundred Only" per the
 * mockup. Whole rupees only; paise are already folded into roundOff.
 */
export function numberToWordsIndian(amount: number): string {
  const n = Math.round(amount);
  if (n === 0) return 'Rupees Zero Only';
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  const parts = [
    crore ? `${threeDigitWords(crore)} Crore` : '',
    lakh ? `${threeDigitWords(lakh)} Lakh` : '',
    thousand ? `${threeDigitWords(thousand)} Thousand` : '',
    rest ? threeDigitWords(rest) : '',
  ].filter(Boolean);
  return `Rupees ${parts.join(' ')} Only`;
}

/**
 * Right/left-pads a fixed-width row so text-only tables line up on a
 * monospace thermal printer. Columns are joined with a mandatory 1-space gap
 * — without it, a column whose content exactly fills its width (a long
 * amount, a long HSN+GST string) runs straight into the next column with no
 * visible separation. Caller-supplied widths should budget for these gaps
 * (n columns → n-1 extra characters) alongside the printer's column count.
 */
function row(cols: Array<{ text: string; width: number; align?: 'l' | 'r' }>): string {
  return cols
    .map((c) => (c.align === 'r' ? c.text.slice(0, c.width).padStart(c.width) : c.text.slice(0, c.width).padEnd(c.width)))
    .join(' ');
}

/** "Cotton Kurta L/Blue" style line — Item has no dedicated name field, only sku/category/brand/size/color. */
function displayName(item: { sku: string; category: string | null; brand: string | null; size: string | null; color: string | null }): string {
  const base = [item.brand, item.category].filter(Boolean).join(' ');
  const variant = [item.size, item.color].filter(Boolean).join('/');
  return base ? [base, variant].filter(Boolean).join(' ') : item.sku;
}

/**
 * InvoiceItem.amount stores the tax-EXCLUDED taxable value (see
 * backend/src/routes/invoices.ts — `amount: line.taxableValue`), which is
 * correct for GST filing but not what a customer expects to see as "amount"
 * on a receipt (qty × rate). Re-derive the actual charged amount: since
 * taxableValue is tax-extracted consistently for both inclusive and
 * exclusive lines, taxableValue × (1 + gstRate/100) always equals qty × rate.
 */
function lineChargedAmount(line: { amount: string; gstRate: string }): number {
  return Number(line.amount) * (1 + Number(line.gstRate) / 100);
}

// ---------- Thermal (ESC/POS raw text — electron/printer-api.ts sends this
// verbatim via printRawCommands, see docs/ARCHITECTURE.md) ----------

export type ThermalLayout = 'compact' | 'standard' | 'detailed' | 'receipt';

function thermalCompact(inv: PrintableInvoice, settings: ReceiptSettings): string {
  const lines = [inv.number, inv.party?.name ?? 'Walk-in', divider(settings.columns)];
  for (const line of inv.items) lines.push(`${line.item.sku} x${Number(line.qty)}  ${money(lineChargedAmount(line))}`);
  lines.push(divider(settings.columns), `TOTAL  ${money(inv.total)}`);
  return lines.join('\n');
}

function thermalStandard(inv: PrintableInvoice, settings: ReceiptSettings): string {
  const lines = [
    'RaSetu Retail',
    `Invoice: ${inv.number}`,
    `Date: ${new Date(inv.date).toLocaleDateString('en-IN')}`,
    `Customer: ${inv.party?.name ?? 'Walk-in'}`,
    divider(settings.columns),
  ];
  for (const line of inv.items) {
    lines.push(`${line.item.sku}`);
    lines.push(`  ${Number(line.qty)} x ${money(line.rate)} = ${money(lineChargedAmount(line))}`);
  }
  lines.push(divider(settings.columns));
  lines.push(`Subtotal: ${money(inv.subtotal)}`);
  if (Number(inv.discountAmt) > 0) lines.push(`Discount: -${money(inv.discountAmt)}`);
  lines.push(`CGST: ${money(inv.cgst)}  SGST: ${money(inv.sgst)}`);
  if (Number(inv.igst) > 0) lines.push(`IGST: ${money(inv.igst)}`);
  lines.push(`TOTAL: ${money(inv.total)}`);
  lines.push('Thank you, visit again!');
  return lines.join('\n');
}

function thermalDetailed(inv: PrintableInvoice, settings: ReceiptSettings): string {
  const lines = [
    'RaSetu Retail - TAX INVOICE',
    `No: ${inv.number}   Date: ${new Date(inv.date).toLocaleDateString('en-IN')}`,
    `Bill to: ${inv.party?.name ?? 'Walk-in'}`,
    inv.party?.gstin ? `GSTIN: ${inv.party.gstin}` : '',
    divider(settings.columns, '='),
  ].filter(Boolean);
  for (const line of inv.items) {
    lines.push(`${line.item.sku}  HSN:${line.item.hsn ?? '-'}  GST:${line.gstRate}%`);
    lines.push(`  Qty ${Number(line.qty)} @ ${money(line.rate)} = ${money(lineChargedAmount(line))}`);
  }
  lines.push(divider(settings.columns, '='));
  lines.push(`Taxable: ${money(inv.subtotal)}`);
  lines.push(`CGST: ${money(inv.cgst)}   SGST: ${money(inv.sgst)}   IGST: ${money(inv.igst)}`);
  if (Number(inv.discountAmt) > 0) lines.push(`Discount: -${money(inv.discountAmt)}`);
  if (Number(inv.roundOff) !== 0) lines.push(`Round off: ${money(inv.roundOff)}`);
  lines.push(`GRAND TOTAL: ${money(inv.total)}`);
  return lines.join('\n');
}

function divider(width: number, char: string = '-'): string {
  return char.repeat(width);
}
function receiptCenter(s: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - s.length) / 2));
  return ' '.repeat(pad) + s;
}

function receiptHeaderText(text: string, fontSize: number): string {
  const clean = text.trim();
  if (!clean) return '';
  return fontSize >= 15 ? clean.toUpperCase() : clean;
}

function orderedReceiptHeaderKeys(settings: ReceiptSettings): ReceiptHeaderKey[] {
  const saved = Array.isArray(settings.headerOrder) ? settings.headerOrder : [];
  const valid = saved.filter((key): key is ReceiptHeaderKey => key in RECEIPT_HEADER_LABELS);
  return [...valid, ...DEFAULT_RECEIPT_HEADER_ORDER.filter((key) => !valid.includes(key))];
}

function sectionHeader(inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  const company = inv.company;
  const w = settings.columns;
  const lines: string[] = [];
  const headerText: Record<ReceiptHeaderKey, string> = {
    logo: '',
    shopName: receiptHeaderText(settings.shopNameText || company?.name || 'RaSetu Retail', settings.shopNameFontSize),
    localShopName: receiptHeaderText(settings.localShopNameText, settings.localShopNameFontSize),
    headerLine1: receiptHeaderText(settings.headerLine1Text, settings.headerLine1FontSize),
    headerLine2: receiptHeaderText(settings.headerLine2Text, settings.headerLine2FontSize),
    headerLine3: receiptHeaderText(settings.headerLine3Text, settings.headerLine3FontSize),
  };
  orderedReceiptHeaderKeys(settings).forEach((key) => {
    const text = headerText[key];
    if (!text) return;
    lines.push(...text.split('\n').filter(Boolean).map((part) => receiptCenter(part, w)));
  });
  if (company?.address) lines.push(receiptCenter(company.address, w));
  if (company?.phone) lines.push(receiptCenter(`Ph: ${company.phone}`, w));
  if (company?.gstin) lines.push(receiptCenter(`GSTIN: ${company.gstin}`, w));
  lines.push(divider(w), receiptCenter('TAX INVOICE', w), divider(w));
  // Bill number and date/time get their own lines rather than one packed
  // row — an invoice number alone (e.g. "Bill: EST/2026-27/0012") can already
  // run past half of the 32-column width, leaving no safe budget for a
  // right-aligned timestamp on the same line without truncating one of them.
  lines.push(`Bill: ${inv.number}`);
  lines.push(new Date(inv.date).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
  return lines;
}

// Round 14 — split from the old combined "cashierCustomer" section: the
// customer belongs with the bill's own details near the top, while the
// cashier/staff name is an internal audit detail a shop typically wants
// lower on the slip (see the new sectionCashier below, defaulted near the
// footer). Both stay independently toggleable/reorderable sections.
function sectionCustomer(inv: PrintableInvoice): string[] {
  return [inv.party ? `Cust: ${inv.party.name}${inv.party.phone ? ` (${inv.party.phone})` : ''}` : 'Cust: Walk-in'];
}

function sectionCashier(inv: PrintableInvoice): string[] {
  return inv.cashierName ? [`Billed by: ${inv.cashierName}`] : [];
}

// Free-text per-item lines (name / HSN+GST% / qty·rate·amount), matching
// thermalDetailed's own established style above — a rigid 4-column grid
// doesn't reliably fit HSN + qty + rate + amount inside 32 characters once
// any of those values run long, so this avoids the same column-smashing
// that a fixed-width table would hit.
function sectionItems(inv: PrintableInvoice): string[] {
  const lines: string[] = [];
  for (const line of inv.items) {
    lines.push(displayName(line.item));
    lines.push(`HSN ${line.item.hsn ?? '-'} GST ${line.gstRate}%`);
    lines.push(`  Qty ${Number(line.qty)} x ${money(line.rate)} = ${money(lineChargedAmount(line))}`);
  }
  return lines;
}

function sectionTotals(inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  const lines: string[] = [];
  const totalQty = inv.items.reduce((sum, line) => sum + Number(line.qty), 0);
  const amountWidth = 14;
  const labelWidth = Math.max(5, settings.columns - 1 - amountWidth);
  lines.push(`Items: ${inv.items.length}  Qty: ${totalQty}`);
  if (Number(inv.discountAmt) > 0) lines.push(row([{ text: 'Discount', width: labelWidth }, { text: `-${money(inv.discountAmt)}`, width: amountWidth, align: 'r' }]));
  lines.push(row([{ text: 'Taxable', width: labelWidth }, { text: money(inv.subtotal), width: amountWidth, align: 'r' }]));
  if (Number(inv.igst) > 0) {
    lines.push(row([{ text: 'IGST', width: labelWidth }, { text: money(inv.igst), width: amountWidth, align: 'r' }]));
  } else {
    lines.push(row([{ text: 'CGST', width: labelWidth }, { text: money(inv.cgst), width: amountWidth, align: 'r' }]));
    lines.push(row([{ text: 'SGST', width: labelWidth }, { text: money(inv.sgst), width: amountWidth, align: 'r' }]));
  }
  lines.push(divider(settings.columns));
  lines.push(row([{ text: 'TOTAL', width: labelWidth }, { text: `Rs.${money(inv.total)}`, width: amountWidth, align: 'r' }]));
  return lines;
}

function sectionPaidLine(inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  const payments = inv.payments ?? [];
  if (payments.length === 0) return [];
  const amountWidth = 14;
  const labelWidth = Math.max(5, settings.columns - 1 - amountWidth);
  const lines: string[] = [];
  for (const p of payments) {
    lines.push(row([{ text: `Paid ${p.mode}`, width: labelWidth }, { text: money(p.amount), width: amountWidth, align: 'r' }]));
    if (p.refNumber) lines.push(`  Ref: ${p.refNumber}`);
  }
  return lines;
}

function sectionAmountInWords(inv: PrintableInvoice): string[] {
  return [numberToWordsIndian(Number(inv.total))];
}

// GST-rate-wise breakup — grouped from the line items themselves, no extra
// backend field: each line's amount is already the tax-excluded taxable
// value (see lineChargedAmount's comment above).
function sectionGstBreakup(inv: PrintableInvoice): string[] {
  const lines: string[] = [];
  const byRate = new Map<string, number>();
  for (const line of inv.items) byRate.set(line.gstRate, (byRate.get(line.gstRate) ?? 0) + Number(line.amount));
  const interState = Number(inv.igst) > 0;
  lines.push(row([{ text: 'GST%', width: 5 }, { text: 'Taxable', width: 8, align: 'r' }, ...(interState ? [{ text: 'IGST', width: 7, align: 'r' as const }] : [{ text: 'CGST', width: 7, align: 'r' as const }, { text: 'SGST', width: 7, align: 'r' as const }])]));
  for (const [rate, taxable] of [...byRate.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const gstAmt = taxable * (Number(rate) / 100);
    lines.push(row([
      { text: `${rate}%`, width: 5 },
      { text: taxable.toFixed(2), width: 8, align: 'r' },
      ...(interState ? [{ text: gstAmt.toFixed(2), width: 7, align: 'r' as const }] : [{ text: (gstAmt / 2).toFixed(2), width: 7, align: 'r' as const }, { text: (gstAmt / 2).toFixed(2), width: 7, align: 'r' as const }]),
    ]));
  }
  return lines;
}

function sectionSavingsLine(inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  if (!settings.showSavingsLine || !(Number(inv.discountAmt) > 0)) return [];
  return [receiptCenter(`You saved Rs.${Math.round(Number(inv.discountAmt))} today!`, settings.columns)];
}

function sectionExchangePolicy(_inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  return settings.exchangePolicyText ? [settings.exchangePolicyText] : [];
}

function sectionCustomMessage(_inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  if (!settings.customMessageText) return [];
  // Multi-line by design (unlike exchangePolicy/footer's single line) — each
  // line the shop typed is its own centered receipt line.
  return settings.customMessageText.split('\n').filter(Boolean).map((line) => receiptCenter(line, settings.columns));
}

function sectionPaymentInfo(_inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  return settings.paymentInfoText ? [receiptCenter(settings.paymentInfoText, settings.columns)] : [];
}

// Round 14 — this used to always print a hardcoded "[ QR: UPI / feedback ]"
// regardless of what a shop configured, which is exactly the confusion that
// prompted this fix: it looked like a real, working feature but had no
// setting behind it at all. Real QR *image* generation still isn't supported
// by the raw-text print pipeline (printer-api.ts's normalizeRawPrinterCommands
// strips non-printable-ASCII bytes, so binary QR commands can't pass through
// safely) — so this now renders the shop's own Payment / UPI Details text
// (Settings → Billing & Receipts) framed as a "scan/pay" note instead of a
// fake placeholder. Prints nothing if that field is blank.
function sectionQrPlaceholder(_inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  if (!settings.paymentInfoText) return [];
  return ['', receiptCenter('[ Scan / Pay ]', settings.columns), receiptCenter(settings.paymentInfoText, settings.columns), ''];
}

function sectionFooter(_inv: PrintableInvoice, settings: ReceiptSettings): string[] {
  const lines: string[] = [];
  if (settings.footerText) lines.push(receiptCenter(settings.footerText, settings.columns));
  lines.push(receiptCenter('Powered by RaSetu ERP', settings.columns));
  return lines;
}

// Each section's `dividerAfter` reproduces exactly where the original
// single hardcoded sequence placed its dividers — reordering/toggling
// sections keeps that same "this block wants a divider after it" intent
// rather than re-deriving divider placement from scratch.
const SECTION_BUILDERS: Record<ReceiptSectionKey, { build: (inv: PrintableInvoice, settings: ReceiptSettings) => string[]; dividerAfter: boolean }> = {
  header: { build: sectionHeader, dividerAfter: false },
  cashierCustomer: { build: sectionCustomer, dividerAfter: true },
  items: { build: sectionItems, dividerAfter: true },
  totals: { build: sectionTotals, dividerAfter: false },
  paidLine: { build: sectionPaidLine, dividerAfter: false },
  amountInWords: { build: sectionAmountInWords, dividerAfter: true },
  gstBreakup: { build: sectionGstBreakup, dividerAfter: true },
  savingsLine: { build: sectionSavingsLine, dividerAfter: false },
  exchangePolicy: { build: sectionExchangePolicy, dividerAfter: false },
  customMessage: { build: sectionCustomMessage, dividerAfter: false },
  paymentInfo: { build: sectionPaymentInfo, dividerAfter: false },
  qrPlaceholder: { build: sectionQrPlaceholder, dividerAfter: false },
  cashier: { build: (inv) => sectionCashier(inv), dividerAfter: false },
  footer: { build: sectionFooter, dividerAfter: false },
};

/**
 * The mockup layout (thermal_receipt_80mm_cloth_store.html): shop header,
 * cashier/customer, HSN+GST per line, GST-rate-wise breakup table, amount in
 * words, savings line, exchange policy, QR placeholder, footer — rebuilt as
 * plain ESC/POS text (the print pipeline only accepts raw text, never
 * HTML/CSS), 32 columns to match this file's existing dividers. Round 7 —
 * sections are individually toggleable/reorderable via settings.sections;
 * 'items'/'totals' stay enabled regardless (LOCKED_RECEIPT_SECTIONS).
 */
function thermalReceipt(inv: PrintableInvoice, settings: ReceiptSettings): string {
  const base = settings.sections?.length ? settings.sections : DEFAULT_RECEIPT_SECTIONS;
  // Round 14 — a shop that already customized/saved their section list
  // before a new section key existed (e.g. 'cashier', split out of the old
  // combined 'cashierCustomer') would otherwise never see it: `configured`
  // only iterates what's actually stored. Backfill any key missing from the
  // saved list (appended at the end, enabled by default) so new sections
  // introduced in later rounds don't silently vanish for existing shops.
  const missing = (Object.keys(SECTION_BUILDERS) as ReceiptSectionKey[]).filter((k) => !base.some((s) => s.key === k));
  const configured = missing.length
    ? [...base, ...missing.map((key, i) => ({ key, enabled: true, order: base.length + i }))]
    : base;
  const enabledKeys = [...configured]
    .sort((a, b) => a.order - b.order)
    .filter((s) => s.enabled || LOCKED_RECEIPT_SECTIONS.includes(s.key))
    .map((s) => s.key);

  const lines: string[] = [];
  enabledKeys.forEach((key, idx) => {
    const def = SECTION_BUILDERS[key];
    lines.push(...def.build(inv, settings));
    if (def.dividerAfter && idx < enabledKeys.length - 1) lines.push(divider(settings.columns));
  });
  return lines.join('\n');
}

const THERMAL_BUILDERS: Record<ThermalLayout, (inv: PrintableInvoice, settings: ReceiptSettings) => string> = {
  compact: thermalCompact,
  standard: thermalStandard,
  detailed: thermalDetailed,
  receipt: thermalReceipt,
};

function receiptContentColumns(settings: ReceiptSettings): number {
  const left = Math.max(0, Math.floor(settings.marginLeftChars ?? 0));
  const right = Math.max(0, Math.floor(settings.marginRightChars ?? 0));
  return Math.max(20, settings.columns - left - right);
}

function wrapReceiptLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const wrapped: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < Math.floor(width * 0.55)) cut = width;
    wrapped.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  wrapped.push(rest);
  return wrapped;
}

function applyReceiptPaper(raw: string, settings: ReceiptSettings): string {
  const left = Math.max(0, Math.floor(settings.marginLeftChars ?? 0));
  const prefix = ' '.repeat(left);
  const width = receiptContentColumns(settings);
  const feedLines = Math.max(0, Math.min(5, Math.floor(settings.endFeedLines ?? 0)));
  const printed = raw
    .split('\n')
    .flatMap((line) => (line ? wrapReceiptLine(line, width) : ['']))
    .map((line) => (line ? prefix + line : ''))
    .join('\n');
  return feedLines ? `${printed}${'\n'.repeat(feedLines)}` : printed;
}

export function buildThermalReceipt(invoice: PrintableInvoice, layout: ThermalLayout, settings: ReceiptSettings = DEFAULT_RECEIPT_SETTINGS): string {
  const effectiveSettings = { ...settings, columns: receiptContentColumns(settings) };
  return applyReceiptPaper(THERMAL_BUILDERS[layout](invoice, effectiveSettings), settings);
}

function enabledReceiptSections(settings: ReceiptSettings): ReceiptSectionKey[] {
  const base = settings.sections?.length ? settings.sections : DEFAULT_RECEIPT_SECTIONS;
  const missing = (Object.keys(SECTION_BUILDERS) as ReceiptSectionKey[]).filter((k) => !base.some((s) => s.key === k));
  const configured = missing.length
    ? [...base, ...missing.map((key, i) => ({ key, enabled: true, order: base.length + i }))]
    : base;
  return [...configured]
    .sort((a, b) => a.order - b.order)
    .filter((s) => s.enabled || LOCKED_RECEIPT_SECTIONS.includes(s.key))
    .map((s) => s.key);
}

function headerTextForHtml(inv: PrintableInvoice, settings: ReceiptSettings): Record<ReceiptHeaderKey, { text: string; fontSize: number }> {
  const company = inv.company;
  return {
    logo: { text: '', fontSize: 0 },
    shopName: {
      text: receiptHeaderText(settings.shopNameText || company?.name || 'RaSetu Retail', settings.shopNameFontSize),
      fontSize: settings.shopNameFontSize,
    },
    localShopName: {
      text: receiptHeaderText(settings.localShopNameText, settings.localShopNameFontSize),
      fontSize: settings.localShopNameFontSize,
    },
    headerLine1: { text: receiptHeaderText(settings.headerLine1Text, settings.headerLine1FontSize), fontSize: settings.headerLine1FontSize },
    headerLine2: { text: receiptHeaderText(settings.headerLine2Text, settings.headerLine2FontSize), fontSize: settings.headerLine2FontSize },
    headerLine3: { text: receiptHeaderText(settings.headerLine3Text, settings.headerLine3FontSize), fontSize: settings.headerLine3FontSize },
  };
}

function buildReceiptHeaderHtml(inv: PrintableInvoice, settings: ReceiptSettings): string {
  const headerText = headerTextForHtml(inv, settings);
  const ordered = orderedReceiptHeaderKeys(settings);
  const parts: string[] = [];
  for (const key of ordered) {
    if (key === 'logo') {
      if (!settings.receiptLogoImage) continue;
      const logoWidth = Math.max(8, Math.min(72, settings.receiptLogoWidthMm || 18));
      parts.push(`<img class="receipt-logo" src="${escapeHtml(settings.receiptLogoImage)}" style="width:${logoWidth}mm" />`);
      continue;
    }
    const def = headerText[key];
    if (!def.text) continue;
    for (const line of def.text.split('\n').filter(Boolean)) {
      const size = Math.max(8, Math.min(32, def.fontSize || 10));
      parts.push(`<div class="receipt-header-line" style="font-size:${size}px">${escapeHtml(line)}</div>`);
    }
  }
  return parts.join('');
}

export function buildThermalReceiptHtml(invoice: PrintableInvoice, layout: ThermalLayout, settings: ReceiptSettings = DEFAULT_RECEIPT_SETTINGS): string {
  const { paperMm, contentMm, sideMarginMm, monoFontPx } = receiptHtmlMetrics(settings);
  const text = buildThermalReceipt(invoice, layout, settings);
  const blockSettings = { ...settings, endFeedLines: 0 };
  if (layout !== 'receipt') {
    return `<!doctype html><html><head><meta charset="utf-8" /><style>
      @page{size:${paperMm}mm auto;margin:0}
      body{margin:0;background:#fff;color:#000}
      pre{box-sizing:border-box;width:${contentMm}mm;margin:0 0 0 ${sideMarginMm}mm;padding:1mm 0 0;font:${monoFontPx}px/1.22 "Courier New",Consolas,monospace;white-space:pre-wrap}
      .cut{width:${contentMm}mm;margin:1mm 0 0 ${sideMarginMm}mm;border-top:1px dashed #000;text-align:center;font:9px/1.2 Arial,sans-serif}
    </style></head><body><pre>${escapeHtml(text)}</pre><div class="cut">CUT HERE</div></body></html>`;
  }

  const effectiveSettings = { ...settings, columns: receiptContentColumns(settings) };
  const htmlBlocks: string[] = [];
  for (const key of enabledReceiptSections(effectiveSettings)) {
    if (key === 'header') {
      const company = invoice.company;
      htmlBlocks.push(`<div class="header">${buildReceiptHeaderHtml(invoice, settings)}</div>`);
      const companyLines = [
        company?.address ? receiptCenter(company.address, effectiveSettings.columns) : '',
        company?.phone ? receiptCenter(`Ph: ${company.phone}`, effectiveSettings.columns) : '',
        company?.gstin ? receiptCenter(`GSTIN: ${company.gstin}`, effectiveSettings.columns) : '',
        divider(effectiveSettings.columns),
        receiptCenter('TAX INVOICE', effectiveSettings.columns),
        divider(effectiveSettings.columns),
        `Bill: ${invoice.number}`,
        new Date(invoice.date).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
      ].filter(Boolean);
      htmlBlocks.push(`<pre>${escapeHtml(applyReceiptPaper(companyLines.join('\n'), blockSettings))}</pre>`);
      continue;
    }
    const def = SECTION_BUILDERS[key];
    const lines = def.build(invoice, effectiveSettings);
    if (def.dividerAfter) lines.push(divider(effectiveSettings.columns));
    if (lines.length) htmlBlocks.push(`<pre>${escapeHtml(applyReceiptPaper(lines.join('\n'), blockSettings))}</pre>`);
  }
  const feedMm = Math.max(0, Math.min(5, Math.floor(settings.endFeedLines ?? 0))) * 2.8;
  return `<!doctype html><html><head><meta charset="utf-8" /><style>
    @page{size:${paperMm}mm auto;margin:0}
    *{box-sizing:border-box}
    body{margin:0;background:#fff;color:#000}
    .receipt{width:${contentMm}mm;margin:0 0 0 ${sideMarginMm}mm;padding:1mm 0 0;text-align:center;overflow:hidden}
    .header{font-family:"Nirmala UI","Noto Sans Kannada",Arial,sans-serif;line-height:1.18;text-align:center}
    .receipt-header-line{font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}
    .receipt-logo{display:block;height:auto;object-fit:contain;margin:0 auto .8mm;image-rendering:auto}
    pre{margin:0;text-align:left;font:${monoFontPx}px/1.22 "Courier New",Consolas,monospace;white-space:pre-wrap}
    .cut{margin-top:1mm;border-top:1px dashed #000;text-align:center;font:9px/1.2 Arial,sans-serif}
    .feed{height:${feedMm}mm}
  </style></head><body><div class="receipt">${htmlBlocks.join('')}<div class="cut">CUT HERE</div><div class="feed"></div></div></body></html>`;
}

function receiptHtmlMetrics(settings: ReceiptSettings): { paperMm: number; contentMm: number; sideMarginMm: number; monoFontPx: number } {
  const paperMm = (settings.columns ?? 32) >= 48 ? 80 : 58;
  const fallbackContentMm = paperMm === 80 ? 72 : 50;
  const fallbackSideMarginMm = paperMm === 80 ? 4 : 3;
  const fallbackFontPx = paperMm === 80 ? 9 : 9.5;
  const contentMm = Math.max(36, Math.min(paperMm, Number(settings.receiptPrintableWidthMm) || fallbackContentMm));
  const sideMarginMm = Math.max(0, Math.min(12, Number(settings.receiptLeftMarginMm) || fallbackSideMarginMm));
  const monoFontPx = Math.max(7, Math.min(12, Number(settings.receiptBodyFontPx) || fallbackFontPx));
  return { paperMm, contentMm, sideMarginMm, monoFontPx };
}

export function buildReceiptCalibrationHtml(settings: ReceiptSettings = DEFAULT_RECEIPT_SETTINGS): string {
  const { paperMm, contentMm, sideMarginMm, monoFontPx } = receiptHtmlMetrics(settings);
  const columns = receiptContentColumns(settings);
  const line = divider(columns);
  const amountWidth = 14;
  const labelWidth = Math.max(5, columns - 1 - amountWidth);
  const rows = [
    line,
    receiptCenter('RASETU RECEIPT TEST', columns),
    line,
    `Paper: ${paperMm === 80 ? '80mm / 3 inch' : '58mm / 2 inch'}`,
    `HTML width: ${contentMm}mm  Left: ${sideMarginMm}mm`,
    `Font: ${monoFontPx}px  Columns: ${columns}`,
    line,
    'Sample Item Saree M/Red',
    'HSN 6109 GST 12%',
    '  Qty 1 x 1,249.11 = 1,399.00',
    line,
    'Items: 1  Qty: 1',
    row([{ text: 'Taxable', width: labelWidth }, { text: '1,249.11', width: amountWidth, align: 'r' }]),
    row([{ text: 'CGST', width: labelWidth }, { text: '74.94', width: amountWidth, align: 'r' }]),
    row([{ text: 'SGST', width: labelWidth }, { text: '74.95', width: amountWidth, align: 'r' }]),
    line,
    row([{ text: 'TOTAL', width: labelWidth }, { text: 'Rs.1,399.00', width: amountWidth, align: 'r' }]),
    'Rupees One Thousand Three Hundred Ninety Nine Only',
    line,
    'GST%   Taxable     CGST     SGST',
    '12%    1249.11    74.95    74.95',
    line,
  ].join('\n');
  return `<!doctype html><html><head><meta charset="utf-8" /><style>
    @page{size:${paperMm}mm auto;margin:0}
    *{box-sizing:border-box}
    body{margin:0;background:#fff;color:#000}
    .receipt{width:${contentMm}mm;margin:0 0 0 ${sideMarginMm}mm;padding:1mm 0 0;overflow:hidden}
    pre{margin:0;text-align:left;font:${monoFontPx}px/1.22 "Courier New",Consolas,monospace;white-space:pre-wrap}
    .cut{margin-top:1mm;border-top:1px dashed #000;text-align:center;font:9px/1.2 Arial,sans-serif}
  </style></head><body><div class="receipt"><pre>${escapeHtml(rows)}</pre><div class="cut">CUT HERE</div></div></body></html>`;
}

/** Guards the Electron-only bridge (electron/preload.ts) the same way LabelsPage does. */
export async function printThermalReceipt(
  invoice: PrintableInvoice,
  layout: ThermalLayout,
  settings: ReceiptSettings = DEFAULT_RECEIPT_SETTINGS
): Promise<{ printed: boolean; message: string }> {
  const commands = buildThermalReceipt(invoice, layout, settings);
  const bridge = (window as unknown as {
    rasetu?: {
      printer: {
        getConfig?: () => Promise<{ receipt: { printerName: string } }>;
        printA4?: (html: string, printerName: string, silent: boolean) => Promise<{ success: boolean }>;
        printRaw: (p: string, c: string) => Promise<{ success: boolean; message: string }>;
      };
    };
  }).rasetu;
  if (!bridge) {
    return { printed: false, message: 'Printing is only available in the desktop app - this preview runs in a plain browser tab.' };
  }
  if (layout === 'receipt' && bridge.printer.getConfig && bridge.printer.printA4) {
    try {
      const config = await bridge.printer.getConfig();
      await bridge.printer.printA4(buildThermalReceiptHtml(invoice, layout, settings), config.receipt?.printerName ?? '', true);
      return { printed: true, message: 'Receipt sent to printer.' };
    } catch (err) {
      const result = await bridge.printer.printRaw('default', commands);
      return {
        printed: result.success,
        message: result.success ? 'Receipt sent with text fallback. Logo/local-language printing needs the Windows printer driver path.' : (err instanceof Error ? err.message : result.message),
      };
    }
  }
  const result = await bridge.printer.printRaw('default', commands);
  return { printed: result.success, message: result.message };
}

// ---------- A4/A5 GST invoice (browser Print, testable in the Chrome preview) ----------

export type A4Layout = 'a4' | 'a5';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Round 14 — full rewrite: the old version hardcoded "RaSetu Retail" as the
// seller on every invoice (never the actual shop's own name/address/GSTIN,
// even though inv.company already carries all of that from GET /invoices/:id)
// and had no tax-rate breakup, amount-in-words, payment/terms, or signature
// block — not a standard GST tax invoice layout. Now takes `settings` so it
// can show the same shop-configured payment/terms/footer text the thermal
// receipt already uses, keeping the two printouts in sync with each other
// and with the shop's own Settings.
export function buildA4Html(inv: PrintableInvoice, layout: A4Layout, settings?: ReceiptSettings): string {
  const isEstimate = inv.status === 'ESTIMATE';
  const company = inv.company;
  const interState = Number(inv.igst) > 0;

  const rows = inv.items
    .map(
      (line, i) => `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(displayName(line.item))}<div class="sku">${escapeHtml(line.item.sku)}</div></td>
        <td>${escapeHtml(line.item.hsn ?? '-')}</td>
        <td style="text-align:right">${Number(line.qty)}</td>
        <td style="text-align:right">${money(line.rate)}</td>
        <td style="text-align:right">${line.gstRate}%</td>
        <td style="text-align:right">${money(lineChargedAmount(line))}</td>
      </tr>`
    )
    .join('');

  // GST rate-wise breakup — same grouping sectionGstBreakup uses for the
  // thermal layout, rebuilt as an HTML table here.
  const byRate = new Map<string, number>();
  for (const line of inv.items) byRate.set(line.gstRate, (byRate.get(line.gstRate) ?? 0) + Number(line.amount));
  const gstRows = [...byRate.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([rate, taxable]) => {
      const gstAmt = taxable * (Number(rate) / 100);
      return interState
        ? `<tr><td>${rate}%</td><td style="text-align:right">${taxable.toFixed(2)}</td><td style="text-align:right">${gstAmt.toFixed(2)}</td></tr>`
        : `<tr><td>${rate}%</td><td style="text-align:right">${taxable.toFixed(2)}</td><td style="text-align:right">${(gstAmt / 2).toFixed(2)}</td><td style="text-align:right">${(gstAmt / 2).toFixed(2)}</td></tr>`;
    })
    .join('');

  const pageSize = layout === 'a4' ? '210mm 297mm' : '210mm 148mm';
  const shopName = settings?.shopNameText || company?.name || 'Shop name not set';
  const headerLines = [
    settings?.localShopNameText,
    settings?.headerLine1Text,
    settings?.headerLine2Text,
    settings?.headerLine3Text,
  ]
    .filter(Boolean)
    .flatMap((line) => String(line).split('\n').filter(Boolean));

  return `
    <html>
      <head>
        <title>${escapeHtml(inv.number)}</title>
        <style>
          @page { size: ${pageSize}; margin: 12mm; }
          * { box-sizing: border-box; }
          body { font-family: Segoe UI, system-ui, sans-serif; font-size: 12px; color: #0f172a; }
          .letterhead { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 10px; }
          .shop-name { font-size: 20px; font-weight: 700; margin: 0 0 3px; }
          .shop-meta { font-size: 11px; color: #475569; line-height: 1.5; }
          .doc-type { text-align: right; }
          .doc-type .label { font-size: 15px; font-weight: 700; letter-spacing: 0.05em; ${isEstimate ? 'color: #b45309;' : ''} }
          .doc-type .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
          .meta-row { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 11.5px; }
          .bill-to { border: 1px solid #cbd5e1; border-radius: 4px; padding: 8px 10px; margin-bottom: 12px; max-width: 60%; }
          .bill-to .heading { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; margin-bottom: 3px; }
          table { width: 100%; border-collapse: collapse; margin-top: 4px; }
          th, td { border: 1px solid #cbd5e1; padding: 6px 8px; font-size: 11px; }
          th { background: #f1f5f9; text-align: left; }
          td .sku { font-size: 9.5px; color: #64748b; font-family: monospace; }
          .lower { display: flex; justify-content: space-between; gap: 16px; margin-top: 12px; align-items: flex-start; }
          .gst-breakup table { margin-top: 4px; }
          .gst-breakup th, .gst-breakup td { font-size: 10.5px; padding: 4px 6px; }
          .totals { width: 260px; flex-shrink: 0; }
          .totals div { display: flex; justify-content: space-between; padding: 2px 0; }
          .grand { font-weight: 700; border-top: 1px solid #0f172a; margin-top: 4px; padding-top: 4px !important; }
          .payments { margin-top: 10px; }
          .payments .heading { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; margin-bottom: 3px; }
          .payments table { margin-top: 0; }
          .payments th, .payments td { font-size: 10.5px; padding: 4px 6px; }
          .amount-due { font-weight: 700; margin-top: 6px; }
          .words { font-size: 11px; margin-top: 6px; font-style: italic; color: #334155; }
          .notes { margin-top: 16px; font-size: 10.5px; color: #475569; white-space: pre-wrap; }
          .footer-row { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 36px; }
          .signature { text-align: center; font-size: 11px; }
          .signature .line { border-top: 1px solid #0f172a; padding-top: 4px; margin-top: 36px; }
          .thanks { font-size: 10.5px; color: #64748b; }
        </style>
      </head>
      <body>
        <div class="letterhead">
          <div>
            <p class="shop-name">${escapeHtml(shopName)}</p>
            <div class="shop-meta">
              ${headerLines.map((line) => `${escapeHtml(line)}<br/>`).join('')}
              ${company?.address ? `${escapeHtml(company.address)}<br/>` : ''}
              ${company?.phone ? `Ph: ${escapeHtml(company.phone)}` : ''}${company?.phone && company?.gstin ? ' &nbsp;|&nbsp; ' : ''}${company?.gstin ? `GSTIN: ${escapeHtml(company.gstin)}` : ''}
            </div>
          </div>
          <div class="doc-type">
            <div class="label">${isEstimate ? 'ESTIMATE' : 'TAX INVOICE'}</div>
            <div class="sub">${isEstimate ? 'Not a tax document - for reference only' : `${layout.toUpperCase()} copy`}</div>
          </div>
        </div>

        <div class="meta-row">
          <div><strong>Invoice #:</strong> ${escapeHtml(inv.number)} &nbsp;&nbsp; <strong>Date:</strong> ${new Date(inv.date).toLocaleDateString('en-IN')}</div>
          ${inv.dueDate ? `<div><strong>Due date:</strong> ${new Date(inv.dueDate).toLocaleDateString('en-IN')}</div>` : ''}
        </div>

        <div class="bill-to">
          <div class="heading">Bill to</div>
          <div><strong>${escapeHtml(inv.party?.name ?? 'Walk-in Customer')}</strong></div>
          ${inv.party?.address ? `<div>${escapeHtml(inv.party.address)}</div>` : ''}
          ${inv.party?.phone ? `<div>Ph: ${escapeHtml(inv.party.phone)}</div>` : ''}
          ${inv.party?.gstin ? `<div>GSTIN: ${escapeHtml(inv.party.gstin)}</div>` : ''}
        </div>

        <table>
          <thead><tr><th>#</th><th>Description</th><th>HSN</th><th>Qty</th><th>Rate</th><th>GST</th><th>Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>

        <div class="lower">
          <div class="gst-breakup">
            ${gstRows ? `
            <table>
              <thead><tr><th>GST%</th><th>Taxable</th>${interState ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>'}</tr></thead>
              <tbody>${gstRows}</tbody>
            </table>` : ''}
            <div class="words">In words: ${escapeHtml(numberToWordsIndian(Number(inv.total)))}</div>
          </div>
          <div class="totals">
            <div><span>Subtotal</span><span>${money(inv.subtotal)}</span></div>
            ${Number(inv.discountAmt) > 0 ? `<div><span>Discount</span><span>-${money(inv.discountAmt)}</span></div>` : ''}
            ${interState
              ? `<div><span>IGST</span><span>${money(inv.igst)}</span></div>`
              : `<div><span>CGST</span><span>${money(inv.cgst)}</span></div><div><span>SGST</span><span>${money(inv.sgst)}</span></div>`}
            ${Number(inv.roundOff) !== 0 ? `<div><span>Round off</span><span>${money(inv.roundOff)}</span></div>` : ''}
            <div class="grand"><span>Total</span><span>${money(inv.total)}</span></div>
          </div>
        </div>

        ${(inv.payments?.length ?? 0) > 0 ? `
        <div class="payments">
          <div class="heading">Payments</div>
          <table>
            <thead><tr><th>Mode</th><th>Ref No</th><th style="text-align:right">Amount</th></tr></thead>
            <tbody>
              ${inv.payments!.map((p) => `<tr><td>${escapeHtml(p.mode)}</td><td>${p.refNumber ? escapeHtml(p.refNumber) : '-'}</td><td style="text-align:right">${money(p.amount)}</td></tr>`).join('')}
            </tbody>
          </table>
          ${(() => {
            const paid = inv.payments!.reduce((s, p) => s + Number(p.amount), 0);
            const due = Number(inv.newBalance ?? inv.total) - paid;
            return due > 0.01 ? `<div class="amount-due">Amount Due: ${money(due)}</div>` : '';
          })()}
        </div>` : ''}

        ${settings?.paymentInfoText || settings?.exchangePolicyText ? `
        <div class="notes">
          ${settings.paymentInfoText ? `<div>${escapeHtml(settings.paymentInfoText)}</div>` : ''}
          ${settings.exchangePolicyText ? `<div>${escapeHtml(settings.exchangePolicyText)}</div>` : ''}
        </div>` : ''}

        <div class="footer-row">
          <div class="thanks">${escapeHtml(settings?.footerText || 'Thank you for your business!')}</div>
          <div class="signature">
            <div>For ${escapeHtml(shopName)}</div>
            <div class="line">Authorized Signatory</div>
          </div>
        </div>
      </body>
    </html>
  `;
}

/**
 * Round 23 — if an Invoice Printer (A4/A5) is configured in Printer
 * Settings, route through Electron's native print (no OS dialog when
 * "silent" is on). Otherwise falls back to exactly the original
 * window.open()+print() behavior — unchanged for the browser preview, for
 * zero-configuration shops, and if the configured printer name fails.
 */
export async function printA4Invoice(invoice: PrintableInvoice, layout: A4Layout, settings?: ReceiptSettings): Promise<void> {
  const html = buildA4Html(invoice, layout, settings);
  const bridge = (
    window as unknown as {
      rasetu?: {
        printer: {
          getConfig: () => Promise<{ invoice: { printerName: string; silent: boolean } }>;
          printA4: (html: string, printerName: string, silent: boolean) => Promise<{ success: boolean }>;
        };
      };
    }
  ).rasetu;

  if (bridge) {
    try {
      const config = await bridge.printer.getConfig();
      const printerName = config.invoice?.printerName;
      if (printerName) {
        await bridge.printer.printA4(html, printerName, config.invoice.silent ?? true);
        return;
      }
    } catch {
      // Fall through to the browser-dialog path below.
    }
  }

  const win = window.open('', '_blank', 'width=800,height=1000');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}
