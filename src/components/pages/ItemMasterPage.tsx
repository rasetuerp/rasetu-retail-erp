import { Fragment, useEffect, useRef, useState } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';
import { CategoryPicker, type CategoryEntry } from '../CategoryPicker';
import { SkuModeToggle, type SkuMode } from '../SkuModeToggle';

// RULES.md #2: types declared inline. RULES.md #3: number inputs use
// defaultValue+onBlur, never onChange. Round 2 Step 6 — tokens applied.
type Item = {
  id: string;
  sku: string;
  category: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  unit: string;
  purchaseRate: string;
  mrp: string;
  sellingRate: string;
  defaultDiscountPct: string;
  stockQty: string;
  minStock: string;
  hsn: string | null;
  gstRate: string;
  barcode: string | null;
};

// Round 10 — the item form is now driven by the vertical profile's own
// itemAttributes/units/gst declarations instead of hardcoding cloth-specific
// fields (category/size/color) directly in JSX. A future hardware/electronics
// profile (docs/PHASE2.md) just declares a different itemAttributes list —
// no code change needed here. See config/profiles/profile-cloth.json.
//
// Round 10 (Phase A) — itemAttributes is now company-effective, not the raw
// base profile: GET /companies/:id/items/fields merges in this company's own
// label renames + custom fields (Settings → Item Fields). `custom: true`
// entries have no matching Item column — their values go into
// `customFields` (a JSON blob) instead of a top-level field; see
// handleAddItem's split below.
type VerticalProfile = {
  itemAttributes: Array<{ key: string; label: string; type: string; required: boolean; custom: boolean }>;
  units: { allowed: string[]; default: string };
  gst: { mrpSlabRule: { thresholdMrp: number; rateBelowOrEqual: number; rateAbove: number } };
};

const { color } = theme;
const numberInputStyle: React.CSSProperties = { padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14, width: 100, fontFamily: theme.mono };
const textInputStyle: React.CSSProperties = { ...numberInputStyle, width: 120, fontFamily: 'inherit' };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft };
const GST_OPTIONS = [0, 5, 12, 18, 28];
const FALLBACK_PROFILE: VerticalProfile = {
  itemAttributes: [
    { key: 'category', label: 'Category', type: 'text', required: true, custom: false },
    { key: 'brand', label: 'Brand', type: 'text', required: false, custom: false },
    { key: 'size', label: 'Size', type: 'text', required: false, custom: false },
    { key: 'color', label: 'Color', type: 'text', required: false, custom: false },
  ],
  units: { allowed: ['PCS'], default: 'PCS' },
  gst: { mrpSlabRule: { thresholdMrp: 1000, rateBelowOrEqual: 5, rateAbove: 12 } },
};

// Mirrors backend/src/lib/gst-calc.ts's clothSlabGstRate, but reads the
// actual slab thresholds from the fetched vertical profile instead of
// hardcoding cloth's ≤1000/12% numbers — a different vertical's profile
// carries its own mrpSlabRule and this keeps working unchanged.
function suggestGstRateForMrp(mrp: number, slab: { thresholdMrp: number; rateBelowOrEqual: number; rateAbove: number }): number {
  return mrp <= slab.thresholdMrp ? slab.rateBelowOrEqual : slab.rateAbove;
}

function clampDiscount(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function salePriceFromMrp(mrp: number, discountPct: number) {
  return mrp * (1 - clampDiscount(discountPct) / 100);
}

function discountFromSalePrice(mrp: number, sellingRate: number) {
  if (!(mrp > 0)) return 0;
  return clampDiscount(((mrp - sellingRate) / mrp) * 100);
}

// Round 22 — a deterministic color per category name (no new data, no
// per-category settings) stands in for GoBilling's per-item photo thumbnail,
// which RaSetu's Item model has no field for yet.
const SWATCH_COLORS = ['#b45309', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#15803d', '#a16207', '#c2410c'];
function categorySwatchColor(category: string | null): string {
  if (!category) return '#94a3b8';
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  return SWATCH_COLORS[hash % SWATCH_COLORS.length];
}

// Matches the exact "low stock" definition backend/src/routes/items.ts's
// `lowStock=true` filter and reports.ts's `lowStockOnly` already use
// (stockQty <= minStock) — kept in sync here for the summary tiles/status
// pill rather than introducing a second definition.
function stockStatus(stockQty: number, minStock: number): { label: string; fg: string; bg: string } {
  if (stockQty <= 0) return { label: 'Out of Stock', fg: '#b91c1c', bg: '#fee2e2' };
  if (stockQty <= minStock) return { label: 'Low Stock', fg: '#92400e', bg: '#fef3c7' };
  return { label: 'In Stock', fg: '#15803d', bg: '#dcfce7' };
}

export function ItemMasterPage() {
  const { session } = useSession();
  const [items, setItems] = useState<Item[]>([]);
  const [profile, setProfile] = useState<VerticalProfile | null>(null);
  const [categories, setCategories] = useState<CategoryEntry[]>([]);
  // Bumped after a successful Add Item to force CategoryPicker to remount —
  // it keeps its own `query` state for live filtering, which the plain
  // `el.value = ''` reset below (matching every other field's reset) can't
  // reach on its own.
  const [formResetToken, setFormResetToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [adjustingItemId, setAdjustingItemId] = useState<string | null>(null);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [removingItemId, setRemovingItemId] = useState<string | null>(null);
  const [stockSearch, setStockSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'in' | 'low' | 'out'>('all');
  const [discountFilter, setDiscountFilter] = useState<'all' | 'discounted' | 'no-discount'>('all');
  const [bulkUpdatingDiscount, setBulkUpdatingDiscount] = useState(false);
  const adjustQtyRef = useRef<HTMLInputElement>(null);
  const adjustTypeRef = useRef<HTMLSelectElement>(null);
  const adjustReasonRef = useRef<HTMLInputElement>(null);
  const bulkDiscountRef = useRef<HTMLInputElement>(null);

  const skuRef = useRef<HTMLInputElement>(null);
  // Round 13 — Auto keeps the SKU field read-only and filled from /next-sku
  // on category pick; Manual hands it to the user and skips the /next-sku
  // call entirely (server-side @@unique([companyId, sku]) still validates on
  // save — see the P2002 'sku' branch in backend/src/app.ts).
  const [skuMode, setSkuMode] = useState<SkuMode>('auto');
  const [selectedCategoryEntry, setSelectedCategoryEntry] = useState<CategoryEntry | null>(null);
  // Round 10 — profile-declared attributes (category/brand/size/color for
  // cloth today) render dynamically, so the ref count isn't known until the
  // profile loads; a single keyed map replaces the old per-field named refs
  // while keeping the same defaultValue+ref convention (RULES.md #3).
  const attrRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const unitRef = useRef<HTMLSelectElement>(null);
  const purchaseRateRef = useRef<HTMLInputElement>(null);
  const mrpRef = useRef<HTMLInputElement>(null);
  const sellingRateRef = useRef<HTMLInputElement>(null);
  const defaultDiscountRef = useRef<HTMLInputElement>(null);
  const openingStockRef = useRef<HTMLInputElement>(null);
  const minStockRef = useRef<HTMLInputElement>(null);
  const hsnRef = useRef<HTMLInputElement>(null);
  const barcodeRef = useRef<HTMLInputElement>(null);

  // Round 10 — legal-metrology label fields, kept collapsed by default so the
  // primary quick-entry flow doesn't get longer for shops that don't print
  // full product labels (only a barcode tag).
  const [showLabelDetails, setShowLabelDetails] = useState(false);
  const commodityRef = useRef<HTMLInputElement>(null);
  const itemTypeRef = useRef<HTMLInputElement>(null);
  const brandCodeRef = useRef<HTMLInputElement>(null);
  const styleCodeRef = useRef<HTMLInputElement>(null);
  const mfgDateRef = useRef<HTMLInputElement>(null);
  const netQtyLabelRef = useRef<HTMLInputElement>(null);

  // GST% dropdown default tracks the MRP field until the user picks a value
  // themselves (pre-build review #4) — after that we stop overriding their choice.
  const [gstRateValue, setGstRateValue] = useState('5');
  const [gstManuallySet, setGstManuallySet] = useState(false);

  // Round 22 — the add-form used to be permanently visible above the table;
  // it's now collapsible, matching a professional inventory-page layout
  // (summary stats + table as the primary view, "Add Item" as a deliberate
  // action). Starts open so first-run behavior (an empty item list) still
  // shows the form immediately.
  const [formOpen, setFormOpen] = useState(true);

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const editBrandRef = useRef<HTMLInputElement>(null);
  const editUnitRef = useRef<HTMLSelectElement>(null);
  const editPurchaseRateRef = useRef<HTMLInputElement>(null);
  const editMrpRef = useRef<HTMLInputElement>(null);
  const editDefaultDiscountRef = useRef<HTMLInputElement>(null);
  const editSellingRateRef = useRef<HTMLInputElement>(null);
  const editBarcodeRef = useRef<HTMLInputElement>(null);
  const editHsnRef = useRef<HTMLInputElement>(null);
  const editGstRateRef = useRef<HTMLSelectElement>(null);

  async function loadItems() {
    if (!session) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ items: Item[] }>(`/companies/${session.companyId}/items`, { token: session.token });
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load items');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  useEffect(() => {
    if (!session) return;
    void (async () => {
      const base = await apiRequest<{ profiles: VerticalProfile[] }>(`/meta/vertical-profiles`, { token: session.token })
        .then((res) => res.profiles[0] ?? FALLBACK_PROFILE)
        .catch(() => FALLBACK_PROFILE);
      const fields = await apiRequest<{ itemAttributes: VerticalProfile['itemAttributes'] }>(`/companies/${session.companyId}/items/fields`, { token: session.token })
        .then((res) => res.itemAttributes)
        .catch(() => FALLBACK_PROFILE.itemAttributes);
      setProfile({ ...base, itemAttributes: fields });
    })();
    void apiRequest<{ categories: CategoryEntry[] }>(`/companies/${session.companyId}/categories`, { token: session.token })
      .then((res) => setCategories(res.categories))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  // Round 11/13 — fills the SKU field from Category+ShopCode+Year+Serial
  // whenever Auto mode is active; Manual mode leaves the field entirely to
  // the user (see skuMode above).
  async function fillAutoSku(entry: CategoryEntry) {
    if (!session) return;
    try {
      const res = await apiRequest<{ skus: string[] }>(`/companies/${session.companyId}/items/next-sku`, {
        method: 'POST',
        token: session.token,
        body: { categoryCode: entry.code },
      });
      if (skuRef.current && res.skus[0]) skuRef.current.value = res.skus[0];
    } catch {
      // SKU auto-fill is a convenience — leave the field as-is on failure.
    }
  }

  async function handleCategorySelect(entry: CategoryEntry) {
    setSelectedCategoryEntry(entry);
    if (skuMode !== 'auto') return;
    await fillAutoSku(entry);
  }

  function handleSkuModeChange(mode: SkuMode) {
    setSkuMode(mode);
    if (mode === 'auto' && selectedCategoryEntry) void fillAutoSku(selectedCategoryEntry);
    if (mode === 'manual') skuRef.current?.focus();
  }

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

  async function handleAddItem(keepOpen: boolean) {
    if (!session || !profile) return;
    setError(null);
    setSubmitting(true);
    try {
      const attrValues: Record<string, string | undefined> = {};
      const customFieldValues: Record<string, string> = {};
      for (const attr of profile.itemAttributes) {
        const value = attrRefs.current[attr.key]?.value.trim();
        if (attr.custom) {
          if (value) customFieldValues[attr.key] = value;
        } else {
          attrValues[attr.key] = value || undefined;
        }
      }
      const mrp = Number(mrpRef.current?.value ?? 0);
      await apiRequest(`/companies/${session.companyId}/items`, {
        method: 'POST',
        token: session.token,
        body: {
          sku: skuRef.current?.value ?? '',
          ...attrValues,
          customFields: Object.keys(customFieldValues).length > 0 ? customFieldValues : undefined,
          unit: unitRef.current?.value || profile.units.default,
          purchaseRate: Number(purchaseRateRef.current?.value ?? 0),
          mrp,
          sellingRate: Number(sellingRateRef.current?.value || mrp),
          defaultDiscountPct: clampDiscount(Number(defaultDiscountRef.current?.value ?? 0)),
          openingStock: Number(openingStockRef.current?.value ?? 0),
          minStock: Number(minStockRef.current?.value ?? 0),
          hsn: hsnRef.current?.value || undefined,
          barcode: barcodeRef.current?.value || undefined,
          gstRate: Number(gstRateValue),
          commodity: commodityRef.current?.value || undefined,
          itemType: itemTypeRef.current?.value || undefined,
          brandCode: brandCodeRef.current?.value || undefined,
          styleCode: styleCodeRef.current?.value || undefined,
          mfgDate: mfgDateRef.current?.value || undefined,
          netQtyLabel: netQtyLabelRef.current?.value || undefined,
        },
      });
      if (skuRef.current) skuRef.current.value = '';
      Object.values(attrRefs.current).forEach((el) => { if (el) el.value = ''; });
      if (purchaseRateRef.current) purchaseRateRef.current.value = '';
      if (mrpRef.current) mrpRef.current.value = '';
      if (sellingRateRef.current) sellingRateRef.current.value = '';
      if (defaultDiscountRef.current) defaultDiscountRef.current.value = '';
      if (openingStockRef.current) openingStockRef.current.value = '';
      if (minStockRef.current) minStockRef.current.value = '';
      if (hsnRef.current) hsnRef.current.value = '';
      if (barcodeRef.current) barcodeRef.current.value = '';
      if (commodityRef.current) commodityRef.current.value = '';
      if (itemTypeRef.current) itemTypeRef.current.value = '';
      if (brandCodeRef.current) brandCodeRef.current.value = '';
      if (styleCodeRef.current) styleCodeRef.current.value = '';
      if (mfgDateRef.current) mfgDateRef.current.value = '';
      if (netQtyLabelRef.current) netQtyLabelRef.current.value = '';
      setGstRateValue('5');
      setGstManuallySet(false);
      setSelectedCategoryEntry(null);
      setFormResetToken((t) => t + 1);
      if (!keepOpen) setFormOpen(false);
      await loadItems();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add item');
    } finally {
      setSubmitting(false);
    }
  }

  function handleMrpChange(e: React.ChangeEvent<HTMLInputElement>) {
    const mrp = Number(e.currentTarget.value) || 0;
    if (!gstManuallySet && profile) setGstRateValue(String(suggestGstRateForMrp(mrp, profile.gst.mrpSlabRule)));
    syncSellingRate();
  }

  function syncSellingRate() {
    const mrp = Number(mrpRef.current?.value || 0);
    const discountPct = clampDiscount(Number(defaultDiscountRef.current?.value || 0));
    if (sellingRateRef.current) sellingRateRef.current.value = salePriceFromMrp(mrp, discountPct).toFixed(2);
  }

  function syncDiscountFromSellingRate() {
    const mrp = Number(mrpRef.current?.value || 0);
    const sellingRate = Number(sellingRateRef.current?.value || 0);
    if (defaultDiscountRef.current) defaultDiscountRef.current.value = discountFromSalePrice(mrp, sellingRate).toFixed(2);
  }

  function syncEditSellingRate() {
    const mrp = Number(editMrpRef.current?.value || 0);
    const discountPct = clampDiscount(Number(editDefaultDiscountRef.current?.value || 0));
    if (editSellingRateRef.current) editSellingRateRef.current.value = salePriceFromMrp(mrp, discountPct).toFixed(2);
  }

  function syncEditDiscountFromSellingRate() {
    const mrp = Number(editMrpRef.current?.value || 0);
    const sellingRate = Number(editSellingRateRef.current?.value || 0);
    if (editDefaultDiscountRef.current) editDefaultDiscountRef.current.value = discountFromSalePrice(mrp, sellingRate).toFixed(2);
  }

  async function handleSaveEdit(itemId: string) {
    if (!session) return;
    setEditError(null);
    try {
      const mrp = Number(editMrpRef.current?.value ?? 0);
      await apiRequest(`/companies/${session.companyId}/items/${itemId}`, {
        method: 'PATCH',
        token: session.token,
        body: {
          brand: editBrandRef.current?.value || undefined,
          unit: editUnitRef.current?.value || undefined,
          purchaseRate: Number(editPurchaseRateRef.current?.value ?? 0),
          mrp,
          defaultDiscountPct: clampDiscount(Number(editDefaultDiscountRef.current?.value ?? 0)),
          sellingRate: Number(editSellingRateRef.current?.value || mrp),
          barcode: editBarcodeRef.current?.value || undefined,
          hsn: editHsnRef.current?.value || undefined,
          gstRate: Number(editGstRateRef.current?.value ?? 0),
        },
      });
      setEditingItemId(null);
      await loadItems();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Failed to save item');
    }
  }

  async function handleAdjustStock(itemId: string) {
    if (!session) return;
    setAdjustError(null);
    const qty = Number(adjustQtyRef.current?.value ?? 0);
    const type = (adjustTypeRef.current?.value ?? 'ADJUST') as 'ADJUST' | 'DAMAGE';
    const reason = adjustReasonRef.current?.value ?? '';
    if (!reason.trim()) {
      setAdjustError('Reason is required for stock adjustments.');
      return;
    }
    try {
      await apiRequest(`/companies/${session.companyId}/stock/adjustments`, { method: 'POST', token: session.token, body: { itemId, qty, type, reason } });
      setAdjustingItemId(null);
      await loadItems();
    } catch (err) {
      setAdjustError(err instanceof ApiError ? err.message : 'Adjustment failed');
    }
  }

  async function handleRemoveItem(item: Item) {
    if (!session) return;
    const ok = window.confirm(`Remove ${item.sku} from active stock?\n\nNewest unused item will be deleted. Older or used items will be cancelled and hidden so old bills stay safe.`);
    if (!ok) return;
    setRemovingItemId(item.id);
    setError(null);
    try {
      const res = await apiRequest<{ mode: 'deleted' | 'cancelled'; message?: string }>(`/companies/${session.companyId}/items/${item.id}/safe`, {
        method: 'DELETE',
        token: session.token,
      });
      await loadItems();
      if (res.message) setError(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove item');
    } finally {
      setRemovingItemId(null);
    }
  }

  async function handleApplyDiscountToFiltered() {
    if (!session || filteredItems.length === 0) return;
    const discountPct = clampDiscount(Number(bulkDiscountRef.current?.value ?? 0));
    const ok = window.confirm(`Apply ${discountPct.toFixed(2)}% discount to ${filteredItems.length} visible item(s)?\n\nThis updates each item's default discount and selling rate. Existing posted bills are not changed.`);
    if (!ok) return;
    setBulkUpdatingDiscount(true);
    setError(null);
    try {
      await Promise.all(
        filteredItems.map((item) =>
          apiRequest(`/companies/${session.companyId}/items/${item.id}`, {
            method: 'PATCH',
            token: session.token,
            body: {
              defaultDiscountPct: discountPct,
              sellingRate: salePriceFromMrp(Number(item.mrp), discountPct),
            },
          })
        )
      );
      await loadItems();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update discounts');
    } finally {
      setBulkUpdatingDiscount(false);
    }
  }

  const totalItems = items.length;
  const availableItems = items.filter((i) => Number(i.stockQty) > 0).length;
  const lowStockCount = items.filter((i) => Number(i.stockQty) <= Number(i.minStock)).length;
  const categoryCount = new Set(items.map((i) => i.category).filter((c): c is string => !!c)).size;
  const totalStockValue = items.reduce((sum, i) => sum + Number(i.stockQty) * Number(i.purchaseRate), 0);
  const categoryOptions = [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
  const filteredItems = items.filter((item) => {
    const q = stockSearch.trim().toLowerCase();
    const stockQty = Number(item.stockQty);
    const minStock = Number(item.minStock);
    const discountPct = Number(item.defaultDiscountPct || 0);
    const matchesSearch =
      !q ||
      item.sku.toLowerCase().includes(q) ||
      item.barcode?.toLowerCase().includes(q) ||
      item.category?.toLowerCase().includes(q) ||
      item.brand?.toLowerCase().includes(q) ||
      item.size?.toLowerCase().includes(q) ||
      item.color?.toLowerCase().includes(q);
    const matchesCategory = categoryFilter === 'all' || item.category === categoryFilter;
    const matchesStock =
      stockFilter === 'all' ||
      (stockFilter === 'out' && stockQty <= 0) ||
      (stockFilter === 'low' && stockQty > 0 && stockQty <= minStock) ||
      (stockFilter === 'in' && stockQty > minStock);
    const matchesDiscount =
      discountFilter === 'all' ||
      (discountFilter === 'discounted' && discountPct > 0) ||
      (discountFilter === 'no-discount' && discountPct <= 0);
    return matchesSearch && matchesCategory && matchesStock && matchesDiscount;
  });

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Item / Stock Master</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>Add items and track stock in one place.</p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 18 }}>
        <SummaryTile label="Total Items" value={String(totalItems)} />
        <SummaryTile label="Available" value={String(availableItems)} tint={color.moneyTint} fg={color.money} />
        <SummaryTile label="Low Stock" value={String(lowStockCount)} tint={lowStockCount > 0 ? '#fef3c7' : undefined} fg={lowStockCount > 0 ? '#92400e' : undefined} />
        <SummaryTile label="Categories" value={String(categoryCount)} />
        <SummaryTile label="Stock Value" value={`₹${totalStockValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} />
      </div>

      {!profile ? (
        <div style={{ padding: 18, color: color.inkFaint, fontSize: 13 }}>Loading item form…</div>
      ) : !formOpen ? (
        <button
          onClick={() => setFormOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 18px', marginBottom: 18, background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
        >
          + Add Item
        </button>
      ) : (
        <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 18, marginBottom: 18, boxShadow: theme.shadowSm }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <strong style={{ fontSize: 15, color: color.ink }}>Add Item</strong>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              style={{ border: 'none', background: 'transparent', color: color.inkFaint, cursor: 'pointer', fontSize: 12.5 }}
            >
              Collapse ▲
            </button>
          </div>

          <FormSection title="Identity">
            <label style={labelStyle}>
              SKU
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input
                  ref={skuRef}
                  defaultValue=""
                  readOnly={skuMode === 'auto'}
                  placeholder={skuMode === 'auto' ? 'Pick a category to generate' : 'Type your own SKU'}
                  style={{ ...textInputStyle, background: skuMode === 'auto' ? color.paper : '#fff' }}
                />
                <SkuModeToggle mode={skuMode} onChange={handleSkuModeChange} />
              </div>
            </label>
            {profile.itemAttributes.map((attr) => (
              <label key={attr.key} style={labelStyle}>
                {attr.label}{attr.required ? '*' : ''}
                {attr.key === 'category' ? (
                  <CategoryPicker
                    key={formResetToken}
                    ref={(el) => { attrRefs.current[attr.key] = el; }}
                    categories={categories}
                    defaultValue=""
                    placeholder="Search or add…"
                    style={textInputStyle}
                    onSelect={handleCategorySelect}
                    onCreate={handleCreateCategory}
                  />
                ) : (
                  <input
                    ref={(el) => { attrRefs.current[attr.key] = el; }}
                    defaultValue=""
                    style={{ ...textInputStyle, width: attr.key === 'size' || attr.key === 'color' ? 80 : textInputStyle.width }}
                  />
                )}
              </label>
            ))}
            <label style={labelStyle}>
              Unit
              <select ref={unitRef} defaultValue={profile.units.default} style={{ ...numberInputStyle, width: 90, fontFamily: 'inherit' }}>
                {profile.units.allowed.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Barcode (optional)
              <input ref={barcodeRef} defaultValue="" placeholder="scan or type" style={{ ...textInputStyle, width: 140 }} />
            </label>
          </FormSection>

          <FormSection title="Pricing">
            <QuickField label="Purchase Rate" innerRef={purchaseRateRef} style={numberInputStyle} type="number" />
            <QuickField label="MRP" innerRef={mrpRef} style={numberInputStyle} type="number" onChange={handleMrpChange} />
            <QuickField label="Default Disc %" innerRef={defaultDiscountRef} style={numberInputStyle} type="number" onChange={syncSellingRate} />
            <QuickField label="Selling Rate" innerRef={sellingRateRef} style={numberInputStyle} type="number" onChange={syncDiscountFromSellingRate} />
            <label style={labelStyle}>
              HSN (optional)
              <input ref={hsnRef} defaultValue="" placeholder="e.g. 6109 (optional, can add later)" style={{ ...textInputStyle, width: 190 }} />
            </label>
            <label style={labelStyle}>
              GST % (for purchase records)
              <select value={gstRateValue} onChange={(e) => { setGstRateValue(e.target.value); setGstManuallySet(true); }} style={{ ...numberInputStyle, width: 90 }}>
                {GST_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r}%</option>
                ))}
              </select>
            </label>
          </FormSection>
          <p style={{ color: color.inkFaint, fontSize: 11.5, margin: '-6px 0 0' }}>
            GST % here feeds Purchase Entry's tax records only - it does not change what's charged on a sale (sale tax is always based on MRP).
          </p>

          <FormSection title="Stock">
            <QuickField label="Opening Stock" innerRef={openingStockRef} style={numberInputStyle} type="number" />
            <QuickField label="Min Stock" innerRef={minStockRef} style={numberInputStyle} type="number" />
          </FormSection>

          <button
            type="button"
            onClick={() => setShowLabelDetails((v) => !v)}
            style={{ border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 12.5, textDecoration: 'underline', padding: 0, margin: '4px 0 12px' }}
          >
            {showLabelDetails ? '− Hide' : '+ Show'} advanced details
          </button>

          {showLabelDetails && (
            <>
              <FormSection title="Label details">
                <QuickField label="Legal name (for label)" innerRef={commodityRef} style={textInputStyle} />
                <QuickField label="Sub-type (for label)" innerRef={itemTypeRef} style={textInputStyle} />
                <QuickField label="Brand Code" innerRef={brandCodeRef} style={textInputStyle} />
                <QuickField label="Style Code" innerRef={styleCodeRef} style={textInputStyle} />
                <label style={labelStyle}>
                  MFG Date
                  <input ref={mfgDateRef} type="date" style={{ ...textInputStyle, width: 150 }} />
                </label>
                <label style={labelStyle}>
                  Net Qty (for label)
                  <input ref={netQtyLabelRef} placeholder="e.g. 1 N, 500 g" style={{ ...textInputStyle, width: 130 }} />
                </label>
              </FormSection>
              <p style={{ color: color.inkFaint, fontSize: 11, margin: '-6px 0 12px' }}>
                "Legal name" is the generic product name printed on the label (e.g. "Shirt") - separate from your own "Category" above, which is just how you group items in this list.
              </p>
            </>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button onClick={() => void handleAddItem(false)} disabled={submitting} style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => void handleAddItem(true)} disabled={submitting} style={{ padding: '9px 18px', background: color.ledger, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              {submitting ? 'Saving…' : 'Save & Add Another'}
            </button>
          </div>
        </div>
      )}

      <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 14, marginBottom: 12, boxShadow: theme.shadowSm }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <label style={labelStyle}>
            Search stock
            <input
              value={stockSearch}
              onChange={(e) => setStockSearch(e.currentTarget.value)}
              placeholder="SKU, category, brand, size, colour, barcode"
              style={{ ...textInputStyle, width: 280 }}
            />
          </label>
          <label style={labelStyle}>
            Category
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.currentTarget.value)} style={{ ...textInputStyle, width: 160 }}>
              <option value="all">All categories</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Stock
            <select value={stockFilter} onChange={(e) => setStockFilter(e.currentTarget.value as typeof stockFilter)} style={{ ...textInputStyle, width: 130 }}>
              <option value="all">All stock</option>
              <option value="in">In stock</option>
              <option value="low">Low stock</option>
              <option value="out">Out of stock</option>
            </select>
          </label>
          <label style={labelStyle}>
            Discount
            <select value={discountFilter} onChange={(e) => setDiscountFilter(e.currentTarget.value as typeof discountFilter)} style={{ ...textInputStyle, width: 150 }}>
              <option value="all">All discounts</option>
              <option value="discounted">Discounted only</option>
              <option value="no-discount">No discount</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              setStockSearch('');
              setCategoryFilter('all');
              setStockFilter('all');
              setDiscountFilter('all');
            }}
            style={{ padding: '9px 12px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', color: color.inkSoft }}
          >
            Clear filters
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <label style={labelStyle}>
              Offer discount %
              <input ref={bulkDiscountRef} defaultValue="" type="number" placeholder="e.g. 20" style={{ ...numberInputStyle, width: 120 }} />
            </label>
            <button
              type="button"
              onClick={() => void handleApplyDiscountToFiltered()}
              disabled={bulkUpdatingDiscount || filteredItems.length === 0}
              style={{ padding: '9px 14px', background: color.ledger, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: filteredItems.length === 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              {bulkUpdatingDiscount ? 'Updating...' : `Apply to visible (${filteredItems.length})`}
            </button>
          </div>
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, boxShadow: theme.shadowSm }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: `2px solid ${color.line}`, fontSize: 12.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase' }}>
            <th style={{ padding: 10 }}>SKU</th>
            <th style={{ padding: 10 }}>Category</th>
            <th style={{ padding: 10 }}>Brand</th>
            <th style={{ padding: 10 }}>Size</th>
            <th style={{ padding: 10 }}>Color</th>
            <th style={{ padding: 10 }}>MRP</th>
            <th style={{ padding: 10 }}>Disc%</th>
            <th style={{ padding: 10 }}>Selling</th>
            <th style={{ padding: 10 }}>HSN</th>
            <th style={{ padding: 10 }}>GST%</th>
            <th style={{ padding: 10 }}>Stock</th>
            <th style={{ padding: 10 }}>Status</th>
            <th style={{ padding: 10 }}></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={13} style={{ padding: 18, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>Loading…</td></tr>
          ) : filteredItems.length === 0 ? (
            <tr><td colSpan={13} style={{ padding: 18, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>{items.length === 0 ? 'No items yet - add one above.' : 'No items match the selected filters.'}</td></tr>
          ) : (
            filteredItems.map((item) => (
              <Fragment key={item.id}>
                <tr style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 14 }}>
                  <td style={{ padding: 10 }}>{item.sku}</td>
                  <td style={{ padding: 10, color: color.inkSoft }}>
                    {item.category && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: categorySwatchColor(item.category), flexShrink: 0 }} />
                        {item.category}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: 10, color: color.inkSoft }}>{item.brand}</td>
                  <td style={{ padding: 10, color: color.inkSoft }}>{item.size}</td>
                  <td style={{ padding: 10, color: color.inkSoft }}>{item.color}</td>
                  <td style={{ padding: 10, fontFamily: theme.mono }}>₹{Number(item.mrp).toLocaleString('en-IN')}</td>
                  <td style={{ padding: 10, fontFamily: theme.mono }}>{Number(item.defaultDiscountPct || 0).toFixed(2)}%</td>
                  <td style={{ padding: 10, fontFamily: theme.mono }}>₹{Number(item.sellingRate).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td style={{ padding: 10, color: color.inkSoft }}>{item.hsn ?? '-'}</td>
                  <td style={{ padding: 10, fontFamily: theme.mono }}>{Number(item.gstRate)}%</td>
                  <td style={{ padding: 10, fontFamily: theme.mono }}>{Number(item.stockQty)} {item.unit}</td>
                  <td style={{ padding: 10 }}>
                    {(() => {
                      const status = stockStatus(Number(item.stockQty), Number(item.minStock));
                      return (
                        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, color: status.fg, background: status.bg }}>
                          {status.label}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={{ padding: 10 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => {
                          setAdjustingItemId(adjustingItemId === item.id ? null : item.id);
                          setAdjustError(null);
                        }}
                        style={{ padding: '4px 10px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12, color: color.inkSoft }}
                      >
                        Adjust
                      </button>
                      <button
                        onClick={() => {
                          setEditingItemId(editingItemId === item.id ? null : item.id);
                          setEditError(null);
                        }}
                        style={{ padding: '4px 10px', background: 'transparent', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12, color: color.inkSoft }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void handleRemoveItem(item)}
                        disabled={removingItemId === item.id}
                        style={{ padding: '4px 10px', background: 'transparent', border: `1px solid #fecaca`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12, color: color.alert }}
                      >
                        {removingItemId === item.id ? 'Removing...' : 'Remove'}
                      </button>
                    </div>
                  </td>
                </tr>
                {editingItemId === item.id && (
                  <tr style={{ background: color.paper }}>
                    <td colSpan={13} style={{ padding: 12 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <label style={labelStyle}>
                          Brand
                          <input ref={editBrandRef} defaultValue={item.brand ?? ''} style={textInputStyle} />
                        </label>
                        <label style={labelStyle}>
                          Unit
                          <select ref={editUnitRef} defaultValue={item.unit} style={{ ...numberInputStyle, width: 90, fontFamily: 'inherit' }}>
                            {(profile?.units.allowed ?? [item.unit]).map((u) => (
                              <option key={u} value={u}>{u}</option>
                            ))}
                          </select>
                        </label>
                        <label style={labelStyle}>
                          Purchase Rate
                          <input ref={editPurchaseRateRef} defaultValue={item.purchaseRate} type="number" style={numberInputStyle} />
                        </label>
                        <label style={labelStyle}>
                          MRP
                          <input ref={editMrpRef} defaultValue={item.mrp} type="number" onChange={syncEditSellingRate} style={numberInputStyle} />
                        </label>
                        <label style={labelStyle}>
                          Default Disc %
                          <input ref={editDefaultDiscountRef} defaultValue={item.defaultDiscountPct ?? '0'} type="number" onChange={syncEditSellingRate} style={numberInputStyle} />
                        </label>
                        <label style={labelStyle}>
                          Selling Rate
                          <input ref={editSellingRateRef} defaultValue={item.sellingRate} type="number" onChange={syncEditDiscountFromSellingRate} style={numberInputStyle} />
                        </label>
                        <label style={labelStyle}>
                          Barcode
                          <input ref={editBarcodeRef} defaultValue={item.barcode ?? ''} style={{ ...textInputStyle, width: 140 }} />
                        </label>
                        <label style={labelStyle}>
                          HSN (optional)
                          <input ref={editHsnRef} defaultValue={item.hsn ?? ''} placeholder="e.g. 6109" style={{ ...textInputStyle, width: 160 }} />
                        </label>
                        <label style={labelStyle}>
                          GST % (for purchase records)
                          <select ref={editGstRateRef} defaultValue={String(Number(item.gstRate))} style={{ ...numberInputStyle, width: 90 }}>
                            {GST_OPTIONS.map((r) => (
                              <option key={r} value={r}>{r}%</option>
                            ))}
                          </select>
                        </label>
                        <button onClick={() => void handleSaveEdit(item.id)} style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                          Save
                        </button>
                      </div>
                      {editError && <div style={{ color: color.alert, fontSize: 12, marginTop: 8 }}>{editError}</div>}
                    </td>
                  </tr>
                )}
                {adjustingItemId === item.id && (
                  <tr style={{ background: color.paper }}>
                    <td colSpan={13} style={{ padding: 12 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <label style={labelStyle}>
                          Qty (+ in / - out)
                          <input ref={adjustQtyRef} defaultValue="" type="number" style={numberInputStyle} />
                        </label>
                        <label style={labelStyle}>
                          Type
                          <select ref={adjustTypeRef} defaultValue="ADJUST" style={{ ...textInputStyle, width: 110 }}>
                            <option value="ADJUST">ADJUST</option>
                            <option value="DAMAGE">DAMAGE</option>
                          </select>
                        </label>
                        <label style={labelStyle}>
                          Reason (required)
                          <input ref={adjustReasonRef} defaultValue="" style={{ ...textInputStyle, width: 200 }} />
                        </label>
                        <button onClick={() => void handleAdjustStock(item.id)} style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                          Save Adjustment
                        </button>
                      </div>
                      {adjustError && <div style={{ color: color.alert, fontSize: 12, marginTop: 8 }}>{adjustError}</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function SummaryTile({ label, value, tint, fg }: { label: string; value: string; tint?: string; fg?: string }) {
  return (
    <div style={{ background: tint ?? color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: '12px 14px', boxShadow: theme.shadowSm }}>
      <div style={{ fontFamily: theme.mono, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: fg ?? color.ink }}>{value}</div>
    </div>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: theme.mono, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function QuickField({
  label,
  innerRef,
  style,
  type = 'text',
  onChange,
}: {
  label: string;
  innerRef: React.RefObject<HTMLInputElement | null>;
  style: React.CSSProperties;
  type?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <input ref={innerRef} defaultValue="" type={type} style={style} onChange={onChange} />
    </label>
  );
}
