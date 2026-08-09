// Live cart preview — infrastructure, same exemption as api.ts/exportUtils.ts.
// Mirrors backend/src/lib/gst-calc.ts's computeInvoiceTotals exactly (same
// round2 + rounding order) so the number the cashier sees in the cart matches
// what /invoices returns on save, closing the flat-sum gap left by Round 1
// Step 7. The CGST/SGST vs IGST split shown here is a same-state assumption
// for display only — the total itself doesn't depend on that split, and the
// server (which knows the company's and party's real GSTIN state) computes
// the authoritative split on save/post.

export type SlabRule = { thresholdMrp: number; rateBelowOrEqual: number; rateAbove: number };

export function clothSlabGstRate(mrp: number, rule: SlabRule): number {
  return mrp <= rule.thresholdMrp ? rule.rateBelowOrEqual : rule.rateAbove;
}

// Round 5 — discountPct and gstRateOverride mirror backend/src/lib/gst-calc.ts
// exactly, so the live cart total matches what /invoices actually posts once
// per-line discount and the ADMIN GST% override are in play.
export type PreviewLine = { itemId: string; qty: number; rate: number; mrp: number; gstInclusive: boolean; discountPct?: number; gstRateOverride?: number };
export type PreviewResult = { subtotal: number; cgst: number; sgst: number; igst: number; total: number };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Round 6 — bill-level discount mirrors gst-calc.ts's computeInvoiceTotals
// exactly (applied to grossTotal = subtotal + totalGst, before rounding),
// so the live cart total matches what actually posts once a whole-invoice
// discount is in play, not just a per-line one.
export function previewInvoiceTotals(lines: PreviewLine[], rule: SlabRule, billDiscountPct = 0, billDiscountAmt = 0): PreviewResult {
  let subtotal = 0;
  let totalGst = 0;

  for (const line of lines) {
    const gstRate = line.gstRateOverride !== undefined ? line.gstRateOverride : clothSlabGstRate(line.mrp, rule);
    const gross = line.qty * line.rate * (1 - (line.discountPct ?? 0) / 100);
    let taxableValue: number;
    let gstAmount: number;
    if (line.gstInclusive) {
      taxableValue = gross / (1 + gstRate / 100);
      gstAmount = gross - taxableValue;
    } else {
      taxableValue = gross;
      gstAmount = gross * (gstRate / 100);
    }
    subtotal += round2(taxableValue);
    totalGst += round2(gstAmount);
  }

  subtotal = round2(subtotal);
  totalGst = round2(totalGst);
  const grossTotal = subtotal + totalGst;
  const discountAmt = round2(billDiscountAmt + grossTotal * (billDiscountPct / 100));
  const afterDiscount = grossTotal - discountAmt;
  const total = Math.round(afterDiscount);

  return {
    subtotal,
    cgst: round2(totalGst / 2),
    sgst: round2(totalGst - round2(totalGst / 2)),
    igst: 0,
    total,
  };
}
