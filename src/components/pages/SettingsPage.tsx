import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Plus } from 'lucide-react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession, type Session, type SessionUser } from '../../lib/session';
import { theme } from '../../lib/theme';
import {
  DEFAULT_RECEIPT_SECTIONS,
  DEFAULT_RECEIPT_HEADER_ORDER,
  LOCKED_RECEIPT_SECTIONS,
  RECEIPT_HEADER_LABELS,
  RECEIPT_SECTION_LABELS,
  type ReceiptHeaderKey,
  type ReceiptSectionConfig,
  type ReceiptSectionKey,
} from '../../lib/invoicePrint';
import { getStartupLicenseStatus, revalidateLicenseInBackground, getOfflineGraceInfo, type StartupLicenseStatus } from '../../lib/license';
import type { CategoryEntry } from '../CategoryPicker';
import { searchFaq, FAQ_CATEGORIES } from '../../data/faq';

// RULES.md #2: types declared inline. RULES.md #3: defaultValue+onBlur/refs,
// never onChange. Pre-delivery fixes #2.1 — shop settings page (core
// address/phone/email/invoicePrefix fields; print-template wiring is the
// stretch piece and is out of scope here per the plan).
type Company = {
  id: string;
  name: string;
  gstin: string | null;
  address: string | null;
  phone: string | null;
  alternatePhone: string | null;
  email: string | null;
  website: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  whatsappNumber: string | null;
  invoicePrefix: string;
  shopCode: string | null;
};

const { color } = theme;
const inputStyle: React.CSSProperties = { padding: 9, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14, width: 320 };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: color.inkSoft };
const groupHeadingStyle: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: color.inkFaint, marginBottom: 8 };

// Round 3 — self-service password/PIN, same show/hide pattern used on
// SetupWizardPage.tsx/UsersPage.tsx (page-local, RULES.md #11).
function PasswordField({ innerRef, placeholder, width = 320 }: { innerRef: React.RefObject<HTMLInputElement | null>; placeholder?: string; width?: number }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative', width }}>
      <input ref={innerRef} defaultValue="" placeholder={placeholder} type={visible ? 'text' : 'password'} style={{ ...inputStyle, width: '100%', paddingRight: 34 }} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: color.inkFaint, display: 'flex' }}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

// Round 4 — "create another company" moves here (post-login, ADMIN/SUPER_ADMIN
// only) from SetupWizardPage.tsx, which keeps its own pre-login create form for
// the true zero-company bootstrap case. Companies can't be clubbed or mixed —
// creating one switches the active session into it (Session is always scoped
// to exactly one company).
type CreateCompanyResponse = { company: { id: string; name: string }; token: string; user: SessionUser };

function CreateCompanyCard() {
  const { setSession } = useSession();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const gstinRef = useRef<HTMLInputElement>(null);
  const adminNameRef = useRef<HTMLInputElement>(null);
  const adminUsernameRef = useRef<HTMLInputElement>(null);
  const adminPasswordRef = useRef<HTMLInputElement>(null);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const res = await apiRequest<CreateCompanyResponse>('/companies', {
        method: 'POST',
        body: {
          name: nameRef.current?.value ?? '',
          gstin: gstinRef.current?.value || undefined,
          adminName: adminNameRef.current?.value ?? '',
          adminUsername: adminUsernameRef.current?.value ?? '',
          adminPassword: adminPasswordRef.current?.value ?? '',
        },
      });
      const session: Session = { companyId: res.company.id, token: res.token, user: res.user };
      setSession(session);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create company');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, marginTop: 20 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: color.ink, marginBottom: 8 }}>Other companies</div>
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: 'transparent', color: color.brass, border: `1px solid ${color.brass}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}
        >
          <Plus size={15} /> Create another company
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
          {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13 }}>{error}</div>}
          <label style={labelStyle}>Company name<input ref={nameRef} defaultValue="" style={inputStyle} placeholder="e.g. Shree Textiles" /></label>
          <label style={labelStyle}>GSTIN (optional)<input ref={gstinRef} defaultValue="" style={inputStyle} placeholder="22AAAAA0000A1Z5" /></label>
          <div style={{ borderTop: `1px solid ${color.lineSoft}`, margin: '4px 0' }} />
          <label style={labelStyle}>Admin name<input ref={adminNameRef} defaultValue="" style={inputStyle} placeholder="Your name" /></label>
          <label style={labelStyle}>Admin username<input ref={adminUsernameRef} defaultValue="" style={inputStyle} placeholder="admin" /></label>
          <label style={labelStyle}>Admin password<PasswordField innerRef={adminPasswordRef} placeholder="min 6 characters" /></label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              onClick={() => void handleCreate()}
              disabled={creating}
              style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
            >
              {creating ? 'Creating…' : 'Create Company & Switch'}
            </button>
            <button onClick={() => setExpanded(false)} style={{ padding: '9px 18px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14 }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Round 5 — payment modes moved from a hardcoded list into an admin-editable
// one, stored as a JSON list in Setting (same mechanism as label-print
// settings), whole-list PUT rather than per-row endpoints (mirrors
// labels.ts's settings pattern, not UsersPage's per-row PATCH, since there's
// no per-mode id — just a name + isActive flag).
type PaymentModeEntry = { name: string; isActive: boolean };

function PaymentModesCard() {
  const { session } = useSession();
  const [modes, setModes] = useState<PaymentModeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const newModeRef = useRef<HTMLInputElement>(null);

  async function loadModes() {
    if (!session) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ modes: PaymentModeEntry[] }>(`/companies/${session.companyId}/payments/modes`, { token: session.token });
      setModes(res.modes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load payment modes');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadModes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  async function saveModes(next: PaymentModeEntry[]) {
    if (!session) return;
    setError(null);
    setSaving(true);
    try {
      const res = await apiRequest<{ modes: PaymentModeEntry[] }>(`/companies/${session.companyId}/payments/modes`, {
        method: 'PUT',
        token: session.token,
        body: next,
      });
      setModes(res.modes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save payment modes');
    } finally {
      setSaving(false);
    }
  }

  function handleAddMode() {
    const name = newModeRef.current?.value.trim();
    if (!name || modes.some((m) => m.name.toLowerCase() === name.toLowerCase())) return;
    if (newModeRef.current) newModeRef.current.value = '';
    void saveModes([...modes, { name, isActive: true }]);
  }

  function handleToggleActive(name: string) {
    void saveModes(modes.map((m) => (m.name === name ? { ...m, isActive: !m.isActive } : m)));
  }

  if (loading) return null;

  return (
    <div style={{ maxWidth: 'none' }}>
      <h2 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 18, margin: '0 0 4px', color: color.ink }}>Payment Modes</h2>
      <p style={{ color: color.inkFaint, fontSize: 12.5, margin: '0 0 12px' }}>Shown at billing time when recording a payment. Deactivating a mode keeps its history intact.</p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
        {modes.map((mode) => (
          <div key={mode.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${color.lineSoft}` }}>
            <span style={{ fontSize: 13.5, color: mode.isActive ? color.ink : color.inkFaint, textDecoration: mode.isActive ? 'none' : 'line-through' }}>{mode.name}</span>
            <button
              onClick={() => handleToggleActive(mode.name)}
              disabled={saving}
              style={{ padding: '5px 12px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12, color: color.inkSoft }}
            >
              {mode.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input ref={newModeRef} defaultValue="" placeholder="e.g. Bank Transfer" style={{ ...inputStyle, width: 200 }} />
          <button
            onClick={handleAddMode}
            disabled={saving}
            style={{ padding: '9px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}
          >
            + Add Mode
          </button>
        </div>
      </div>
    </div>
  );
}

// Round 10 (Phase A) — lets a shop rename Item Master's core field labels
// (Category/Brand/Size/Color today) and add its own custom text fields,
// without needing a code change per business type. Field *definitions* live
// here (Setting key 'item-fields'); values for custom fields land on
// Item.customFields. Same immediate-save-on-each-action pattern as
// PaymentModesCard above (whole-list PUT, not a batched "Save" button).
type EffectiveItemAttr = { key: string; label: string; required: boolean; custom: boolean };

// Round 12 — the structural fields every Item Master form has regardless of
// vertical profile (real Item columns, not part of the profile-driven
// itemAttributes list) — shown for a complete picture, not editable here.
const LOCKED_ITEM_FIELDS = ['SKU', 'Unit', 'Purchase Rate', 'MRP', 'Selling Rate', 'Opening Stock', 'Min Stock', 'HSN', 'Barcode', 'GST%'];

function slugifyFieldKey(label: string): string {
  return label
    .trim()
    .replace(/[^a-zA-Z0-9]+(.)/g, (_m, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '')
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

function ItemFieldsCard() {
  const { session } = useSession();
  const [attrs, setAttrs] = useState<EffectiveItemAttr[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const labelRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const newFieldLabelRef = useRef<HTMLInputElement>(null);
  const newFieldRequiredRef = useRef<HTMLInputElement>(null);

  async function loadFields() {
    if (!session) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ itemAttributes: EffectiveItemAttr[] }>(`/companies/${session.companyId}/items/fields`, { token: session.token });
      setAttrs(res.itemAttributes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load item fields');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  async function saveAttrs(next: EffectiveItemAttr[]) {
    if (!session) return;
    setError(null);
    setSaving(true);
    const labelOverrides: Record<string, string> = {};
    const custom: Array<{ key: string; label: string; required: boolean }> = [];
    for (const a of next) {
      if (a.custom) custom.push({ key: a.key, label: a.label, required: a.required });
      else labelOverrides[a.key] = a.label;
    }
    try {
      await apiRequest(`/companies/${session.companyId}/items/fields`, {
        method: 'PUT',
        token: session.token,
        body: { labelOverrides, custom },
      });
      setAttrs(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save item fields');
    } finally {
      setSaving(false);
    }
  }

  function handleRenameLabel(key: string) {
    const label = labelRefs.current[key]?.value.trim();
    if (!label) return;
    void saveAttrs(attrs.map((a) => (a.key === key ? { ...a, label } : a)));
  }

  function handleAddCustomField() {
    const label = newFieldLabelRef.current?.value.trim();
    if (!label) return;
    const key = slugifyFieldKey(label);
    if (!key || attrs.some((a) => a.key.toLowerCase() === key.toLowerCase())) {
      setError('That field name is already in use - try a different name.');
      return;
    }
    const required = newFieldRequiredRef.current?.checked ?? false;
    if (newFieldLabelRef.current) newFieldLabelRef.current.value = '';
    if (newFieldRequiredRef.current) newFieldRequiredRef.current.checked = false;
    void saveAttrs([...attrs, { key, label, required, custom: true }]);
  }

  function handleRemoveCustomField(key: string, label: string) {
    if (!confirm(`Remove the "${label}" field? Existing items keep their saved value, but it will no longer show on any item form.`)) return;
    void saveAttrs(attrs.filter((a) => a.key !== key));
  }

  if (loading) return null;

  return (
    <div style={{ maxWidth: 'none' }}>
      <h2 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 18, margin: '0 0 4px', color: color.ink }}>Item Fields</h2>
      <p style={{ color: color.inkFaint, fontSize: 12.5, margin: '0 0 12px' }}>Rename built-in fields or add your own.</p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
        {attrs.map((attr) => (
          <div key={attr.key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${color.lineSoft}` }}>
            <input
              ref={(el) => { labelRefs.current[attr.key] = el; }}
              key={attr.label}
              defaultValue={attr.label}
              onBlur={() => handleRenameLabel(attr.key)}
              disabled={saving}
              style={{ ...inputStyle, flex: '1 1 140px', minWidth: 0, boxSizing: 'border-box', fontSize: 13.5 }}
            />
            <span style={{ fontSize: 11, color: color.inkFaint, fontFamily: theme.mono, flexShrink: 0 }}>
              {attr.custom ? 'custom' : 'built-in'}
            </span>
            {attr.custom && (
              <button
                onClick={() => handleRemoveCustomField(attr.key, attr.label)}
                disabled={saving}
                style={{ flexShrink: 0, padding: '5px 12px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12, color: color.alert }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <input ref={newFieldLabelRef} defaultValue="" placeholder="e.g. Fabric Type" style={{ ...inputStyle, flex: '1 1 140px', minWidth: 0, boxSizing: 'border-box' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: color.inkSoft, flexShrink: 0 }}>
            <input ref={newFieldRequiredRef} type="checkbox" /> Required
          </label>
          <button
            onClick={handleAddCustomField}
            disabled={saving}
            style={{ flexShrink: 0, padding: '9px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}
          >
            + Add Field
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={groupHeadingStyle}>Always shown, not editable here</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 14 }}>
          {LOCKED_ITEM_FIELDS.map((label) => (
            <span key={label} style={{ padding: '4px 10px', background: color.paper, border: `1px solid ${color.lineSoft}`, borderRadius: theme.radiusSm, fontSize: 12, color: color.inkFaint }}>
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Round 11 — the item Category master (name + short code), same
// immediate-save-per-action pattern as ItemFieldsCard above. Backs the
// searchable Category picker on Item Master / Bulk Stock Entry and the
// CategoryCode segment of auto-generated SKUs (see items.ts's /next-sku).
// Every entry is removable (unlike ItemFieldsCard's built-in fields) — there's
// no "core" category, and removing one only affects future picks, not
// existing items' saved category text.
function CategoriesCard() {
  const { session } = useSession();
  const [categories, setCategories] = useState<CategoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const codeRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const newNameRef = useRef<HTMLInputElement>(null);
  const newCodeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    apiRequest<{ categories: CategoryEntry[] }>(`/companies/${session.companyId}/categories`, { token: session.token })
      .then((res) => setCategories(res.categories))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load categories'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  async function handleRenameCategory(originalCode: string) {
    if (!session) return;
    const name = nameRefs.current[originalCode]?.value.trim();
    const code = codeRefs.current[originalCode]?.value.trim();
    if (!name || !code) return;
    setError(null);
    setSaving(true);
    try {
      const res = await apiRequest<{ categories: CategoryEntry[] }>(`/companies/${session.companyId}/categories/${originalCode}`, {
        method: 'PATCH',
        token: session.token,
        body: { name, code },
      });
      setCategories(res.categories);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update category');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveCategory(code: string, name: string) {
    if (!session) return;
    if (!confirm(`Remove the "${name}" category? Items already using it keep it as plain text, but it won't be pickable or auto-generate SKUs anymore.`)) return;
    setError(null);
    setSaving(true);
    try {
      const res = await apiRequest<{ categories: CategoryEntry[] }>(`/companies/${session.companyId}/categories/${code}`, {
        method: 'DELETE',
        token: session.token,
      });
      setCategories(res.categories);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove category');
    } finally {
      setSaving(false);
    }
  }

  async function handleAddCategory() {
    if (!session) return;
    const name = newNameRef.current?.value.trim();
    if (!name) return;
    const code = newCodeRef.current?.value.trim() || undefined;
    setError(null);
    setSaving(true);
    try {
      const res = await apiRequest<{ categories: CategoryEntry[] }>(`/companies/${session.companyId}/categories`, {
        method: 'POST',
        token: session.token,
        body: { name, code },
      });
      setCategories(res.categories);
      if (newNameRef.current) newNameRef.current.value = '';
      if (newCodeRef.current) newCodeRef.current.value = '';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add category');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <div style={{ maxWidth: 'none' }}>
      <h2 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 18, margin: '0 0 4px', color: color.ink }}>Categories</h2>
      <p style={{ color: color.inkFaint, fontSize: 12.5, margin: '0 0 12px' }}>Used for the Category picker and SKU codes.</p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
        {categories.length === 0 && <div style={{ fontSize: 12.5, color: color.inkFaint }}>No categories yet - add one below.</div>}
        {categories.map((cat) => (
          <div key={cat.code} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${color.lineSoft}` }}>
            <input
              ref={(el) => { nameRefs.current[cat.code] = el; }}
              defaultValue={cat.name}
              onBlur={() => handleRenameCategory(cat.code)}
              disabled={saving}
              style={{ ...inputStyle, flex: '1 1 100px', minWidth: 0, boxSizing: 'border-box', fontSize: 13.5 }}
            />
            <input
              ref={(el) => { codeRefs.current[cat.code] = el; }}
              defaultValue={cat.code}
              onBlur={() => handleRenameCategory(cat.code)}
              disabled={saving}
              style={{ ...inputStyle, width: 60, flexShrink: 0, boxSizing: 'border-box', fontSize: 13.5, fontFamily: theme.mono, textTransform: 'uppercase' }}
            />
            <button
              onClick={() => handleRemoveCategory(cat.code, cat.name)}
              disabled={saving}
              style={{ flexShrink: 0, padding: '5px 12px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12, color: color.alert }}
            >
              Remove
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <input ref={newNameRef} defaultValue="" placeholder="e.g. Shirts" style={{ ...inputStyle, flex: '1 1 100px', minWidth: 0, boxSizing: 'border-box' }} />
          <input ref={newCodeRef} defaultValue="" placeholder="auto" style={{ ...inputStyle, width: 60, flexShrink: 0, boxSizing: 'border-box', fontFamily: theme.mono, textTransform: 'uppercase' }} />
          <button
            onClick={handleAddCategory}
            disabled={saving}
            style={{ flexShrink: 0, padding: '9px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}
          >
            + Add Category
          </button>
        </div>
      </div>
    </div>
  );
}

// Round 6 — shop-configurable text shown on the printed thermal receipt
// (exchange policy, footer), same Setting-JSON mechanism as PaymentModesCard
// above, just a single-object PUT instead of a list. Round 7 — extended with
// a toggleable/reorderable section list (src/lib/invoicePrint.ts owns the
// per-section text; this only stores which sections are on and in what
// order — a text-only analog of a section catalog, since true drag
// positioning doesn't apply to a monospace receipt).
type ReceiptSettings = {
  receiptLogoImage: string;
  receiptLogoWidthMm: number;
  shopNameText: string;
  shopNameFontSize: number;
  localShopNameText: string;
  localShopNameFontSize: number;
  headerLine1Text: string;
  headerLine1FontSize: number;
  headerLine2Text: string;
  headerLine2FontSize: number;
  headerLine3Text: string;
  headerLine3FontSize: number;
  headerOrder: ReceiptHeaderKey[];
  exchangePolicyText: string;
  footerText: string;
  customMessageText: string;
  paymentInfoText: string;
  showSavingsLine: boolean;
  sections: ReceiptSectionConfig[];
  columns: number;
  marginLeftChars: number;
  marginRightChars: number;
  endFeedLines: number;
  receiptPrintableWidthMm: number;
  receiptLeftMarginMm: number;
  receiptBodyFontPx: number;
};

function ReceiptSettingsCard() {
  const { session } = useSession();
  const [settings, setSettings] = useState<ReceiptSettings | null>(null);
  const [sections, setSections] = useState<ReceiptSectionConfig[]>(DEFAULT_RECEIPT_SECTIONS);
  const [headerOrder, setHeaderOrder] = useState<ReceiptHeaderKey[]>(DEFAULT_RECEIPT_HEADER_ORDER);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const shopNameRef = useRef<HTMLInputElement>(null);
  const receiptLogoInputRef = useRef<HTMLInputElement>(null);
  const receiptLogoWidthRef = useRef<HTMLInputElement>(null);
  const shopNameFontRef = useRef<HTMLInputElement>(null);
  const localShopNameRef = useRef<HTMLInputElement>(null);
  const localShopNameFontRef = useRef<HTMLInputElement>(null);
  const headerLine1Ref = useRef<HTMLInputElement>(null);
  const headerLine1FontRef = useRef<HTMLInputElement>(null);
  const headerLine2Ref = useRef<HTMLTextAreaElement>(null);
  const headerLine2FontRef = useRef<HTMLInputElement>(null);
  const headerLine3Ref = useRef<HTMLInputElement>(null);
  const headerLine3FontRef = useRef<HTMLInputElement>(null);
  const exchangeRef = useRef<HTMLInputElement>(null);
  const footerRef = useRef<HTMLInputElement>(null);
  const customMessageRef = useRef<HTMLTextAreaElement>(null);
  const paymentInfoRef = useRef<HTMLInputElement>(null);
  const savingsRef = useRef<HTMLInputElement>(null);
  const columnsRef = useRef<HTMLSelectElement>(null);
  const marginLeftRef = useRef<HTMLInputElement>(null);
  const marginRightRef = useRef<HTMLInputElement>(null);
  const endFeedLinesRef = useRef<HTMLInputElement>(null);
  const receiptPrintableWidthRef = useRef<HTMLInputElement>(null);
  const receiptLeftMarginMmRef = useRef<HTMLInputElement>(null);
  const receiptBodyFontPxRef = useRef<HTMLInputElement>(null);

  async function loadSettings() {
    if (!session) return;
    try {
      const res = await apiRequest<{ settings: ReceiptSettings }>(`/companies/${session.companyId}/invoices/receipt-settings`, { token: session.token });
      setSettings(res.settings);
      setSections([...(res.settings.sections?.length ? res.settings.sections : DEFAULT_RECEIPT_SECTIONS)].sort((a, b) => a.order - b.order));
      setHeaderOrder(normalizeHeaderOrder(res.settings.headerOrder));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load receipt settings');
    }
  }

  useEffect(() => {
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  function toggleSection(key: ReceiptSectionKey) {
    if (LOCKED_RECEIPT_SECTIONS.includes(key)) return;
    setSections((prev) => prev.map((s) => (s.key === key ? { ...s, enabled: !s.enabled } : s)));
  }

  function moveSection(index: number, direction: -1 | 1) {
    setSections((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((s, i) => ({ ...s, order: i }));
    });
  }

  function normalizeHeaderOrder(order: ReceiptHeaderKey[] | undefined): ReceiptHeaderKey[] {
    const valid = (order ?? []).filter((key): key is ReceiptHeaderKey => key in RECEIPT_HEADER_LABELS);
    return [...valid, ...DEFAULT_RECEIPT_HEADER_ORDER.filter((key) => !valid.includes(key))];
  }

  function moveHeader(index: number, direction: -1 | 1) {
    setHeaderOrder((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function handleReceiptLogoUpload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file for the receipt logo.');
      return;
    }
    if (file.size > 900000) {
      setError('Receipt logo must be under 900 KB. Use a smaller PNG/JPG/WebP.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = String(reader.result || '');
      setSettings((prev) => (prev ? { ...prev, receiptLogoImage: image } : prev));
      setHeaderOrder((prev) => normalizeHeaderOrder(prev));
      setError(null);
    };
    reader.onerror = () => setError('Could not read receipt logo image.');
    reader.readAsDataURL(file);
  }

  async function handleSave() {
    if (!session || !settings) return;
    setError(null);
    setSaving(true);
    try {
      const res = await apiRequest<{ settings: ReceiptSettings }>(`/companies/${session.companyId}/invoices/receipt-settings`, {
        method: 'PUT',
        token: session.token,
        body: {
          shopNameText: shopNameRef.current?.value ?? '',
          shopNameFontSize: Number(shopNameFontRef.current?.value ?? 16),
          localShopNameText: localShopNameRef.current?.value ?? '',
          localShopNameFontSize: Number(localShopNameFontRef.current?.value ?? 16),
          headerLine1Text: headerLine1Ref.current?.value ?? '',
          headerLine1FontSize: Number(headerLine1FontRef.current?.value ?? 12),
          headerLine2Text: headerLine2Ref.current?.value ?? '',
          headerLine2FontSize: Number(headerLine2FontRef.current?.value ?? 10),
          headerLine3Text: headerLine3Ref.current?.value ?? '',
          headerLine3FontSize: Number(headerLine3FontRef.current?.value ?? 10),
          receiptLogoImage: settings.receiptLogoImage ?? '',
          receiptLogoWidthMm: Number(receiptLogoWidthRef.current?.value ?? settings.receiptLogoWidthMm ?? 18),
          headerOrder,
          exchangePolicyText: exchangeRef.current?.value ?? '',
          footerText: footerRef.current?.value ?? '',
          customMessageText: customMessageRef.current?.value ?? '',
          paymentInfoText: paymentInfoRef.current?.value ?? '',
          showSavingsLine: savingsRef.current?.checked ?? true,
          columns: Number(columnsRef.current?.value ?? 32),
          marginLeftChars: Number(marginLeftRef.current?.value ?? 0),
          marginRightChars: Number(marginRightRef.current?.value ?? 0),
          endFeedLines: Number(endFeedLinesRef.current?.value ?? 0),
          receiptPrintableWidthMm: Number(receiptPrintableWidthRef.current?.value ?? 0),
          receiptLeftMarginMm: Number(receiptLeftMarginMmRef.current?.value ?? 0),
          receiptBodyFontPx: Number(receiptBodyFontPxRef.current?.value ?? 0),
          sections,
        },
      });
      setSettings(res.settings);
      setSections([...(res.settings.sections?.length ? res.settings.sections : DEFAULT_RECEIPT_SECTIONS)].sort((a, b) => a.order - b.order));
      setHeaderOrder(normalizeHeaderOrder(res.settings.headerOrder));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save receipt settings');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <div style={{ maxWidth: 'none' }}>
      <h2 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 18, margin: '0 0 4px', color: color.ink }}>Receipt Settings</h2>
      <p style={{ color: color.inkFaint, fontSize: 12.5, margin: '0 0 12px' }}>Shown on the printed thermal receipt - text, plus which sections appear and in what order.</p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
        <div style={groupHeadingStyle}>Receipt Shop Header</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(160px, 1fr) 110px', gap: 10, alignItems: 'end' }}>
          <div style={{ width: 76, height: 54, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, background: color.paper, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {settings.receiptLogoImage ? (
              <img src={settings.receiptLogoImage} alt="Receipt logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            ) : (
              <span style={{ fontSize: 11, color: color.inkFaint }}>No logo</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              ref={receiptLogoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/bmp"
              hidden
              onChange={(event) => {
                handleReceiptLogoUpload(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <button type="button" onClick={() => receiptLogoInputRef.current?.click()} style={reorderBtn}>Upload logo</button>
            {settings.receiptLogoImage && (
              <button type="button" onClick={() => setSettings((prev) => (prev ? { ...prev, receiptLogoImage: '' } : prev))} style={{ ...reorderBtn, color: color.alert, borderColor: '#fecaca' }}>
                Remove
              </button>
            )}
            <span style={{ fontSize: 11.5, color: color.inkFaint }}>Print order can move logo up/down below.</span>
          </div>
          <label style={labelStyle}>
            Logo width (mm)
            <input ref={receiptLogoWidthRef} key={`receipt-logo-width-${settings.receiptLogoWidthMm}`} type="number" min={8} max={72} defaultValue={settings.receiptLogoWidthMm ?? 18} style={{ ...inputStyle, width: 96 }} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 90px', gap: 8 }}>
          <label style={labelStyle}>
            Shop name override
            <input ref={shopNameRef} key={settings.shopNameText} defaultValue={settings.shopNameText} placeholder="Uses Shop Profile name if blank" style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Size
            <input ref={shopNameFontRef} key={`shop-font-${settings.shopNameFontSize}`} type="number" min={8} max={32} defaultValue={settings.shopNameFontSize ?? 16} style={{ ...inputStyle, width: 80 }} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 90px', gap: 8 }}>
          <label style={labelStyle}>
            Local language shop name
            <input ref={localShopNameRef} key={settings.localShopNameText} defaultValue={settings.localShopNameText} placeholder="Kannada/local shop name" style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Size
            <input ref={localShopNameFontRef} key={`local-font-${settings.localShopNameFontSize}`} type="number" min={8} max={32} defaultValue={settings.localShopNameFontSize ?? 16} style={{ ...inputStyle, width: 80 }} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 90px', gap: 8 }}>
          <label style={labelStyle}>
            Header line 1
            <input ref={headerLine1Ref} key={settings.headerLine1Text} defaultValue={settings.headerLine1Text} placeholder="Family Show Room" style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Size
            <input ref={headerLine1FontRef} key={`h1-font-${settings.headerLine1FontSize}`} type="number" min={8} max={24} defaultValue={settings.headerLine1FontSize ?? 12} style={{ ...inputStyle, width: 80 }} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 90px', gap: 8 }}>
          <label style={labelStyle}>
            Header line 2 / business details
            <textarea
              ref={headerLine2Ref}
              key={settings.headerLine2Text}
              defaultValue={settings.headerLine2Text}
              rows={3}
              placeholder={'Pure Handloom Sarees\nAll types of Sarees Ready-Made Garments\n& Gold Covering Jewellery'}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </label>
          <label style={labelStyle}>
            Size
            <input ref={headerLine2FontRef} key={`h2-font-${settings.headerLine2FontSize}`} type="number" min={8} max={24} defaultValue={settings.headerLine2FontSize ?? 10} style={{ ...inputStyle, width: 80 }} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 90px', gap: 8 }}>
          <label style={labelStyle}>
            Header line 3
            <input ref={headerLine3Ref} key={settings.headerLine3Text} defaultValue={settings.headerLine3Text} placeholder="Optional extra line" style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Size
            <input ref={headerLine3FontRef} key={`h3-font-${settings.headerLine3FontSize}`} type="number" min={8} max={24} defaultValue={settings.headerLine3FontSize ?? 10} style={{ ...inputStyle, width: 80 }} />
          </label>
        </div>
        <div style={{ background: color.paper, border: `1px solid ${color.lineSoft}`, borderRadius: theme.radiusSm, padding: 10 }}>
          <div style={{ ...groupHeadingStyle, marginBottom: 6 }}>Header print order</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {headerOrder.map((key, index) => (
              <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 6, alignItems: 'center', fontSize: 12.5, color: color.ink }}>
                <span>{index + 1}. {RECEIPT_HEADER_LABELS[key]}</span>
                <button type="button" onClick={() => moveHeader(index, -1)} disabled={index === 0} style={reorderBtn}>Up</button>
                <button type="button" onClick={() => moveHeader(index, 1)} disabled={index === headerOrder.length - 1} style={reorderBtn}>Down</button>
              </div>
            ))}
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${color.lineSoft}`, margin: '4px 0' }} />
        <label style={labelStyle}>
          Exchange policy text
          <input ref={exchangeRef} key={settings.exchangePolicyText} defaultValue={settings.exchangePolicyText} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Footer text
          <input ref={footerRef} key={settings.footerText} defaultValue={settings.footerText} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Custom message / terms &amp; offers (optional, multi-line)
          <textarea
            ref={customMessageRef}
            key={settings.customMessageText}
            defaultValue={settings.customMessageText}
            rows={3}
            placeholder={'e.g. Follow us @yourshop for offers\nTerms: Sale items are non-refundable'}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </label>
        <label style={labelStyle}>
          Payment / UPI details (optional)
          <input ref={paymentInfoRef} key={settings.paymentInfoText} defaultValue={settings.paymentInfoText} placeholder="e.g. Pay via UPI: shopname@bank" style={inputStyle} />
        </label>
        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input ref={savingsRef} key={String(settings.showSavingsLine)} type="checkbox" defaultChecked={settings.showSavingsLine} />
          Show "you saved" line when a discount was applied
        </label>
        <label style={labelStyle}>
          Thermal printer roll width
          <select ref={columnsRef} key={settings.columns} defaultValue={settings.columns} style={inputStyle}>
            <option value={32}>58mm / 2 inch roll - 32 columns</option>
            <option value={48}>80mm / 3 inch roll - 48 columns</option>
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label style={labelStyle}>
            Left margin (chars)
            <input ref={marginLeftRef} key={`left-${settings.marginLeftChars}`} type="number" min={0} max={12} defaultValue={settings.marginLeftChars ?? 0} style={{ ...inputStyle, width: 120 }} />
          </label>
          <label style={labelStyle}>
            Right margin (chars)
            <input ref={marginRightRef} key={`right-${settings.marginRightChars}`} type="number" min={0} max={12} defaultValue={settings.marginRightChars ?? 0} style={{ ...inputStyle, width: 120 }} />
          </label>
          <label style={labelStyle}>
            End feed lines
            <input ref={endFeedLinesRef} key={`feed-${settings.endFeedLines}`} type="number" min={0} max={5} defaultValue={settings.endFeedLines ?? 0} style={{ ...inputStyle, width: 120 }} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label style={labelStyle}>
            Receipt printable width (mm)
            <input ref={receiptPrintableWidthRef} key={`receipt-width-mm-${settings.receiptPrintableWidthMm}`} type="number" min={0} max={90} step="0.5" defaultValue={settings.receiptPrintableWidthMm ?? 0} placeholder={settings.columns === 48 ? '72' : '50'} style={{ ...inputStyle, width: 150 }} />
          </label>
          <label style={labelStyle}>
            Receipt left margin (mm)
            <input ref={receiptLeftMarginMmRef} key={`receipt-left-mm-${settings.receiptLeftMarginMm}`} type="number" min={0} max={12} step="0.5" defaultValue={settings.receiptLeftMarginMm ?? 0} placeholder={settings.columns === 48 ? '4' : '3'} style={{ ...inputStyle, width: 140 }} />
          </label>
          <label style={labelStyle}>
            Receipt body font (px)
            <input ref={receiptBodyFontPxRef} key={`receipt-font-px-${settings.receiptBodyFontPx}`} type="number" min={0} max={12} step="0.5" defaultValue={settings.receiptBodyFontPx ?? 0} placeholder={settings.columns === 48 ? '9' : '9.5'} style={{ ...inputStyle, width: 130 }} />
          </label>
        </div>
        <div style={{ fontSize: 11.5, color: color.inkFaint, lineHeight: 1.4 }}>
          Use 48 columns for 3 inch rolls. Leave mm/font fields at 0 for auto defaults; adjust them only after printing the receipt calibration test.
        </div>

        <div style={{ borderTop: `1px solid ${color.lineSoft}`, margin: '4px 0' }} />
        <div style={{ fontSize: 12.5, fontWeight: 600, color: color.ink }}>Receipt sections</div>
        {sections.map((s, i) => {
          const locked = LOCKED_RECEIPT_SECTIONS.includes(s.key);
          return (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: locked ? color.inkFaint : color.ink, flex: 1 }}>
                <input type="checkbox" checked={s.enabled || locked} disabled={locked} onChange={() => toggleSection(s.key)} />
                {RECEIPT_SECTION_LABELS[s.key]}
              </label>
              <button onClick={() => moveSection(i, -1)} disabled={i === 0} style={reorderBtn}>↑</button>
              <button onClick={() => moveSection(i, 1)} disabled={i === sections.length - 1} style={reorderBtn}>↓</button>
            </div>
          );
        })}

        <button
          onClick={() => void handleSave()}
          disabled={saving}
          style={{ padding: '9px 16px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13.5, fontWeight: 600, alignSelf: 'flex-start', marginTop: 4 }}
        >
          {saving ? 'Saving…' : 'Save Receipt Settings'}
        </button>
      </div>
    </div>
  );
}

const reorderBtn: React.CSSProperties = { padding: '4px 8px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12, color: color.inkSoft };

// Round 7 — read-only visibility into the license this machine already has
// (src/lib/license.ts owns all the actual activation/validation logic —
// this card only displays it and offers a manual re-check). Per the user's
// "manual for now" call on machine transfer, there is deliberately no
// deactivate/transfer UI here — moving a license to a new machine stays a
// vendor-side action (updating the Supabase machine_id by hand); adding
// self-service transfer would be new attack surface for a need this round
// explicitly chose not to build.
type TrialDataSummary = {
  invoices: number;
  postedInvoices: number;
  payments: number;
  purchases: number;
  creditNotes: number;
  debitNotes: number;
  stockMovements: number;
  itemsWithStock: number;
  partyBalances: number;
  lastInvoice: { id: string; number: string; status: string; total: string; createdAt: string } | null;
};

function DataManagementCard() {
  const { session } = useSession();
  const [summary, setSummary] = useState<TrialDataSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState<'summary' | 'clear' | 'delete-last' | null>(null);
  const clearRef = useRef<HTMLInputElement>(null);
  const deleteLastRef = useRef<HTMLInputElement>(null);

  async function loadSummary() {
    if (!session) return;
    setWorking('summary');
    setError(null);
    try {
      const res = await apiRequest<{ summary: TrialDataSummary }>(`/companies/${session.companyId}/trial-data-summary`, { token: session.token });
      setSummary(res.summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load data summary');
    } finally {
      setWorking(null);
    }
  }

  useEffect(() => {
    queueMicrotask(() => void loadSummary());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  async function clearTrialData() {
    if (!session) return;
    setWorking('clear');
    setError(null);
    setStatus(null);
    try {
      const res = await apiRequest<{ summary: TrialDataSummary }>(`/companies/${session.companyId}/clear-trial-data`, {
        method: 'POST',
        token: session.token,
        body: { confirmation: clearRef.current?.value ?? '' },
      });
      setSummary(res.summary);
      if (clearRef.current) clearRef.current.value = '';
      setStatus('Trial transactions cleared. Item stock and party balances are reset to zero.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to clear trial data');
    } finally {
      setWorking(null);
    }
  }

  async function deleteLastInvoice() {
    if (!session) return;
    setWorking('delete-last');
    setError(null);
    setStatus(null);
    try {
      const res = await apiRequest<{ deletedInvoice: { number: string } }>(`/companies/${session.companyId}/invoices/last/safe`, {
        method: 'DELETE',
        token: session.token,
        body: { confirmation: deleteLastRef.current?.value ?? '' },
      });
      if (deleteLastRef.current) deleteLastRef.current.value = '';
      setStatus(`Deleted last invoice ${res.deletedInvoice.number}.`);
      await loadSummary();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Last invoice is not safe to delete');
    } finally {
      setWorking(null);
    }
  }

  const counts = summary
    ? [
        ['Invoices', summary.invoices],
        ['Posted/cancelled invoices', summary.postedInvoices],
        ['Payments', summary.payments],
        ['Purchases', summary.purchases],
        ['Sales returns', summary.creditNotes],
        ['Purchase returns', summary.debitNotes],
        ['Stock movements', summary.stockMovements],
        ['Items with stock', summary.itemsWithStock],
        ['Parties with balance', summary.partyBalances],
      ]
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13 }}>{error}</div>}
      {status && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13 }}>{status}</div>}

      <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
        <div style={groupHeadingStyle}>Current Trial Data</div>
        {summary ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
              {counts.map(([label, value]) => (
                <div key={label} style={{ background: color.paper, border: `1px solid ${color.lineSoft}`, borderRadius: theme.radiusSm, padding: 10 }}>
                  <div style={{ fontSize: 11, color: color.inkFaint, textTransform: 'uppercase' }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: color.ink }}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 12.5, color: color.inkSoft }}>
              Last invoice: {summary.lastInvoice ? `${summary.lastInvoice.number} (${summary.lastInvoice.status})` : 'None'}
            </div>
          </>
        ) : (
          <div style={{ color: color.inkFaint, fontSize: 13 }}>{working === 'summary' ? 'Loading summary...' : 'No summary loaded.'}</div>
        )}
        <button onClick={() => void loadSummary()} disabled={working !== null} style={{ ...reorderBtn, marginTop: 12 }}>Refresh Summary</button>
      </div>

      <div style={{ background: color.paperRaised, border: `1px solid ${color.alert}55`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
        <div style={{ ...groupHeadingStyle, color: color.alert }}>Clear Trial Transactions</div>
        <p style={{ margin: '0 0 12px', color: color.inkSoft, fontSize: 12.5, lineHeight: 1.45 }}>
          Removes invoices, payments, purchases, returns, ledger entries and stock movements. Keeps users, shop profile, item master, parties, receipt settings and label designs.
        </p>
        <label style={labelStyle}>
          Type CLEAR TRIAL DATA
          <input ref={clearRef} style={inputStyle} placeholder="CLEAR TRIAL DATA" />
        </label>
        <button onClick={() => void clearTrialData()} disabled={working !== null} style={{ marginTop: 10, padding: '9px 16px', background: color.alert, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13.5, fontWeight: 700 }}>
          {working === 'clear' ? 'Clearing...' : 'Clear Trial Data'}
        </button>
      </div>

      <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
        <div style={groupHeadingStyle}>Delete Last Bill / Estimate</div>
        <p style={{ margin: '0 0 12px', color: color.inkSoft, fontSize: 12.5, lineHeight: 1.45 }}>
          Only works for the newest saved bill or estimate when it has no linked payments, returns, later ledger activity, or later issued number. Otherwise use cancel or sales return.
        </p>
        <label style={labelStyle}>
          Type DELETE LAST INVOICE
          <input ref={deleteLastRef} style={inputStyle} placeholder="DELETE LAST INVOICE" />
        </label>
        <button onClick={() => void deleteLastInvoice()} disabled={working !== null || !summary?.lastInvoice} style={{ marginTop: 10, padding: '9px 16px', background: color.ledger, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13.5, fontWeight: 700 }}>
          {working === 'delete-last' ? 'Checking...' : 'Delete Last Bill / Estimate If Safe'}
        </button>
      </div>
    </div>
  );
}

function maskLicenseKey(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// Round 12 — Trial/AMC days-remaining, computed client-side from a date
// already in the cached snapshot (no backend/Supabase change needed).
function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function DaysRemaining({ days }: { days: number }) {
  const col = days <= 3 ? color.alert : days <= 7 ? color.amber : color.inkFaint;
  const text = days < 0 ? 'expired' : days === 0 ? 'expires today' : `${days} day${days === 1 ? '' : 's'} remaining`;
  return <span style={{ color: col, fontWeight: days <= 7 ? 600 : 400 }}>{text}</span>;
}

function LicenseStatusCard() {
  const [status, setStatus] = useState<StartupLicenseStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [blockedBanner, setBlockedBanner] = useState<string | null>(null);

  async function load() {
    setStatus(await getStartupLicenseStatus());
  }

  useEffect(() => {
    void load();
    if (!window.rasetu) return;
    // Fixes the previously-dead onLicenseBlocked wiring (electron/main.ts's
    // periodic background re-check now actually broadcasts this) — a
    // license that gets blocked mid-session no longer fails silently.
    return window.rasetu.onLicenseBlocked(() => setBlockedBanner('This license has been blocked. Contact support.'));
  }, []);

  async function handleCheckNow() {
    setChecking(true);
    await revalidateLicenseInBackground();
    await load();
    setChecking(false);
  }

  if (typeof window === 'undefined' || !window.rasetu) return null; // desktop-only, same precedent as printer/backup features

  return (
    <div style={{ maxWidth: 420 }}>
      <h2 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 18, margin: '0 0 4px', color: color.ink }}>License</h2>
      <p style={{ color: color.inkFaint, fontSize: 12.5, margin: '0 0 12px' }}>This device's activation status.</p>

      {blockedBanner && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 10 }}>{blockedBanner}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
        {!status?.hasValidLicense ? (
          <div style={{ fontSize: 13, color: color.alert }}>No active license found on this device.</div>
        ) : (
          <>
            <div style={{ fontSize: 13 }}>Key: <span style={{ fontFamily: theme.mono }}>{maskLicenseKey(status.snapshot.licenseKey)}</span></div>
            <div style={{ fontSize: 13 }}>Type: {status.license.type}</div>
            <div style={{ fontSize: 13 }}>Status: {status.license.status}</div>
            {status.license.type === 'TRIAL' && (
              <div style={{ fontSize: 13 }}>
                Trial expires: {new Date(status.license.validUntil).toLocaleDateString('en-IN')} - <DaysRemaining days={daysUntil(status.license.validUntil)} />
              </div>
            )}
            {status.license.amcExpiresOn && (
              <div style={{ fontSize: 13 }}>
                AMC expires: {new Date(status.license.amcExpiresOn).toLocaleDateString('en-IN')} - <DaysRemaining days={daysUntil(status.license.amcExpiresOn)} />
              </div>
            )}
            <div style={{ fontSize: 13 }}>Cached until: {new Date(status.license.validUntil).toLocaleDateString('en-IN')}</div>
            <div style={{ fontSize: 12, color: color.inkFaint }}>Last checked: {new Date(status.snapshot.lastValidAt).toLocaleString('en-IN')}</div>
            {(() => {
              // Round 9 — same three-state grace logic as App.tsx's LicenseGate
              // banner; here it's ambient (the card is only visible once
              // already inside the app) rather than a top banner.
              const grace = getOfflineGraceInfo(status.snapshot.lastValidAt, status.license.validUntil);
              if (grace.state === 'warning') {
                return (
                  <div style={{ background: color.amberTint, color: color.amber, padding: 9, borderRadius: theme.radiusSm, fontSize: 12.5, marginTop: 2 }}>
                    {grace.message}
                  </div>
                );
              }
              if (grace.state === 'grace') {
                return (
                  <div style={{ fontSize: 12, color: color.inkFaint }}>
                    Offline for {grace.daysOffline} day{grace.daysOffline === 1 ? '' : 's'} - within the 7-day grace period.
                  </div>
                );
              }
              return null;
            })()}
          </>
        )}
        <button
          onClick={() => void handleCheckNow()}
          disabled={checking}
          style={{ padding: '9px 16px', background: color.ledger, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13.5, fontWeight: 600, alignSelf: 'flex-start', marginTop: 4 }}
        >
          {checking ? 'Checking…' : 'Check License Now'}
        </button>
      </div>
    </div>
  );
}

function MyAccountCard() {
  const { session } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);
  const [savingPin, setSavingPin] = useState(false);

  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const pinCurrentPasswordRef = useRef<HTMLInputElement>(null);
  const newPinRef = useRef<HTMLInputElement>(null);

  async function handleChangePassword() {
    if (!session) return;
    setError(null);
    setStatus(null);
    setSavingPassword(true);
    try {
      await apiRequest(`/companies/${session.companyId}/users/me/password`, {
        method: 'PATCH',
        token: session.token,
        body: { currentPassword: currentPasswordRef.current?.value ?? '', newPassword: newPasswordRef.current?.value ?? '' },
      });
      if (currentPasswordRef.current) currentPasswordRef.current.value = '';
      if (newPasswordRef.current) newPasswordRef.current.value = '';
      setStatus('Password updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change password');
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleSetPin() {
    if (!session) return;
    setError(null);
    setStatus(null);
    const pin = newPinRef.current?.value ?? '';
    if (!/^\d{4}$/.test(pin)) {
      setError('PIN must be exactly 4 digits');
      return;
    }
    setSavingPin(true);
    try {
      await apiRequest(`/companies/${session.companyId}/users/me/pin`, {
        method: 'POST',
        token: session.token,
        body: { currentPassword: pinCurrentPasswordRef.current?.value ?? '', pin },
      });
      if (pinCurrentPasswordRef.current) pinCurrentPasswordRef.current.value = '';
      if (newPinRef.current) newPinRef.current.value = '';
      setStatus('PIN saved - you can use it for quick login on this device next time.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set PIN');
    } finally {
      setSavingPin(false);
    }
  }

  return (
    <div>
      <div>
        <h2 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 18, margin: '0 0 4px', color: color.ink }}>Account &amp; Security</h2>
        <p style={{ color: color.inkFaint, fontSize: 12.5, margin: 0 }}>Change your own password or set a 4-digit PIN for quick login on this device.</p>
      </div>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginTop: 12 }}>{error}</div>}
      {status && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginTop: 12 }}>{status}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, marginTop: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: color.ink }}>Change password</div>
          <label style={labelStyle}>Current password<PasswordField innerRef={currentPasswordRef} placeholder="current password" /></label>
          <label style={labelStyle}>New password<PasswordField innerRef={newPasswordRef} placeholder="min 6 characters" /></label>
          <button
            onClick={() => void handleChangePassword()}
            disabled={savingPassword}
            style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600, alignSelf: 'flex-start', marginTop: 4 }}
          >
            {savingPassword ? 'Saving…' : 'Update Password'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: color.ink }}>Set / change PIN</div>
          <label style={labelStyle}>Current password<PasswordField innerRef={pinCurrentPasswordRef} placeholder="current password" /></label>
          <label style={labelStyle}>
            New 4-digit PIN
            <PasswordField innerRef={newPinRef} placeholder="4 digits" />
          </label>
          <button
            onClick={() => void handleSetPin()}
            disabled={savingPin}
            style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600, alignSelf: 'flex-start', marginTop: 4 }}
          >
            {savingPin ? 'Saving…' : 'Save PIN'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Round 13 — searchable Help/FAQ, seeded from the product audit
// (docs/PRODUCT_REVIEW.md) and meant to keep growing over time (src/data/faq.ts).
// Purely client-side filtering over the static array — no backend, matches
// this app's local-first bias for content that doesn't change per shop.
function HelpCard() {
  const [query, setQuery] = useState('');
  const results = searchFaq(query);

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 18, margin: '0 0 4px', color: color.ink }}>Help & FAQ</h2>
      <p style={{ color: color.inkFaint, fontSize: 12.5, margin: '0 0 12px' }}>Search for how something works. This list grows as new features ship.</p>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search, e.g. &quot;sku&quot;, &quot;credit limit&quot;, &quot;forgot password&quot;…"
        style={{ ...inputStyle, width: '100%', marginBottom: 16, boxSizing: 'border-box' }}
      />

      {!query.trim() && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {FAQ_CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setQuery(c)}
              style={{ padding: '4px 10px', borderRadius: 20, border: `1px solid ${color.line}`, background: color.paperRaised, cursor: 'pointer', fontSize: 11.5, color: color.inkSoft }}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {results.length === 0 ? (
        <div style={{ color: color.inkFaint, fontSize: 13, padding: 12 }}>No matches - try a different word, or ask your team lead.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {results.map((entry) => (
            <details key={entry.id} style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, padding: '10px 14px' }}>
              <summary style={{ cursor: 'pointer', fontSize: 13.5, fontWeight: 600, color: color.ink }}>{entry.question}</summary>
              <p style={{ fontSize: 12.5, color: color.inkSoft, margin: '8px 0 2px', lineHeight: 1.5 }}>{entry.answer}</p>
              <div style={{ fontSize: 10.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase', marginTop: 6 }}>{entry.category}</div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

// Round 11 — structured Settings navigation (left sub-menu, one section
// visible at a time) replacing the old single long scroll of every card
// stacked vertically. Purely a layout change: every card below keeps its own
// fetch/save logic untouched; `visible` on each section just reuses the same
// role/window.rasetu checks that used to gate each card's `{cond && <Card/>}`
// line directly.
export type SectionKey = 'profile' | 'items' | 'billing' | 'data' | 'license' | 'account' | 'help';

export function SettingsPage({ initialSection }: { initialSection?: SectionKey } = {}) {
  const { session } = useSession();
  const [company, setCompany] = useState<Company | null>(null);
  const [suggestedShopCode, setSuggestedShopCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionKey>(initialSection ?? 'profile');

  // Round 22 — the top bar's Help/Profile buttons deep-link here after the
  // page is already mounted (activeTab flips to 'settings' first render,
  // this component mounts fresh each time since it's not kept alive off-
  // screen), so the initial-state default above already covers navigation
  // from a cold mount; this effect only matters if the section is ever
  // pushed while already on the Settings page.
  useEffect(() => {
    if (initialSection) setActiveSection(initialSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSection]);

  const nameRef = useRef<HTMLInputElement>(null);
  const gstinRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const alternatePhoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const websiteRef = useRef<HTMLInputElement>(null);
  const facebookRef = useRef<HTMLInputElement>(null);
  const instagramRef = useRef<HTMLInputElement>(null);
  const whatsappRef = useRef<HTMLInputElement>(null);
  const invoicePrefixRef = useRef<HTMLInputElement>(null);
  const shopCodeRef = useRef<HTMLInputElement>(null);

  async function loadCompany() {
    if (!session) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ company: Company; suggestedShopCode: string }>(`/companies/${session.companyId}`, { token: session.token });
      setCompany(res.company);
      setSuggestedShopCode(res.suggestedShopCode);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load company settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCompany();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  async function handleSave() {
    if (!session) return;
    setError(null);
    setStatus(null);
    setSaving(true);
    try {
      await apiRequest(`/companies/${session.companyId}`, {
        method: 'PATCH',
        token: session.token,
        body: {
          name: nameRef.current?.value || undefined,
          gstin: gstinRef.current?.value || undefined,
          address: addressRef.current?.value || undefined,
          phone: phoneRef.current?.value || undefined,
          alternatePhone: alternatePhoneRef.current?.value || undefined,
          email: emailRef.current?.value || undefined,
          website: websiteRef.current?.value || undefined,
          facebookUrl: facebookRef.current?.value || undefined,
          instagramUrl: instagramRef.current?.value || undefined,
          whatsappNumber: whatsappRef.current?.value || undefined,
          invoicePrefix: invoicePrefixRef.current?.value || undefined,
          shopCode: shopCodeRef.current?.value || undefined,
        },
      });
      setStatus('Settings saved.');
      await loadCompany();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div style={{ padding: 28, color: color.inkFaint, fontSize: 13 }}>Loading…</div>;
  }

  // Round 11 fix — a failed fetch (e.g. company data unreachable/corrupted)
  // used to leave this page stuck on "Loading…" forever, since the guard
  // above only checked `loading`, not whether the fetch actually succeeded.
  // Surface the real error instead, with a way to retry.
  if (!company) {
    return (
      <div style={{ padding: 28 }}>
        <div style={{ background: color.alertTint, color: color.alert, padding: 14, borderRadius: theme.radiusSm, fontSize: 13, maxWidth: 420 }}>
          {error ?? 'Could not load shop settings.'}
        </div>
        <button
          onClick={() => void loadCompany()}
          style={{ marginTop: 12, padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
        >
          Retry
        </button>
      </div>
    );
  }

  const isAdmin = session?.user.role === 'ADMIN' || session?.user.role === 'SUPER_ADMIN';
  const isDesktop = typeof window !== 'undefined' && !!window.rasetu;

  const sections: { key: SectionKey; label: string; visible: boolean; render: () => React.ReactNode }[] = [
    {
      key: 'profile',
      label: 'Shop Profile',
      visible: true,
      render: () => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 460, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, boxShadow: theme.shadowSm }}>
          <div>
            <div style={groupHeadingStyle}>Shop Identity</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={labelStyle}>Shop Name<input ref={nameRef} defaultValue={company.name} style={inputStyle} placeholder="Shop name" /></label>
              <label style={labelStyle}>GSTIN<input ref={gstinRef} defaultValue={company.gstin ?? ''} style={inputStyle} placeholder="22AAAAA0000A1Z5" /></label>
            </div>
          </div>

          <div>
            <div style={groupHeadingStyle}>Contact</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={labelStyle}>Address<input ref={addressRef} defaultValue={company.address ?? ''} style={inputStyle} placeholder="Shop address" /></label>
              <label style={labelStyle}>Phone<input ref={phoneRef} defaultValue={company.phone ?? ''} style={inputStyle} placeholder="Shop phone number" /></label>
              <label style={labelStyle}>Alternate Mobile<input ref={alternatePhoneRef} defaultValue={company.alternatePhone ?? ''} style={inputStyle} placeholder="Optional second number" /></label>
              <label style={labelStyle}>Email<input ref={emailRef} defaultValue={company.email ?? ''} style={inputStyle} placeholder="Shop email" /></label>
            </div>
          </div>

          <div>
            <div style={groupHeadingStyle}>Online Presence</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={labelStyle}>Website<input ref={websiteRef} defaultValue={company.website ?? ''} style={inputStyle} placeholder="https://yourshop.com" /></label>
              <label style={labelStyle}>Facebook<input ref={facebookRef} defaultValue={company.facebookUrl ?? ''} style={inputStyle} placeholder="facebook.com/yourshop" /></label>
              <label style={labelStyle}>Instagram<input ref={instagramRef} defaultValue={company.instagramUrl ?? ''} style={inputStyle} placeholder="instagram.com/yourshop" /></label>
              <label style={labelStyle}>WhatsApp Business<input ref={whatsappRef} defaultValue={company.whatsappNumber ?? ''} style={inputStyle} placeholder="+91…" /></label>
            </div>
          </div>

          <div>
            <div style={groupHeadingStyle}>Invoicing</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={labelStyle}>Invoice prefix<input ref={invoicePrefixRef} defaultValue={company.invoicePrefix} style={inputStyle} placeholder="INV" /></label>
              <label style={labelStyle}>
                Shop Code
                <input
                  ref={shopCodeRef}
                  defaultValue={company.shopCode ?? ''}
                  style={{ ...inputStyle, fontFamily: theme.mono, textTransform: 'uppercase' }}
                  placeholder={suggestedShopCode}
                />
                <span style={{ fontSize: 11, color: color.inkFaint, fontWeight: 400 }}>
                  Used as the prefix on auto-generated SKUs, e.g. {suggestedShopCode || 'FTS'}-SHI-26-0001.
                </span>
              </label>
            </div>
          </div>

          <button
            onClick={() => void handleSave()}
            disabled={saving}
            style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600, alignSelf: 'flex-start' }}
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>

          {isAdmin && <CreateCompanyCard />}
        </div>
      ),
    },
    {
      key: 'items',
      label: 'Item Master',
      visible: isAdmin,
      render: () => (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
          <ItemFieldsCard />
          <CategoriesCard />
        </div>
      ),
    },
    {
      key: 'billing',
      label: 'Billing & Receipts',
      visible: isAdmin,
      render: () => (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
          <PaymentModesCard />
          <ReceiptSettingsCard />
        </div>
      ),
    },
    { key: 'data', label: 'Data Reset', visible: isAdmin, render: () => <DataManagementCard /> },
    { key: 'license', label: 'License', visible: isAdmin && isDesktop, render: () => <LicenseStatusCard /> },
    { key: 'account', label: 'Account & Security', visible: true, render: () => <MyAccountCard /> },
    { key: 'help', label: 'Help & FAQ', visible: true, render: () => <HelpCard /> },
  ];

  const visibleSections = sections.filter((s) => s.visible);
  const active = visibleSections.find((s) => s.key === activeSection) ?? visibleSections[0];

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Settings</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>Manage your shop's profile, item catalog, billing, and account.</p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {status && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{status}</div>}

      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
        <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {visibleSections.map((s) => (
            <button
              key={s.key}
              onClick={() => setActiveSection(s.key)}
              style={{
                textAlign: 'left',
                padding: '9px 14px',
                border: 'none',
                borderRadius: theme.radiusSm,
                cursor: 'pointer',
                fontSize: 13.5,
                background: active?.key === s.key ? color.brass : 'transparent',
                color: active?.key === s.key ? '#fff' : color.inkSoft,
                fontWeight: active?.key === s.key ? 600 : 400,
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>{active?.render()}</div>
      </div>
    </div>
  );
}
