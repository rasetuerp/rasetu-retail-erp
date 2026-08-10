import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard, Package, Receipt, ShoppingCart, Users, UserCog, BarChart3, Tag, LogOut, Settings, Menu, PackagePlus, FileText, LayoutTemplate,
  Bell, ClipboardList, Printer, HelpCircle, ChevronDown, ShieldCheck, X, RefreshCw, Download,
} from 'lucide-react';

import { DashboardPage } from './components/pages/DashboardPage';
import { ItemMasterPage } from './components/pages/ItemMasterPage';
import { BulkStockEntryPage } from './components/pages/BulkStockEntryPage';
import { BillingPage } from './components/pages/BillingPage';
import { InvoicesPage } from './components/pages/InvoicesPage';
import { PurchasePage } from './components/pages/PurchasePage';
import { PartiesPage } from './components/pages/PartiesPage';
import { ReportsPage } from './components/pages/ReportsPage';
import { LabelsPage } from './components/pages/LabelsPage';
import { LabelDesignerPage } from './components/pages/LabelDesignerPage';
import { SettingsPage, type SectionKey } from './components/pages/SettingsPage';
import { UsersPage } from './components/pages/UsersPage';
import { SetupWizardPage } from './components/pages/SetupWizardPage';
import { useSession } from './lib/session';
import { apiRequest, setUnauthorizedHandler, setDriveDisconnectedHandler } from './lib/api';
import { activateLicense, getStartupLicenseStatus, revalidateLicenseInBackground, getOfflineGraceInfo, LicenseError, type StartupLicenseStatus } from './lib/license';
import { theme } from './lib/theme';
import type { PrinterConfig, ThermalLayout, A4Layout } from './lib/rasetu-bridge';
import type { ReceiptSettings } from './lib/invoicePrint';

const { color } = theme;

// RULES.md #11: one page = one file, MainApp + PageContent + setActiveTab.
// RULES.md #1: inline style objects only, no CSS frameworks.

type Tab = 'dashboard' | 'items' | 'bulk-stock' | 'billing' | 'invoices' | 'purchase' | 'parties' | 'reports' | 'labels' | 'label-designer' | 'users' | 'settings';

// Round 3: 'users' (Team & Access) is never STAFF-assignable — only
// ADMIN/SUPER_ADMIN manage accounts/permissions, so it's excluded from
// visibleTabs() below regardless of a STAFF user's `permissions` field.
const NAV: Array<{ tab: Tab; label: string; icon: typeof LayoutDashboard }> = [
  { tab: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { tab: 'billing', label: 'GST Billing', icon: Receipt },
  { tab: 'invoices', label: 'Invoice History', icon: FileText },
  { tab: 'items', label: 'Item / Stock Master', icon: Package },
  { tab: 'bulk-stock', label: 'Bulk Stock Entry', icon: PackagePlus },
  { tab: 'purchase', label: 'Purchase Entry', icon: ShoppingCart },
  { tab: 'parties', label: 'Parties & Ledger', icon: Users },
  { tab: 'reports', label: 'Reports & GST Pack', icon: BarChart3 },
  { tab: 'labels', label: 'Barcode Labels', icon: Tag },
  { tab: 'label-designer', label: 'Label Designer', icon: LayoutTemplate },
  { tab: 'users', label: 'Team & Access', icon: UserCog },
  { tab: 'settings', label: 'Settings', icon: Settings },
];

// ADMIN/SUPER_ADMIN always see every tab. STAFF sees everything unless
// `permissions` is a non-null array (Round 3 — set from Team & Access), in
// which case only those tabs show, and 'users' never shows regardless.
// Round 5 — 'bulk-stock' and 'invoices' piggyback on existing permissions
// ('items' and 'billing' respectively) rather than adding new
// separately-assignable permission values on the backend.
function visibleTabs(user: { role: 'ADMIN' | 'STAFF' | 'SUPER_ADMIN'; permissions?: string[] | null }) {
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return NAV;
  return NAV.filter((item) => {
    if (item.tab === 'users') return false;
    if (!user.permissions) return true;
    if (item.tab === 'bulk-stock') return user.permissions.includes('items');
    if (item.tab === 'invoices') return user.permissions.includes('billing');
    if (item.tab === 'label-designer') return user.permissions.includes('labels');
    return user.permissions.includes(item.tab);
  });
}

function PageContent({
  activeTab,
  selectedPartyId,
  onNavigateToParty,
  onPartyConsumed,
  billingPartyId,
  onStartExchange,
  onBillingPartyConsumed,
  onNavigate,
  settingsInitialSection,
}: {
  activeTab: Tab;
  selectedPartyId: string | null;
  onNavigateToParty: (partyId: string) => void;
  onPartyConsumed: () => void;
  billingPartyId: string | null;
  onStartExchange: (partyId: string) => void;
  onBillingPartyConsumed: () => void;
  onNavigate: (tab: Tab) => void;
  settingsInitialSection?: SectionKey;
}) {
  switch (activeTab) {
    case 'dashboard':
      return <DashboardPage onSelectOverdueParty={onNavigateToParty} onNavigate={onNavigate} />;
    case 'items':
      return <ItemMasterPage />;
    case 'bulk-stock':
      return <BulkStockEntryPage />;
    case 'billing':
      return <BillingPage initialPartyId={billingPartyId} onInitialPartyConsumed={onBillingPartyConsumed} />;
    case 'invoices':
      return <InvoicesPage onStartExchange={onStartExchange} />;
    case 'purchase':
      return <PurchasePage />;
    case 'parties':
      return <PartiesPage initialSelectedPartyId={selectedPartyId} onInitialSelectedHandled={onPartyConsumed} />;
    case 'reports':
      return <ReportsPage />;
    case 'labels':
      return <LabelsPage />;
    case 'label-designer':
      return <LabelDesignerPage />;
    case 'users':
      return <UsersPage />;
    case 'settings':
      return <SettingsPage initialSection={settingsInitialSection} />;
    default:
      return null;
  }
}

// Round 4 — one license per installed copy, gates the whole app (before even
// the company picker). Checked offline on boot (electron/main.ts's
// rt:license-startup-status — the cached token's own signature+expiry IS the
// offline grace period); window.rasetu is absent in the plain browser
// preview, so the gate is a no-op there (desktop-only feature, same
// precedent as LabelsPage.tsx's printer bridge).
function LicenseGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<StartupLicenseStatus | 'checking' | 'not-desktop'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.rasetu) {
      setStatus('not-desktop');
      return;
    }
    void getStartupLicenseStatus().then((result) => {
      setStatus(result);
      if (result.hasValidLicense) void revalidateLicenseInBackground();
    });
  }, []);

  async function handleActivate() {
    setError(null);
    setActivating(true);
    try {
      await activateLicense(keyRef.current?.value.trim() ?? '');
      setStatus(await getStartupLicenseStatus());
    } catch (err) {
      setError(err instanceof LicenseError ? err.message : 'Activation failed. Check your license key and internet connection.');
    } finally {
      setActivating(false);
    }
  }

  if (status === 'checking') return null;
  if (status === 'not-desktop') return <>{children}</>;

  // Round 9 — past the 7-day soft grace but still within the cached token's
  // 30-day validUntil: the app stays fully usable, but shows a persistent
  // top banner naming the exact reconnect-by date (mirrors GoBilling's own
  // offlineStatus() hard-warning state). Once validUntil itself passes,
  // rt:license-startup-status already flips hasValidLicense to false and
  // the blocked screen below takes over — no separate "expired" banner here.
  if (status.hasValidLicense) {
    const grace = getOfflineGraceInfo(status.snapshot.lastValidAt, status.license.validUntil);
    if (grace.state === 'warning') {
      return (
        <>
          <div
            style={{
              padding: '9px 20px',
              background: color.amberTint,
              color: color.amber,
              fontSize: 13,
              fontWeight: 600,
              textAlign: 'center',
              borderBottom: `1px solid ${color.amber}33`,
            }}
          >
            {grace.message}
          </div>
          {children}
        </>
      );
    }
    return <>{children}</>;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: color.paper, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <div style={{ width: 380, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 28, boxShadow: theme.shadow }}>
        <img src="/branding/rasetu-logo-full-dark.png" alt="RaSetu" style={{ height: 34, marginBottom: 4, display: 'block' }} />
        <div style={{ fontSize: 10, color: '#5C6B78', marginBottom: 16 }}>A brand of Ratan Business Solutions</div>
        <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>Enter your license key to continue.</p>
        {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: color.inkSoft, marginBottom: 14 }}>
          License key
          <input
            ref={keyRef}
            defaultValue=""
            placeholder="RTL-TRIAL-XXXX-XXXX"
            style={{ padding: 9, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14, fontFamily: theme.mono, textTransform: 'uppercase' }}
          />
          {/* Round 10 — RTL- keys are RaSetu-specific; RBS- keys are issued by
              Ratan Business Solutions across products (bundles, resellers,
              future products) and work identically here. Both accepted -
              license-activate matches the key string exactly, no prefix
              parsing - this note just says so, since the placeholder above
              only shows one example. */}
          <span style={{ fontSize: 10.5, color: color.inkFaint, fontWeight: 400 }}>Also accepts RBS- keys issued by Ratan Business Solutions.</span>
        </label>
        <button
          onClick={() => void handleActivate()}
          disabled={activating}
          style={{ width: '100%', padding: '11px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
        >
          {activating ? 'Activating…' : 'Activate'}
        </button>
      </div>
    </div>
  );
}

function topBarIconBtn(active: boolean): React.CSSProperties {
  return {
    position: 'relative',
    background: active ? color.brassTint : 'transparent',
    border: active ? `1px solid ${color.brass}55` : '1px solid transparent',
    borderRadius: theme.radiusSm,
    padding: '6px 8px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    color: active ? color.brass : color.inkSoft,
  };
}

const profileMenuItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, border: 'none', background: 'transparent', color: color.ink,
  padding: '10px 12px', width: '100%', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
};

// Round 22 — top-bar quick-glance popover reusing the exact same "low stock"
// and "overdue party" data DashboardPage.tsx already fetches
// (GET /items?lowStock=true, GET /reports/outstanding) rather than a second
// definition of either — Dashboard's own cards stay the canonical detailed
// view; this is just a badge + short list.
type AlertItem = { id: string; sku: string; stockQty: string; minStock: string };
type AlertParty = { id: string; name: string; balance: string; overdue: boolean };

function AlertsBell({
  open,
  onToggle,
  onClose,
  onNavigate,
  onNavigateToParty,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNavigate: (tab: 'items' | 'parties') => void;
  onNavigateToParty: (partyId: string) => void;
}) {
  const { session } = useSession();
  const [lowStock, setLowStock] = useState<AlertItem[]>([]);
  const [overdue, setOverdue] = useState<AlertParty[]>([]);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) return;
    void Promise.all([
      apiRequest<{ items: AlertItem[] }>(`/companies/${session.companyId}/items?lowStock=true`, { token: session.token }),
      apiRequest<{ parties: AlertParty[] }>(`/companies/${session.companyId}/reports/outstanding`, { token: session.token }),
    ])
      .then(([itemsRes, partiesRes]) => {
        setLowStock(itemsRes.items);
        setOverdue(partiesRes.parties.filter((p) => p.overdue));
        setLoaded(true);
      })
      .catch(() => {});
  }, [session]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onClose]);

  const count = lowStock.length + overdue.length;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={onToggle} title="Alerts" aria-label="Alerts" style={topBarIconBtn(open)}>
        <Bell size={18} />
        {loaded && count > 0 && (
          <span style={{ position: 'absolute', top: 2, right: 2, minWidth: 15, height: 15, borderRadius: 999, background: color.alert, color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>
            {count}
          </span>
        )}
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 44, right: 0, width: 300, maxHeight: 380, overflowY: 'auto', background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, boxShadow: theme.shadow, zIndex: 30 }}>
          <div style={{ padding: '10px 14px', fontSize: 11, fontFamily: theme.mono, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, borderBottom: `1px solid ${color.lineSoft}` }}>
            Alerts
          </div>
          {count === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: color.inkFaint, textAlign: 'center' }}>All clear - nothing needs attention.</div>
          ) : (
            <>
              {lowStock.slice(0, 6).map((item) => (
                <button key={item.id} onClick={() => onNavigate('items')} style={alertRow}>
                  <span style={{ ...alertPill, background: color.amberTint, color: color.amber }}>LOW STOCK</span>
                  {item.sku} - {Number(item.stockQty)} left, min {Number(item.minStock)}
                </button>
              ))}
              {overdue.slice(0, 6).map((party) => (
                <button key={party.id} onClick={() => onNavigateToParty(party.id)} style={alertRow}>
                  <span style={{ ...alertPill, background: color.alertTint, color: color.alert }}>OVERDUE</span>
                  {party.name} - ₹{Number(party.balance).toLocaleString('en-IN')}
                </button>
              ))}
              {(lowStock.length > 6 || overdue.length > 6) && (
                <div style={{ padding: '8px 14px', fontSize: 11, color: color.inkFaint, textAlign: 'center' }}>See Dashboard for the full list.</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const alertRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', borderBottom: `1px solid ${color.lineSoft}`,
  background: 'transparent', padding: '9px 14px', fontSize: 12.5, color: color.ink, cursor: 'pointer', textAlign: 'left',
};
const alertPill: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, padding: '2px 6px', borderRadius: 999, flexShrink: 0 };

// Round 22 — a free-text scratchpad persisted per company via a new
// Setting-JSON key (backend/src/routes/companies.ts's quick-notepad
// GET/PUT), same pattern as receipt settings/payment modes. Simplified from
// GoBilling's own QuickNotepad (gobilling-erp/src/App.tsx lines 457-530) —
// one direct GET/PUT instead of its generic loadPageState/savePageState
// helper, since this is the only page-state blob RaSetu needs so far.
function QuickNotepad({ session, onClose }: { session: NonNullable<ReturnType<typeof useSession>['session']>; onClose: () => void }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void apiRequest<{ notepad: { text: string } }>(`/companies/${session.companyId}/quick-notepad`, { token: session.token })
      .then((res) => setText(res.notepad.text))
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.companyId]);

  async function save() {
    setSaving(true);
    try {
      await apiRequest(`/companies/${session.companyId}/quick-notepad`, { method: 'PUT', token: session.token, body: { text } });
    } catch {
      // best-effort — a failed autosave shouldn't block typing further notes
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', top: 74, right: 20, width: 280, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, boxShadow: theme.shadow, zIndex: 40, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: color.ink }}>Quick Notepad</strong>
        <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: color.inkFaint, cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        placeholder={loading ? 'Loading…' : 'Jot down a quick note…'}
        disabled={loading}
        style={{ width: '100%', height: 160, padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
      />
      <div style={{ fontSize: 10.5, color: color.inkFaint, marginTop: 4 }}>{saving ? 'Saving…' : 'Saves automatically when you click away.'}</div>
    </div>
  );
}

// Round 23 — one consolidated place to pick, per document type, which
// physical printer handles it and configure that printer's own settings.
// Before this, the modal edited a single in-memory-only settings object
// shared by receipt AND label printing (no way to tell RaSetu they're two
// different physical printers), and had no effect at all on A4/A5 invoices
// (those bypassed the printer bridge entirely) — see electron/printer-config.ts.
function PrinterSettingsModal({ onClose }: { onClose: () => void }) {
  const { session } = useSession();
  const [config, setConfig] = useState<PrinterConfig | null>(null);
  const [receiptSettings, setReceiptSettings] = useState<ReceiptSettings | null>(null);
  const [printers, setPrinters] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState<'receipt' | 'receiptPaper' | 'label' | 'invoice' | null>(null);

  useEffect(() => {
    if (!window.rasetu) {
      setError('Printer settings are only available in the desktop app.');
      return;
    }
    void window.rasetu.printer.getConfig().then(setConfig);
    void window.rasetu.printer.listPrinters().then((p) => setPrinters(p as string[]));
    if (session) {
      void apiRequest<{ settings: ReceiptSettings }>(`/companies/${session.companyId}/invoices/receipt-settings`, { token: session.token }).then((res) => setReceiptSettings(res.settings));
    }
  }, [session]);

  function patch<K extends keyof PrinterConfig>(role: K, value: Partial<PrinterConfig[K]>) {
    setConfig((prev) => (prev ? { ...prev, [role]: { ...prev[role], ...value } } : prev));
  }

  function fieldLabel(key: keyof PrinterConfig['label'], value: number) {
    patch('label', { [key]: value } as Partial<PrinterConfig['label']>);
  }

  const numLabel = (key: keyof PrinterConfig['label'], fallback = 0) => Number(config?.label[key] ?? fallback);

  function patchReceiptPaper(value: Partial<Pick<ReceiptSettings, 'columns' | 'marginLeftChars' | 'marginRightChars'>>) {
    setReceiptSettings((prev) => (prev ? { ...prev, ...value } : prev));
  }

  async function saveRole(role: 'receipt' | 'label' | 'invoice') {
    if (!window.rasetu || !config) return;
    setSaving(role);
    setStatus(null);
    setError(null);
    try {
      if (role === 'label') {
        // Round-trips through the existing per-field save path so the live
        // PrinterManager instance updates immediately (Round 22 behavior).
        await window.rasetu.printer.savePrinterSettings('label', config.label);
      } else {
        await window.rasetu.printer.saveConfig(role, config[role]);
      }
      setStatus('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save printer settings.');
    } finally {
      setSaving(null);
    }
  }

  async function printTest(role: 'receipt' | 'label') {
    if (!window.rasetu) return;
    setStatus(null);
    setError(null);
    try {
      const result = (await window.rasetu.printer.printTest(role)) as { message?: string; success?: boolean };
      setStatus(result.message ?? (result.success ? 'Test sent.' : 'Test print failed.'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test print failed.');
    }
  }

  async function saveReceiptPaper() {
    if (!session || !receiptSettings) return;
    setSaving('receiptPaper');
    setStatus(null);
    setError(null);
    try {
      const res = await apiRequest<{ settings: ReceiptSettings }>(`/companies/${session.companyId}/invoices/receipt-settings`, {
        method: 'PUT',
        token: session.token,
        body: receiptSettings,
      });
      setReceiptSettings(res.settings);
      setStatus('Saved receipt paper width.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save receipt paper width.');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: color.paperRaised, borderRadius: theme.radius, boxShadow: theme.shadow, width: 480, maxHeight: '88vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <strong style={{ fontSize: 16, color: color.ink }}>Printer Settings</strong>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: color.inkFaint, cursor: 'pointer', display: 'flex' }}><X size={18} /></button>
        </div>

        {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {status && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{status}</div>}

        {config && (
          <>
            <div style={pdSection}>
              <div style={pdSectionTitle}>Receipt Printer</div>
              <div style={pdSectionSubtitle}>Thermal receipts printed from Billing.</div>
              <label style={pdLabelFull}>
                Printer
                <select value={config.receipt.printerName} onChange={(e) => patch('receipt', { printerName: e.target.value })} style={pdSelect}>
                  <option value="">Not set (uses system default)</option>
                  {printers.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label style={pdLabelFull}>
                Default layout
                <select value={config.receipt.defaultLayout} onChange={(e) => patch('receipt', { defaultLayout: e.target.value as ThermalLayout })} style={pdSelect}>
                  <option value="receipt">Receipt (narrow)</option>
                  <option value="compact">Compact</option>
                  <option value="standard">Standard</option>
                  <option value="detailed">Detailed</option>
                </select>
              </label>
              {receiptSettings && (
                <>
                  <label style={pdLabelFull}>
                    Paper width
                    <select value={receiptSettings.columns} onChange={(e) => patchReceiptPaper({ columns: Number(e.target.value) })} style={pdSelect}>
                      <option value={32}>58mm / 2 inch roll (32 columns)</option>
                      <option value={48}>80mm / 3 inch roll (48 columns)</option>
                    </select>
                  </label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    <label style={pdLabel}>
                      Left margin (chars)
                      <input type="number" min={0} max={12} value={receiptSettings.marginLeftChars ?? 0} onChange={(e) => patchReceiptPaper({ marginLeftChars: Number(e.target.value) || 0 })} style={pdInput} />
                    </label>
                    <label style={pdLabel}>
                      Right margin (chars)
                      <input type="number" min={0} max={12} value={receiptSettings.marginRightChars ?? 0} onChange={(e) => patchReceiptPaper({ marginRightChars: Number(e.target.value) || 0 })} style={pdInput} />
                    </label>
                  </div>
                </>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => void saveRole('receipt')} disabled={saving === 'receipt'} style={pdSaveBtn}>{saving === 'receipt' ? 'Saving…' : 'Save'}</button>
                {receiptSettings && <button onClick={() => void saveReceiptPaper()} disabled={saving === 'receiptPaper'} style={pdSaveBtn}>{saving === 'receiptPaper' ? 'Saving...' : 'Save Paper'}</button>}
                <button onClick={() => void printTest('receipt')} style={pdTestBtn}>Print Test</button>
              </div>
            </div>

            <div style={pdSection}>
              <div style={pdSectionTitle}>Label Printer</div>
              <div style={pdSectionSubtitle}>Barcode/price-tag labels printed from Label Designer and Bulk Stock Entry.</div>
              <label style={pdLabelFull}>
                Printer
                <select value={config.label.name} onChange={(e) => patch('label', { name: e.target.value })} style={pdSelect}>
                  <option value="">Not set (uses system default)</option>
                  {printers.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <div style={{ background: color.paper, border: `1px solid ${color.lineSoft}`, borderRadius: theme.radiusSm, padding: 10, fontSize: 11.5, color: color.inkSoft, lineHeight: 1.45, marginBottom: 10 }}>
                Label size and gap are taken from the selected Label Designer template, so the printed label uses the same width and height shown in Live Preview.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <label style={pdLabel}>
                  Global X nudge (mm)
                  <input type="number" value={numLabel('marginLeft')} onChange={(e) => fieldLabel('marginLeft', Number(e.target.value) || 0)} style={pdInput} />
                </label>
                <label style={pdLabel}>
                  Global Y nudge (mm)
                  <input type="number" value={numLabel('marginTop')} onChange={(e) => fieldLabel('marginTop', Number(e.target.value) || 0)} style={pdInput} />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <label style={pdLabel}>
                  Darkness (0-15)
                  <input type="number" min={0} max={15} value={numLabel('darknessFactor')} onChange={(e) => fieldLabel('darknessFactor', Math.max(0, Math.min(15, Number(e.target.value) || 0)))} style={pdInput} />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => void saveRole('label')} disabled={saving === 'label'} style={pdSaveBtn}>{saving === 'label' ? 'Saving…' : 'Save'}</button>
                <button onClick={() => void printTest('label')} style={pdTestBtn}>Print Test Label</button>
              </div>
            </div>

            <div style={{ ...pdSection, borderBottom: 'none', marginBottom: 0, paddingBottom: 0 }}>
              <div style={pdSectionTitle}>Invoice Printer (A4/A5)</div>
              <div style={pdSectionSubtitle}>Full-page GST invoices printed from Billing and Invoice History.</div>
              <label style={pdLabelFull}>
                Printer
                <select value={config.invoice.printerName} onChange={(e) => patch('invoice', { printerName: e.target.value })} style={pdSelect}>
                  <option value="">Not set (shows the print dialog)</option>
                  {printers.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label style={pdLabelFull}>
                Default layout
                <select value={config.invoice.defaultLayout} onChange={(e) => patch('invoice', { defaultLayout: e.target.value as A4Layout })} style={pdSelect}>
                  <option value="a4">A4</option>
                  <option value="a5">A5</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: color.inkSoft, margin: '10px 0' }}>
                <input type="checkbox" checked={config.invoice.silent} onChange={(e) => patch('invoice', { silent: e.target.checked })} />
                Print silently (skip the printer dialog)
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => void saveRole('invoice')} disabled={saving === 'invoice'} style={pdSaveBtn}>{saving === 'invoice' ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const pdSection: React.CSSProperties = { borderBottom: `1px solid ${color.line}`, marginBottom: 16, paddingBottom: 16 };
const pdSectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: color.ink, marginBottom: 2 };
const pdSectionSubtitle: React.CSSProperties = { fontSize: 11, color: color.inkFaint, marginBottom: 10 };
const pdLabelFull: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft, marginBottom: 8 };
const pdSelect: React.CSSProperties = { padding: 7, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13, width: '100%', boxSizing: 'border-box' };
const pdSaveBtn: React.CSSProperties = { padding: '9px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const pdTestBtn: React.CSSProperties = { padding: '9px 16px', background: color.ledger, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13 };
const pdLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft };
const pdInput: React.CSSProperties = { padding: 7, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13, width: 90 };

function AppShell() {
  const { session, setSession } = useSession();
  const [activeTab, setActiveTab] = useState<Tab>(() => (session ? (visibleTabs(session.user)[0]?.tab ?? 'dashboard') : 'dashboard'));
  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(null);
  // Round 10 — "Bill a replacement now" from a Sales Return, same
  // navigate-with-an-id-then-consume-it pattern as selectedPartyId above.
  const [billingPartyId, setBillingPartyId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [driveDisconnectedMessage, setDriveDisconnectedMessage] = useState<string | null>(null);
  // Round 22 — top bar's Help/My Account buttons deep-link into Settings on
  // a specific section, same navigate-with-a-value pattern as
  // selectedPartyId/billingPartyId above. Cleared right after each
  // navigation (Settings mounting fresh each visit already consumes it via
  // its own initialSection default, so there's nothing to "un-consume").
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionKey | undefined>(undefined);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [notepadOpen, setNotepadOpen] = useState(false);
  const [printerSettingsOpen, setPrinterSettingsOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloaded' | 'error'>('idle');
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!profileMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) setProfileMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [profileMenuOpen]);

  // A token expiring mid-shift should drop the user back to the login gate,
  // not leave every page stuck showing "Invalid or expired token" over
  // stale data — see src/lib/api.ts.
  useEffect(() => {
    setUnauthorizedHandler(() => setSession(null));
    return () => setUnauthorizedHandler(null);
  }, [setSession]);

  // Round 9 — an externally-stored company's drive can be unplugged
  // mid-session; the backend detects the failed read/write and reports
  // DRIVE_DISCONNECTED (backend/src/app.ts) instead of a generic 500. Block
  // further work with a clear message rather than letting every page keep
  // failing silently against a company whose data just went offline.
  useEffect(() => {
    setDriveDisconnectedHandler((message) => setDriveDisconnectedMessage(message));
    return () => setDriveDisconnectedHandler(null);
  }, []);

  useEffect(() => {
    if (!window.rasetu) return;
    return window.rasetu.onUpdateStatus((payload) => {
      const status = (payload as { status?: string })?.status;
      if (status === 'available') {
        setUpdateStatus('available');
        setUpdateMessage('Update found. Downloading...');
      } else if (status === 'downloaded') {
        setUpdateStatus('downloaded');
        setUpdateMessage('Update ready to install.');
      }
    });
  }, []);

  async function checkForUpdates() {
    if (!window.rasetu) {
      setUpdateStatus('error');
      setUpdateMessage('Updates are only available in the desktop app.');
      return;
    }
    setUpdateStatus('checking');
    setUpdateMessage('Checking for updates...');
    try {
      const result = (await window.rasetu.checkForUpdates()) as { updateInfo?: unknown } | null;
      if (!result?.updateInfo) {
        setUpdateStatus('idle');
        setUpdateMessage('You are on the latest version.');
      }
    } catch (err) {
      setUpdateStatus('error');
      setUpdateMessage(err instanceof Error ? err.message : 'Update check failed.');
    }
  }

  async function installUpdate() {
    if (!window.rasetu) return;
    await window.rasetu.installUpdate();
  }

  // No session → Setup Wizard / Login gate (docs/SCOPE.md #1). No sidebar until
  // a company + admin account exist.
  if (!session) {
    return <SetupWizardPage />;
  }

  if (driveDisconnectedMessage) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: color.paper, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
        <div style={{ width: 380, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 28, boxShadow: theme.shadow, textAlign: 'center' }}>
          <img src="/branding/rasetu-logo-full-dark.png" alt="RaSetu" style={{ height: 34, marginBottom: 12, display: 'block', marginLeft: 'auto', marginRight: 'auto' }} />
          <p style={{ color: color.alert, fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>Drive disconnected</p>
          <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>{driveDisconnectedMessage}</p>
          <button
            onClick={() => { setDriveDisconnectedMessage(null); setSession(null); }}
            style={{ width: '100%', padding: '11px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
          >
            Reconnect drive & continue
          </button>
        </div>
      </div>
    );
  }

  const initial = session.user.name.trim().charAt(0).toUpperCase() || '?';
  const sidebarWidth = sidebarCollapsed ? 64 : 240;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      {/* Top bar — full width, sits above the sidebar+content row (GoBilling's
          layout pattern: branding + the sidebar collapse toggle live here,
          not inside the sidebar itself). */}
      <div
        style={{
          height: 64,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '0 20px',
          background: color.paperRaised,
          borderBottom: `1px solid ${color.line}`,
          boxShadow: theme.shadowSm,
        }}
      >
        <button
          onClick={() => setSidebarCollapsed((v) => !v)}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: color.inkSoft, display: 'flex', padding: 6, borderRadius: theme.radiusSm }}
        >
          <Menu size={19} />
        </button>
        <img src="/branding/rasetu-logo-full-dark.png" alt="RaSetu" style={{ height: 26, display: 'block' }} />
        <div style={{ flex: 1 }} />

        <AlertsBell
          open={alertsOpen}
          onToggle={() => setAlertsOpen((v) => !v)}
          onClose={() => setAlertsOpen(false)}
          onNavigate={(tab) => { setAlertsOpen(false); setActiveTab(tab); }}
          onNavigateToParty={(partyId) => { setAlertsOpen(false); setSelectedPartyId(partyId); setActiveTab('parties'); }}
        />

        <button
          onClick={() => setNotepadOpen((v) => !v)}
          title="Quick Notepad"
          aria-label="Quick Notepad"
          style={topBarIconBtn(notepadOpen)}
        >
          <ClipboardList size={18} />
        </button>

        <button
          onClick={() => setPrinterSettingsOpen(true)}
          title="Printer Settings"
          aria-label="Printer Settings"
          style={topBarIconBtn(printerSettingsOpen)}
        >
          <Printer size={18} />
        </button>

        <button
          onClick={() => { setSettingsInitialSection('help'); setActiveTab('settings'); }}
          title="Help & FAQ"
          aria-label="Help and FAQ"
          style={topBarIconBtn(activeTab === 'settings' && settingsInitialSection === 'help')}
        >
          <HelpCircle size={18} />
        </button>

        <div ref={profileMenuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setProfileMenuOpen((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px 4px 4px',
              border: `1px solid ${color.line}`, borderRadius: 999, background: color.paper, cursor: 'pointer',
            }}
          >
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: color.ledger, color: color.brass, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>
              {initial}
            </div>
            <div style={{ lineHeight: 1.15, textAlign: 'left' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: color.ink }}>{session.user.name}</div>
              <div style={{ fontSize: 10.5, color: color.inkFaint, textTransform: 'uppercase', letterSpacing: 0.4 }}>{session.user.role}</div>
            </div>
            <ChevronDown size={14} color={color.inkFaint} />
          </button>
          {profileMenuOpen && (
            <div style={{ position: 'absolute', top: 44, right: 0, width: 220, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, boxShadow: theme.shadow, zIndex: 30, overflow: 'hidden' }}>
              <button
                onClick={() => { setProfileMenuOpen(false); setSettingsInitialSection('account'); setActiveTab('settings'); }}
                style={profileMenuItem}
              >
                <UserCog size={15} /> My Account
              </button>
              <button
                onClick={() => { setProfileMenuOpen(false); setSettingsInitialSection('help'); setActiveTab('settings'); }}
                style={profileMenuItem}
              >
                <ShieldCheck size={15} /> Help & FAQ
              </button>
              <button
                onClick={() => void checkForUpdates()}
                disabled={updateStatus === 'checking'}
                style={{ ...profileMenuItem, borderTop: `1px solid ${color.lineSoft}`, opacity: updateStatus === 'checking' ? 0.65 : 1 }}
              >
                <RefreshCw size={15} /> {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
              </button>
              {updateStatus === 'downloaded' && (
                <button
                  onClick={() => void installUpdate()}
                  style={{ ...profileMenuItem, color: color.money, borderTop: `1px solid ${color.lineSoft}` }}
                >
                  <Download size={15} /> Install Update
                </button>
              )}
              <div style={{ padding: '8px 12px', fontSize: 10.5, color: updateStatus === 'error' ? color.alert : color.inkFaint, borderTop: `1px solid ${color.lineSoft}` }}>
                v0.1.0{updateMessage ? ` - ${updateMessage}` : ''}
              </div>
              <button
                onClick={() => { setProfileMenuOpen(false); setSession(null); }}
                style={{ ...profileMenuItem, color: color.alert, borderTop: `1px solid ${color.lineSoft}` }}
              >
                <LogOut size={15} /> Sign Out
              </button>
            </div>
          )}
        </div>
      </div>

      {notepadOpen && <QuickNotepad session={session} onClose={() => setNotepadOpen(false)} />}
      {printerSettingsOpen && <PrinterSettingsModal onClose={() => setPrinterSettingsOpen(false)} />}

      {session.user.role === 'SUPER_ADMIN' && (
        <div style={{ padding: '8px 16px', fontSize: 13, fontFamily: theme.mono, background: color.amberTint, color: color.amber, borderBottom: `1px solid ${color.amber}33` }}>
          Support mode - accessing this shop's data as RaSetu vendor support. This access is logged.
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav
          style={{
            width: sidebarWidth,
            flexShrink: 0,
            background: `linear-gradient(180deg, ${color.ledger} 0%, ${color.ledgerRaised} 52%, ${color.ledger} 100%)`,
            color: '#C9D3CC',
            display: 'flex',
            flexDirection: 'column',
            padding: sidebarCollapsed ? '16px 6px' : '16px 8px',
            transition: 'width 150ms ease',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {visibleTabs(session.user).map(({ tab, label, icon: Icon }) => {
              const active = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  title={sidebarCollapsed ? label : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                    gap: 10,
                    padding: sidebarCollapsed ? '10px 0' : '10px 12px',
                    border: 'none',
                    borderRadius: theme.radiusSm,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 13.5,
                    fontWeight: active ? 700 : 400,
                    background: active ? color.ledgerRaised : 'transparent',
                    color: active ? color.brass : '#AAB6AF',
                    boxShadow: active && !sidebarCollapsed ? `inset 3px 0 0 ${color.brass}` : 'none',
                  }}
                >
                  <Icon size={17} />
                  {!sidebarCollapsed && label}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 10, textAlign: 'center' }}>
            {!sidebarCollapsed && <div style={{ fontSize: 9.5, color: '#5C6B78' }}>A brand of Ratan Business Solutions</div>}
            <div style={{ fontSize: 9.5, color: '#7C8B93', marginTop: 2 }}>v0.1.0</div>
          </div>
        </nav>
        <main style={{ flex: 1, overflow: 'auto', background: color.paper }}>
          <PageContent
            activeTab={activeTab}
            selectedPartyId={selectedPartyId}
            onNavigateToParty={(partyId) => { setSelectedPartyId(partyId); setActiveTab('parties'); }}
            onPartyConsumed={() => setSelectedPartyId(null)}
            billingPartyId={billingPartyId}
            onStartExchange={(partyId) => { setBillingPartyId(partyId); setActiveTab('billing'); }}
            onBillingPartyConsumed={() => setBillingPartyId(null)}
            onNavigate={setActiveTab}
            settingsInitialSection={settingsInitialSection}
          />
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <LicenseGate>
      <AppShell />
    </LicenseGate>
  );
}
