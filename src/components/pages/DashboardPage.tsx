import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingUp, TrendingDown, Wallet, PackageX, Receipt, ShoppingCart, PackagePlus } from 'lucide-react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

// RULES.md #2: types declared inline. docs/SPRINT_PLAN.md Step 11, Round 2 Step 3.
type Invoice = { id: string; number: string; total: string; date: string; party: { name: string } | null };
type Item = { id: string; sku: string; stockQty: string; minStock: string };
type Party = { id: string; name: string; balance: string; dueDate: string | null; overdue: boolean };
type Payment = { id: string; amount: string; mode: string; date: string; invoice?: { number: string } | null };

const { color } = theme;

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

// Round 13 — quick-action shortcuts (competitor table stakes: Vyapar/Marg
// both lead their dashboard with "New Sale"/"New Purchase" buttons). Typed
// narrowly rather than importing App.tsx's Tab (RULES.md #2/#11 — pages
// don't cross-import each other; App.tsx's onNavigate is just `setActiveTab`,
// whose param type is a superset of this).
export function DashboardPage({
  onSelectOverdueParty,
  onNavigate,
}: {
  onSelectOverdueParty: (partyId: string) => void;
  onNavigate: (tab: 'billing' | 'purchase' | 'items') => void;
}) {
  const { session } = useSession();
  const [todaysSales, setTodaysSales] = useState(0);
  const [yesterdaySales, setYesterdaySales] = useState(0);
  const [weekSales, setWeekSales] = useState<Invoice[]>([]);
  const [lowStockItems, setLowStockItems] = useState<Item[]>([]);
  const [outstandingParties, setOutstandingParties] = useState<Party[]>([]);
  const [recentPayments, setRecentPayments] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    (async () => {
      setLoading(true);
      try {
        const now = new Date();
        const today = isoDate(now);
        const yesterday = isoDate(new Date(now.getTime() - 86_400_000));
        const weekAgo = isoDate(new Date(now.getTime() - 6 * 86_400_000));

        const [todayRes, yesterdayRes, weekRes, lowStockRes, outstandingRes, paymentsRes] = await Promise.all([
          apiRequest<{ invoices: Invoice[] }>(`/companies/${session.companyId}/reports/sales?from=${today}&to=${today}`, { token: session.token }),
          apiRequest<{ invoices: Invoice[] }>(`/companies/${session.companyId}/reports/sales?from=${yesterday}&to=${yesterday}`, { token: session.token }),
          apiRequest<{ invoices: Invoice[] }>(`/companies/${session.companyId}/reports/sales?from=${weekAgo}&to=${today}`, { token: session.token }),
          apiRequest<{ items: Item[] }>(`/companies/${session.companyId}/items?lowStock=true`, { token: session.token }),
          apiRequest<{ parties: Party[] }>(`/companies/${session.companyId}/reports/outstanding`, { token: session.token }),
          apiRequest<{ payments: Payment[] }>(`/companies/${session.companyId}/payments`, { token: session.token }),
        ]);
        setTodaysSales(todayRes.invoices.reduce((s, i) => s + Number(i.total), 0));
        setYesterdaySales(yesterdayRes.invoices.reduce((s, i) => s + Number(i.total), 0));
        setWeekSales(weekRes.invoices);
        setLowStockItems([...lowStockRes.items].sort((a, b) => (Number(b.minStock) - Number(b.stockQty)) - (Number(a.minStock) - Number(a.stockQty))));
        setOutstandingParties([...outstandingRes.parties].sort((a, b) => Number(b.balance) - Number(a.balance)));
        setRecentPayments(paymentsRes.payments);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    })();
  }, [session]);

  const totalOutstanding = outstandingParties.reduce((s, p) => s + Number(p.balance), 0);
  const salesTrendPct = yesterdaySales > 0 ? Math.round(((todaysSales - yesterdaySales) / yesterdaySales) * 100) : null;

  // 7-day sparkline: bucket weekSales by date, oldest first
  const dayBuckets: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) dayBuckets[isoDate(new Date(Date.now() - i * 86_400_000))] = 0;
  for (const inv of weekSales) dayBuckets[isoDate(new Date(inv.date))] = (dayBuckets[isoDate(new Date(inv.date))] ?? 0) + Number(inv.total);
  const sparkValues = Object.values(dayBuckets);
  const sparkMax = Math.max(1, ...sparkValues);
  const sparkPoints = sparkValues.map((v, i) => `${(i / (sparkValues.length - 1)) * 100},${26 - (v / sparkMax) * 22}`).join(' ');

  // Activity feed: merge recent posted invoices + recent payments, newest first
  type Activity = { key: string; label: string; amount: number; date: string; positive: boolean };
  const activity: Activity[] = [
    ...weekSales.map((i): Activity => ({ key: `inv-${i.id}`, label: `${i.number} - ${i.party?.name ?? 'Walk-in'}`, amount: Number(i.total), date: i.date, positive: true })),
    ...recentPayments.map((p): Activity => ({ key: `pay-${p.id}`, label: `Payment (${p.mode})${p.invoice ? ' - ' + p.invoice.number : ''}`, amount: Number(p.amount), date: p.date, positive: true })),
  ]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 6);

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: 0, color: color.ink }}>Dashboard</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <QuickActionButton icon={<Receipt size={14} />} label="New Bill" onClick={() => onNavigate('billing')} primary />
          <QuickActionButton icon={<ShoppingCart size={14} />} label="New Purchase" onClick={() => onNavigate('purchase')} />
          <QuickActionButton icon={<PackagePlus size={14} />} label="New Item" onClick={() => onNavigate('items')} />
        </div>
      </div>

      {error && (
        <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, marginBottom: 16 }}>
        <StatCard
          icon={<TrendingUp size={17} />}
          label="Today's Sales"
          value={`₹${todaysSales.toLocaleString('en-IN')}`}
          trend={salesTrendPct}
          sparkPoints={sparkPoints}
          sparkColor={color.money}
          loading={loading}
        />
        <StatCard icon={<Wallet size={17} />} label="Outstanding" value={`₹${totalOutstanding.toLocaleString('en-IN')}`} badge={outstandingParties.length ? `${outstandingParties.length} ${outstandingParties.length === 1 ? 'party' : 'parties'}` : undefined} loading={loading} />
        <StatCard icon={<AlertTriangle size={17} />} label="Low Stock Items" value={String(lowStockItems.length)} loading={loading} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 14 }}>
        <Panel title="Alerts - by urgency">
          {lowStockItems.length === 0 && outstandingParties.length === 0 ? (
            <EmptyRow icon={<PackageX size={16} />} text="No alerts - all stocked up and paid up." />
          ) : (
            <>
              {lowStockItems.map((item) => (
                <AlertRow key={item.id} pillText="LOW STOCK" pillBg={color.amberTint} pillFg={color.amber} text={`${item.sku} - ${Number(item.stockQty)} left, min ${Number(item.minStock)}`} />
              ))}
              {outstandingParties.filter((p) => p.overdue).map((party) => (
                <AlertRow
                  key={party.id}
                  pillText="OVERDUE"
                  pillBg={color.alertTint}
                  pillFg={color.alert}
                  text={`${party.name} - ₹${Number(party.balance).toLocaleString('en-IN')}`}
                  onClick={() => onSelectOverdueParty(party.id)}
                />
              ))}
            </>
          )}
        </Panel>

        <Panel title="Recent activity">
          {activity.length === 0 ? (
            <EmptyRow text="Nothing yet - post a bill to see it here." />
          ) : (
            activity.map((a) => (
              <div key={a.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: `1px solid ${color.lineSoft}`, fontSize: 13 }}>
                <span style={{ color: color.inkSoft }}>{a.label}</span>
                <span style={{ fontFamily: theme.mono, color: color.money, fontVariantNumeric: 'tabular-nums' }}>+₹{a.amount.toLocaleString('en-IN')}</span>
              </div>
            ))
          )}
        </Panel>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  trend,
  badge,
  sparkPoints,
  sparkColor,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  trend?: number | null;
  badge?: string;
  sparkPoints?: string;
  sparkColor?: string;
  loading?: boolean;
}) {
  return (
    <div style={{ flex: 1, background: color.paperRaised, borderRadius: theme.radius, padding: '14px 16px', border: `1px solid ${color.line}`, boxShadow: theme.shadowSm }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ color: color.inkFaint, display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
          {icon}
          {label}
        </div>
        {trend !== undefined && trend !== null && (
          <span
            style={{
              fontFamily: theme.mono,
              fontSize: 10.5,
              padding: '1px 7px',
              borderRadius: 20,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              background: trend >= 0 ? color.moneyTint : color.alertTint,
              color: trend >= 0 ? color.money : color.alert,
            }}
          >
            {trend >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
            {Math.abs(trend)}%
          </span>
        )}
        {badge && <span style={{ fontFamily: theme.mono, fontSize: 10.5, padding: '1px 7px', borderRadius: 20, background: color.amberTint, color: color.amber }}>{badge}</span>}
      </div>
      <div style={{ fontFamily: theme.mono, fontSize: 22, fontVariantNumeric: 'tabular-nums', marginBottom: sparkPoints ? 6 : 0, color: color.ink }}>
        {loading ? '-' : value}
      </div>
      {sparkPoints && (
        <svg viewBox="0 0 100 26" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 26 }}>
          <polyline points={sparkPoints} fill="none" stroke={sparkColor} strokeWidth={2} />
        </svg>
      )}
    </div>
  );
}

function QuickActionButton({ icon, label, onClick, primary }: { icon: React.ReactNode; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
        border: `1px solid ${primary ? color.brass : color.line}`, background: primary ? color.brass : color.paperRaised, color: primary ? '#fff' : color.inkSoft,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: color.paperRaised, borderRadius: theme.radius, padding: '14px 16px', border: `1px solid ${color.line}`, boxShadow: theme.shadowSm }}>
      <div style={{ fontFamily: theme.mono, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function AlertRow({ pillText, pillBg, pillFg, text, onClick }: { pillText: string; pillBg: string; pillFg: string; text: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: `1px solid ${color.lineSoft}`, fontSize: 13, cursor: onClick ? 'pointer' : 'default' }}
    >
      <span style={{ fontFamily: theme.mono, fontSize: 10, padding: '2px 7px', borderRadius: 20, background: pillBg, color: pillFg, flexShrink: 0 }}>{pillText}</span>
      <span style={{ color: color.inkSoft }}>{text}</span>
    </div>
  );
}

function EmptyRow({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: color.inkFaint, padding: '8px 0' }}>
      {icon}
      {text}
    </div>
  );
}
