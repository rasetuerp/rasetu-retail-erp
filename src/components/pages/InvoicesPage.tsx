import { useEffect, useRef, useState } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { printThermalReceipt, printA4Invoice, type PrintableInvoice, type ThermalLayout, type A4Layout, type ReceiptSettings, DEFAULT_RECEIPT_SECTIONS } from '../../lib/invoicePrint';
import { theme, statusColor } from '../../lib/theme';
import { PaymentSplitPanel } from '../PaymentSplitPanel';

// RULES.md #2: types declared inline. Round 5 follow-up — a place to see
// every saved invoice, open one back up to review, and reprint it. Held
// bills deliberately never appear here — they're working scratch state,
// only ever visible in Billing's own tab strip (reopen/remove/post from
// there); DRAFT is kept in the type only for any pre-existing legacy rows.
type InvoiceStatus = 'DRAFT' | 'HELD' | 'ESTIMATE' | 'POSTED' | 'CANCELLED';
type InvoiceSummary = {
  id: string;
  number: string;
  date: string;
  status: InvoiceStatus;
  total: string;
  dueDate: string | null;
  updatedAt: string;
  party: { name: string } | null;
};
type PaymentModeEntry = { name: string; isActive: boolean };

const { color } = theme;
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
  headerOrder: ['logo', 'shopName', 'localShopName', 'headerLine1', 'headerLine2', 'headerLine3'],
  exchangePolicyText: '',
  footerText: '',
  customMessageText: '',
  paymentInfoText: '',
  showSavingsLine: true,
  sections: DEFAULT_RECEIPT_SECTIONS,
  columns: 32,
  marginLeftChars: 0,
  marginRightChars: 0,
  endFeedLines: 0,
  receiptPrintableWidthMm: 0,
  receiptLeftMarginMm: 0,
  receiptBodyFontPx: 0,
};
const STATUS_TABS: Array<{ value: InvoiceStatus | 'ALL'; label: string }> = [
  { value: 'POSTED', label: 'Posted' },
  { value: 'ALL', label: 'All' },
  { value: 'ESTIMATE', label: 'Estimates' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function InvoicesPage({ onStartExchange, onEditInvoice }: { onStartExchange: (partyId: string) => void; onEditInvoice: (invoiceId: string) => void }) {
  const { session } = useSession();
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'ALL'>('POSTED');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedInvoice, setSelectedInvoice] = useState<PrintableInvoice | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [thermalLayout, setThermalLayout] = useState<ThermalLayout>('receipt');
  const [a4Layout, setA4Layout] = useState<A4Layout>('a4');
  const [printStatus, setPrintStatus] = useState<string | null>(null);
  const [receiptSettings, setReceiptSettings] = useState<ReceiptSettings>(DEFAULT_RECEIPT_SETTINGS);

  // Round 23 — seed the layout dropdowns from Printer Settings' saved
  // defaults instead of the hardcoded 'receipt'/'a4' literals; the per-bill
  // dropdown override below is unchanged, this only changes what it starts on.
  useEffect(() => {
    if (!window.rasetu) return;
    void window.rasetu.printer.getConfig().then((config) => {
      setThermalLayout(config.receipt.defaultLayout);
      setA4Layout(config.invoice.defaultLayout);
    });
  }, []);

  // Round 6 — recording a payment against an already-posted invoice, and
  // nudging its due date, from here rather than only in Billing's own
  // ephemeral post-bill session (per the user's own choice of where this
  // should live).
  const [paymentModes, setPaymentModes] = useState<PaymentModeEntry[]>([]);

  // Round 10 — Sales Return. Per-line return quantity (keyed by itemId, capped
  // at what was actually sold on this line) rather than a single lump amount
  // — this is what lets the resulting CreditNote actually reverse stock.
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const returnReasonRef = useRef<HTMLInputElement>(null);
  const [returnStatus, setReturnStatus] = useState<string | null>(null);
  // Round 15 — lets the shop record that some/all of a just-submitted return
  // was actually handed back as cash, instead of only ever becoming store
  // credit. Tracks the note just created so the refund form knows how much
  // is still refundable (amount - refundedAmount) and against which note.
  const [lastCreditNote, setLastCreditNote] = useState<{ id: string; amount: number; refundedAmount: number } | null>(null);
  const [refundMode, setRefundMode] = useState('CASH');
  const refundAmountRef = useRef<HTMLInputElement>(null);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [submittingRefund, setSubmittingRefund] = useState(false);
  const [submittingReturn, setSubmittingReturn] = useState(false);

  async function loadInvoices() {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const query = statusFilter === 'ALL' ? '' : `?status=${statusFilter}`;
      const res = await apiRequest<{ invoices: InvoiceSummary[] }>(`/companies/${session.companyId}/invoices${query}`, { token: session.token });
      // "All" fetches without a status filter, which would also surface any
      // working Held/Draft bills — those belong only in Billing's tab strip.
      setInvoices(statusFilter === 'ALL' ? res.invoices.filter((inv) => inv.status !== 'HELD' && inv.status !== 'DRAFT') : res.invoices);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadInvoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId, statusFilter]);

  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const [modesRes, settingsRes] = await Promise.all([
          apiRequest<{ modes: PaymentModeEntry[] }>(`/companies/${session.companyId}/payments/modes`, { token: session.token }),
          apiRequest<{ settings: ReceiptSettings }>(`/companies/${session.companyId}/invoices/receipt-settings`, { token: session.token }),
        ]);
        const activeModes = modesRes.modes.filter((m) => m.isActive);
        setPaymentModes(activeModes);
        setReceiptSettings(settingsRes.settings);
      } catch {
        // Non-fatal — payment recording/print footer just fall back to defaults.
      }
    })();
  }, [session?.companyId]);

  async function viewInvoice(id: string) {
    if (!session) return;
    setError(null);
    setPrintStatus(null);
    try {
      const res = await apiRequest<{ invoice: PrintableInvoice }>(`/companies/${session.companyId}/invoices/${id}`, { token: session.token });
      setSelectedInvoice(res.invoice);
      setSelectedInvoiceId(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load invoice');
    }
  }

  function amountDue(invoice: PrintableInvoice): number {
    const collected = (invoice.payments ?? []).reduce((s, p) => s + Number(p.amount), 0);
    return Math.max(0, Number(invoice.newBalance ?? 0) - collected);
  }


  async function submitReturn() {
    if (!session || !selectedInvoiceId || !selectedInvoice) return;
    const reason = returnReasonRef.current?.value.trim();
    if (!reason) {
      setError('Enter a reason for the return');
      return;
    }
    const items = selectedInvoice.items
      .map((line) => ({ itemId: line.itemId, qty: Number(returnQtys[line.itemId] || 0), rate: Number(line.rate) }))
      .filter((line) => line.qty > 0);
    if (items.length === 0) {
      setError('Enter a quantity for at least one item to return');
      return;
    }
    setError(null);
    setSubmittingReturn(true);
    try {
      const res = await apiRequest<{ creditNote: { id: string; amount: string; refundedAmount: string } }>(`/companies/${session.companyId}/credit-notes`, {
        method: 'POST',
        token: session.token,
        body: { invoiceId: selectedInvoiceId, reason, items },
      });
      setReturnStatus(selectedInvoice.partyId ? 'Return recorded - stock and the customer balance have been updated.' : 'Return recorded - stock has been updated.');
      setLastCreditNote({ id: res.creditNote.id, amount: Number(res.creditNote.amount), refundedAmount: Number(res.creditNote.refundedAmount) });
      setRefundError(null);
      setShowReturnForm(false);
      setReturnQtys({});
      if (returnReasonRef.current) returnReasonRef.current.value = '';
      await viewInvoice(selectedInvoiceId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record return');
    } finally {
      setSubmittingReturn(false);
    }
  }

  // Round 15 — settles some/all of the just-created return in cash instead
  // of leaving it as store credit; see credit-notes.ts's POST /:id/refund
  // for why this needs its own endpoint rather than reusing POST /payments.
  async function submitRefund() {
    if (!session || !lastCreditNote) return;
    const amount = Number(refundAmountRef.current?.value ?? 0);
    const remaining = lastCreditNote.amount - lastCreditNote.refundedAmount;
    if (amount <= 0 || amount > remaining) {
      setRefundError(`Enter an amount between ₹0.01 and ₹${remaining.toFixed(2)}.`);
      return;
    }
    setRefundError(null);
    setSubmittingRefund(true);
    try {
      const res = await apiRequest<{ creditNote: { id: string; amount: string; refundedAmount: string } }>(
        `/companies/${session.companyId}/credit-notes/${lastCreditNote.id}/refund`,
        { method: 'POST', token: session.token, body: { amount, mode: refundMode } }
      );
      setLastCreditNote({ id: res.creditNote.id, amount: Number(res.creditNote.amount), refundedAmount: Number(res.creditNote.refundedAmount) });
      if (refundAmountRef.current) refundAmountRef.current.value = '';
      if (selectedInvoiceId) await viewInvoice(selectedInvoiceId);
    } catch (err) {
      setRefundError(err instanceof ApiError ? err.message : 'Failed to record refund');
    } finally {
      setSubmittingRefund(false);
    }
  }

  async function printReceipt() {
    if (!selectedInvoice) return;
    const result = await printThermalReceipt(selectedInvoice, thermalLayout, receiptSettings);
    setPrintStatus(result.message);
  }

  function printInvoice() {
    if (!selectedInvoice) return;
    void printA4Invoice(selectedInvoice, a4Layout, receiptSettings);
  }

  // Reuses the same /post endpoint Billing's postBill() calls for Draft/Held
  // — it already handles "assign a real sequential number, deduct stock,
  // update the party's ledger" for any non-POSTED status.
  async function convertToInvoice(id: string) {
    if (!session) return;
    setError(null);
    try {
      await apiRequest(`/companies/${session.companyId}/invoices/${id}/post`, { method: 'POST', token: session.token });
      await viewInvoice(id);
      await loadInvoices();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to convert estimate to invoice');
    }
  }

  async function deleteInvoice(id: string, number: string, safeLast = false) {
    if (!session) return;
    const ok = window.confirm(`Delete ${number}?\n\nThe app will block this if it is not safe.`);
    if (!ok) return;
    setError(null);
    try {
      await apiRequest(`/companies/${session.companyId}/invoices/${safeLast ? 'last/safe' : id}`, {
        method: 'DELETE',
        token: session.token,
        body: safeLast ? { confirmation: 'DELETE LAST INVOICE' } : undefined,
      });
      setSelectedInvoice(null);
      setSelectedInvoiceId(null);
      await loadInvoices();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'This invoice is not safe to delete');
    }
  }

  const filtered = search.trim()
    ? invoices.filter((inv) => inv.number.toLowerCase().includes(search.toLowerCase()) || inv.party?.name.toLowerCase().includes(search.toLowerCase()))
    : invoices;

  if (selectedInvoice) {
    return (
      <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
        <button onClick={() => { setSelectedInvoice(null); setSelectedInvoiceId(null); }} style={{ ...linkBtn, marginBottom: 12 }}>← Back to list</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 24, margin: 0, color: color.ink }}>{selectedInvoice.number}</h1>
          {selectedInvoice.status && (
            <span style={{ fontFamily: theme.mono, fontSize: 10, padding: '2px 8px', borderRadius: 20, background: statusColor(selectedInvoice.status).bg, color: statusColor(selectedInvoice.status).fg }}>{selectedInvoice.status}</span>
          )}
        </div>
        <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 16 }}>
          {new Date(selectedInvoice.date).toLocaleDateString('en-IN')} · {selectedInvoice.party?.name ?? 'Walk-in customer'}
          {selectedInvoice.party?.gstin ? ` · GSTIN ${selectedInvoice.party.gstin}` : ''}
        </p>

        <p style={{ color: color.inkFaint, fontSize: 12, marginTop: -10, marginBottom: 16 }}>
          Last edited {new Date(selectedInvoice.updatedAt ?? selectedInvoice.date).toLocaleString('en-IN')}
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {(selectedInvoice.status === 'ESTIMATE' || selectedInvoice.status === 'HELD' || selectedInvoice.status === 'DRAFT') && selectedInvoiceId && (
            <>
              <button onClick={() => onEditInvoice(selectedInvoiceId)} style={secondaryBtn}>Edit</button>
              <button onClick={() => void deleteInvoice(selectedInvoiceId, selectedInvoice.number)} style={{ ...secondaryBtn, background: color.alert }}>Delete</button>
            </>
          )}
          {selectedInvoice.status === 'POSTED' && selectedInvoiceId && (
            <button onClick={() => void deleteInvoice(selectedInvoiceId, selectedInvoice.number, true)} style={{ ...secondaryBtn, background: color.alert }}>Delete Latest If Safe</button>
          )}
        </div>
        {selectedInvoice.status === 'ESTIMATE' && (
          <div style={{ background: color.amberTint, color: color.amber, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span>Not a tax invoice - for the customer's reference only.</span>
            <button onClick={() => selectedInvoiceId && void convertToInvoice(selectedInvoiceId)} style={{ ...secondaryBtn, background: color.money, padding: '6px 12px', fontSize: 12 }}>
              Convert to Invoice
            </button>
          </div>
        )}

        {printStatus && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{printStatus}</div>}

        <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 16, boxShadow: theme.shadowSm, maxWidth: 720 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: 11.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase', borderBottom: `1px solid ${color.line}` }}>
                <th style={{ padding: 6 }}>SKU</th>
                <th style={{ padding: 6 }}>HSN</th>
                <th style={{ padding: 6 }}>Qty</th>
                <th style={{ padding: 6 }}>Rate</th>
                <th style={{ padding: 6 }}>GST%</th>
                <th style={{ padding: 6 }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {selectedInvoice.items.map((line, idx) => (
                <tr key={idx} style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 14 }}>
                  <td style={{ padding: 6 }}>{line.item.sku}</td>
                  <td style={{ padding: 6, color: color.inkFaint }}>{line.item.hsn ?? '-'}</td>
                  <td style={{ padding: 6 }}>{Number(line.qty)}</td>
                  <td style={{ padding: 6, fontFamily: theme.mono }}>₹{Number(line.rate).toLocaleString('en-IN')}</td>
                  <td style={{ padding: 6, fontFamily: theme.mono }}>{line.gstRate}%</td>
                  <td style={{ padding: 6, fontFamily: theme.mono }}>₹{Number(line.amount).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px dashed ${color.line}`, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', fontSize: 13 }}>
            <div>Subtotal: <span style={{ fontFamily: theme.mono }}>₹{Number(selectedInvoice.subtotal).toLocaleString('en-IN')}</span></div>
            {Number(selectedInvoice.discountAmt) > 0 && <div>Discount: <span style={{ fontFamily: theme.mono }}>-₹{Number(selectedInvoice.discountAmt).toLocaleString('en-IN')}</span></div>}
            <div>CGST: <span style={{ fontFamily: theme.mono }}>₹{Number(selectedInvoice.cgst).toLocaleString('en-IN')}</span> &nbsp; SGST: <span style={{ fontFamily: theme.mono }}>₹{Number(selectedInvoice.sgst).toLocaleString('en-IN')}</span></div>
            {Number(selectedInvoice.igst) > 0 && <div>IGST: <span style={{ fontFamily: theme.mono }}>₹{Number(selectedInvoice.igst).toLocaleString('en-IN')}</span></div>}
            <div style={{ fontWeight: 700, fontSize: 18, color: color.ink }}>Total: ₹{Number(selectedInvoice.total).toLocaleString('en-IN')}</div>
          </div>
        </div>

        {selectedInvoice.status === 'POSTED' && selectedInvoice.partyId && (
          <div style={{ background: color.moneyTint, border: `1px solid ${color.money}44`, borderRadius: theme.radius, padding: 16, marginTop: 16, maxWidth: 720 }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color: color.ink }}>
              Amount Due: ₹{amountDue(selectedInvoice).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            {amountDue(selectedInvoice) > 0 ? (
              <PaymentSplitPanel
                companyId={session?.companyId ?? ''}
                token={session?.token ?? ''}
                invoiceId={selectedInvoiceId ?? ''}
                partyId={selectedInvoice.partyId}
                billTotal={Number(selectedInvoice.newBalance ?? 0)}
                alreadyPaid={(selectedInvoice.payments ?? []).reduce((s, p) => s + Number(p.amount), 0)}
                paymentModes={paymentModes}
                onRecorded={async () => {
                  if (selectedInvoiceId) await viewInvoice(selectedInvoiceId);
                  await loadInvoices();
                }}
              />
            ) : (
              <div style={{ fontSize: 13, color: color.money }}>Fully paid.</div>
            )}
          </div>
        )}

        {selectedInvoice.status === 'POSTED' && (
          <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 16, marginTop: 16, maxWidth: 720 }}>
            {returnStatus && (
              <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span>{returnStatus}</span>
                  {selectedInvoice.partyId && (
                    <button onClick={() => onStartExchange(selectedInvoice.partyId!)} style={{ ...secondaryBtn, background: color.brass, padding: '6px 12px', fontSize: 12 }}>
                      Bill a replacement now →
                    </button>
                  )}
                </div>
                {lastCreditNote && lastCreditNote.amount - lastCreditNote.refundedAmount > 0 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${color.money}44` }}>
                    <div style={{ fontSize: 12, marginBottom: 6 }}>
                      Left as store credit: ₹{(lastCreditNote.amount - lastCreditNote.refundedAmount).toLocaleString('en-IN')}
                      {lastCreditNote.refundedAmount > 0 && ` (already refunded ₹${lastCreditNote.refundedAmount.toLocaleString('en-IN')})`}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <select value={refundMode} onChange={(e) => setRefundMode(e.target.value)} style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 12.5 }}>
                        {paymentModes.map((m) => (
                          <option key={m.name} value={m.name}>{m.name}</option>
                        ))}
                      </select>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                        Refund amount
                        <input ref={refundAmountRef} defaultValue="" type="number" placeholder={`up to ${(lastCreditNote.amount - lastCreditNote.refundedAmount).toFixed(2)}`} style={{ width: 130, padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontFamily: theme.mono }} />
                      </label>
                      <button onClick={() => void submitRefund()} disabled={submittingRefund} style={secondaryBtn}>
                        {submittingRefund ? 'Recording…' : 'Record a refund'}
                      </button>
                    </div>
                    {refundError && <div style={{ color: color.alert, fontSize: 12, marginTop: 6 }}>{refundError}</div>}
                  </div>
                )}
              </div>
            )}
            {!showReturnForm ? (
              <button onClick={() => setShowReturnForm(true)} style={linkBtn}>Return items…</button>
            ) : (
              <>
                <div style={{ fontWeight: 700, marginBottom: 8, color: color.ink, fontSize: 13.5 }}>Return items</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', fontSize: 11, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase' }}>
                      <th style={{ padding: 4 }}>SKU</th>
                      <th style={{ padding: 4 }}>Sold Qty</th>
                      <th style={{ padding: 4 }}>Return Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedInvoice.items.map((line) => (
                      <tr key={line.itemId} style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 13 }}>
                        <td style={{ padding: 4 }}>{line.item.sku}</td>
                        <td style={{ padding: 4, fontFamily: theme.mono }}>{Number(line.qty)}</td>
                        <td style={{ padding: 4 }}>
                          <input
                            defaultValue=""
                            type="number"
                            min={0}
                            max={Number(line.qty)}
                            onBlur={(e) => {
                              const value = e.currentTarget.value;
                              setReturnQtys((prev) => ({ ...prev, [line.itemId]: value }));
                            }}
                            style={{ width: 70, padding: 4, border: `1px solid ${color.line}`, borderRadius: 4, fontFamily: theme.mono }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft, flex: 1, minWidth: 200 }}>
                    Reason
                    <input ref={returnReasonRef} defaultValue="" placeholder="e.g. Size didn't fit" style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }} />
                  </label>
                  <button onClick={() => void submitReturn()} disabled={submittingReturn} style={secondaryBtn}>
                    {submittingReturn ? 'Recording…' : 'Record Return'}
                  </button>
                  <button onClick={() => { setShowReturnForm(false); setReturnQtys({}); }} style={linkBtn}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
            Thermal layout
            <select value={thermalLayout} onChange={(e) => setThermalLayout(e.target.value as ThermalLayout)} style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }}>
              <option value="receipt">Receipt</option>
              <option value="compact">Compact</option>
              <option value="standard">Standard</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>
          <button onClick={() => void printReceipt()} style={secondaryBtn}>Print Receipt</button>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
            Invoice layout
            <select value={a4Layout} onChange={(e) => setA4Layout(e.target.value as A4Layout)} style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }}>
              <option value="a4">A4</option>
              <option value="a5">A5</option>
            </select>
          </label>
          <button onClick={printInvoice} style={secondaryBtn}>Print A4/A5 Invoice</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Invoice History</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 16 }}>Every saved bill - open one to review the details or reprint it.</p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusFilter(tab.value)}
            style={{
              padding: '7px 14px', borderRadius: theme.radiusSm, border: `1px solid ${statusFilter === tab.value ? color.brass : color.line}`, cursor: 'pointer', fontSize: 12.5,
              background: statusFilter === tab.value ? color.brass : color.paperRaised, color: statusFilter === tab.value ? '#fff' : color.inkSoft, fontWeight: statusFilter === tab.value ? 600 : 400,
            }}
          >
            {tab.label}
          </button>
        ))}
        <input
          defaultValue=""
          placeholder="Search invoice number or customer"
          onBlur={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSearch(e.currentTarget.value);
          }}
          style={{ flex: 1, minWidth: 200, padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13 }}
        />
      </div>

      <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, boxShadow: theme.shadowSm }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>No invoices match.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: 11.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase', borderBottom: `1px solid ${color.line}` }}>
                <th style={{ padding: '10px 12px' }}>Number</th>
                <th style={{ padding: '10px 12px' }}>Date</th>
                <th style={{ padding: '10px 12px' }}>Customer</th>
                <th style={{ padding: '10px 12px' }}>Status</th>
                <th style={{ padding: '10px 12px' }}>Due Date</th>
                <th style={{ padding: '10px 12px' }}>Last Edited</th>
                <th style={{ padding: '10px 12px' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const sc = statusColor(inv.status);
                return (
                  <tr
                    key={inv.id}
                    onClick={() => void viewInvoice(inv.id)}
                    style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 13.5, cursor: 'pointer' }}
                  >
                    <td style={{ padding: '10px 12px', fontFamily: theme.mono }}>{inv.number}</td>
                    <td style={{ padding: '10px 12px', color: color.inkFaint }}>{new Date(inv.date).toLocaleDateString('en-IN')}</td>
                    <td style={{ padding: '10px 12px' }}>{inv.party?.name ?? 'Walk-in'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ fontFamily: theme.mono, fontSize: 10, padding: '2px 8px', borderRadius: 20, background: sc.bg, color: sc.fg }}>{inv.status}</span>
                    </td>
                    <td style={{ padding: '10px 12px', color: color.inkFaint }}>{inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('en-IN') : '-'}</td>
                    <td style={{ padding: '10px 12px', color: color.inkFaint }}>{new Date(inv.updatedAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td style={{ padding: '10px 12px', fontFamily: theme.mono }}>₹{Number(inv.total).toLocaleString('en-IN')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const secondaryBtn: React.CSSProperties = {
  padding: '9px 16px',
  background: color.ledger,
  color: '#fff',
  border: 'none',
  borderRadius: theme.radiusSm,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const linkBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: color.brass,
  cursor: 'pointer',
  fontSize: 12.5,
  textDecoration: 'underline',
  padding: 0,
  alignSelf: 'flex-start',
};
