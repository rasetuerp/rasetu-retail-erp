import { getClothProfile } from './vertical-profile.js';

// GST Billing engine (docs/SCOPE.md #5, docs/SPRINT_PLAN.md Step 7). Pure
// functions so they're hand-verifiable and unit-testable without a DB.

/**
 * Cloth MRP-slab auto-rate (docs/ARCHITECTURE.md, config/profiles/profile-cloth.json
 * gst.mrpSlabRule): GST rate is a statutory function of the garment's declared
 * MRP, not the actual billed/discounted rate — so this is always derived from
 * Item.mrp server-side, never trusted from the client.
 */
export function clothSlabGstRate(mrp: number): number {
  const { thresholdMrp, rateBelowOrEqual, rateAbove } = getClothProfile().gst.mrpSlabRule;
  return mrp <= thresholdMrp ? rateBelowOrEqual : rateAbove;
}

/** First 2 digits of a GSTIN are the state code (docs/GST-SPEC.md). */
export function gstinStateCode(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  return gstin.slice(0, 2);
}

export type CalcLineInput = {
  itemId: string;
  qty: number;
  rate: number;
  mrp: number; // Item.mrp, used only to derive the slab GST rate
  gstInclusive: boolean;
  discountPct: number; // per-line discount, applied before tax split
  // Round 5 — ADMIN/SUPER_ADMIN safety-valve override of the auto slab rate
  // (e.g. a genuine slab/price revision the vertical profile hasn't caught up
  // with yet). The caller (invoices.ts's runCalc) re-checks the requester's
  // role server-side before ever setting this — never trust it blindly here.
  gstRateOverride?: number;
  gstOverrideReason?: string;
};

export type CalcLineResult = CalcLineInput & {
  gstRate: number;
  taxableValue: number;
  gstAmount: number;
  lineTotal: number; // taxableValue + gstAmount (post per-line discount)
};

export type InvoiceCalcInput = {
  lines: CalcLineInput[];
  discountPct: number; // overall bill-level discount
  discountAmt: number; // overall bill-level flat discount
  sameState: boolean; // company state === party state → CGST+SGST; else IGST
  /** Reverse adjustment: type the final amount, back-solve the bill-level discount. */
  reverseAdjustTotal?: number;
};

export type InvoiceCalcResult = {
  lines: CalcLineResult[];
  subtotal: number; // sum of taxable values, pre-discount
  discountAmt: number; // resolved bill-level discount actually applied
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeInvoiceTotals(input: InvoiceCalcInput): InvoiceCalcResult {
  const lines: CalcLineResult[] = input.lines.map((line) => {
    const gstRate = line.gstRateOverride !== undefined ? line.gstRateOverride : clothSlabGstRate(line.mrp);
    const gross = line.qty * line.rate * (1 - line.discountPct / 100);

    let taxableValue: number;
    let gstAmount: number;
    if (line.gstInclusive) {
      taxableValue = gross / (1 + gstRate / 100);
      gstAmount = gross - taxableValue;
    } else {
      taxableValue = gross;
      gstAmount = gross * (gstRate / 100);
    }

    return {
      ...line,
      gstRate,
      taxableValue: round2(taxableValue),
      gstAmount: round2(gstAmount),
      lineTotal: round2(taxableValue + gstAmount),
    };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.taxableValue, 0));
  const totalGst = round2(lines.reduce((s, l) => s + l.gstAmount, 0));
  const grossTotal = subtotal + totalGst;

  const discountAmt =
    input.reverseAdjustTotal !== undefined
      ? Math.max(0, round2(grossTotal - input.reverseAdjustTotal))
      : round2(input.discountAmt + grossTotal * (input.discountPct / 100));

  const afterDiscount = grossTotal - discountAmt;
  const total = Math.round(afterDiscount);
  const roundOff = round2(total - afterDiscount);

  const cgst = input.sameState ? round2(totalGst / 2) : 0;
  const sgst = input.sameState ? round2(totalGst - cgst) : 0;
  const igst = input.sameState ? 0 : totalGst;

  return { lines, subtotal, discountAmt, cgst, sgst, igst, roundOff, total };
}
