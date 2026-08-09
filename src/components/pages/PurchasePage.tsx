import { useEffect, useRef, useState } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { theme, statusColor } from '../../lib/theme';

// RULES.md #2: types declared inline. docs/SCOPE.md #6, docs/SPRINT_PLAN.md Step 9.
// Round 2 Step 6 — tokens applied.
type Item = { id: string; sku: string; category: string | null; purchaseRate: string; gstRate: string };
type Party = { id: string; name: string; type: 'CUSTOMER' | 'SUPPLIER' };
type PurchaseLine = { itemId: string; sku: string; qty: number; rate: number; gstRate: number };
type Purchase = {
  id: string;
  billNumber: string;
  billDate: string;
  total: string;
  cancelledAt: string | null;
  party: { name: string };
  items: Array<{ itemId: string; qty: string; rate: string; item?: { sku: string } }>;
};

const { color } = theme;
const inputStyle: React.CSSProperties = { padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14 };

export function PurchasePage() {
  const { session } = useSession();
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const billNumberRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Round 10 — Purchase Return, mirrors InvoicesPage.tsx's Sales Return form
  // exactly (per-line return qty capped at what was bought, same submit shape).
  const [returningPurchaseId, setReturningPurchaseId] = useState<string | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const returnReasonRef = useRef<HTMLInputElement>(null);
  const [returnStatus, setReturnStatus] = useState<string | null>(null);
  const [submittingReturn, setSubmittingReturn] = useState(false);

  // Round 10 — supplier inline-create, mirrors BillingPage.tsx's
  // handleAddPerson/showAddPerson pattern for customers, for suppliers.
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const newSupplierNameRef = useRef<HTMLInputElement>(null);
  const newSupplierPhoneRef = useRef<HTMLInputElement>(null);
  // Round 13 — brought up to the same field set as PartiesPage.tsx's own
  // inline add-party bar (minus Credit Limit, which isn't part of this ask).
  const newSupplierGstinRef = useRef<HTMLInputElement>(null);
  const newSupplierAddressRef = useRef<HTMLInputElement>(null);
  const newSupplierOpeningBalanceRef = useRef<HTMLInputElement>(null);

  async function loadAll() {
    if (!session) return;
    try {
      const [itemsRes, suppliersRes, purchasesRes] = await Promise.all([
        apiRequest<{ items: Item[] }>(`/companies/${session.companyId}/items`, { token: session.token }),
        apiRequest<{ parties: Party[] }>(`/companies/${session.companyId}/parties?type=SUPPLIER`, { token: session.token }),
        apiRequest<{ purchases: Purchase[] }>(`/companies/${session.companyId}/purchases`, { token: session.token }),
      ]);
      setItems(itemsRes.items);
      setSuppliers(suppliersRes.parties);
      setPurchases(purchasesRes.purchases);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load purchase data');
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  function addLine(item: Item) {
    setLines((prev) => {
      const existing = prev.find((l) => l.itemId === item.id);
      if (existing) return prev.map((l) => (l.itemId === item.id ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { itemId: item.id, sku: item.sku, qty: 1, rate: Number(item.purchaseRate), gstRate: Number(item.gstRate) }];
    });
    setSearch('');
    if (searchRef.current) searchRef.current.value = '';
  }

  function updateQty(itemId: string, qty: number) {
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, qty } : l)));
  }

  function updateRate(itemId: string, rate: number) {
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, rate } : l)));
  }

  function removeLine(itemId: string) {
    setLines((prev) => prev.filter((l) => l.itemId !== itemId));
  }

  async function submitPurchase() {
    if (!session || !supplierId || lines.length === 0) return;
    setError(null);
    try {
      await apiRequest(`/companies/${session.companyId}/purchases`, {
        method: 'POST',
        token: session.token,
        body: { partyId: supplierId, billNumber: billNumberRef.current?.value || `PB-${Date.now()}`, items: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, rate: l.rate, gstRate: l.gstRate })) },
      });
      setLines([]);
      setSupplierId('');
      if (billNumberRef.current) billNumberRef.current.value = '';
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save purchase');
    }
  }

  async function handleAddSupplier() {
    if (!session) return;
    const name = newSupplierNameRef.current?.value.trim();
    if (!name) {
      setError('Enter a name for the new supplier');
      return;
    }
    setError(null);
    try {
      const res = await apiRequest<{ party: Party }>(`/companies/${session.companyId}/parties`, {
        method: 'POST',
        token: session.token,
        body: {
          type: 'SUPPLIER',
          name,
          phone: newSupplierPhoneRef.current?.value.trim() || undefined,
          gstin: newSupplierGstinRef.current?.value.trim() || undefined,
          address: newSupplierAddressRef.current?.value.trim() || undefined,
          openingBalance: Number(newSupplierOpeningBalanceRef.current?.value || 0),
        },
      });
      setSuppliers((prev) => [...prev, res.party]);
      setSupplierId(res.party.id);
      setShowAddSupplier(false);
      if (newSupplierNameRef.current) newSupplierNameRef.current.value = '';
      if (newSupplierPhoneRef.current) newSupplierPhoneRef.current.value = '';
      if (newSupplierGstinRef.current) newSupplierGstinRef.current.value = '';
      if (newSupplierAddressRef.current) newSupplierAddressRef.current.value = '';
      if (newSupplierOpeningBalanceRef.current) newSupplierOpeningBalanceRef.current.value = '';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add supplier');
    }
  }

  async function submitDebitNote(purchase: Purchase) {
    if (!session) return;
    const reason = returnReasonRef.current?.value.trim();
    if (!reason) {
      setError('Enter a reason for the return');
      return;
    }
    const debitItems = purchase.items
      .map((line) => ({ itemId: line.itemId, qty: Number(returnQtys[line.itemId] || 0), rate: Number(line.rate) }))
      .filter((line) => line.qty > 0);
    if (debitItems.length === 0) {
      setError('Enter a quantity for at least one item to return');
      return;
    }
    setError(null);
    setSubmittingReturn(true);
    try {
      await apiRequest(`/companies/${session.companyId}/debit-notes`, {
        method: 'POST',
        token: session.token,
        body: { purchaseId: purchase.id, reason, items: debitItems },
      });
      setReturnStatus(`Return to ${purchase.party.name} recorded - stock and the supplier balance have been updated.`);
      setReturningPurchaseId(null);
      setReturnQtys({});
      if (returnReasonRef.current) returnReasonRef.current.value = '';
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record return');
    } finally {
      setSubmittingReturn(false);
    }
  }

  const filteredItems = search.trim() ? items.filter((i) => i.sku.toLowerCase().includes(search.toLowerCase()) || i.category?.toLowerCase().includes(search.toLowerCase())) : [];
  const total = lines.reduce((sum, l) => sum + l.qty * l.rate, 0);

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Purchase Entry</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>Record a supplier bill - stock updates automatically.</p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={{ ...inputStyle, width: 200 }}>
              <option value="">Select supplier</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button
              onClick={() => setShowAddSupplier((v) => !v)}
              style={{ border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 12.5, textDecoration: 'underline', whiteSpace: 'nowrap' }}
            >
              {showAddSupplier ? 'Cancel' : '+ New supplier'}
            </button>
            <input ref={billNumberRef} defaultValue="" placeholder="Bill number" style={{ ...inputStyle, width: 140 }} />
            <div style={{ position: 'relative', flex: 1 }}>
              <input ref={searchRef} defaultValue="" placeholder="Search item to add" onBlur={(e) => setSearch(e.currentTarget.value)} style={{ ...inputStyle, width: '100%' }} />
              {filteredItems.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, zIndex: 10, maxHeight: 200, overflow: 'auto', boxShadow: theme.shadow }}>
                  {filteredItems.map((item) => (
                    <div key={item.id} onClick={() => addLine(item)} style={{ padding: 8, cursor: 'pointer', fontSize: 13, borderTop: `1px solid ${color.lineSoft}` }}>
                      {item.sku} - {item.category} - purchase ₹{Number(item.purchaseRate).toLocaleString('en-IN')}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {showAddSupplier && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, padding: 10, flexWrap: 'wrap' }}>
              <input ref={newSupplierNameRef} defaultValue="" placeholder="Supplier name*" style={{ ...inputStyle, width: 180 }} />
              <input ref={newSupplierGstinRef} defaultValue="" placeholder="GSTIN (optional)" style={{ ...inputStyle, width: 160 }} />
              <input ref={newSupplierPhoneRef} defaultValue="" placeholder="Phone (optional)" style={{ ...inputStyle, width: 130 }} />
              <input ref={newSupplierAddressRef} defaultValue="" placeholder="Address (optional)" style={{ ...inputStyle, width: 200 }} />
              <input ref={newSupplierOpeningBalanceRef} defaultValue="" type="number" placeholder="Opening balance" style={{ ...inputStyle, width: 130 }} />
              <button onClick={() => void handleAddSupplier()} style={{ padding: '8px 14px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
                Save & Select
              </button>
            </div>
          )}

          <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 16, boxShadow: theme.shadowSm }}>
            {lines.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>No items added yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: 11.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase', borderBottom: `1px solid ${color.line}` }}>
                    <th style={{ padding: 6 }}>SKU</th>
                    <th style={{ padding: 6 }}>Qty</th>
                    <th style={{ padding: 6 }}>Rate</th>
                    <th style={{ padding: 6 }}>Amount</th>
                    <th style={{ padding: 6 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.itemId} style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 14 }}>
                      <td style={{ padding: 6 }}>{line.sku}</td>
                      <td style={{ padding: 6 }}>
                        <input defaultValue={line.qty} type="number" onBlur={(e) => updateQty(line.itemId, Number(e.currentTarget.value) || 0)} style={{ width: 60, padding: 4, border: `1px solid ${color.line}`, borderRadius: 4, fontFamily: theme.mono }} />
                      </td>
                      <td style={{ padding: 6 }}>
                        <input defaultValue={line.rate} type="number" onBlur={(e) => updateRate(line.itemId, Number(e.currentTarget.value) || 0)} style={{ width: 70, padding: 4, border: `1px solid ${color.line}`, borderRadius: 4, fontFamily: theme.mono }} />
                      </td>
                      <td style={{ padding: 6, fontFamily: theme.mono }}>₹{(line.qty * line.rate).toLocaleString('en-IN')}</td>
                      <td style={{ padding: 6 }}>
                        <button onClick={() => removeLine(line.itemId)} style={{ border: 'none', background: 'transparent', color: color.alert, cursor: 'pointer', fontSize: 12 }}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
              <div style={{ fontFamily: theme.mono, fontSize: 20, color: color.ink }}>₹{total.toLocaleString('en-IN')}</div>
              <button onClick={() => void submitPurchase()} disabled={lines.length === 0 || !supplierId} style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Save Purchase
              </button>
            </div>
          </div>
        </div>

        <div style={{ width: 340 }}>
          <h2 style={{ fontFamily: theme.mono, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 8 }}>Recent Purchases</h2>
          {returnStatus && (
            <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 12.5, marginBottom: 8 }}>{returnStatus}</div>
          )}
          <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 8, boxShadow: theme.shadowSm }}>
            {purchases.length === 0 ? (
              <div style={{ fontSize: 13, color: color.inkFaint, padding: 8 }}>None yet.</div>
            ) : (
              purchases.map((p) => {
                const sc = p.cancelledAt ? statusColor('CANCELLED') : statusColor('POSTED');
                return (
                  <div key={p.id} style={{ padding: 8, fontSize: 13, borderTop: `1px solid ${color.lineSoft}` }}>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {p.cancelledAt && <span style={{ fontFamily: theme.mono, fontSize: 9, padding: '1px 6px', borderRadius: 20, background: sc.bg, color: sc.fg }}>CANCELLED</span>}
                      {p.billNumber} - {p.party.name}
                    </div>
                    <div style={{ color: color.inkFaint, fontFamily: theme.mono }}>₹{Number(p.total).toLocaleString('en-IN')}</div>
                    {!p.cancelledAt && (
                      returningPurchaseId === p.id ? (
                        <div style={{ marginTop: 8, background: color.paper, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, padding: 8 }}>
                          {p.items.map((line) => (
                            <div key={line.itemId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                              <span style={{ fontSize: 12 }}>{line.item?.sku ?? line.itemId} <span style={{ color: color.inkFaint, fontFamily: theme.mono }}>x{Number(line.qty)}</span></span>
                              <input
                                defaultValue=""
                                type="number"
                                min={0}
                                max={Number(line.qty)}
                                onBlur={(e) => {
                                  const value = e.currentTarget.value;
                                  setReturnQtys((prev) => ({ ...prev, [line.itemId]: value }));
                                }}
                                style={{ width: 60, padding: 3, border: `1px solid ${color.line}`, borderRadius: 4, fontFamily: theme.mono }}
                              />
                            </div>
                          ))}
                          <input ref={returnReasonRef} defaultValue="" placeholder="Reason" style={{ width: '100%', padding: 5, border: `1px solid ${color.line}`, borderRadius: 4, fontSize: 12, marginTop: 4, marginBottom: 6 }} />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => void submitDebitNote(p)} disabled={submittingReturn} style={{ padding: '5px 10px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 11.5 }}>
                              {submittingReturn ? 'Recording…' : 'Record Return'}
                            </button>
                            <button onClick={() => { setReturningPurchaseId(null); setReturnQtys({}); }} style={{ border: 'none', background: 'transparent', color: color.inkFaint, cursor: 'pointer', fontSize: 11.5 }}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => setReturningPurchaseId(p.id)} style={{ border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 11.5, textDecoration: 'underline', padding: 0, marginTop: 4 }}>
                          Return to supplier…
                        </button>
                      )
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
