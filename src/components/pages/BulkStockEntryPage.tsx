import { useEffect, useRef, useState } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';
import { buildPrinterPayloadForItem, type LabelTemplateDto, type LabelPrintItem, type LabelPrintCompany } from '../../lib/labelPrint';
import { CategoryPicker, type CategoryEntry } from '../CategoryPicker';
import { SkuModeToggle, type SkuMode } from '../SkuModeToggle';

// RULES.md #2: types declared inline. Round 5 — for onboarding a batch of
// near-identical variants (same product, different size/colour) without
// re-typing the shared details 20 times: fill the shared fields once,
// generate N editable rows for what actually differs, save all in one call,
// then print labels for the whole batch.
type VerticalProfile = {
  gst: { mrpSlabRule: { thresholdMrp: number; rateBelowOrEqual: number; rateAbove: number } };
  units: { allowed: string[]; default: string };
};
// Round 10 (Phase A) — shop-added custom fields (Settings → Item Fields),
// shared across the whole batch (same as Category/Brand already are), not
// per-row. Values go into Item.customFields, same split as ItemMasterPage.tsx.
type CustomAttr = { key: string; label: string; required: boolean };
type BulkRow = { tempId: number; sku: string; size: string; color: string; openingStock: number };

const { color } = theme;
const inputStyle: React.CSSProperties = { padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13 };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft };

export function BulkStockEntryPage() {
  const { session } = useSession();
  const [slabRule, setSlabRule] = useState({ thresholdMrp: 1000, rateBelowOrEqual: 5, rateAbove: 12 });
  const [units, setUnits] = useState({ allowed: ['PCS'], default: 'PCS' });
  const [customAttrs, setCustomAttrs] = useState<CustomAttr[]>([]);
  const [categories, setCategories] = useState<CategoryEntry[]>([]);
  const customAttrRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [gstInclusive, setGstInclusive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [createdItemIds, setCreatedItemIds] = useState<string[]>([]);
  const [templates, setTemplates] = useState<LabelTemplateDto[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [company, setCompany] = useState<LabelPrintCompany | null>(null);

  const baseSkuRef = useRef<HTMLInputElement>(null);
  const countRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLInputElement>(null);
  const brandRef = useRef<HTMLInputElement>(null);
  const unitRef = useRef<HTMLSelectElement>(null);
  const purchaseRateRef = useRef<HTMLInputElement>(null);
  const mrpRef = useRef<HTMLInputElement>(null);
  const sellingRateRef = useRef<HTMLInputElement>(null);
  const hsnRef = useRef<HTMLInputElement>(null);
  const minStockRef = useRef<HTMLInputElement>(null);
  // Round 13 — Auto requires a matched Category (drives /next-sku); Manual
  // always uses the ${base}-${counter} scheme below and never calls
  // /next-sku, matching ItemMasterPage/BillingPage's same toggle.
  const [skuMode, setSkuMode] = useState<SkuMode>('auto');
  const [gstRateValue, setGstRateValue] = useState('5');
  const [gstManuallySet, setGstManuallySet] = useState(false);

  // Round 10 — legal-metrology label fields, shared across the whole batch
  // (same style/commodity across sizes/colours) — collapsed by default, same
  // pattern as ItemMasterPage.tsx.
  const [showLabelDetails, setShowLabelDetails] = useState(false);
  const commodityRef = useRef<HTMLInputElement>(null);
  const itemTypeRef = useRef<HTMLInputElement>(null);
  const brandCodeRef = useRef<HTMLInputElement>(null);
  const styleCodeRef = useRef<HTMLInputElement>(null);
  const mfgDateRef = useRef<HTMLInputElement>(null);
  const netQtyLabelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!session) return;
    void apiRequest<{ profiles: VerticalProfile[] }>(`/meta/vertical-profiles`, { token: session.token })
      .then((res) => {
        if (res.profiles[0]?.gst?.mrpSlabRule) setSlabRule(res.profiles[0].gst.mrpSlabRule);
        if (res.profiles[0]?.units) setUnits(res.profiles[0].units);
      })
      .catch(() => {});
    void apiRequest<{ itemAttributes: Array<CustomAttr & { custom: boolean }> }>(`/companies/${session.companyId}/items/fields`, { token: session.token })
      .then((res) => setCustomAttrs(res.itemAttributes.filter((a) => a.custom)))
      .catch(() => {});
    void apiRequest<{ templates: LabelTemplateDto[] }>(`/companies/${session.companyId}/labels/label-templates`, { token: session.token })
      .then((res) => {
        setTemplates(res.templates);
        setSelectedTemplateId(res.templates.find((t) => t.isDefault)?.id ?? res.templates[0]?.id ?? '');
      })
      .catch(() => {});
    void apiRequest<{ company: LabelPrintCompany }>(`/companies/${session.companyId}`, { token: session.token })
      .then((res) => setCompany(res.company))
      .catch(() => {});
    void apiRequest<{ categories: CategoryEntry[] }>(`/companies/${session.companyId}/categories`, { token: session.token })
      .then((res) => setCategories(res.categories))
      .catch(() => {});
  }, [session]);

  async function handleCreateCategory(name: string): Promise<CategoryEntry> {
    if (!session) throw new Error('No session');
    const res = await apiRequest<{ categories: CategoryEntry[]; category: CategoryEntry }>(`/companies/${session.companyId}/categories`, {
      method: 'POST',
      token: session.token,
      body: { name },
    });
    setCategories(res.categories);
    return res.category;
  }

  // Round 11/13 — Auto mode generates SKUs as ShopCode-CategoryCode-Year-Serial
  // (one batch of `count` sequential serials from next-sku) and requires a
  // matched Category; Manual mode never calls next-sku and always uses the
  // ${base}-${counter} scheme, so the format is entirely the user's own.
  async function handleGenerateRows() {
    setError(null);
    const count = Number(countRef.current?.value || 0);
    const base = baseSkuRef.current?.value.trim();
    const categoryName = categoryRef.current?.value.trim();
    const matchedCategory = categoryName
      ? categories.find((c) => c.name.toLowerCase() === categoryName.toLowerCase())
      : undefined;

    if (count <= 0 || count > 200) {
      setError('Enter how many items to create (1-200)');
      return;
    }

    let skus: string[];
    if (skuMode === 'manual') {
      if (!base) {
        setError('Enter a Base SKU for manual numbering.');
        return;
      }
      skus = Array.from({ length: count }, (_, i) => `${base}-${String(i + 1).padStart(2, '0')}`);
    } else {
      if (!matchedCategory || !session) {
        setError('Pick a Category to auto-generate SKUs, or switch to Manual.');
        return;
      }
      try {
        const res = await apiRequest<{ skus: string[] }>(`/companies/${session.companyId}/items/next-sku`, {
          method: 'POST',
          token: session.token,
          body: { categoryCode: matchedCategory.code, count },
        });
        skus = res.skus;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to generate SKUs');
        return;
      }
    }

    setRows(skus.map((sku, i) => ({ tempId: i, sku, size: '', color: '', openingStock: 0 })));
    setCreatedItemIds([]);
    setStatus(null);
  }

  // Mirrors ItemMasterPage.tsx's handleMrpChange — GST% dropdown default
  // tracks MRP until the user picks a value themselves.
  function handleMrpChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (gstManuallySet) return;
    const mrp = Number(e.currentTarget.value) || 0;
    setGstRateValue(String(mrp <= slabRule.thresholdMrp ? slabRule.rateBelowOrEqual : slabRule.rateAbove));
  }

  function updateRow(tempId: number, patch: Partial<BulkRow>) {
    setRows((prev) => prev.map((r) => (r.tempId === tempId ? { ...r, ...patch } : r)));
  }

  function removeRow(tempId: number) {
    setRows((prev) => prev.filter((r) => r.tempId !== tempId));
  }

  async function handleSaveAll() {
    if (!session || rows.length === 0) return;
    setError(null);
    setSaving(true);
    try {
      const mrp = Number(mrpRef.current?.value || 0);
      const customFieldValues: Record<string, string> = {};
      for (const attr of customAttrs) {
        const value = customAttrRefs.current[attr.key]?.value.trim();
        if (value) customFieldValues[attr.key] = value;
      }
      const shared = {
        category: categoryRef.current?.value.trim() || undefined,
        brand: brandRef.current?.value.trim() || undefined,
        customFields: Object.keys(customFieldValues).length > 0 ? customFieldValues : undefined,
        unit: unitRef.current?.value || units.default,
        purchaseRate: Number(purchaseRateRef.current?.value || 0),
        mrp,
        sellingRate: Number(sellingRateRef.current?.value || mrp),
        hsn: hsnRef.current?.value.trim() || undefined,
        gstRate: Number(gstRateValue),
        gstInclusive,
        minStock: Number(minStockRef.current?.value || 0),
        commodity: commodityRef.current?.value.trim() || undefined,
        itemType: itemTypeRef.current?.value.trim() || undefined,
        brandCode: brandCodeRef.current?.value.trim() || undefined,
        styleCode: styleCodeRef.current?.value.trim() || undefined,
        mfgDate: mfgDateRef.current?.value || undefined,
        netQtyLabel: netQtyLabelRef.current?.value.trim() || undefined,
      };
      const res = await apiRequest<{ items: Array<{ id: string }> }>(`/companies/${session.companyId}/items/bulk`, {
        method: 'POST',
        token: session.token,
        body: { items: rows.map((r) => ({ ...shared, sku: r.sku, size: r.size || undefined, color: r.color || undefined, openingStock: r.openingStock })) },
      });
      setCreatedItemIds(res.items.map((i) => i.id));
      setStatus(`${res.items.length} items created.`);
      setRows([]);
      if (hsnRef.current) hsnRef.current.value = '';
      setGstRateValue('5');
      setGstManuallySet(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save items');
    } finally {
      setSaving(false);
    }
  }

  async function handlePrintBatch() {
    if (!session || createdItemIds.length === 0) return;
    setError(null);
    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template) {
      setError('Choose a label template first - create one in Label Designer if none exist yet.');
      return;
    }
    if (!window.rasetu) {
      setStatus('Printing is only available in the desktop app - this preview runs in a plain browser tab.');
      return;
    }
    try {
      const itemsRes = await apiRequest<{ items: LabelPrintItem[] }>(`/companies/${session.companyId}/labels/queue-data?itemIds=${createdItemIds.join(',')}`, { token: session.token });
      const labels = await Promise.all(itemsRes.items.map(async (item) => ({
        ...(await buildPrinterPayloadForItem(template, item, company)),
        copies: 1,
      })));
      const result = await window.rasetu.printer.printBatch('default', labels);
      setStatus(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Print failed');
    }
  }

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Bulk Stock Entry</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>
        Enter the shared details once, generate rows for how many you're adding, then tweak what differs (size, colour, SKU) per row.
      </p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {status && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{status}</div>}

      <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 16, boxShadow: theme.shadowSm, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: color.ink, marginBottom: 10 }}>Shared details</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <label style={labelStyle}>
            Base SKU {skuMode === 'manual' ? '*' : '(optional)'}
            <input ref={baseSkuRef} defaultValue="" placeholder="e.g. SHIRT" style={inputStyle} />
            <SkuModeToggle mode={skuMode} onChange={setSkuMode} />
          </label>
          <label style={labelStyle}>Number of items*<input ref={countRef} defaultValue="" type="number" placeholder="e.g. 20" style={inputStyle} /></label>
          <label style={labelStyle}>Category
            <CategoryPicker
              ref={categoryRef}
              categories={categories}
              defaultValue=""
              placeholder="Search or add…"
              style={inputStyle}
              onCreate={handleCreateCategory}
            />
          </label>
          <label style={labelStyle}>Brand<input ref={brandRef} defaultValue="" style={inputStyle} /></label>
          {customAttrs.map((attr) => (
            <label key={attr.key} style={labelStyle}>
              {attr.label}{attr.required ? '*' : ''}
              <input ref={(el) => { customAttrRefs.current[attr.key] = el; }} defaultValue="" style={inputStyle} />
            </label>
          ))}
          <label style={labelStyle}>Unit
            {/* key forces a remount once the real profile.units loads, so
                defaultValue re-applies instead of staying stuck on the
                pre-fetch fallback ("PCS") - see ItemMasterPage.tsx's own
                note on why an uncontrolled select's defaultValue is only
                read once, at mount. */}
            <select key={units.default} ref={unitRef} defaultValue={units.default} style={inputStyle}>
              {units.allowed.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>Purchase rate<input ref={purchaseRateRef} defaultValue="" type="number" style={inputStyle} /></label>
          <label style={labelStyle}>MRP<input ref={mrpRef} defaultValue="" type="number" style={inputStyle} onChange={handleMrpChange} /></label>
          <label style={labelStyle}>Selling rate<input ref={sellingRateRef} defaultValue="" type="number" placeholder="defaults to MRP" style={inputStyle} /></label>
          <label style={labelStyle}>HSN (optional)<input ref={hsnRef} defaultValue="" placeholder="e.g. 6109" style={inputStyle} /></label>
          <label style={labelStyle}>
            GST %
            <select value={gstRateValue} onChange={(e) => { setGstRateValue(e.target.value); setGstManuallySet(true); }} style={inputStyle}>
              {[0, 5, 12, 18, 28].map((r) => (
                <option key={r} value={r}>{r}%</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>Min stock<input ref={minStockRef} defaultValue="0" type="number" style={inputStyle} /></label>
          <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16 }}>
            <input type="checkbox" checked={gstInclusive} onChange={(e) => setGstInclusive(e.target.checked)} /> GST inclusive
          </label>
        </div>
        <button
          type="button"
          onClick={() => setShowLabelDetails((v) => !v)}
          style={{ border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 12, textDecoration: 'underline', padding: 0, marginTop: 12, display: 'block' }}
        >
          {showLabelDetails ? '− Hide' : '+ Show'} advanced details
        </button>
        {showLabelDetails && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 10 }}>
              <label style={labelStyle}>Legal name (for label)<input ref={commodityRef} defaultValue="" placeholder="e.g. Shirt" style={inputStyle} /></label>
              <label style={labelStyle}>Sub-type (for label)<input ref={itemTypeRef} defaultValue="" placeholder="e.g. Casual" style={inputStyle} /></label>
              <label style={labelStyle}>Brand Code<input ref={brandCodeRef} defaultValue="" style={inputStyle} /></label>
              <label style={labelStyle}>Style Code<input ref={styleCodeRef} defaultValue="" style={inputStyle} /></label>
              <label style={labelStyle}>MFG Date<input ref={mfgDateRef} defaultValue="" type="date" style={inputStyle} /></label>
              <label style={labelStyle}>Net Qty (for label)<input ref={netQtyLabelRef} defaultValue="" placeholder="e.g. 1 N, 500 g" style={inputStyle} /></label>
            </div>
            <p style={{ color: color.inkFaint, fontSize: 11, marginTop: 6 }}>
              "Legal name" is the generic product name printed on the label (e.g. "Shirt") - separate from "Category" above, which is just how you group items in this list.
            </p>
          </>
        )}
        <button onClick={() => void handleGenerateRows()} style={{ marginTop: 12, padding: '9px 18px', background: color.ledger, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          Generate rows
        </button>
      </div>

      {rows.length > 0 && (
        <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 16, boxShadow: theme.shadowSm, marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: 11.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase', borderBottom: `1px solid ${color.line}` }}>
                <th style={{ padding: 6 }}>SKU</th>
                <th style={{ padding: 6 }}>Size</th>
                <th style={{ padding: 6 }}>Colour</th>
                <th style={{ padding: 6 }}>Opening Stock</th>
                <th style={{ padding: 6 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tempId} style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 13 }}>
                  <td style={{ padding: 6 }}>
                    <input defaultValue={row.sku} onBlur={(e) => updateRow(row.tempId, { sku: e.currentTarget.value })} style={{ ...inputStyle, width: 120, fontFamily: theme.mono }} />
                  </td>
                  <td style={{ padding: 6 }}>
                    <input defaultValue={row.size} onBlur={(e) => updateRow(row.tempId, { size: e.currentTarget.value })} style={{ ...inputStyle, width: 70 }} />
                  </td>
                  <td style={{ padding: 6 }}>
                    <input defaultValue={row.color} onBlur={(e) => updateRow(row.tempId, { color: e.currentTarget.value })} style={{ ...inputStyle, width: 90 }} />
                  </td>
                  <td style={{ padding: 6 }}>
                    <input defaultValue={row.openingStock} type="number" onBlur={(e) => updateRow(row.tempId, { openingStock: Number(e.currentTarget.value) || 0 })} style={{ ...inputStyle, width: 70, fontFamily: theme.mono }} />
                  </td>
                  <td style={{ padding: 6 }}>
                    <button onClick={() => removeRow(row.tempId)} style={{ border: 'none', background: 'transparent', color: color.alert, cursor: 'pointer', fontSize: 12 }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button
            onClick={() => void handleSaveAll()}
            disabled={saving}
            style={{ marginTop: 14, padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
          >
            {saving ? 'Saving…' : `Save all ${rows.length} items`}
          </button>
        </div>
      )}

      {createdItemIds.length > 0 && (
        <div style={{ background: color.moneyTint, border: `1px solid ${color.money}44`, borderRadius: theme.radius, padding: 16 }}>
          <div style={{ fontSize: 13, color: color.money, marginBottom: 10 }}>{createdItemIds.length} items saved to Item Master.</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <label style={labelStyle}>
              Label template
              <select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)} style={{ ...inputStyle, width: 220 }}>
                {templates.length === 0 && <option value="">No templates - create one in Label Designer</option>}
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' ★' : ''}</option>
                ))}
              </select>
            </label>
            <button onClick={() => void handlePrintBatch()} style={{ padding: '9px 18px', background: color.ledger, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Print labels for these {createdItemIds.length} items
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
