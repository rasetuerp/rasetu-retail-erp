import { useEffect, useRef, useState } from 'react';
import { Plus, Minus, X, User, Barcode, Trash2 } from 'lucide-react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { printThermalReceipt, printA4Invoice, buildThermalReceipt, buildA4Html, type PrintableInvoice, type ThermalLayout, type A4Layout, type ReceiptSettings, DEFAULT_RECEIPT_SECTIONS } from '../../lib/invoicePrint';
import { previewInvoiceTotals, type SlabRule } from '../../lib/gstPreview';
import { theme, statusColor } from '../../lib/theme';
import { CategoryPicker, type CategoryEntry } from '../CategoryPicker';
import { SkuModeToggle, type SkuMode } from '../SkuModeToggle';
import { PaymentSplitPanel } from '../PaymentSplitPanel';

// RULES.md #2: types declared inline. Round 2 Step 2 — product grid, qty
// stepper, held-bill tabs, payment tiles, and a live GST-aware total
// (src/lib/gstPreview.ts) replacing the flat-sum placeholder from Round 1.
type Item = { id: string; sku: string; hsn: string | null; category: string | null; size: string | null; color: string | null; mrp: string; sellingRate: string; gstRate: string; gstInclusive: boolean; stockQty: string };
// Round 5 — phone/address surfaced for the inline customer search panel;
// dob/anniversary/notes aren't needed on this page, only at creation time.
type Party = { id: string; name: string; type: 'CUSTOMER' | 'SUPPLIER'; balance: string; creditLimit: string | null; phone: string | null; address: string | null };
type CartLine = {
  itemId: string;
  sku: string;
  hsn: string | null;
  category: string | null;
  qty: number;
  rate: number;
  mrp: number;
  gstRate: number;
  gstInclusive: boolean;
  discountPct: number;
  // Set only when an ADMIN/SUPER_ADMIN overrides the auto slab GST% for this
  // line — undefined means "use the normal clothSlabGstRate(mrp) engine".
  gstRateOverride?: number;
  gstOverrideReason?: string;
};
type PaymentModeEntry = { name: string; isActive: boolean };
type InvoiceSummary = {
  id: string;
  number: string;
  status: 'DRAFT' | 'HELD' | 'ESTIMATE' | 'POSTED' | 'CANCELLED';
  total: string;
  discountPct: string;
  discountAmt: string;
  party: { name: string } | null;
  items: Array<{ itemId: string; qty: string; rate: string; gstRate: string; gstInclusive: boolean; discountPct: string }>;
};
type PostedInvoice = { id: string; number: string; total: string; oldBalance: string; newBalance: string; partyId: string | null; dueDate: string | null };
type VerticalProfile = { gst: { mrpSlabRule: SlabRule }; units: { allowed: string[]; default: string } };
const GST_OPTIONS = [0, 5, 12, 18, 28];

const { color } = theme;
const DEFAULT_SLAB: SlabRule = { thresholdMrp: 1000, rateBelowOrEqual: 5, rateAbove: 12 };
const DEFAULT_UNITS = { allowed: ['PCS'], default: 'PCS' };
// Round 5 — mirrors payments.ts's DEFAULT_PAYMENT_MODES, shown only until the
// real list loads from the server (avoids an empty picker while loadAll runs).
const FALLBACK_PAYMENT_MODES: PaymentModeEntry[] = [
  { name: 'CASH', isActive: true },
  { name: 'UPI', isActive: true },
  { name: 'CARD', isActive: true },
  { name: 'CHEQUE', isActive: true },
  { name: 'CREDIT', isActive: true },
];
// Polish pass — category (not per-SKU random) drives the item chip's accent
// color, so the same product line always reads as the same color.
const CATEGORY_SWATCHES = ['#C7D9D2', '#E3D3B8', '#D8C6D6', '#C9CFE3', '#DCD3A8', '#C9DDE0'];
// Brand amber for the single primary action (Post Bill) — kept as one
// dedicated constant here rather than added to the shared theme, since this
// page is the only place it's used as a fill color.
const PRIMARY_AMBER = '#E07B1F';
// One consistent decimal format for every money figure on this page —
// display-only, doesn't touch the underlying calc.
const MONEY_FMT: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
function money(n: number | string) {
  return Number(n).toLocaleString('en-IN', MONEY_FMT);
}

function defaultDueDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 15);
  return d.toISOString().slice(0, 10);
}

function looksLikePhone(s: string) {
  return s.replace(/\D/g, '').length >= 4;
}

function categoryColor(category: string | null) {
  if (!category) return color.line;
  let h = 0;
  for (let i = 0; i < category.length; i++) h = (h * 31 + category.charCodeAt(i)) >>> 0;
  return CATEGORY_SWATCHES[h % CATEGORY_SWATCHES.length];
}

// Round 10 — "Bill a replacement now" from a just-posted Sales Return
// (InvoicesPage.tsx) lands here with only a partyId; App.tsx wires this the
// same way it already does for Dashboard→Parties (onNavigateToParty).
export function BillingPage({ initialPartyId, onInitialPartyConsumed }: { initialPartyId?: string | null; onInitialPartyConsumed?: () => void } = {}) {
  const { session } = useSession();
  const isAdmin = session?.user.role === 'ADMIN' || session?.user.role === 'SUPER_ADMIN';
  const [items, setItems] = useState<Item[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentModes, setPaymentModes] = useState<PaymentModeEntry[]>(FALLBACK_PAYMENT_MODES);
  const [error, setError] = useState<string | null>(null);
  const [heldBills, setHeldBills] = useState<InvoiceSummary[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Round 5 — customer is search-driven rather than a full-list dropdown, so
  // "the family under this phone number" naturally falls out of the same
  // search: typing a phone number returns every Party row containing it.
  const [selectedParty, setSelectedParty] = useState<Party | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerMatches, setCustomerMatches] = useState<Party[]>([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [showAddPerson, setShowAddPerson] = useState(false);
  const newPersonNameRef = useRef<HTMLInputElement>(null);
  const newPersonPhoneRef = useRef<HTMLInputElement>(null);
  const newPersonAddressRef = useRef<HTMLInputElement>(null);
  const newPersonDobRef = useRef<HTMLInputElement>(null);
  const newPersonAnniversaryRef = useRef<HTMLInputElement>(null);
  const newPersonNotesRef = useRef<HTMLInputElement>(null);
  // Round 14 — brought up to the same field set as PartiesPage.tsx's own
  // add-party form (GSTIN/Opening Balance/Credit Limit), aligning all three
  // party-creation surfaces (Parties, Billing customer, Purchase supplier).
  const newPersonGstinRef = useRef<HTMLInputElement>(null);
  const newPersonOpeningBalanceRef = useRef<HTMLInputElement>(null);
  const newPersonCreditLimitRef = useRef<HTMLInputElement>(null);

  // Round 5/13 — inline "+ Add new item" without leaving Billing. Round 13
  // brought this form up to the same field set as ItemMasterPage/
  // BulkStockEntryPage (CategoryPicker + SKU auto/manual toggle, Brand, Unit,
  // Purchase Rate, Min Stock, HSN, Barcode, GST inclusive, GST% dropdown)
  // instead of the old thinner ad-hoc set.
  const [showAddItem, setShowAddItem] = useState(false);
  const newItemSkuRef = useRef<HTMLInputElement>(null);
  const newItemCategoryRef = useRef<HTMLInputElement>(null);
  const newItemBrandRef = useRef<HTMLInputElement>(null);
  const newItemSizeRef = useRef<HTMLInputElement>(null);
  const newItemColorRef = useRef<HTMLInputElement>(null);
  const newItemUnitRef = useRef<HTMLSelectElement>(null);
  const newItemPurchaseRateRef = useRef<HTMLInputElement>(null);
  const newItemMrpRef = useRef<HTMLInputElement>(null);
  const newItemRateRef = useRef<HTMLInputElement>(null);
  const newItemStockRef = useRef<HTMLInputElement>(null);
  const newItemMinStockRef = useRef<HTMLInputElement>(null);
  const newItemHsnRef = useRef<HTMLInputElement>(null);
  const newItemBarcodeRef = useRef<HTMLInputElement>(null);
  const [newItemGstRateValue, setNewItemGstRateValue] = useState('5');
  const [newItemGstManuallySet, setNewItemGstManuallySet] = useState(false);
  const [newItemGstInclusive, setNewItemGstInclusive] = useState(true);
  const [newItemSkuMode, setNewItemSkuMode] = useState<SkuMode>('auto');
  const [newItemSelectedCategory, setNewItemSelectedCategory] = useState<CategoryEntry | null>(null);
  const [addItemFormResetToken, setAddItemFormResetToken] = useState(0);
  const [showAddItemAdvanced, setShowAddItemAdvanced] = useState(false);
  const newItemCommodityRef = useRef<HTMLInputElement>(null);
  const newItemItemTypeRef = useRef<HTMLInputElement>(null);
  const newItemBrandCodeRef = useRef<HTMLInputElement>(null);
  const newItemStyleCodeRef = useRef<HTMLInputElement>(null);
  const newItemMfgDateRef = useRef<HTMLInputElement>(null);
  const newItemNetQtyLabelRef = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState<CategoryEntry[]>([]);
  const [units, setUnits] = useState({ allowed: ['PCS'], default: 'PCS' });
  const skuSearchRef = useRef<HTMLInputElement>(null);

  // Round 5/15 — dueDate is still sent at creation (Hold/Estimate/Post) with
  // the same +15-day default the backend itself falls back to; Round 15
  // removed the pre-post UI for editing it here — a due date is only ever
  // meaningful once a credit portion exists, which PaymentSplitPanel now
  // handles entirely after posting (see the postedInvoice panel below).
  const [dueDate] = useState(defaultDueDateStr());
  // Round 6 — whole-bill discount, on top of any per-line discount; backend
  // already accepts both simultaneously (invoiceBodySchema.discountPct/Amt).
  const [billDiscountPct, setBillDiscountPct] = useState(0);
  const [billDiscountAmt, setBillDiscountAmt] = useState(0);
  // Forces the uncontrolled discount inputs below to remount (and thus
  // re-read defaultValue) whenever resetCart() zeroes them out from code —
  // same problem qty/rate cells solve today with key={line.qty}.
  const [cartGen, setCartGen] = useState(0);
  const [gstEditLineId, setGstEditLineId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [postedInvoice, setPostedInvoice] = useState<PostedInvoice | null>(null);
  const [payingAmount, setPayingAmount] = useState<number | null>(null);
  const [showCancelReason, setShowCancelReason] = useState(false);
  const cancelReasonRef = useRef<HTMLInputElement>(null);
  const [printableInvoice, setPrintableInvoice] = useState<PrintableInvoice | null>(null);
  const [thermalLayout, setThermalLayout] = useState<ThermalLayout>('receipt');
  const [receiptSettings, setReceiptSettings] = useState<ReceiptSettings>({
    exchangePolicyText: '',
    footerText: '',
    customMessageText: '',
    paymentInfoText: '',
    showSavingsLine: true,
    sections: DEFAULT_RECEIPT_SECTIONS,
    columns: 32,
    marginLeftChars: 0,
    marginRightChars: 0,
  });
  const [a4Layout, setA4Layout] = useState<A4Layout>('a4');
  const [printStatus, setPrintStatus] = useState<string | null>(null);
  // Round 13 — preview the actual printable output before committing to
  // print, for both thermal and A4/A5. Uses the same pure builders
  // (buildThermalReceipt/buildA4Html) the real print functions call.
  const [previewMode, setPreviewMode] = useState<'thermal' | 'a4' | null>(null);
  const [slabRule, setSlabRule] = useState<SlabRule>(DEFAULT_SLAB);

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

  async function loadAll() {
    if (!session) return;
    setError(null);
    const [itemsRes, heldRes, profileRes, modesRes, receiptSettingsRes, categoriesRes] = await Promise.allSettled([
      apiRequest<{ items: Item[] }>(`/companies/${session.companyId}/items`, { token: session.token }),
      apiRequest<{ invoices: InvoiceSummary[] }>(`/companies/${session.companyId}/invoices?status=HELD`, { token: session.token }),
      apiRequest<{ profiles: VerticalProfile[] }>(`/meta/vertical-profiles`, { token: session.token }),
      apiRequest<{ modes: PaymentModeEntry[] }>(`/companies/${session.companyId}/payments/modes`, { token: session.token }),
      apiRequest<{ settings: ReceiptSettings }>(`/companies/${session.companyId}/invoices/receipt-settings`, { token: session.token }),
      apiRequest<{ categories: CategoryEntry[] }>(`/companies/${session.companyId}/categories`, { token: session.token }),
    ]);

    if (itemsRes.status === 'fulfilled') {
      setItems(itemsRes.value.items);
    } else {
      setItems([]);
      setError(itemsRes.reason instanceof ApiError ? itemsRes.reason.message : 'Failed to load stock items for billing.');
    }

    if (heldRes.status === 'fulfilled') {
      setHeldBills(heldRes.value.invoices);
    } else {
      setHeldBills([]);
    }

    if (profileRes.status === 'fulfilled') {
      if (profileRes.value.profiles[0]?.gst?.mrpSlabRule) setSlabRule(profileRes.value.profiles[0].gst.mrpSlabRule);
      if (profileRes.value.profiles[0]?.units) setUnits(profileRes.value.profiles[0].units);
    } else {
      setSlabRule(DEFAULT_SLAB);
      setUnits(DEFAULT_UNITS);
    }

    if (modesRes.status === 'fulfilled') {
      const activeModes = modesRes.value.modes.filter((m) => m.isActive);
      setPaymentModes(activeModes.length ? activeModes : FALLBACK_PAYMENT_MODES);
    } else {
      setPaymentModes(FALLBACK_PAYMENT_MODES);
    }

    if (receiptSettingsRes.status === 'fulfilled') setReceiptSettings(receiptSettingsRes.value.settings);
    if (categoriesRes.status === 'fulfilled') setCategories(categoriesRes.value.categories);
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  function addToCart(item: Item) {
    const available = Number(item.stockQty);
    setCart((prev) => {
      const existing = prev.find((l) => l.itemId === item.id);
      if (existing) {
        if (existing.qty + 1 > available) {
          setError(`Only ${available} in stock for ${item.sku}`);
          return prev;
        }
        setError(null);
        return prev.map((l) => (l.itemId === item.id ? { ...l, qty: l.qty + 1 } : l));
      }
      if (available < 1) {
        setError(`Only ${available} in stock for ${item.sku}`);
        return prev;
      }
      setError(null);
      const gstRate = Number(item.gstRate);
      // Round 6 — the cart always stores an ex-tax unit rate from here on
      // ("Rate without tax"), regardless of how the item's own MRP/selling
      // rate is configured. An item priced inclusive gets converted once,
      // at add-time; gstInclusive: false is then permanent for this line, so
      // gst-calc.ts's existing exclusive branch (unchanged) does the rest.
      const rate = item.gstInclusive ? Number(item.sellingRate) / (1 + gstRate / 100) : Number(item.sellingRate);
      return [
        ...prev,
        { itemId: item.id, sku: item.sku, hsn: item.hsn, category: item.category, qty: 1, rate, mrp: Number(item.mrp), gstRate, gstInclusive: false, discountPct: 0 },
      ];
    });
    // Keep the cashier scanning without a re-click — the whole point of a
    // barcode-driven counter flow.
    skuSearchRef.current?.focus();
  }

  function updateLineQty(itemId: string, qty: number) {
    if (qty <= 0) {
      removeLine(itemId);
      return;
    }
    const item = items.find((i) => i.id === itemId);
    const available = item ? Number(item.stockQty) : Infinity;
    if (qty > available) {
      setError(`Only ${available} in stock for ${item?.sku ?? 'this item'}`);
      qty = available;
      if (qty <= 0) {
        removeLine(itemId);
        return;
      }
    } else {
      setError(null);
    }
    setCart((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, qty } : l)));
  }

  function updateLineRate(itemId: string, rate: number) {
    setCart((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, rate } : l)));
  }

  // Amount is the tax-inclusive line total (qty × rate × (1-disc%) × (1+gst%))
  // — editing it back-solves the ex-tax Rate for the same qty/discount/GST%,
  // then reuses updateLineRate so Rate stays the single source of truth.
  function updateLineAmount(itemId: string, amount: number) {
    setCart((prev) =>
      prev.map((l) => {
        if (l.itemId !== itemId) return l;
        const gstRate = l.gstRateOverride ?? l.gstRate;
        const divisor = l.qty * (1 - l.discountPct / 100) * (1 + gstRate / 100);
        return { ...l, rate: divisor > 0 ? amount / divisor : 0 };
      })
    );
  }

  function updateLineDiscount(itemId: string, discountPct: number) {
    setCart((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, discountPct } : l)));
  }

  // Editing MRP recalculates GST% through the normal, already-compliant slab
  // engine (same math, new input) — the safe alternative to a raw GST%
  // override, for when a shop's declared MRP has genuinely changed.
  function updateLineMrp(itemId: string, mrp: number) {
    setCart((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, mrp, gstRate: mrp <= slabRule.thresholdMrp ? slabRule.rateBelowOrEqual : slabRule.rateAbove } : l)));
  }

  function setLineGstOverride(itemId: string, gstRateOverride: number | undefined, gstOverrideReason: string | undefined) {
    setCart((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, gstRateOverride, gstOverrideReason } : l)));
  }

  function removeLine(itemId: string) {
    setCart((prev) => prev.filter((l) => l.itemId !== itemId));
  }

  function resetCart() {
    setCart([]);
    setSelectedParty(null);
    setCustomerQuery('');
    setCustomerMatches([]);
    setShowAddPerson(false);
    setBillDiscountPct(0);
    setBillDiscountAmt(0);
    setCartGen((g) => g + 1);
    setEditingId(null);
  }

  // "+ New bill" — resetCart() alone leaves the previous invoice's posted
  // panel (postedInvoice/payingAmount/printableInvoice) on screen, which is
  // both confusing and (per the payingAmount leak above) actively wrong.
  function startNewBill() {
    resetCart();
    setPostedInvoice(null);
    setPayingAmount(null);
    setPrintableInvoice(null);
    setPrintStatus(null);
  }

  function cartToLineBodies() {
    return cart.map((l) => ({
      itemId: l.itemId,
      qty: l.qty,
      rate: l.rate,
      gstInclusive: l.gstInclusive,
      discountPct: l.discountPct,
      ...(l.gstRateOverride !== undefined ? { gstRateOverride: l.gstRateOverride, gstOverrideReason: l.gstOverrideReason } : {}),
    }));
  }

  // Draft and Held were near-duplicate "not final yet" states — collapsed
  // into just Held. A held bill shows up in the tab strip below, where it
  // can be reopened, removed, or turned into a real invoice.
  async function saveHeld() {
    if (!session || cart.length === 0) return;
    setError(null);
    const body = {
      partyId: selectedParty?.id || undefined,
      status: 'HELD' as const,
      items: cartToLineBodies(),
      dueDate,
      discountPct: billDiscountPct,
      discountAmt: billDiscountAmt,
    };
    try {
      if (editingId) {
        await apiRequest(`/companies/${session.companyId}/invoices/${editingId}`, { method: 'PUT', token: session.token, body });
      } else {
        await apiRequest(`/companies/${session.companyId}/invoices`, { method: 'POST', token: session.token, body });
      }
      resetCart();
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to hold bill');
    }
  }

  async function removeHeld(id: string) {
    if (!session) return;
    setError(null);
    try {
      await apiRequest(`/companies/${session.companyId}/invoices/${id}`, { method: 'DELETE', token: session.token });
      if (editingId === id) resetCart();
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove held bill');
    }
  }

  async function postBill() {
    if (!session || cart.length === 0) return;
    setError(null);
    // Round 16 — payingAmount only ever grows (bumped by PaymentSplitPanel's
    // onRecorded) and was never cleared when a new bill gets posted, so a
    // previous invoice's paid amount was leaking into this one's "Amount
    // Due" and into the new overpayment guard, wrongly showing it already
    // paid off and blocking real payments from being recorded.
    setPayingAmount(null);
    const body = {
      partyId: selectedParty?.id || undefined,
      status: 'HELD' as const,
      items: cartToLineBodies(),
      dueDate,
      discountPct: billDiscountPct,
      discountAmt: billDiscountAmt,
    };
    try {
      let invoiceId = editingId;
      if (invoiceId) {
        try {
          await apiRequest(`/companies/${session.companyId}/invoices/${invoiceId}`, { method: 'PUT', token: session.token, body });
        } catch (err) {
          throw new Error(`Could not update held bill before posting: ${err instanceof ApiError ? err.message : String(err)}`);
        }
      } else {
        let created: { invoice: { id: string } };
        try {
          created = await apiRequest<{ invoice: { id: string } }>(`/companies/${session.companyId}/invoices`, { method: 'POST', token: session.token, body });
        } catch (err) {
          throw new Error(`Could not create bill: ${err instanceof ApiError ? err.message : String(err)}`);
        }
        invoiceId = created.invoice.id;
      }
      let posted: { invoice: PostedInvoice };
      try {
        posted = await apiRequest<{ invoice: PostedInvoice }>(`/companies/${session.companyId}/invoices/${invoiceId}/post`, { method: 'POST', token: session.token });
      } catch (err) {
        throw new Error(`Could not post bill: ${err instanceof ApiError ? err.message : String(err)}`);
      }
      setPostedInvoice(posted.invoice);
      setPrintStatus(null);
      const full = await apiRequest<{ invoice: PrintableInvoice }>(`/companies/${session.companyId}/invoices/${invoiceId}`, { token: session.token });
      setPrintableInvoice(full.invoice);
      resetCart();
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post bill');
    }
  }

  // A quotation for the customer — gets its own real EST/<fy>/<seq> number
  // immediately (unlike Draft/Held's placeholder), but never touches stock
  // or the party's ledger, so there's no /post step and no payment panel.
  async function saveEstimate() {
    if (!session || cart.length === 0) return;
    setError(null);
    const body = {
      partyId: selectedParty?.id || undefined,
      status: 'ESTIMATE' as const,
      items: cartToLineBodies(),
      dueDate,
      discountPct: billDiscountPct,
      discountAmt: billDiscountAmt,
    };
    try {
      const created = await apiRequest<{ invoice: { id: string } }>(`/companies/${session.companyId}/invoices`, { method: 'POST', token: session.token, body });
      setPostedInvoice(null);
      setPrintStatus(null);
      const full = await apiRequest<{ invoice: PrintableInvoice }>(`/companies/${session.companyId}/invoices/${created.invoice.id}`, { token: session.token });
      setPrintableInvoice(full.invoice);
      resetCart();
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save estimate');
    }
  }

  async function printReceipt() {
    if (!printableInvoice) return;
    const result = await printThermalReceipt(printableInvoice, thermalLayout, receiptSettings);
    setPrintStatus(result.message);
  }

  function printInvoice() {
    if (!printableInvoice) return;
    void printA4Invoice(printableInvoice, a4Layout, receiptSettings);
  }

  async function cancelPostedInvoice(reason: string) {
    if (!session || !postedInvoice) return;
    try {
      await apiRequest(`/companies/${session.companyId}/invoices/${postedInvoice.id}/cancel`, { method: 'POST', token: session.token, body: { reason } });
      setPostedInvoice(null);
      setPayingAmount(null);
      setShowCancelReason(false);
      setPrintableInvoice(null);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to cancel invoice');
    }
  }

  function reopenInvoice(invoice: InvoiceSummary) {
    setPostedInvoice(null);
    setPrintableInvoice(null);
    setPayingAmount(null);
    setEditingId(invoice.id);
    // Reopening a held/draft bill doesn't currently restore its original
    // customer selection — pre-existing limitation, unchanged by Round 5.
    setSelectedParty(null);
    setBillDiscountPct(Number(invoice.discountPct));
    setBillDiscountAmt(Number(invoice.discountAmt));
    setCartGen((g) => g + 1);
    setCart(
      invoice.items.map((line) => {
        const item = items.find((i) => i.id === line.itemId);
        return {
          itemId: line.itemId,
          sku: item?.sku ?? line.itemId,
          hsn: item?.hsn ?? null,
          category: item?.category ?? null,
          qty: Number(line.qty),
          rate: Number(line.rate),
          mrp: Number(item?.mrp ?? line.rate),
          gstRate: Number(line.gstRate),
          gstInclusive: line.gstInclusive,
          discountPct: Number(line.discountPct),
        };
      })
    );
  }

  const filteredItems = search.trim()
    ? items.filter((i) => {
        const q = search.toLowerCase();
        return (
          i.sku.toLowerCase().includes(q) ||
          i.category?.toLowerCase().includes(q) ||
          i.size?.toLowerCase().includes(q) ||
          i.color?.toLowerCase().includes(q)
        );
      })
    : items;

  async function runCustomerSearch(query: string) {
    setCustomerQuery(query);
    if (!session || !query.trim()) {
      setCustomerMatches([]);
      return;
    }
    setCustomerSearching(true);
    try {
      const res = await apiRequest<{ parties: Party[] }>(
        `/companies/${session.companyId}/parties?type=CUSTOMER&search=${encodeURIComponent(query.trim())}`,
        { token: session.token }
      );
      setCustomerMatches(res.parties);
    } catch {
      setCustomerMatches([]);
    } finally {
      setCustomerSearching(false);
    }
  }

  function selectParty(p: Party) {
    setSelectedParty(p);
    setCustomerMatches([]);
    setCustomerQuery('');
    setShowAddPerson(false);
  }

  useEffect(() => {
    if (!session || !initialPartyId) return;
    void apiRequest<{ party: Party }>(`/companies/${session.companyId}/parties/${initialPartyId}`, { token: session.token })
      .then((res) => selectParty(res.party))
      .catch(() => {})
      .finally(() => onInitialPartyConsumed?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPartyId]);

  async function handleAddPerson() {
    if (!session) return;
    const name = newPersonNameRef.current?.value.trim();
    if (!name) {
      setError('Enter a name for the new customer');
      return;
    }
    setError(null);
    try {
      const res = await apiRequest<{ party: Party }>(`/companies/${session.companyId}/parties`, {
        method: 'POST',
        token: session.token,
        body: {
          type: 'CUSTOMER',
          name,
          phone: newPersonPhoneRef.current?.value.trim() || undefined,
          gstin: newPersonGstinRef.current?.value.trim() || undefined,
          address: newPersonAddressRef.current?.value.trim() || undefined,
          openingBalance: Number(newPersonOpeningBalanceRef.current?.value || 0),
          creditLimit: newPersonCreditLimitRef.current?.value ? Number(newPersonCreditLimitRef.current.value) : undefined,
          dob: newPersonDobRef.current?.value || undefined,
          anniversary: newPersonAnniversaryRef.current?.value || undefined,
          notes: newPersonNotesRef.current?.value.trim() || undefined,
        },
      });
      selectParty(res.party);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add customer');
    }
  }

  // Round 13 — mirrors ItemMasterPage.tsx's fillAutoSku/handleCategorySelect:
  // Auto mode calls /next-sku on category pick, Manual mode never does.
  async function fillNewItemAutoSku(entry: CategoryEntry) {
    if (!session) return;
    try {
      const res = await apiRequest<{ skus: string[] }>(`/companies/${session.companyId}/items/next-sku`, {
        method: 'POST',
        token: session.token,
        body: { categoryCode: entry.code },
      });
      if (newItemSkuRef.current && res.skus[0]) newItemSkuRef.current.value = res.skus[0];
    } catch {
      // SKU auto-fill is a convenience — leave the field as-is on failure.
    }
  }

  function handleNewItemCategorySelect(entry: CategoryEntry) {
    setNewItemSelectedCategory(entry);
    if (newItemSkuMode === 'auto') void fillNewItemAutoSku(entry);
  }

  function handleNewItemSkuModeChange(mode: SkuMode) {
    setNewItemSkuMode(mode);
    if (mode === 'auto' && newItemSelectedCategory) void fillNewItemAutoSku(newItemSelectedCategory);
    if (mode === 'manual') newItemSkuRef.current?.focus();
  }

  async function handleCreateCategoryForNewItem(name: string): Promise<CategoryEntry> {
    if (!session) throw new Error('No session');
    const res = await apiRequest<{ categories: CategoryEntry[]; category: CategoryEntry }>(`/companies/${session.companyId}/categories`, {
      method: 'POST',
      token: session.token,
      body: { name },
    });
    setCategories(res.categories);
    return res.category;
  }

  function handleNewItemMrpChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (newItemGstManuallySet) return;
    const mrp = Number(e.currentTarget.value) || 0;
    setNewItemGstRateValue(String(mrp <= slabRule.thresholdMrp ? slabRule.rateBelowOrEqual : slabRule.rateAbove));
  }

  async function handleAddItem() {
    if (!session) return;
    const sku = newItemSkuRef.current?.value.trim();
    if (!sku) {
      setError('Enter or generate a SKU for the new item');
      return;
    }
    setError(null);
    try {
      const mrp = Number(newItemMrpRef.current?.value || 0);
      const res = await apiRequest<{ item: Item }>(`/companies/${session.companyId}/items`, {
        method: 'POST',
        token: session.token,
        body: {
          sku,
          category: newItemCategoryRef.current?.value.trim() || undefined,
          brand: newItemBrandRef.current?.value.trim() || undefined,
          size: newItemSizeRef.current?.value.trim() || undefined,
          color: newItemColorRef.current?.value.trim() || undefined,
          unit: newItemUnitRef.current?.value || units.default,
          purchaseRate: Number(newItemPurchaseRateRef.current?.value || 0),
          mrp,
          sellingRate: Number(newItemRateRef.current?.value || mrp),
          openingStock: Number(newItemStockRef.current?.value || 0),
          minStock: Number(newItemMinStockRef.current?.value || 0),
          hsn: newItemHsnRef.current?.value.trim() || undefined,
          barcode: newItemBarcodeRef.current?.value.trim() || undefined,
          gstRate: Number(newItemGstRateValue),
          gstInclusive: newItemGstInclusive,
          commodity: newItemCommodityRef.current?.value.trim() || undefined,
          itemType: newItemItemTypeRef.current?.value.trim() || undefined,
          brandCode: newItemBrandCodeRef.current?.value.trim() || undefined,
          styleCode: newItemStyleCodeRef.current?.value.trim() || undefined,
          mfgDate: newItemMfgDateRef.current?.value || undefined,
          netQtyLabel: newItemNetQtyLabelRef.current?.value.trim() || undefined,
        },
      });
      setItems((prev) => [...prev, res.item]);
      addToCart(res.item);
      setShowAddItem(false);
      if (newItemSkuRef.current) newItemSkuRef.current.value = '';
      if (newItemBrandRef.current) newItemBrandRef.current.value = '';
      if (newItemSizeRef.current) newItemSizeRef.current.value = '';
      if (newItemColorRef.current) newItemColorRef.current.value = '';
      if (newItemPurchaseRateRef.current) newItemPurchaseRateRef.current.value = '';
      if (newItemMrpRef.current) newItemMrpRef.current.value = '';
      if (newItemRateRef.current) newItemRateRef.current.value = '';
      if (newItemStockRef.current) newItemStockRef.current.value = '';
      if (newItemMinStockRef.current) newItemMinStockRef.current.value = '';
      if (newItemHsnRef.current) newItemHsnRef.current.value = '';
      if (newItemBarcodeRef.current) newItemBarcodeRef.current.value = '';
      if (newItemCommodityRef.current) newItemCommodityRef.current.value = '';
      if (newItemItemTypeRef.current) newItemItemTypeRef.current.value = '';
      if (newItemBrandCodeRef.current) newItemBrandCodeRef.current.value = '';
      if (newItemStyleCodeRef.current) newItemStyleCodeRef.current.value = '';
      if (newItemMfgDateRef.current) newItemMfgDateRef.current.value = '';
      if (newItemNetQtyLabelRef.current) newItemNetQtyLabelRef.current.value = '';
      setNewItemGstRateValue('5');
      setNewItemGstManuallySet(false);
      setNewItemGstInclusive(true);
      setNewItemSelectedCategory(null);
      setAddItemFormResetToken((t) => t + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add item');
    }
  }

  const preview = previewInvoiceTotals(cart, slabRule, billDiscountPct, billDiscountAmt);

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      {/* Polish pass — focus ring is a real CSS pseudo-class, which inline
          style objects can't express; this is the one page-scoped exception,
          same precedent as index.html's box-sizing reset. */}
      <style>{`.rt-input:focus { outline: 2px solid ${color.brass}; outline-offset: 1px; border-color: ${color.brass} !important; }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 19, margin: 0, color: color.ink }}>GST Billing</h1>
        <button onClick={startNewBill} style={outlineBtn(color.inkSoft)}>+ New bill</button>
      </div>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {/* Held-bill tabs — keep it (reopen), remove it, or reopen then Post Bill to save as a real invoice. */}
      {heldBills.length > 0 && (
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
        {heldBills.map((inv) => {
          const sc = statusColor(inv.status);
          const active = editingId === inv.id;
          return (
            <div
              key={inv.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, borderRadius: '7px 7px 0 0',
                background: active ? color.paperRaised : color.lineSoft,
                boxShadow: active ? `inset 0 -2px 0 ${color.brass}` : 'none',
              }}
            >
              <button
                onClick={() => reopenInvoice(inv)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 4px 6px 12px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12.5,
                  color: active ? color.ink : color.inkSoft, fontWeight: active ? 600 : 400,
                }}
              >
                <span style={{ fontFamily: theme.mono, fontSize: 9, padding: '1px 5px', borderRadius: 20, background: sc.bg, color: sc.fg }}>{inv.status}</span>
                {inv.party?.name ?? 'Walk-in'}
              </button>
              <button
                onClick={() => void removeHeld(inv.id)}
                aria-label="Remove held bill"
                title="Remove"
                style={{ display: 'flex', border: 'none', background: 'transparent', cursor: 'pointer', color: color.inkFaint, padding: '6px 10px 6px 0' }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      )}

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          {/* Customer panel — search-driven; typing a phone number naturally
              surfaces every family member already linked to it (same search
              matches every Party row containing that number). */}
          <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, padding: 10, marginBottom: 10 }}>
            {selectedParty ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 13.5, color: color.ink }}>{selectedParty.name}</span>
                  {selectedParty.phone && <span style={{ fontSize: 12, color: color.inkFaint }}> · {selectedParty.phone}</span>}
                  <div style={{ fontSize: 12, color: color.inkFaint, marginTop: 2 }}>
                    Old Balance: <span style={{ fontFamily: theme.mono }}>₹{money(selectedParty.balance)}</span>
                  </div>
                  {selectedParty.creditLimit && Number(selectedParty.creditLimit) > 0 && Number(selectedParty.balance) + preview.total > Number(selectedParty.creditLimit) && (
                    <div style={{ fontSize: 11.5, color: color.amber, background: color.amberTint, borderRadius: theme.radiusSm, padding: '4px 8px', marginTop: 6 }}>
                      This bill would take {selectedParty.name} past their credit limit of ₹{money(selectedParty.creditLimit)}.
                    </div>
                  )}
                </div>
                <button onClick={() => setSelectedParty(null)} style={linkBtn}>Change</button>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {/* Walk-in is the default when nothing's selected — shown as
                      an explicit chip rather than buried in placeholder text.
                      Clicking it clears any in-progress search. */}
                  <button
                    onClick={() => { setCustomerQuery(''); setCustomerMatches([]); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 999, border: 'none', background: color.ledger, color: '#fff', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer' }}
                  >
                    Walk-in
                  </button>
                  <div style={{ position: 'relative', flex: 1 }}>
                    <User size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: color.inkFaint, pointerEvents: 'none' }} />
                    <input
                      className="rt-input"
                      defaultValue=""
                      placeholder="Search by mobile, name or address"
                      onBlur={(e) => void runCustomerSearch(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void runCustomerSearch(e.currentTarget.value);
                      }}
                      style={{ width: '100%', padding: '9px 9px 9px 32px', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14 }}
                    />
                  </div>
                  <button onClick={() => setShowAddPerson((v) => !v)} style={secondaryBtn}>+ Add new customer</button>
                </div>

                {customerSearching && <div style={{ fontSize: 12, color: color.inkFaint, marginTop: 6 }}>Searching…</div>}

                {customerMatches.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ fontSize: 11, color: color.inkFaint }}>
                      {customerMatches.length > 1 ? `${customerMatches.length} matches - same number can link several family members` : '1 match'}
                    </div>
                    {customerMatches.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => selectParty(p)}
                        style={{ cursor: 'pointer', padding: '8px 10px', borderRadius: theme.radiusSm, border: `1px solid ${color.line}`, fontSize: 13 }}
                      >
                        <span style={{ fontWeight: 600 }}>{p.name}</span>
                        {p.phone && <span style={{ color: color.inkFaint }}> · {p.phone}</span>}
                        {p.address && <span style={{ color: color.inkFaint }}> · {p.address}</span>}
                      </div>
                    ))}
                  </div>
                )}

                {showAddPerson && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${color.line}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <Field label="Name*" innerRef={newPersonNameRef} placeholder="Customer name" />
                    <Field label="Phone" innerRef={newPersonPhoneRef} keyOverride={customerQuery} defaultOverride={looksLikePhone(customerQuery) ? customerQuery : ''} placeholder="mobile number" />
                    <Field label="GSTIN (optional)" innerRef={newPersonGstinRef} placeholder="22AAAAA0000A1Z5" />
                    <Field label="Address (optional)" innerRef={newPersonAddressRef} placeholder="address" />
                    <Field label="Opening Balance" innerRef={newPersonOpeningBalanceRef} type="number" placeholder="0" />
                    <Field label="Credit Limit (optional)" innerRef={newPersonCreditLimitRef} type="number" placeholder="0" />
                    <Field label="Notes (optional)" innerRef={newPersonNotesRef} placeholder="sizes, preferences, marketing notes" />
                    <Field label="DOB (optional)" innerRef={newPersonDobRef} type="date" />
                    <Field label="Anniversary (optional)" innerRef={newPersonAnniversaryRef} type="date" />
                    <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
                      <button onClick={() => void handleAddPerson()} style={secondaryBtn}>Save & Select</button>
                      <button onClick={() => setShowAddPerson(false)} style={linkBtn}>Cancel</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Barcode size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: color.inkFaint, pointerEvents: 'none' }} />
              <input
                ref={skuSearchRef}
                className="rt-input"
                defaultValue=""
                placeholder="Scan barcode or search SKU/category/colour/size"
                onBlur={(e) => setSearch(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setSearch(e.currentTarget.value);
                }}
                style={{ width: '100%', padding: '9px 9px 9px 32px', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14 }}
              />
            </div>
            <button onClick={() => setShowAddItem((v) => !v)} style={secondaryBtn}>+ Add new item</button>
          </div>

          {showAddItem && (
            <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, padding: 10, marginBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                  SKU*
                  <input
                    ref={newItemSkuRef}
                    className="rt-input"
                    defaultValue=""
                    readOnly={newItemSkuMode === 'auto'}
                    placeholder={newItemSkuMode === 'auto' ? 'Pick a category to generate' : 'unique SKU'}
                    style={{ padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13, background: newItemSkuMode === 'auto' ? color.paper : '#fff' }}
                  />
                  <SkuModeToggle mode={newItemSkuMode} onChange={handleNewItemSkuModeChange} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                  Category
                  <CategoryPicker
                    key={addItemFormResetToken}
                    ref={newItemCategoryRef}
                    categories={categories}
                    defaultValue=""
                    placeholder="Search or add…"
                    style={{ padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13 }}
                    onSelect={handleNewItemCategorySelect}
                    onCreate={handleCreateCategoryForNewItem}
                  />
                </label>
                <Field label="Brand" innerRef={newItemBrandRef} placeholder="optional" />
                <Field label="Size" innerRef={newItemSizeRef} placeholder="e.g. M" />
                <Field label="Colour" innerRef={newItemColorRef} placeholder="e.g. Blue" />
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                  Unit
                  <select key={units.default} ref={newItemUnitRef} defaultValue={units.default} className="rt-input" style={{ padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13 }}>
                    {units.allowed.map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </label>
                <Field label="Purchase rate" innerRef={newItemPurchaseRateRef} type="number" placeholder="0" />
                <Field label="MRP" innerRef={newItemMrpRef} type="number" placeholder="0" onChange={handleNewItemMrpChange} />
                <Field label="Selling rate" innerRef={newItemRateRef} type="number" placeholder="defaults to MRP" />
                <Field label="Opening stock" innerRef={newItemStockRef} type="number" placeholder="0" />
                <Field label="Min stock" innerRef={newItemMinStockRef} type="number" placeholder="0" />
                <Field label="HSN (optional)" innerRef={newItemHsnRef} placeholder="e.g. 6109" />
                <Field label="Barcode (optional)" innerRef={newItemBarcodeRef} placeholder="scan or type" />
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                  GST %
                  <select
                    value={newItemGstRateValue}
                    onChange={(e) => { setNewItemGstRateValue(e.target.value); setNewItemGstManuallySet(true); }}
                    className="rt-input"
                    style={{ padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13 }}
                  >
                    {GST_OPTIONS.map((r) => (
                      <option key={r} value={r}>{r}%</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, fontSize: 12, color: color.inkSoft, marginTop: 16 }}>
                  <input type="checkbox" checked={newItemGstInclusive} onChange={(e) => setNewItemGstInclusive(e.target.checked)} /> GST inclusive
                </label>
              </div>

              <button
                type="button"
                onClick={() => setShowAddItemAdvanced((v) => !v)}
                style={{ border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 11.5, textDecoration: 'underline', padding: 0, marginTop: 8, display: 'block' }}
              >
                {showAddItemAdvanced ? '- Hide' : '+ Show'} advanced details
              </button>
              {showAddItemAdvanced && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 8 }}>
                  <Field label="Legal name (for label)" innerRef={newItemCommodityRef} placeholder="e.g. Shirt" />
                  <Field label="Sub-type (for label)" innerRef={newItemItemTypeRef} placeholder="e.g. Casual" />
                  <Field label="Brand Code" innerRef={newItemBrandCodeRef} />
                  <Field label="Style Code" innerRef={newItemStyleCodeRef} />
                  <Field label="MFG Date" innerRef={newItemMfgDateRef} type="date" />
                  <Field label="Net Qty (for label)" innerRef={newItemNetQtyLabelRef} placeholder="e.g. 1 N, 500 g" />
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => void handleAddItem()} style={secondaryBtn}>Save & Add to Bill</button>
                <button onClick={() => setShowAddItem(false)} style={linkBtn}>Cancel</button>
              </div>
            </div>
          )}

          {/* Product grid — compact chips; the left accent maps to category
              (not a random per-SKU color) so the same product line always
              reads the same way. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8, marginBottom: 14, maxHeight: 220, overflowY: 'auto' }}>
            {filteredItems.length === 0 ? (
              <div style={{ gridColumn: '1 / -1', padding: 16, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>No items match.</div>
            ) : (
              filteredItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => addToCart(item)}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left', background: color.paperRaised,
                    border: `1px solid ${color.line}`, borderLeft: `3px solid ${categoryColor(item.category)}`,
                    borderRadius: theme.radiusSm, padding: '8px 10px', cursor: 'pointer', boxShadow: theme.shadowSm,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: color.ink }}>{item.sku}</div>
                  {item.category && <div style={{ fontSize: 10, color: color.inkSoft }}>{item.category}</div>}
                  <div style={{ fontSize: 10.5, color: color.inkFaint, minHeight: 13 }}>{[item.size, item.color].filter(Boolean).join(' · ')}</div>
                  {item.hsn && <div style={{ fontSize: 9.5, color: color.inkFaint }}>HSN {item.hsn}</div>}
                  <div style={{ fontFamily: theme.mono, fontSize: 12, color: color.brass, fontWeight: 600 }}>₹{money(item.sellingRate)}</div>
                </button>
              ))
            )}
          </div>

          {/* Cart */}
          <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 16, boxShadow: theme.shadowSm }}>
            {cart.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: color.inkFaint, fontSize: 13 }}>No items added yet - tap a product above.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: 11.5, color: color.inkFaint, fontFamily: theme.mono, textTransform: 'uppercase', borderBottom: `1px solid ${color.line}` }}>
                    <th style={{ padding: 6 }}>SKU</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>Qty</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>Rate (excl. GST)</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>Disc%</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>GST%</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>Amount (incl. GST)</th>
                    <th style={{ padding: 6 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((line) => {
                    const effectiveGstRate = line.gstRateOverride ?? line.gstRate;
                    const lineTaxable = line.qty * line.rate * (1 - line.discountPct / 100);
                    const lineAmount = lineTaxable * (1 + effectiveGstRate / 100);
                    return (
                      <tr key={line.itemId} style={{ borderTop: `1px solid ${color.lineSoft}`, fontSize: 14 }}>
                        <td style={{ padding: 6 }}>
                          {line.sku}
                          {line.category && <div style={{ fontSize: 10, color: color.inkSoft }}>{line.category}</div>}
                          {line.hsn && <div style={{ fontSize: 10, color: color.inkFaint }}>HSN {line.hsn}</div>}
                        </td>
                        <td style={{ padding: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                            <StepBtn icon={<Minus size={11} />} onClick={() => updateLineQty(line.itemId, line.qty - 1)} />
                            <input
                              defaultValue={line.qty}
                              key={line.qty}
                              type="number"
                              className="rt-input"
                              onBlur={(e) => updateLineQty(line.itemId, Number(e.currentTarget.value) || 0)}
                              style={cellInputStyle(48, 'center')}
                            />
                            <StepBtn icon={<Plus size={11} />} onClick={() => updateLineQty(line.itemId, line.qty + 1)} />
                          </div>
                        </td>
                        <td style={{ padding: 6, textAlign: 'right' }}>
                          <input
                            defaultValue={line.rate}
                            key={line.rate}
                            type="number"
                            className="rt-input"
                            onBlur={(e) => updateLineRate(line.itemId, Number(e.currentTarget.value) || 0)}
                            style={cellInputStyle(72, 'right')}
                          />
                        </td>
                        <td style={{ padding: 6, textAlign: 'right' }}>
                          <input
                            defaultValue={line.discountPct}
                            key={line.discountPct}
                            type="number"
                            className="rt-input"
                            onBlur={(e) => updateLineDiscount(line.itemId, Number(e.currentTarget.value) || 0)}
                            style={cellInputStyle(56, 'right')}
                          />
                        </td>
                        <td style={{ padding: 6, textAlign: 'right' }}>
                          <button
                            onClick={() => isAdmin && setGstEditLineId((id) => (id === line.itemId ? null : line.itemId))}
                            disabled={!isAdmin}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginLeft: 'auto',
                              border: 'none', background: 'transparent', cursor: isAdmin ? 'pointer' : 'default', padding: '4px 2px',
                              width: '100%',
                            }}
                          >
                            <span style={{ fontFamily: theme.mono, color: color.ink }}>{line.gstRateOverride ?? line.gstRate}%</span>
                            {line.gstRateOverride !== undefined && (
                              <span title={line.gstOverrideReason} style={{ fontSize: 9, color: color.amber, fontFamily: theme.mono }}>OVR</span>
                            )}
                          </button>
                          {gstEditLineId === line.itemId && (
                            <GstOverrideEditor
                              line={line}
                              onApplyMrp={(mrp) => {
                                updateLineMrp(line.itemId, mrp);
                                setGstEditLineId(null);
                              }}
                              onApplyOverride={(rate, reason) => {
                                setLineGstOverride(line.itemId, rate, reason);
                                setGstEditLineId(null);
                              }}
                              onClearOverride={() => {
                                setLineGstOverride(line.itemId, undefined, undefined);
                                setGstEditLineId(null);
                              }}
                            />
                          )}
                        </td>
                        <td style={{ padding: 6, textAlign: 'right' }}>
                          <input
                            defaultValue={lineAmount.toFixed(2)}
                            key={`${line.qty}-${line.rate}-${line.discountPct}-${effectiveGstRate}`}
                            type="number"
                            className="rt-input"
                            onBlur={(e) => updateLineAmount(line.itemId, Number(e.currentTarget.value) || 0)}
                            style={cellInputStyle(80, 'right')}
                          />
                        </td>
                        <td style={{ padding: 6 }}>
                          <RemoveLineButton onClick={() => removeLine(line.itemId)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px dashed ${color.line}` }}>
              {/* Stacked, right-aligned summary — Total is the one figure
                  that should visually dominate. */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: 200, fontSize: 12, color: color.inkFaint }}>
                  <span>Taxable</span><span style={{ fontFamily: theme.mono }}>₹{money(preview.subtotal)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: 200, fontSize: 12, color: color.inkFaint }}>
                  <span>CGST</span><span style={{ fontFamily: theme.mono }}>₹{money(preview.cgst)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: 200, fontSize: 12, color: color.inkFaint }}>
                  <span>SGST</span><span style={{ fontFamily: theme.mono }}>₹{money(preview.sgst)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: 200, fontSize: 12, color: color.inkFaint }}>
                  <span>Bill Discount</span>
                  <span style={{ display: 'flex', gap: 4 }}>
                    <input
                      key={`disc-pct-${cartGen}`}
                      defaultValue={billDiscountPct || ''}
                      type="number"
                      className="rt-input"
                      placeholder="%"
                      onBlur={(e) => setBillDiscountPct(Number(e.currentTarget.value) || 0)}
                      style={cellInputStyle(38, 'right')}
                    />
                    <input
                      key={`disc-amt-${cartGen}`}
                      defaultValue={billDiscountAmt || ''}
                      type="number"
                      className="rt-input"
                      placeholder="₹"
                      onBlur={(e) => setBillDiscountAmt(Number(e.currentTarget.value) || 0)}
                      style={cellInputStyle(48, 'right')}
                    />
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: 200, borderTop: `1px solid ${color.line}`, marginTop: 4, paddingTop: 4 }}>
                  <span style={{ fontWeight: 600, color: color.ink, alignSelf: 'center' }}>Total</span>
                  <span style={{ fontFamily: theme.mono, fontSize: 22, fontWeight: 700, color: color.ink }}>₹{money(preview.total)}</span>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => void saveHeld()} disabled={cart.length === 0} style={outlineBtn(color.inkSoft)}>Hold</button>
                  <button onClick={() => void saveEstimate()} disabled={cart.length === 0 || !!editingId} title={editingId ? 'Estimates are single-shot - finish or cancel this edit first' : undefined} style={outlineBtn(color.amber)}>Save as Estimate</button>
                  <button onClick={() => void postBill()} disabled={cart.length === 0} style={primaryBtn}>Post Bill</button>
                  {editingId && <button onClick={resetCart} style={linkBtn}>Cancel Edit</button>}
                </div>
              </div>
            </div>
          </div>

          {printableInvoice && !postedInvoice && (
            <div style={{ background: color.amberTint, border: `1px solid ${color.amber}44`, borderRadius: theme.radius, padding: 16, marginTop: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 4, color: color.ink }}>Estimate: {printableInvoice.number}</div>
              <div style={{ fontSize: 13, color: color.amber, marginBottom: 10 }}>
                Not a tax invoice - for the customer's reference only. Total ₹{money(printableInvoice.total)}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                  Thermal layout
                  <select value={thermalLayout} onChange={(e) => setThermalLayout(e.target.value as ThermalLayout)} style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }}>
                    <option value="receipt">Receipt</option>
                    <option value="compact">Compact</option>
                    <option value="standard">Standard</option>
                    <option value="detailed">Detailed</option>
                  </select>
                </label>
                <button onClick={() => setPreviewMode('thermal')} style={outlineBtn(color.inkSoft)}>Preview</button>
                <button onClick={() => void printReceipt()} style={secondaryBtn}>Print Receipt</button>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                  Invoice layout
                  <select value={a4Layout} onChange={(e) => setA4Layout(e.target.value as A4Layout)} style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }}>
                    <option value="a4">A4</option>
                    <option value="a5">A5</option>
                  </select>
                </label>
                <button onClick={() => setPreviewMode('a4')} style={outlineBtn(color.inkSoft)}>Preview</button>
                <button onClick={printInvoice} style={secondaryBtn}>Print A4/A5 Invoice</button>
              </div>
              {printStatus && <div style={{ fontSize: 12, color: color.amber, marginTop: 8 }}>{printStatus}</div>}
            </div>
          )}

          {postedInvoice && (
            <div style={{ background: color.moneyTint, border: `1px solid ${color.money}44`, borderRadius: theme.radius, padding: 16, marginTop: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 4, color: color.ink }}>Posted: {postedInvoice.number}</div>
              <div style={{ fontSize: 13, color: color.money, marginBottom: 10 }}>
                Total ₹{money(postedInvoice.total)} - Old Balance ₹{money(postedInvoice.oldBalance)} →
                Amount Due ₹{money(Number(postedInvoice.newBalance) - (payingAmount ?? 0))}
                {payingAmount ? ` (₹${money(payingAmount)} paid)` : ''}
              </div>

              <PaymentSplitPanel
                companyId={session?.companyId ?? ''}
                token={session?.token ?? ''}
                invoiceId={postedInvoice.id}
                partyId={postedInvoice.partyId}
                billTotal={Number(postedInvoice.newBalance)}
                alreadyPaid={payingAmount ?? 0}
                paymentModes={paymentModes}
                onRecorded={async (paidAmount) => {
                  if (paidAmount > 0) setPayingAmount((prev) => (prev ?? 0) + paidAmount);
                  // Round 18 — printableInvoice was only ever fetched once,
                  // right after posting, so it never reflected payments
                  // recorded afterward: the printed receipt's payment-mode
                  // detail (sectionPaidLine) silently stayed empty/stale for
                  // the entire post-bill → record payment → print flow.
                  if (session && postedInvoice) {
                    const full = await apiRequest<{ invoice: PrintableInvoice }>(`/companies/${session.companyId}/invoices/${postedInvoice.id}`, { token: session.token });
                    setPrintableInvoice(full.invoice);
                  }
                  await loadAll();
                }}
              />

              <button onClick={() => setShowCancelReason(true)} style={{ ...secondaryBtn, background: color.alert, marginTop: 10 }}>Cancel Bill</button>

              {showCancelReason && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                    Cancel reason (required)
                    <input ref={cancelReasonRef} defaultValue="" style={{ width: 220, padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }} />
                  </label>
                  <button
                    onClick={() => {
                      const reason = cancelReasonRef.current?.value.trim();
                      if (reason) void cancelPostedInvoice(reason);
                    }}
                    style={{ ...secondaryBtn, background: color.alert }}
                  >
                    Confirm Cancel
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${color.money}33` }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                  Thermal layout
                  <select value={thermalLayout} onChange={(e) => setThermalLayout(e.target.value as ThermalLayout)} style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }}>
                    <option value="receipt">Receipt</option>
                    <option value="compact">Compact</option>
                    <option value="standard">Standard</option>
                    <option value="detailed">Detailed</option>
                  </select>
                </label>
                <button onClick={() => setPreviewMode('thermal')} style={outlineBtn(color.inkSoft)}>Preview</button>
                <button onClick={() => void printReceipt()} style={secondaryBtn}>Print Receipt</button>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                  Invoice layout
                  <select value={a4Layout} onChange={(e) => setA4Layout(e.target.value as A4Layout)} style={{ padding: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }}>
                    <option value="a4">A4</option>
                    <option value="a5">A5</option>
                  </select>
                </label>
                <button onClick={() => setPreviewMode('a4')} style={outlineBtn(color.inkSoft)}>Preview</button>
                <button onClick={printInvoice} style={secondaryBtn}>Print A4/A5 Invoice</button>
              </div>
              {printStatus && <div style={{ fontSize: 12, color: color.money, marginTop: 8 }}>{printStatus}</div>}
            </div>
          )}

          {previewMode && printableInvoice && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
              <div style={{ background: color.paperRaised, borderRadius: theme.radius, boxShadow: theme.shadowSm, maxWidth: previewMode === 'thermal' ? 360 : 700, width: '92%', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${color.line}` }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: color.ink }}>
                    {previewMode === 'thermal' ? 'Receipt preview' : 'Invoice preview'}
                  </div>
                  <button onClick={() => setPreviewMode(null)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, color: color.inkFaint, lineHeight: 1 }}>×</button>
                </div>
                <div style={{ flex: 1, overflow: 'auto', padding: previewMode === 'thermal' ? 16 : 0, background: previewMode === 'thermal' ? color.paper : '#fff' }}>
                  {previewMode === 'thermal' ? (
                    <pre style={{ fontFamily: theme.mono, fontSize: 12, whiteSpace: 'pre-wrap', margin: 0, background: '#fff', padding: 12, borderRadius: theme.radiusSm, border: `1px solid ${color.line}` }}>
                      {buildThermalReceipt(printableInvoice, thermalLayout, receiptSettings)}
                    </pre>
                  ) : (
                    <iframe title="Invoice preview" srcDoc={buildA4Html(printableInvoice, a4Layout, receiptSettings)} style={{ width: '100%', height: '70vh', border: 'none' }} />
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: `1px solid ${color.line}` }}>
                  <button
                    onClick={() => {
                      if (previewMode === 'thermal') void printReceipt();
                      else printInvoice();
                      setPreviewMode(null);
                    }}
                    style={secondaryBtn}
                  >
                    Print now
                  </button>
                  <button onClick={() => setPreviewMode(null)} style={outlineBtn(color.inkSoft)}>Close</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  innerRef,
  placeholder,
  type = 'text',
  keyOverride,
  defaultOverride,
  onChange,
}: {
  label: string;
  innerRef: React.RefObject<HTMLInputElement | null>;
  placeholder?: string;
  type?: string;
  keyOverride?: string;
  defaultOverride?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
      {label}
      <input
        key={keyOverride}
        ref={innerRef}
        className="rt-input"
        defaultValue={defaultOverride ?? ''}
        placeholder={placeholder}
        type={type}
        onChange={onChange}
        style={{ padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13 }}
      />
    </label>
  );
}

// Round 5 — ADMIN-only per-line GST control: the primary, safe path is
// editing MRP (recalculates through the normal compliant slab engine); the
// direct GST% override is a fallback requiring a reason, kept separate here
// so its own uncontrolled inputs don't interfere with the row's other cells.
function GstOverrideEditor({
  line,
  onApplyMrp,
  onApplyOverride,
  onClearOverride,
}: {
  line: CartLine;
  onApplyMrp: (mrp: number) => void;
  onApplyOverride: (rate: number, reason: string) => void;
  onClearOverride: () => void;
}) {
  const mrpRef = useRef<HTMLInputElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6, background: color.paper, padding: 8, borderRadius: theme.radiusSm, border: `1px solid ${color.line}`, minWidth: 190 }}>
      <label style={{ fontSize: 10, color: color.inkSoft, display: 'flex', flexDirection: 'column', gap: 2 }}>
        MRP (safe - recalculates GST% automatically)
        <input ref={mrpRef} type="number" defaultValue={line.mrp} style={{ padding: 4, fontSize: 12, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }} />
      </label>
      <button onClick={() => onApplyMrp(Number(mrpRef.current?.value) || line.mrp)} style={{ ...linkBtn, padding: '2px 0', fontSize: 11 }}>Apply MRP</button>

      <div style={{ borderTop: `1px dashed ${color.line}` }} />

      <label style={{ fontSize: 10, color: color.inkSoft, display: 'flex', flexDirection: 'column', gap: 2 }}>
        Override GST% (requires a reason)
        <input ref={rateRef} type="number" defaultValue={line.gstRateOverride ?? ''} style={{ padding: 4, fontSize: 12, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }} />
      </label>
      <input ref={reasonRef} type="text" placeholder="Reason (required, kept for audit)" defaultValue={line.gstOverrideReason ?? ''} style={{ padding: 4, fontSize: 12, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => {
            const rate = Number(rateRef.current?.value);
            const reason = reasonRef.current?.value.trim();
            if (!Number.isFinite(rate) || !reason) return;
            onApplyOverride(rate, reason);
          }}
          style={{ ...linkBtn, padding: '2px 0', fontSize: 11 }}
        >
          Apply Override
        </button>
        {line.gstRateOverride !== undefined && (
          <button onClick={onClearOverride} style={{ ...linkBtn, padding: '2px 0', fontSize: 11, color: color.alert }}>Clear</button>
        )}
      </div>
    </div>
  );
}

function StepBtn({ icon, onClick }: { icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: theme.radiusSm, border: `1px solid ${color.line}`, background: color.paperRaised, color: color.inkSoft, cursor: 'pointer' }}
    >
      {icon}
    </button>
  );
}

// One consistent height/padding/radius for every cart-row number input.
function cellInputStyle(width: number, align: 'left' | 'center' | 'right'): React.CSSProperties {
  return {
    width, height: 32, padding: '0 8px', border: `1px solid ${color.line}`, borderRadius: theme.radiusSm,
    fontFamily: theme.mono, fontSize: 13, textAlign: align, boxSizing: 'border-box',
  };
}

// Muted by default, red only on hover — a quieter signal than a permanently
// red delete icon in a row full of otherwise neutral controls.
function RemoveLineButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Remove line"
      title="Remove"
      style={{ display: 'flex', border: 'none', background: 'transparent', cursor: 'pointer', color: hovered ? color.alert : color.inkFaint, padding: 4 }}
    >
      <Trash2 size={15} />
    </button>
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

// Polish pass — Post Bill is the only filled/primary action on the page now;
// Hold and Save as Estimate are outline/ghost so they don't visually compete.
const primaryBtn: React.CSSProperties = {
  padding: '10px 20px',
  background: PRIMARY_AMBER,
  color: '#fff',
  border: 'none',
  borderRadius: theme.radiusSm,
  cursor: 'pointer',
  fontSize: 13.5,
  fontWeight: 700,
};

function outlineBtn(accent: string): React.CSSProperties {
  return {
    padding: '9px 16px',
    background: 'transparent',
    color: accent,
    border: `1.5px solid ${accent}`,
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  };
}

const linkBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: color.brass,
  cursor: 'pointer',
  fontSize: 12.5,
  textDecoration: 'underline',
  padding: '9px 6px',
};
