# GST-SPEC.md — GST Report Pack (the one-click CA bundle)

One button: **"Generate GST Returns Pack — [Month]"**. Output: one Excel workbook
(+ optional PDF summary) with sheets matching GSTR-1 structure so the CA can file
directly, built on the shared `exportUtils.ts` (see [RULES.md](RULES.md) #8).

## Sheets

1. **B2B** — invoice-wise sales to GST-registered buyers (GSTIN, invoice no/date, taxable value, rate-wise tax)
2. **B2C (Small)** — rate-wise consolidated intra-state retail sales (this is ~95% of a cloth shop's sales)
3. **B2C (Large)** — inter-state invoices above threshold
4. **CDNR/CDNUR** — credit/debit notes
5. **HSN Summary** — HSN-wise qty, taxable value, tax (mandatory; every item's HSN feeds this — see `Item.hsn` in [SCHEMA.md](SCHEMA.md))
6. **Documents Issued** — invoice number series, cancelled count (this is why the schema forbids invoice deletion — see [SCHEMA.md](SCHEMA.md) lifecycle table)
7. **Purchase Register** — for GSTR-2B/3B reconciliation by the CA
8. **GSTR-3B summary sheet** — outward taxable value + tax totals

## Validation rule

Verify GSTIN format on entry (15-char pattern + state code) at the point of party
creation — this alone prevents ~90% of CA rework later.

## Build order

This report pack is built on Day 8 (see [SPRINT_PLAN.md](SPRINT_PLAN.md)), after Purchase
Entry (Day 7) and once Invoice/Item data has real GST fields populated. It depends
directly on: `Item.hsn`, `Item.gstRate`, `Invoice.cgst/sgst/igst`, `Party.gstin`,
`Invoice.status` (for cancelled-count), and `Purchase` records.
