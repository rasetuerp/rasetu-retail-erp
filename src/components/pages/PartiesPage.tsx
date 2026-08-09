import { useEffect, useRef, useState } from 'react';
import { Users, Pencil } from 'lucide-react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { exportToExcel, exportToPdf, printRows, type ExportColumn } from '../../lib/exportUtils';
import { theme, statusColor } from '../../lib/theme';

// RULES.md #2: types declared inline. RULES.md #3: defaultValue+onBlur/refs, never onChange.
// Round 2 Step 1 (tokens) + Step 5 (Customer Profile) combined — same panel.
type Party = {
  id: string;
  type: 'CUSTOMER' | 'SUPPLIER';
  name: string;
  gstin: string | null;
  phone: string | null;
  balance: string;
  creditLimit: string | null;
};

type LedgerEntry = {
  id: string;
  debit: string;
  credit: string;
  balance: string;
  refType: string;
  date: string;
};

type PartyInvoice = { id: string; number: string; total: string; date: string; status: 'DRAFT' | 'HELD' | 'POSTED' | 'CANCELLED' };
// Round 16 — the Ledger card above only shows abstract debit/credit lines;
// this shows the actual Payment rows (mode, direction, which invoice) so a
// shop owner can see receipts/vouchers without hunting through Reports.
type PartyPayment = { id: string; mode: string; amount: string; direction: string; date: string; invoice: { number: string } | null };

const { color } = theme;
const inputStyle: React.CSSProperties = { padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14, width: 140 };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft };

export function PartiesPage({
  initialSelectedPartyId,
  onInitialSelectedHandled,
}: {
  initialSelectedPartyId?: string | null;
  onInitialSelectedHandled?: () => void;
} = {}) {
  const { session } = useSession();
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [partyInvoices, setPartyInvoices] = useState<PartyInvoice[]>([]);
  const [partyPayments, setPartyPayments] = useState<PartyPayment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // Round 10 — Customer/Supplier tab filter; the API already supports
  // ?type=, but Parties itself always fetched everything and filtered
  // in-memory for search only. Type filtering joins that same in-memory pass.
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'CUSTOMER' | 'SUPPLIER'>('ALL');

  // Round 14 — Type is now controlled so the DOB/Anniversary/Notes fields
  // (relationship-building fields, only meaningful for a customer) can show
  // conditionally, matching the same field set BillingPage.tsx's customer
  // quick-add and PurchasePage.tsx's supplier quick-add already collect —
  // aligning all three party-creation surfaces instead of each being a
  // different subset.
  const [addPartyType, setAddPartyType] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  const nameRef = useRef<HTMLInputElement>(null);
  const gstinRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const openingBalanceRef = useRef<HTMLInputElement>(null);
  const creditLimitRef = useRef<HTMLInputElement>(null);
  const dobRef = useRef<HTMLInputElement>(null);
  const anniversaryRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLInputElement>(null);

  const [editingParty, setEditingParty] = useState(false);
  const [editPartyError, setEditPartyError] = useState<string | null>(null);
  const editTypeRef = useRef<HTMLSelectElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const editGstinRef = useRef<HTMLInputElement>(null);
  const editPhoneRef = useRef<HTMLInputElement>(null);
  const editCreditLimitRef = useRef<HTMLInputElement>(null);

  async function loadParties() {
    if (!session) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ parties: Party[] }>(`/companies/${session.companyId}/parties`, { token: session.token });
      setParties(res.parties);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load parties');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadParties();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  useEffect(() => {
    if (initialSelectedPartyId) {
      void viewProfile(initialSelectedPartyId);
      onInitialSelectedHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelectedPartyId]);

  async function viewProfile(partyId: string) {
    if (!session) return;
    setSelectedId(partyId);
    setEditingParty(false);
    setEditPartyError(null);
    try {
      const [ledgerRes, invoicesRes, paymentsRes] = await Promise.all([
        apiRequest<{ entries: LedgerEntry[] }>(`/companies/${session.companyId}/parties/${partyId}/ledger`, { token: session.token }),
        apiRequest<{ invoices: PartyInvoice[] }>(`/companies/${session.companyId}/invoices?partyId=${partyId}`, { token: session.token }),
        apiRequest<{ payments: PartyPayment[] }>(`/companies/${session.companyId}/payments?partyId=${partyId}`, { token: session.token }),
      ]);
      setLedger(ledgerRes.entries);
      setPartyInvoices(invoicesRes.invoices);
      setPartyPayments(paymentsRes.payments);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load party profile');
    }
  }

  async function handleAddParty() {
    if (!session) return;
    setError(null);
    setSubmitting(true);
    try {
      const gstinValue = gstinRef.current?.value.trim();
      await apiRequest(`/companies/${session.companyId}/parties`, {
        method: 'POST',
        token: session.token,
        body: {
          type: addPartyType,
          name: nameRef.current?.value ?? '',
          gstin: gstinValue || undefined,
          phone: phoneRef.current?.value || undefined,
          address: addressRef.current?.value.trim() || undefined,
          openingBalance: Number(openingBalanceRef.current?.value ?? 0),
          creditLimit: creditLimitRef.current?.value ? Number(creditLimitRef.current.value) : undefined,
          dob: addPartyType === 'CUSTOMER' ? dobRef.current?.value || undefined : undefined,
          anniversary: addPartyType === 'CUSTOMER' ? anniversaryRef.current?.value || undefined : undefined,
          notes: addPartyType === 'CUSTOMER' ? notesRef.current?.value.trim() || undefined : undefined,
        },
      });
      if (nameRef.current) nameRef.current.value = '';
      if (gstinRef.current) gstinRef.current.value = '';
      if (phoneRef.current) phoneRef.current.value = '';
      if (addressRef.current) addressRef.current.value = '';
      if (openingBalanceRef.current) openingBalanceRef.current.value = '';
      if (creditLimitRef.current) creditLimitRef.current.value = '';
      if (dobRef.current) dobRef.current.value = '';
      if (anniversaryRef.current) anniversaryRef.current.value = '';
      if (notesRef.current) notesRef.current.value = '';
      await loadParties();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add party');
    } finally {
      setSubmitting(false);
    }
  }

  const filteredParties = parties
    .filter((p) => typeFilter === 'ALL' || p.type === typeFilter)
    .filter((p) => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()) || p.phone?.includes(search));
  const selectedParty = parties.find((p) => p.id === selectedId) ?? null;

  async function handleSaveEditParty() {
    if (!session || !selectedId) return;
    setEditPartyError(null);
    const gstinValue = editGstinRef.current?.value.trim();
    try {
      await apiRequest(`/companies/${session.companyId}/parties/${selectedId}`, {
        method: 'PATCH',
        token: session.token,
        body: {
          type: editTypeRef.current?.value,
          name: editNameRef.current?.value || undefined,
          gstin: gstinValue ?? '',
          phone: editPhoneRef.current?.value || undefined,
          creditLimit: editCreditLimitRef.current?.value ? Number(editCreditLimitRef.current.value) : undefined,
        },
      });
      setEditingParty(false);
      await loadParties();
      await viewProfile(selectedId);
    } catch (err) {
      setEditPartyError(err instanceof ApiError ? err.message : 'Failed to save party');
    }
  }

  const posted = partyInvoices.filter((i) => i.status === 'POSTED');
  const lifetimeValue = posted.reduce((s, i) => s + Number(i.total), 0);
  const avgBill = posted.length ? lifetimeValue / posted.length : 0;
  const lastVisit = posted[0]?.date;

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Parties & Ledger</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>Manage customers and suppliers, and track their balances.</p>

      {error && (
        <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div
        style={{
          display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 16,
          background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 14, flexWrap: 'wrap', boxShadow: theme.shadowSm,
        }}
      >
        <label style={labelStyle}>
          Type
          <select value={addPartyType} onChange={(e) => setAddPartyType(e.target.value as 'CUSTOMER' | 'SUPPLIER')} style={inputStyle}>
            <option value="CUSTOMER">Customer</option>
            <option value="SUPPLIER">Supplier</option>
          </select>
        </label>
        <label style={labelStyle}>
          Name
          <input ref={nameRef} defaultValue="" style={inputStyle} />
        </label>
        <label style={labelStyle}>
          GSTIN (optional)
          <input ref={gstinRef} defaultValue="" style={inputStyle} placeholder="22AAAAA0000A1Z5" />
        </label>
        <label style={labelStyle}>
          Phone
          <input ref={phoneRef} defaultValue="" style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Address (optional)
          <input ref={addressRef} defaultValue="" style={{ ...inputStyle, width: 180 }} />
        </label>
        <label style={labelStyle}>
          Opening Balance
          <input ref={openingBalanceRef} defaultValue="" type="number" style={{ ...inputStyle, width: 110 }} />
        </label>
        <label style={labelStyle}>
          Credit Limit (optional)
          <input ref={creditLimitRef} defaultValue="" type="number" style={{ ...inputStyle, width: 110 }} />
        </label>
        {addPartyType === 'CUSTOMER' && (
          <>
            <label style={labelStyle}>
              DOB (optional)
              <input ref={dobRef} type="date" style={{ ...inputStyle, width: 140 }} />
            </label>
            <label style={labelStyle}>
              Anniversary (optional)
              <input ref={anniversaryRef} type="date" style={{ ...inputStyle, width: 140 }} />
            </label>
            <label style={labelStyle}>
              Notes (optional)
              <input ref={notesRef} defaultValue="" style={{ ...inputStyle, width: 160 }} />
            </label>
          </>
        )}
        <button
          onClick={handleAddParty}
          disabled={submitting}
          style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
        >
          {submitting ? 'Adding…' : 'Add Party'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          ref={searchRef}
          defaultValue=""
          placeholder="Search by name or phone"
          onBlur={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSearch(e.currentTarget.value);
          }}
          style={{ ...inputStyle, width: 260 }}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          {(['ALL', 'CUSTOMER', 'SUPPLIER'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              style={{
                padding: '6px 14px', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12.5,
                background: typeFilter === t ? color.brass : color.paperRaised,
                color: typeFilter === t ? '#fff' : color.inkSoft,
                fontWeight: typeFilter === t ? 600 : 400,
              }}
            >
              {t === 'ALL' ? 'All' : t === 'CUSTOMER' ? 'Customers' : 'Suppliers'}
            </button>
          ))}
        </div>
      </div>

      <ExportToolbar parties={filteredParties} />

      <div style={{ display: 'flex', gap: 16 }}>
        <table style={{ flex: 1, borderCollapse: 'collapse', background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, boxShadow: theme.shadowSm }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: `2px solid ${color.line}`, fontSize: 12.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase', letterSpacing: '.03em' }}>
              <th style={{ padding: 10 }}>Name</th>
              <th style={{ padding: 10 }}>Phone</th>
              <th style={{ padding: 10 }}>Type</th>
              <th style={{ padding: 10 }}>GSTIN</th>
              <th style={{ padding: 10 }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{ padding: 18, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>Loading…</td></tr>
            ) : filteredParties.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 18, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>{parties.length === 0 ? 'No parties yet - add one above.' : 'No parties match your search.'}</td></tr>
            ) : (
              filteredParties.map((party) => (
                <tr
                  key={party.id}
                  onClick={() => void viewProfile(party.id)}
                  style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 14, cursor: 'pointer', background: selectedId === party.id ? color.brassTint : 'transparent' }}
                >
                  <td style={{ padding: 10 }}>{party.name}</td>
                  <td style={{ padding: 10, color: color.inkSoft }}>{party.phone ?? '-'}</td>
                  <td style={{ padding: 10, color: color.inkSoft }}>{party.type}</td>
                  <td style={{ padding: 10, color: color.inkSoft }}>{party.gstin ?? '-'}</td>
                  <td style={{ padding: 10, fontFamily: theme.mono, fontVariantNumeric: 'tabular-nums' }}>₹{Number(party.balance).toLocaleString('en-IN')}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {selectedId && selectedParty && (
          <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 14, boxShadow: theme.shadowSm }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: theme.mono, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint }}>
                  <Users size={13} /> Customer profile
                </div>
                <button
                  onClick={() => { setEditingParty((prev) => !prev); setEditPartyError(null); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 11.5, color: color.inkSoft }}
                >
                  <Pencil size={11} /> {editingParty ? 'Cancel' : 'Edit'}
                </button>
              </div>

              {editingParty ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                  <label style={labelStyle}>
                    Type
                    <select ref={editTypeRef} defaultValue={selectedParty.type} style={inputStyle}>
                      <option value="CUSTOMER">Customer</option>
                      <option value="SUPPLIER">Supplier</option>
                    </select>
                  </label>
                  <label style={labelStyle}>
                    Name
                    <input ref={editNameRef} defaultValue={selectedParty.name} style={inputStyle} />
                  </label>
                  <label style={labelStyle}>
                    Phone
                    <input ref={editPhoneRef} defaultValue={selectedParty.phone ?? ''} style={inputStyle} />
                  </label>
                  <label style={labelStyle}>
                    GSTIN
                    <input ref={editGstinRef} defaultValue={selectedParty.gstin ?? ''} style={inputStyle} placeholder="22AAAAA0000A1Z5" />
                  </label>
                  <label style={labelStyle}>
                    Credit Limit (optional)
                    <input ref={editCreditLimitRef} defaultValue={selectedParty.creditLimit ?? ''} type="number" style={inputStyle} />
                  </label>
                  {editPartyError && <div style={{ color: color.alert, fontSize: 12 }}>{editPartyError}</div>}
                  <button
                    onClick={() => void handleSaveEditParty()}
                    style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                  >
                    Save
                  </button>
                </div>
              ) : (
                selectedParty.phone && (
                  <div style={{ fontSize: 12.5, color: color.inkSoft, marginBottom: 8 }}>{selectedParty.phone}</div>
                )
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12.5 }}>
                <ProfileStat label="Lifetime value" value={`₹${lifetimeValue.toLocaleString('en-IN')}`} />
                <ProfileStat label="Invoices" value={String(posted.length)} />
                <ProfileStat label="Avg bill" value={`₹${Math.round(avgBill).toLocaleString('en-IN')}`} />
                <ProfileStat label="Last visit" value={lastVisit ? new Date(lastVisit).toLocaleDateString('en-IN') : '-'} />
              </div>
            </div>

            <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 14, boxShadow: theme.shadowSm }}>
              <div style={{ fontFamily: theme.mono, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 10 }}>Ledger</div>
              {ledger.length === 0 ? (
                <div style={{ fontSize: 13, color: color.inkFaint }}>No entries.</div>
              ) : (
                ledger.map((entry) => (
                  <div key={entry.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '6px 0', borderTop: `1px solid ${color.lineSoft}` }}>
                    <span style={{ color: color.inkSoft }}>{entry.refType}</span>
                    <span style={{ fontFamily: theme.mono, fontVariantNumeric: 'tabular-nums' }}>
                      {Number(entry.debit) > 0 ? `Dr ${Number(entry.debit).toLocaleString('en-IN')}` : `Cr ${Number(entry.credit).toLocaleString('en-IN')}`}
                    </span>
                    <span style={{ fontFamily: theme.mono, fontVariantNumeric: 'tabular-nums', color: color.inkFaint }}>₹{Number(entry.balance).toLocaleString('en-IN')}</span>
                  </div>
                ))
              )}
            </div>

            <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 14, boxShadow: theme.shadowSm }}>
              <div style={{ fontFamily: theme.mono, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 10 }}>Payments</div>
              {partyPayments.length === 0 ? (
                <div style={{ fontSize: 13, color: color.inkFaint }}>No payments recorded.</div>
              ) : (
                partyPayments.map((p) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5, padding: '6px 0', borderTop: `1px solid ${color.lineSoft}` }}>
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ color: color.inkSoft }}>
                        {p.mode} · {p.direction === 'OUT' ? 'Payment Voucher' : 'Receipt'}
                      </span>
                      <span style={{ color: color.inkFaint, fontSize: 11 }}>{p.invoice?.number ?? '-'} · {new Date(p.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                    </span>
                    <span style={{ fontFamily: theme.mono, fontVariantNumeric: 'tabular-nums' }}>₹{Number(p.amount).toLocaleString('en-IN')}</span>
                  </div>
                ))
              )}
            </div>

            {partyInvoices.length > 0 && (
              <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 14, boxShadow: theme.shadowSm }}>
                <div style={{ fontFamily: theme.mono, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 10 }}>Invoice history</div>
                {partyInvoices.map((inv) => {
                  const sc = statusColor(inv.status);
                  return (
                    <div key={inv.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5, padding: '6px 0', borderTop: `1px solid ${color.lineSoft}` }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: theme.mono, fontSize: 9.5, padding: '1px 6px', borderRadius: 20, background: sc.bg, color: sc.fg }}>{inv.status}</span>
                        {inv.number}
                      </span>
                      <span style={{ fontFamily: theme.mono, fontVariantNumeric: 'tabular-nums' }}>₹{Number(inv.total).toLocaleString('en-IN')}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: theme.color.inkFaint, fontSize: 11 }}>{label}</div>
      <div style={{ fontFamily: theme.mono, fontVariantNumeric: 'tabular-nums', fontSize: 15, color: theme.color.ink }}>{value}</div>
    </div>
  );
}

const PARTY_COLUMNS: ExportColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'type', label: 'Type' },
  { key: 'gstin', label: 'GSTIN' },
  { key: 'balance', label: 'Balance' },
  { key: 'creditLimit', label: 'Credit Limit' },
];

function ExportToolbar({ parties }: { parties: Party[] }) {
  const rows = parties.map((p) => ({ ...p, balance: Number(p.balance).toLocaleString('en-IN') }));
  const btnStyle: React.CSSProperties = {
    padding: '6px 12px', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, background: color.paperRaised, cursor: 'pointer', fontSize: 12, color: color.inkSoft,
  };
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
      <button style={btnStyle} onClick={() => printRows('Parties', PARTY_COLUMNS, rows)}>Print</button>
      <button style={btnStyle} onClick={() => exportToExcel('parties', 'Parties', PARTY_COLUMNS, rows)}>Excel</button>
      <button style={btnStyle} onClick={() => exportToPdf('parties', 'Parties', PARTY_COLUMNS, rows)}>PDF</button>
    </div>
  );
}
