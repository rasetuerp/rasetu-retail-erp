import { useEffect, useState } from 'react';
import { theme } from '../lib/theme';
import { apiRequest, ApiError } from '../lib/api';

const { color } = theme;

// Round 15 — replaces the old "one payment-mode tile selected at a time +
// repeat-click Add Payment" pattern (previously duplicated near-identically
// in BillingPage.tsx and InvoicesPage.tsx) with a single composable row list:
// cash 4500 + card 1000 + upi 15000 in one clear action instead of three
// separate clicks with no running total.
//
// No backend change needed: POST /payments already creates one row per call
// with no uniqueness constraint on invoiceId, so looping it here for each
// non-zero row is exactly as valid as the old repeat-click flow was.
//
// Round 16 — a live test surfaced a real bug: nothing stopped the entered
// total from exceeding what's actually due, and a successful submit reset
// silently with no confirmation, so "did that work?" naturally led to
// clicking again and creating extra Payment rows. Fixed by (a) disabling
// the button once entered exceeds due, (b) showing a self-fetched list of
// payments already recorded against this invoice right here, and (c) a
// short success line after each submit.
//
// Round 18 — an earlier round wrongly treated the CREDIT payment mode as
// "left on account, not collected" (it actually means paid by credit card,
// same as CASH/UPI/CARD/CHEQUE). All modes now count fully toward what's
// paid; the due-date field is keyed on "is anything still due" rather than
// on picking a specific mode, and payments can carry an optional reference
// number (UPI txn id, cheque no, card auth code).
export type PaymentModeEntry = { name: string; isActive: boolean };
type Row = { id: string; mode: string; amount: string; refNumber: string };
type RecordedPayment = { id: string; mode: string; amount: string; date: string; refNumber?: string | null };

function defaultDueDateStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 15);
  return d.toISOString().slice(0, 10);
}

export function PaymentSplitPanel({
  companyId,
  token,
  invoiceId,
  partyId,
  billTotal,
  alreadyPaid,
  paymentModes,
  onRecorded,
}: {
  companyId: string;
  token: string;
  invoiceId: string;
  partyId?: string | null;
  billTotal: number;
  alreadyPaid: number;
  paymentModes: PaymentModeEntry[];
  onRecorded: (paidAmount: number) => void | Promise<void>;
}) {
  const remainingDue = Math.max(0, billTotal - alreadyPaid);
  const firstMode = paymentModes[0]?.name ?? 'CASH';
  function blankRow(): Row {
    return { id: `r${Date.now()}${Math.random()}`, mode: firstMode, amount: '', refNumber: '' };
  }
  // Controlled inputs here (not this codebase's usual defaultValue+onBlur
  // convention for number fields) are a deliberate exception — a live
  // Entered/Remaining running total as the cashier types is the whole point
  // of this component, and that's only possible with controlled state.
  const [rows, setRows] = useState<Row[]>([{ id: 'r1', mode: firstMode, amount: remainingDue > 0 ? String(remainingDue) : '', refNumber: '' }]);
  const [dueDate, setDueDate] = useState(defaultDueDateStr());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<RecordedPayment[] | null>(null);

  const enteredTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const remaining = remainingDue - enteredTotal;
  // Small epsilon for Decimal/GST rounding (e.g. 190.476190...) — real
  // overpayment is anything meaningfully past a rounding error.
  const overLimit = remaining < -0.01;

  async function loadRecorded() {
    try {
      const res = await apiRequest<{ payments: RecordedPayment[] }>(`/companies/${companyId}/payments?invoiceId=${invoiceId}`, { token });
      setRecorded(res.payments);
    } catch {
      // Non-fatal — the recorded-payments list is a convenience view, not
      // load-bearing for the record-payment action itself.
    }
  }

  useEffect(() => {
    void loadRecorded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, invoiceId]);

  function updateRow(id: string, patch: Partial<Row>) {
    setSuccessMsg(null);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, blankRow()]);
  }

  function removeRow(id: string) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));
  }

  function clearRows() {
    setSuccessMsg(null);
    setRows([blankRow()]);
  }

  async function handleSubmit() {
    setError(null);
    setSuccessMsg(null);
    const toRecord = rows.filter((r) => Number(r.amount) > 0);
    if (toRecord.length === 0) return;
    setSubmitting(true);
    let paidSoFar = 0;
    const succeededIds = new Set<string>();
    try {
      for (const row of toRecord) {
        await apiRequest(`/companies/${companyId}/payments`, {
          method: 'POST',
          token,
          body: { mode: row.mode, amount: Number(row.amount), invoiceId, partyId: partyId ?? undefined, refNumber: row.refNumber.trim() || undefined },
        });
        succeededIds.add(row.id);
        paidSoFar += Number(row.amount);
      }
      // Round 19 — a due date set while part of the bill was still owed
      // used to linger on the invoice (and on the printed A4 copy) forever,
      // even after later payments cleared the balance entirely. Keep/update
      // it while something's still owed; clear it once fully paid.
      await apiRequest(`/companies/${companyId}/invoices/${invoiceId}/due-date`, {
        method: 'PATCH',
        token,
        body: { dueDate: remaining > 0 ? dueDate : null },
      });
      const totalRecorded = toRecord.reduce((s, r) => s + Number(r.amount), 0);
      setRows([blankRow()]);
      setSuccessMsg(`₹${totalRecorded.toLocaleString('en-IN')} recorded.`);
      await loadRecorded();
      await onRecorded(paidSoFar);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record payment');
      // A row further down the list may have failed after earlier rows
      // already committed server-side — drop only the rows that actually
      // succeeded so a retry doesn't resubmit (and duplicate) them, and let
      // the parent/list reflect exactly what was committed, not attempted.
      if (succeededIds.size > 0) {
        setRows((prev) => {
          const left = prev.filter((r) => !succeededIds.has(r.id));
          return left.length > 0 ? left : [blankRow()];
        });
        await loadRecorded();
        await onRecorded(paidSoFar);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 14, boxShadow: theme.shadowSm, marginBottom: 12 }}>
        <div style={{ fontFamily: theme.mono, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 10 }}>
          Payments recorded on this bill
        </div>
        {recorded === null ? (
          <div style={{ fontSize: 12.5, color: color.inkFaint }}>Loading…</div>
        ) : recorded.length === 0 ? (
          <div style={{ fontSize: 12.5, color: color.inkFaint }}>None yet.</div>
        ) : (
          recorded.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '6px 0', borderTop: `1px solid ${color.lineSoft}` }}>
              <span style={{ color: color.inkSoft }}>
                {p.mode}
                {p.refNumber && <span style={{ color: color.inkFaint }}> · Ref: {p.refNumber}</span>}
              </span>
              <span style={{ fontFamily: theme.mono, fontVariantNumeric: 'tabular-nums' }}>
                ₹{Number(p.amount).toLocaleString('en-IN')}
              </span>
              <span style={{ fontFamily: theme.mono, fontVariantNumeric: 'tabular-nums', color: color.inkFaint }}>
                {new Date(p.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
              </span>
            </div>
          ))
        )}
      </div>

      {remainingDue > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: color.inkSoft, marginBottom: 10 }}>
          <span>Due: <strong style={{ fontFamily: theme.mono }}>₹{remainingDue.toLocaleString('en-IN')}</strong></span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Due date
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={{ padding: 5, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontFamily: theme.mono, fontSize: 12 }} />
          </label>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {rows.map((row) => (
          <div key={row.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={row.mode}
              onChange={(e) => updateRow(row.id, { mode: e.target.value })}
              style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 12.5, width: 100 }}
            >
              {paymentModes.map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
            <input
              type="number"
              value={row.amount}
              onChange={(e) => updateRow(row.id, { amount: e.target.value })}
              placeholder="0"
              style={{ width: 100, padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontFamily: theme.mono, fontSize: 12.5 }}
            />
            <input
              type="text"
              value={row.refNumber}
              onChange={(e) => updateRow(row.id, { refNumber: e.target.value })}
              placeholder="Ref no (optional)"
              style={{ width: 130, padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 12.5 }}
            />
            <button
              onClick={() => removeRow(row.id)}
              disabled={rows.length === 1}
              style={{ border: 'none', background: 'transparent', color: rows.length === 1 ? color.inkFaint : color.alert, cursor: rows.length === 1 ? 'default' : 'pointer', fontSize: 12 }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <button
          onClick={addRow}
          style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${color.brass}`, borderRadius: theme.radiusSm, color: color.brass, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}
        >
          + Add Payment Method
        </button>
        <button onClick={clearRows} style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, color: color.inkSoft, cursor: 'pointer', fontSize: 12.5 }}>
          Clear
        </button>
      </div>

      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: color.inkSoft, marginBottom: 10 }}>
        <span>Entered: <strong style={{ fontFamily: theme.mono }}>₹{enteredTotal.toLocaleString('en-IN')}</strong></span>
        {remaining !== 0 && (
          <span style={{ color: remaining > 0 ? color.amber : color.alert }}>
            {remaining > 0 ? 'Remaining' : 'Over by'}: <strong style={{ fontFamily: theme.mono }}>₹{Math.abs(remaining).toLocaleString('en-IN')}</strong>
          </span>
        )}
      </div>

      {overLimit && <div style={{ color: color.alert, fontSize: 12, marginBottom: 8 }}>Entered amount is more than what's due — reduce it before recording.</div>}
      {error && <div style={{ color: color.alert, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {successMsg && <div style={{ color: color.money, fontSize: 12, marginBottom: 8 }}>{successMsg}</div>}

      <button
        onClick={() => void handleSubmit()}
        disabled={submitting || enteredTotal <= 0 || overLimit}
        style={{ padding: '8px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
      >
        {submitting ? 'Recording…' : 'Record Payment(s)'}
      </button>
    </div>
  );
}
