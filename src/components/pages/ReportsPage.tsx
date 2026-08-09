import { useRef, useState } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { exportToExcel, exportToPdf, printRows, type ExportColumn } from '../../lib/exportUtils';
import { theme } from '../../lib/theme';

// RULES.md #2: types declared inline. docs/SCOPE.md #10-11, docs/GST-SPEC.md.
// Round 2 Step 4 adds Reorder + Valuation tabs (no backend changes — /reports/stock
// already returns purchaseRate on every item).
type SalesInvoice = { id: string; number: string; date: string; total: string; party: { name: string } | null };
type StockItem = { id: string; sku: string; category: string | null; stockQty: string; minStock: string; purchaseRate: string };
type OutstandingParty = { id: string; name: string; type: 'CUSTOMER' | 'SUPPLIER'; balance: string; dueDate: string | null; agingBucket: string };
type PaymentRow = { id: string; mode: string; amount: string; direction: string; date: string; party: { name: string } | null; invoice: { number: string } | null };
type DeadStockItem = { id: string; sku: string; category: string | null; stockQty: string; lastSaleAt: string | null };
// Round 15 — Returns & Adjustments tab: unifies Sales Returns, Purchase
// Returns, and stock Adjustments/Damage, previously only viewable inline in
// three unrelated pages (Invoice History, Purchase Entry, Item Master).
type SalesReturn = { id: string; number: string; date: string; amount: string; refundedAmount: string; reason: string; party: { name: string } | null; invoice: { number: string } | null };
type PurchaseReturn = { id: string; number: string; date: string; amount: string; reason: string; party: { name: string } | null; purchase: { billNumber: string } | null };
type StockAdjustment = { id: string; type: string; qty: string; reason: string | null; createdAt: string; item: { sku: string; category: string | null } | null };
type GstPack = {
  month: string;
  b2b: Array<{ number: string; party: { name: string; gstin: string | null } | null; total: string }>;
  b2cSmall: Array<{ number: string; total: string }>;
  hsnSummary: Array<{ hsn: string; qty: number; taxable: number; tax: number }>;
  documentsIssued: { total: number; cancelled: number };
  gstr3bSummary: { outwardTaxableValue: number; cgst: number; sgst: number; igst: number };
};

type ReportTab = 'sales' | 'stock' | 'reorder' | 'valuation' | 'outstanding' | 'gst' | 'payments' | 'deadstock' | 'returns';

const { color } = theme;

const SALES_COLUMNS: ExportColumn[] = [
  { key: 'number', label: 'Invoice No' },
  { key: 'date', label: 'Date' },
  { key: 'party', label: 'Party' },
  { key: 'total', label: 'Total' },
];
const STOCK_COLUMNS: ExportColumn[] = [
  { key: 'sku', label: 'SKU' },
  { key: 'category', label: 'Category' },
  { key: 'stockQty', label: 'Stock' },
  { key: 'minStock', label: 'Min Stock' },
];
const REORDER_COLUMNS: ExportColumn[] = [
  { key: 'sku', label: 'SKU' },
  { key: 'stockQty', label: 'In Stock' },
  { key: 'minStock', label: 'Min Stock' },
  { key: 'suggestedQty', label: 'Suggested Reorder Qty' },
];
const VALUATION_COLUMNS: ExportColumn[] = [
  { key: 'sku', label: 'SKU' },
  { key: 'stockQty', label: 'Qty' },
  { key: 'purchaseRate', label: 'Purchase Rate' },
  { key: 'value', label: 'Value' },
];
const OUTSTANDING_COLUMNS: ExportColumn[] = [
  { key: 'name', label: 'Party' },
  { key: 'type', label: 'Type' },
  { key: 'balance', label: 'Balance' },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'agingBucket', label: 'Aging' },
];
const PAYMENTS_COLUMNS: ExportColumn[] = [
  { key: 'date', label: 'Date' },
  { key: 'party', label: 'Party' },
  { key: 'invoiceNumber', label: 'Invoice' },
  { key: 'direction', label: 'Type' },
  { key: 'mode', label: 'Mode' },
  { key: 'amount', label: 'Amount' },
];
const DEADSTOCK_COLUMNS: ExportColumn[] = [
  { key: 'sku', label: 'SKU' },
  { key: 'category', label: 'Category' },
  { key: 'stockQty', label: 'Stock' },
  { key: 'lastSaleAt', label: 'Last Sold' },
];
const HSN_COLUMNS: ExportColumn[] = [
  { key: 'hsn', label: 'HSN' },
  { key: 'qty', label: 'Qty' },
  { key: 'taxable', label: 'Taxable Value' },
  { key: 'tax', label: 'Tax' },
];
const SALES_RETURN_COLUMNS: ExportColumn[] = [
  { key: 'number', label: 'Return No' },
  { key: 'date', label: 'Date' },
  { key: 'invoiceNumber', label: 'Against Invoice' },
  { key: 'party', label: 'Party' },
  { key: 'amount', label: 'Amount' },
  { key: 'refundedAmount', label: 'Refunded' },
  { key: 'remaining', label: 'Left as Credit' },
  { key: 'reason', label: 'Reason' },
];
const PURCHASE_RETURN_COLUMNS: ExportColumn[] = [
  { key: 'number', label: 'Return No' },
  { key: 'date', label: 'Date' },
  { key: 'billNumber', label: 'Against Purchase Bill' },
  { key: 'party', label: 'Supplier' },
  { key: 'amount', label: 'Amount' },
  { key: 'reason', label: 'Reason' },
];
const ADJUSTMENT_COLUMNS: ExportColumn[] = [
  { key: 'date', label: 'Date' },
  { key: 'sku', label: 'SKU' },
  { key: 'category', label: 'Category' },
  { key: 'type', label: 'Type' },
  { key: 'qty', label: 'Qty' },
  { key: 'reason', label: 'Reason' },
];

export function ReportsPage() {
  const { session } = useSession();
  const [tab, setTab] = useState<ReportTab>('sales');
  const [sales, setSales] = useState<SalesInvoice[] | null>(null);
  const [stock, setStock] = useState<StockItem[] | null>(null);
  const [outstanding, setOutstanding] = useState<OutstandingParty[] | null>(null);
  const [gstPack, setGstPack] = useState<GstPack | null>(null);
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [deadStock, setDeadStock] = useState<DeadStockItem[] | null>(null);
  const [salesReturns, setSalesReturns] = useState<SalesReturn[] | null>(null);
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[] | null>(null);
  const [adjustments, setAdjustments] = useState<StockAdjustment[] | null>(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Round 16 — the Receipts & Vouchers list was previously an unfiltered
  // company-wide dump; this makes it searchable by party, invoice, or mode.
  const [paymentsSearch, setPaymentsSearch] = useState('');
  const paymentsSearchRef = useRef<HTMLInputElement>(null);

  async function runReport(target: ReportTab) {
    if (!session) return;
    setTab(target);
    setError(null);
    setLoading(true);
    try {
      if (target === 'sales') {
        const res = await apiRequest<{ invoices: SalesInvoice[] }>(`/companies/${session.companyId}/reports/sales`, { token: session.token });
        setSales(res.invoices);
      } else if (target === 'stock' || target === 'reorder' || target === 'valuation') {
        const res = await apiRequest<{ items: StockItem[] }>(`/companies/${session.companyId}/reports/stock`, { token: session.token });
        setStock(res.items);
      } else if (target === 'outstanding') {
        const res = await apiRequest<{ parties: OutstandingParty[] }>(`/companies/${session.companyId}/reports/outstanding`, { token: session.token });
        setOutstanding(res.parties);
      } else if (target === 'gst') {
        const res = await apiRequest<GstPack>(`/companies/${session.companyId}/gst-reports/pack?month=${month}`, { token: session.token });
        setGstPack(res);
      } else if (target === 'payments') {
        const res = await apiRequest<{ payments: PaymentRow[] }>(`/companies/${session.companyId}/payments`, { token: session.token });
        setPayments(res.payments);
      } else if (target === 'deadstock') {
        const res = await apiRequest<{ items: DeadStockItem[] }>(`/companies/${session.companyId}/reports/dead-stock`, { token: session.token });
        setDeadStock(res.items);
      } else if (target === 'returns') {
        const [creditRes, debitRes, movementsRes] = await Promise.all([
          apiRequest<{ creditNotes: SalesReturn[] }>(`/companies/${session.companyId}/credit-notes`, { token: session.token }),
          apiRequest<{ debitNotes: PurchaseReturn[] }>(`/companies/${session.companyId}/debit-notes`, { token: session.token }),
          apiRequest<{ movements: StockAdjustment[] }>(`/companies/${session.companyId}/stock/movements`, { token: session.token }),
        ]);
        setSalesReturns(creditRes.creditNotes);
        setPurchaseReturns(debitRes.debitNotes);
        setAdjustments(movementsRes.movements);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }

  const salesRows = (sales ?? []).map((i) => ({
    ...i,
    date: new Date(i.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    party: i.party?.name ?? 'Walk-in',
    total: Number(i.total).toLocaleString('en-IN'),
  }));
  const stockRows = (stock ?? []).map((i) => ({ ...i, stockQty: Number(i.stockQty), minStock: Number(i.minStock) }));
  const reorderRows = (stock ?? [])
    .filter((i) => Number(i.stockQty) <= Number(i.minStock))
    .map((i) => ({
      sku: i.sku,
      stockQty: Number(i.stockQty),
      minStock: Number(i.minStock),
      suggestedQty: Math.max(0, Number(i.minStock) * 2 - Number(i.stockQty)),
    }));
  const valuationRows = (stock ?? []).map((i) => ({
    sku: i.sku,
    stockQty: Number(i.stockQty),
    purchaseRate: Number(i.purchaseRate).toLocaleString('en-IN'),
    value: Math.round(Number(i.stockQty) * Number(i.purchaseRate)).toLocaleString('en-IN'),
  }));
  const valuationTotal = (stock ?? []).reduce((s, i) => s + Number(i.stockQty) * Number(i.purchaseRate), 0);
  // Round 10 — worst-aged first, matching how a shop owner scans an aging
  // report (who to chase first), not the backend's balance-desc default order.
  const AGING_ORDER = ['90+', '61-90', '31-60', '1-30', 'current'];
  const outstandingRows = [...(outstanding ?? [])]
    .sort((a, b) => AGING_ORDER.indexOf(a.agingBucket) - AGING_ORDER.indexOf(b.agingBucket))
    .map((p) => ({
      ...p,
      balance: Number(p.balance).toLocaleString('en-IN'),
      dueDate: p.dueDate ? new Date(p.dueDate).toLocaleDateString('en-IN') : '-',
    }));
  const hsnRows = gstPack?.hsnSummary ?? [];
  const paymentsRows = (payments ?? [])
    .filter((p) => {
      if (!paymentsSearch.trim()) return true;
      const q = paymentsSearch.toLowerCase();
      return (p.party?.name ?? '').toLowerCase().includes(q) || (p.invoice?.number ?? '').toLowerCase().includes(q) || p.mode.toLowerCase().includes(q);
    })
    .map((p) => ({
      ...p,
      date: new Date(p.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      party: p.party?.name ?? '-',
      invoiceNumber: p.invoice?.number ?? '-',
      direction: p.direction === 'OUT' ? 'Payment Voucher' : 'Receipt',
      amount: Number(p.amount).toLocaleString('en-IN'),
    }));
  const deadStockRows = (deadStock ?? []).map((i) => ({
    ...i,
    stockQty: Number(i.stockQty),
    lastSaleAt: i.lastSaleAt ? new Date(i.lastSaleAt).toLocaleDateString('en-IN') : 'Never',
  }));
  const salesReturnRows = (salesReturns ?? []).map((n) => ({
    ...n,
    date: new Date(n.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    invoiceNumber: n.invoice?.number ?? '-',
    party: n.party?.name ?? 'Walk-in',
    amount: Number(n.amount).toLocaleString('en-IN'),
    refundedAmount: Number(n.refundedAmount).toLocaleString('en-IN'),
    remaining: (Number(n.amount) - Number(n.refundedAmount)).toLocaleString('en-IN'),
  }));
  const purchaseReturnRows = (purchaseReturns ?? []).map((n) => ({
    ...n,
    date: new Date(n.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    billNumber: n.purchase?.billNumber ?? '-',
    party: n.party?.name ?? '-',
    amount: Number(n.amount).toLocaleString('en-IN'),
  }));
  const adjustmentRows = (adjustments ?? []).map((m) => ({
    ...m,
    date: new Date(m.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    sku: m.item?.sku ?? '-',
    category: m.item?.category ?? '-',
    type: m.type === 'DAMAGE' ? 'Damage' : 'Adjustment',
    qty: Number(m.qty),
    reason: m.reason ?? '-',
  }));

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Reports & GST Pack</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>View and export your sales, stock, and GST reports.</p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabButton active={tab === 'sales'} label="Sales" onClick={() => void runReport('sales')} />
        <TabButton active={tab === 'stock'} label="Stock" onClick={() => void runReport('stock')} />
        <TabButton active={tab === 'reorder'} label="Reorder Suggestions" onClick={() => void runReport('reorder')} />
        <TabButton active={tab === 'valuation'} label="Stock Valuation" onClick={() => void runReport('valuation')} />
        <TabButton active={tab === 'outstanding'} label="Outstanding" onClick={() => void runReport('outstanding')} />
        <TabButton active={tab === 'gst'} label="GST Pack" onClick={() => void runReport('gst')} />
        <TabButton active={tab === 'payments'} label="Receipts & Vouchers" onClick={() => void runReport('payments')} />
        <TabButton active={tab === 'deadstock'} label="Dead Stock" onClick={() => void runReport('deadstock')} />
        <TabButton active={tab === 'returns'} label="Returns & Adjustments" onClick={() => void runReport('returns')} />
      </div>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {loading && <div style={{ fontSize: 13, color: color.inkFaint, marginBottom: 12 }}>Loading…</div>}

      {tab === 'sales' && sales && <ReportTable columns={SALES_COLUMNS} rows={salesRows} title="Sales Report" filenamePrefix="sales-report" />}

      {tab === 'stock' && stock && <ReportTable columns={STOCK_COLUMNS} rows={stockRows} title="Stock Report" filenamePrefix="stock-report" />}

      {tab === 'reorder' && stock && (
        <>
          <p style={{ fontSize: 12.5, color: color.inkFaint, marginBottom: 10 }}>
            Items at or below their minimum stock - suggested qty = (min stock × 2) − current stock.
          </p>
          <ReportTable columns={REORDER_COLUMNS} rows={reorderRows} title="Reorder Suggestions" filenamePrefix="reorder-suggestions" />
        </>
      )}

      {tab === 'valuation' && stock && (
        <>
          <div style={{ marginBottom: 12, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: '10px 16px', display: 'inline-block', boxShadow: theme.shadowSm }}>
            <div style={{ fontSize: 11, color: color.inkFaint }}>Total stock value (qty × purchase rate)</div>
            <div style={{ fontFamily: theme.mono, fontSize: 20, color: color.ink }}>₹{Math.round(valuationTotal).toLocaleString('en-IN')}</div>
          </div>
          <ReportTable columns={VALUATION_COLUMNS} rows={valuationRows} title="Stock Valuation" filenamePrefix="stock-valuation" />
        </>
      )}

      {tab === 'outstanding' && outstanding && <ReportTable columns={OUTSTANDING_COLUMNS} rows={outstandingRows} title="Outstanding Report" filenamePrefix="outstanding-report" />}

      {tab === 'gst' && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              style={{ width: 140, padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontFamily: theme.mono }}
            />
            <button onClick={() => void runReport('gst')} style={{ padding: '7px 14px', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, background: color.paperRaised, cursor: 'pointer', fontSize: 12, color: color.inkSoft }}>
              Generate
            </button>
          </div>
          {gstPack && (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, fontSize: 13, flexWrap: 'wrap' }}>
                <StatBox label="B2B invoices" value={gstPack.b2b.length} />
                <StatBox label="B2C (Small) invoices" value={gstPack.b2cSmall.length} />
                <StatBox label="Documents issued" value={gstPack.documentsIssued.total} />
                <StatBox label="Cancelled" value={gstPack.documentsIssued.cancelled} />
                <StatBox label="CGST" value={`₹${gstPack.gstr3bSummary.cgst.toLocaleString('en-IN')}`} />
                <StatBox label="SGST" value={`₹${gstPack.gstr3bSummary.sgst.toLocaleString('en-IN')}`} />
                <StatBox label="IGST" value={`₹${gstPack.gstr3bSummary.igst.toLocaleString('en-IN')}`} />
              </div>
              <ReportTable columns={HSN_COLUMNS} rows={hsnRows} title={`GST Pack HSN Summary - ${gstPack.month}`} filenamePrefix="gst-hsn-summary" />
            </>
          )}
        </div>
      )}

      {tab === 'payments' && payments && (
        <>
          <p style={{ fontSize: 12.5, color: color.inkFaint, marginBottom: 10 }}>
            Receipts = money in (from customers). Payment Vouchers = money out (e.g. to suppliers).
          </p>
          <input
            ref={paymentsSearchRef}
            defaultValue=""
            placeholder="Search by party, invoice number, or mode"
            onBlur={(e) => setPaymentsSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setPaymentsSearch(e.currentTarget.value);
            }}
            style={{ padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13, width: 300, marginBottom: 12 }}
          />
          <ReportTable columns={PAYMENTS_COLUMNS} rows={paymentsRows} title="Receipts & Payment Vouchers" filenamePrefix="receipts-and-vouchers" />
        </>
      )}

      {tab === 'deadstock' && deadStock && (
        <>
          <p style={{ fontSize: 12.5, color: color.inkFaint, marginBottom: 10 }}>
            Items with no sale in the last 60 days - candidates for a clearance offer or write-off.
          </p>
          <ReportTable columns={DEADSTOCK_COLUMNS} rows={deadStockRows} title="Dead Stock" filenamePrefix="dead-stock" />
        </>
      )}

      {tab === 'returns' && salesReturns && purchaseReturns && adjustments && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div>
            <h3 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 17, margin: '0 0 8px', color: color.ink }}>Sales Returns</h3>
            <p style={{ fontSize: 12.5, color: color.inkFaint, marginBottom: 10 }}>
              "Left as Credit" is the part of a return still sitting as store credit against the customer's balance. Record a refund from Invoice History to move it to "Refunded".
            </p>
            <ReportTable columns={SALES_RETURN_COLUMNS} rows={salesReturnRows} title="Sales Returns" filenamePrefix="sales-returns" />
          </div>
          <div>
            <h3 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 17, margin: '0 0 8px', color: color.ink }}>Purchase Returns</h3>
            <ReportTable columns={PURCHASE_RETURN_COLUMNS} rows={purchaseReturnRows} title="Purchase Returns" filenamePrefix="purchase-returns" />
          </div>
          <div>
            <h3 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 17, margin: '0 0 8px', color: color.ink }}>Stock Adjustments & Damage</h3>
            <p style={{ fontSize: 12.5, color: color.inkFaint, marginBottom: 10 }}>
              Manual stock corrections and damage write-offs recorded from Item Master. New entries are added there, not here.
            </p>
            <ReportTable columns={ADJUSTMENT_COLUMNS} rows={adjustmentRows} title="Stock Adjustments and Damage" filenamePrefix="stock-adjustments" />
          </div>
        </div>
      )}
    </div>
  );
}

function ReportTable({ columns, rows, title, filenamePrefix }: { columns: ExportColumn[]; rows: Record<string, unknown>[]; title: string; filenamePrefix: string }) {
  const btnStyle: React.CSSProperties = { padding: '6px 12px', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, background: color.paperRaised, cursor: 'pointer', fontSize: 12, color: color.inkSoft };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button style={btnStyle} onClick={() => printRows(title, columns, rows)}>Print</button>
        <button style={btnStyle} onClick={() => exportToExcel(filenamePrefix, title, columns, rows)}>Excel</button>
        <button style={btnStyle} onClick={() => exportToPdf(filenamePrefix, title, columns, rows)}>PDF</button>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, boxShadow: theme.shadowSm }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: `2px solid ${color.line}`, fontSize: 12.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase' }}>
            {columns.map((c) => (
              <th key={c.key} style={{ padding: 10 }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} style={{ padding: 18, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>No data.</td></tr>
          ) : (
            rows.map((row, idx) => (
              <tr key={idx} style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 14 }}>
                {columns.map((c) => (
                  <td key={c.key} style={{ padding: 10, fontFamily: typeof row[c.key] === 'number' ? theme.mono : undefined }}>{String(row[c.key] ?? '')}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 16px', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13,
        background: active ? color.brass : color.paperRaised, color: active ? '#fff' : color.inkSoft, fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: '8px 14px', boxShadow: theme.shadowSm }}>
      <div style={{ color: color.inkFaint, fontSize: 11 }}>{label}</div>
      <div style={{ fontFamily: theme.mono, fontWeight: 700, fontSize: 15, color: color.ink }}>{value}</div>
    </div>
  );
}
