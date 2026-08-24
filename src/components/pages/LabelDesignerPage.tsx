import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Copy, Printer, Crosshair, Settings, X } from 'lucide-react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';
import { LabelElementPreview } from '../LabelElementPreview';
import { readLabelImageFile } from '../../lib/thermalBitmap';
import {
  buildPrinterTemplate,
  buildPrinterPayloadForItem,
  buildFieldOptions,
  defaultElementsForSize,
  LABEL_PRINT_DIRECTION_OPTIONS,
  PRESET_GALLERY,
  tsplFontPreviewPx,
  type ElementType,
  type DesignElement,
  type LabelPrintDirection,
  type LabelTemplateDto,
  type LabelPrintItem as Item,
  type LabelPrintCompany,
} from '../../lib/labelPrint';

// RULES.md #2: types declared inline (element/template/item shapes live in
// src/lib/labelPrint.ts since three pages need them — same exemption as
// invoicePrint.ts). RULES.md #11: this page owns the *authoring* workflow
// (build/edit/save a label design) — separate from LabelsPage.tsx, which
// owns day-to-day "print labels for these items" using whichever templates
// already exist. Full WYSIWYG free-drag canvas, per the user's explicit
// choice this round (matches GoBilling's own LabelDesigner.tsx approach, not
// a reorderable-list-only designer).
//
// Round 22 — restructured from "one sidebar with everything" into GoBilling's
// two-panel workflow: a Live Preview panel (the canvas, still the actual
// editing surface) + an Item Selection panel (search/multi-select/batch
// print) replacing the old single-item "Preview / print item" dropdown.
// Template-level settings (name/size/loop zone/calibration/save/duplicate/
// delete) that used to live inline in the sidebar now live behind a "Setup"
// button in a modal, so the main view stays focused on designing + printing.

const { color } = theme;
const ZOOM = 4; // px per mm

const SIZE_PRESETS: Array<{ label: string; widthMm: number; heightMm: number }> = [
  { label: 'Jewellery Tag (63 × 11mm)', widthMm: 63, heightMm: 11 },
  { label: 'Small Tag (85 × 12mm)', widthMm: 85, heightMm: 12 },
  { label: 'Small Tag (92 × 15mm)', widthMm: 92, heightMm: 15 },
  { label: 'Square (50 × 50mm)', widthMm: 50, heightMm: 50 },
  { label: 'Tall (50 × 75mm)', widthMm: 50, heightMm: 75 },
  { label: 'Shelf Label (100 × 50mm)', widthMm: 100, heightMm: 50 },
];

function newElementDefaults(type: ElementType, widthMm: number, heightMm: number): DesignElement {
  const id = `el-${Date.now()}-${Math.round(Math.random() * 1000)}`;
  const base = { id, type, xMm: Math.round(widthMm * 0.1), yMm: Math.round(heightMm * 0.2) };
  if (type === 'text') return { ...base, widthMm: Math.round(widthMm * 0.6), heightMm: Math.max(3, Math.round(heightMm * 0.25)), fontSize: 8, content: 'Label text' };
  if (type === 'barcode') return { ...base, widthMm: Math.round(widthMm * 0.8), heightMm: Math.max(5, Math.round(heightMm * 0.4)), sourceKey: 'item.sku', barcodeType: 'code128' };
  if (type === 'qrcode') return { ...base, widthMm: Math.min(widthMm, heightMm) * 0.5, heightMm: Math.min(widthMm, heightMm) * 0.5, sourceKey: 'item.sku' };
  if (type === 'image') return { ...base, widthMm: Math.round(widthMm * 0.3), heightMm: Math.round(heightMm * 0.3) };
  return { ...base, widthMm: Math.round(widthMm * 0.8), heightMm: type === 'line' ? 0.5 : Math.round(heightMm * 0.3) };
}

function blankTemplate(): LabelTemplateDto {
  return {
    id: '',
    name: 'New Template',
    isDefault: false,
    widthMm: 63,
    heightMm: 11,
    elements: defaultElementsForSize(63, 11),
    printConfig: { darkness: 8, gapMm: 2, xOffsetMm: 0, yOffsetMm: 0, dpi: 203, printDirection: 'normal' },
  };
}

function buildCalibrationDraft(draft: LabelTemplateDto): LabelTemplateDto {
  const w = draft.widthMm;
  const h = draft.heightMm;
  const line = (id: string, xMm: number, yMm: number, widthMm: number, heightMm: number): DesignElement => ({
    id,
    type: 'line',
    xMm,
    yMm,
    widthMm,
    heightMm,
  });
  const text = (id: string, content: string, xMm: number, yMm: number, widthMm: number): DesignElement => ({
    id,
    type: 'text',
    content,
    xMm,
    yMm,
    widthMm,
    heightMm: 3,
    fontSize: 5,
  });

  const elements: DesignElement[] = [
    line('cal-top', 0, 0, w, 0.6),
    line('cal-bottom', 0, Math.max(0, h - 0.6), w, 0.6),
    line('cal-left', 0, 0, 0.6, h),
    line('cal-right', Math.max(0, w - 0.6), 0, 0.6, h),
    line('cal-center-x', 0, Math.max(0, h / 2 - 0.2), w, 0.4),
    line('cal-center-y', Math.max(0, w / 2 - 0.2), 0, 0.4, h),
    text('cal-origin', '0,0', 1, 1, Math.max(10, w / 3)),
    text('cal-size', `${w}x${h}mm`, Math.max(1, w - 24), Math.max(1, h - 4), 23),
  ];

  for (let x = 5; x < w; x += 5) elements.push(line(`cal-x-${x}`, x, 0, 0.25, h));
  for (let y = 5; y < h; y += 5) elements.push(line(`cal-y-${y}`, 0, y, w, 0.25));

  return {
    ...draft,
    id: `${draft.id || 'draft'}-calibration`,
    name: `${draft.name} Calibration Grid`,
    elements,
  };
}

export function LabelDesignerPage() {
  const { session } = useSession();
  const [templates, setTemplates] = useState<LabelTemplateDto[]>([]);
  const [draft, setDraft] = useState<LabelTemplateDto>(blankTemplate());
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [previewItemId, setPreviewItemId] = useState<string>('');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [itemSearch, setItemSearch] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [company, setCompany] = useState<LabelPrintCompany | null>(null);
  // Round 14 — shop-added custom item fields (Settings → Item Fields),
  // merged into the field picker below so a custom field is bindable on a
  // label like any real Item column.
  const [customAttrs, setCustomAttrs] = useState<Array<{ key: string; label: string }>>([]);
  const fieldOptions = buildFieldOptions(customAttrs);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copies, setCopies] = useState(1);
  const [showCalibrationGrid, setShowCalibrationGrid] = useState(true);

  const dragState = useRef<{ id: string; startX: number; startY: number; startXMm: number; startYMm: number } | null>(null);

  async function loadAll() {
    if (!session) return;
    try {
      const [tRes, iRes, cRes, fRes] = await Promise.all([
        apiRequest<{ templates: LabelTemplateDto[] }>(`/companies/${session.companyId}/labels/label-templates`, { token: session.token }),
        apiRequest<{ items: Item[] }>(`/companies/${session.companyId}/items`, { token: session.token }),
        apiRequest<{ company: { name: string; address: string | null; phone: string | null; gstin: string | null } }>(`/companies/${session.companyId}`, { token: session.token }).catch(() => null),
        apiRequest<{ itemAttributes: Array<{ key: string; label: string; custom: boolean }> }>(`/companies/${session.companyId}/items/fields`, { token: session.token }).catch(() => null),
      ]);
      setTemplates(tRes.templates);
      setItems(iRes.items);
      if (cRes) setCompany(cRes.company);
      if (fRes) setCustomAttrs(fRes.itemAttributes.filter((a) => a.custom));
      if (tRes.templates.length && !draft.id) {
        const def = tRes.templates.find((t) => t.isDefault) ?? tRes.templates[0];
        setDraft(def);
      }
      if (iRes.items.length && !previewItemId) setPreviewItemId(iRes.items[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load label designer data');
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  function selectTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (t) {
      setDraft(t);
      setSelectedElementId(null);
    }
  }

  function updateElement(id: string, patch: Partial<DesignElement>) {
    setDraft((prev) => ({ ...prev, elements: prev.elements.map((el) => (el.id === id ? { ...el, ...patch } : el)) }));
  }

  function addElement(type: ElementType) {
    const el = newElementDefaults(type, draft.widthMm, draft.heightMm);
    setDraft((prev) => ({ ...prev, elements: [...prev.elements, el] }));
    setSelectedElementId(el.id);
  }

  function removeElement(id: string) {
    setDraft((prev) => ({ ...prev, elements: prev.elements.filter((el) => el.id !== id) }));
    if (selectedElementId === id) setSelectedElementId(null);
  }

  function onElementPointerDown(e: React.PointerEvent, el: DesignElement) {
    e.stopPropagation();
    setSelectedElementId(el.id);
    dragState.current = { id: el.id, startX: e.clientX, startY: e.clientY, startXMm: el.xMm, startYMm: el.yMm };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onElementPointerMove(e: React.PointerEvent) {
    const drag = dragState.current;
    if (!drag) return;
    const deltaXMm = (e.clientX - drag.startX) / ZOOM;
    const deltaYMm = (e.clientY - drag.startY) / ZOOM;
    const el = draft.elements.find((x) => x.id === drag.id);
    if (!el) return;
    const xMm = Math.max(0, Math.min(draft.widthMm - el.widthMm, Math.round((drag.startXMm + deltaXMm) * 10) / 10));
    const yMm = Math.max(0, Math.min(draft.heightMm - el.heightMm, Math.round((drag.startYMm + deltaYMm) * 10) / 10));
    updateElement(drag.id, { xMm, yMm });
  }

  function onElementPointerUp() {
    dragState.current = null;
  }

  async function saveTemplate() {
    if (!session) return;
    setError(null);
    setSaving(true);
    try {
      const body = { name: draft.name, isDefault: draft.isDefault, widthMm: draft.widthMm, heightMm: draft.heightMm, elements: draft.elements, printConfig: draft.printConfig };
      const res = draft.id
        ? await apiRequest<{ template: LabelTemplateDto }>(`/companies/${session.companyId}/labels/label-templates/${draft.id}`, { method: 'PUT', token: session.token, body })
        : await apiRequest<{ template: LabelTemplateDto }>(`/companies/${session.companyId}/labels/label-templates`, { method: 'POST', token: session.token, body });
      setDraft(res.template);
      setStatus('Saved.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function deleteTemplate() {
    if (!session || !draft.id) return;
    if (!confirm(`Delete "${draft.name}"? This cannot be undone.`)) return;
    try {
      await apiRequest(`/companies/${session.companyId}/labels/label-templates/${draft.id}`, { method: 'DELETE', token: session.token });
      setDraft(blankTemplate());
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete template');
    }
  }

  async function duplicateTemplate() {
    if (!session || !draft.id) return;
    try {
      const res = await apiRequest<{ template: LabelTemplateDto }>(`/companies/${session.companyId}/labels/label-templates/${draft.id}/duplicate`, { method: 'POST', token: session.token });
      setDraft(res.template);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to duplicate template');
    }
  }

  function toggleItemSelected(id: string) {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Batch-prints every checked item — reuses window.rasetu.printer.printBatch,
  // the same bridge call BulkStockEntryPage.tsx already uses, rather than
  // looping single printLabel calls.
  async function printSelectedLabels() {
    if (!window.rasetu) {
      setStatus('Printing is only available in the desktop app - this preview runs in a plain browser tab.');
      return;
    }
    const selected = items.filter((i) => selectedItemIds.has(i.id));
    if (selected.length === 0) {
      setStatus('Select at least one item to print.');
      return;
    }
    setPrinting(true);
    try {
      const labels = await Promise.all(selected.map(async (item) => ({ ...(await buildPrinterPayloadForItem(draft, item, company)), copies })));
      const result = await window.rasetu.printer.printBatch('default', labels);
      setStatus(result.message ?? (result.success ? 'Printed.' : 'Print failed.'));
    } finally {
      setPrinting(false);
    }
  }

  async function printCalibrationGrid() {
    if (!window.rasetu) {
      setStatus('Printing is only available in the desktop app.');
      return;
    }
    setPrinting(true);
    setError(null);
    setStatus(null);
    try {
      const printerTemplate = await buildPrinterTemplate(buildCalibrationDraft(draft));
      const result = await window.rasetu.printer.printBatch('default', [{ template: printerTemplate, data: {}, copies: 1 }]);
      setStatus(result.message ?? (result.success ? 'Calibration grid printed.' : 'Calibration print failed.'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to print calibration grid.');
    } finally {
      setPrinting(false);
    }
  }

  const selectedElement = draft.elements.find((el) => el.id === selectedElementId) ?? null;
  const previewItem = items.find((i) => i.id === previewItemId) ?? null;
  const filteredItems = items.filter((i) => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return true;
    return i.sku.toLowerCase().includes(q) || (i.category ?? '').toLowerCase().includes(q) || (i.brand ?? '').toLowerCase().includes(q);
  });

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 22, margin: 0, color: color.ink }}>Label Designer</h1>
          <select
            value={draft.id}
            onChange={(e) => (e.target.value ? selectTemplate(e.target.value) : setDraft(blankTemplate()))}
            style={{ padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }}
          >
            <option value="">+ New Template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: color.inkFaint, fontFamily: theme.mono }}>
            {draft.widthMm}×{draft.heightMm}mm
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowCalibrationGrid((v) => !v)} style={secondaryBtn}>
            <Crosshair size={13} /> {showCalibrationGrid ? 'Hide Grid' : 'Show Grid'}
          </button>
          <button onClick={() => setSetupOpen(true)} style={secondaryBtn}><Settings size={13} /> Setup</button>
          <button onClick={() => void saveTemplate()} disabled={saving} style={secondaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
          <button onClick={() => void printCalibrationGrid()} disabled={printing} style={secondaryBtn}>
            <Crosshair size={13} /> Print Calibration Grid
          </button>
          <button onClick={() => void printSelectedLabels()} disabled={printing} style={primaryBtn}>
            <Printer size={13} /> {printing ? 'Printing…' : `Print Labels (${selectedItemIds.size})`}
          </button>
        </div>
      </div>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, margin: '12px 0' }}>{error}</div>}
      {status && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, margin: '12px 0' }}>{status}</div>}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: 14 }}>
        {/* Live Preview panel */}
        <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 20, boxShadow: theme.shadowSm }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontFamily: theme.mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint }}>Live Preview</div>
            <div style={{ fontSize: 11, color: color.inkFaint }}>
              {draft.widthMm} × {draft.heightMm}mm{draft.printConfig.loopZone ? ` · loop zone ${draft.printConfig.loopZone.edge}` : ''}
            </div>
          </div>
          <div
            onPointerMove={onElementPointerMove}
            onPointerUp={onElementPointerUp}
            onClick={() => setSelectedElementId(null)}
            style={{
              position: 'relative',
              width: draft.widthMm * ZOOM,
              height: draft.heightMm * ZOOM,
              background: '#fff',
              border: `1px solid ${color.inkFaint}`,
              boxShadow: '0 0 0 1px #fff',
              overflow: 'hidden',
            }}
          >
            {draft.elements.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 12, pointerEvents: 'none', color: color.inkFaint, fontSize: 11.5, lineHeight: 1.5 }}>
                Click an element type below to add it,<br />or open Setup to start from a professional template.
              </div>
            )}
            {draft.printConfig.loopZone && <LoopZoneOverlay loopZone={draft.printConfig.loopZone} widthMm={draft.widthMm} heightMm={draft.heightMm} />}
            {showCalibrationGrid && <CalibrationGridOverlay widthMm={draft.widthMm} heightMm={draft.heightMm} />}
            {draft.elements.map((el) => {
              const isSelected = el.id === selectedElementId;
              return (
                <div
                  key={el.id}
                  onPointerDown={(e) => onElementPointerDown(e, el)}
                  // Bug fix — a plain click (pointerdown+pointerup with no
                  // real drag) also fires a native `click` afterward, which
                  // bubbles independently of the pointerdown handler's own
                  // stopPropagation above. That bubbled click was reaching
                  // the canvas wrapper's onClick (which deselects on
                  // background click) and immediately un-selecting whatever
                  // was just selected — the sidebar's format panel would
                  // flash open for one render then vanish. Stopping the
                  // click here (not just pointerdown) keeps the selection.
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    left: el.xMm * ZOOM,
                    top: el.yMm * ZOOM,
                    width: el.widthMm * ZOOM,
                    height: el.heightMm * ZOOM,
                    cursor: 'move',
                    border: isSelected ? `1px dashed ${color.brass}` : '1px dashed transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start',
                    overflow: 'hidden',
                    background: el.type === 'line' || el.type === 'rectangle' ? color.ink : 'transparent',
                    fontSize: el.type === 'text' ? tsplFontPreviewPx(el.fontSize) : 9,
                    fontWeight: el.bold ? 700 : 400,
                    color: color.ink,
                    whiteSpace: el.type === 'text' ? 'nowrap' : undefined,
                  }}
                  title={el.type}
                >
                  <LabelElementPreview el={el} item={previewItem} company={company} />
                </div>
              );
            })}
          </div>
          <p style={{ textAlign: 'center', fontSize: 10.5, color: color.inkFaint, margin: '8px 0 0' }}>
            Shown at {ZOOM}x actual size{previewItem ? ` · previewing ${previewItem.sku}` : ''}{showCalibrationGrid ? ' · grid is 5mm' : ''}
          </p>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontFamily: theme.mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 8 }}>+ Add element</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => addElement('text')} style={addElementBtn}><Plus size={14} /> Text</button>
              <button onClick={() => addElement('barcode')} style={addElementBtn}><Plus size={14} /> Barcode</button>
              <button onClick={() => addElement('qrcode')} style={addElementBtn}><Plus size={14} /> QR</button>
              <button onClick={() => addElement('image')} style={addElementBtn}><Plus size={14} /> Image</button>
              <button onClick={() => addElement('line')} style={addElementBtn}><Plus size={14} /> Line</button>
              <button onClick={() => addElement('rectangle')} style={addElementBtn}><Plus size={14} /> Rectangle</button>
            </div>
          </div>

          {selectedElement && (
            <div style={{ marginTop: 14, borderTop: `1px solid ${color.lineSoft}`, paddingTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <strong style={{ fontSize: 13, textTransform: 'capitalize' }}>{selectedElement.type} element</strong>
                <button onClick={() => removeElement(selectedElement.id)} style={{ border: 'none', background: 'transparent', color: color.alert, cursor: 'pointer' }}><Trash2 size={14} /></button>
              </div>

              {selectedElement.type === 'text' && (
                <>
                  <label style={labelStyle}>
                    Bind to field (optional)
                    <select
                      value={selectedElement.sourceKey ?? ''}
                      onChange={(e) => updateElement(selectedElement.id, { sourceKey: e.target.value || undefined })}
                      style={inputStyle}
                    >
                      <option value="">- Static text -</option>
                      {fieldOptions.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                  </label>
                  {!selectedElement.sourceKey && (
                    <label style={{ ...labelStyle, marginTop: 8 }}>
                      Text
                      <input value={selectedElement.content ?? ''} onChange={(e) => updateElement(selectedElement.id, { content: e.target.value })} style={inputStyle} />
                    </label>
                  )}
                  {selectedElement.sourceKey && (
                    <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                      <input type="checkbox" checked={selectedElement.showLabel ?? false} onChange={(e) => updateElement(selectedElement.id, { showLabel: e.target.checked })} />
                      Show label prefix (e.g. "MRP: ")
                    </label>
                  )}
                  {selectedElement.showLabel && (
                    <>
                      <label style={{ ...labelStyle, marginTop: 8 }}>
                        Label prefix text
                        <input value={selectedElement.displayLabel ?? ''} onChange={(e) => updateElement(selectedElement.id, { displayLabel: e.target.value })} style={inputStyle} />
                      </label>
                      <label style={{ ...labelStyle, marginTop: 8 }}>
                        Prefix layout
                        <select value={selectedElement.labelPlacement ?? 'inline'} onChange={(e) => updateElement(selectedElement.id, { labelPlacement: e.target.value as DesignElement['labelPlacement'] })} style={inputStyle}>
                          <option value="inline">Inline - label and value align together</option>
                          <option value="split">Split - label left, value uses Align</option>
                        </select>
                      </label>
                    </>
                  )}
                </>
              )}

              {(selectedElement.type === 'barcode' || selectedElement.type === 'qrcode') && (
                <>
                  <label style={labelStyle}>
                    Encodes field
                    <select
                      value={selectedElement.sourceKey ?? ''}
                      onChange={(e) => updateElement(selectedElement.id, { sourceKey: e.target.value || undefined })}
                      style={inputStyle}
                    >
                      <option value="">- Custom value -</option>
                      {fieldOptions.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                  </label>
                  {!selectedElement.sourceKey && (
                    <label style={{ ...labelStyle, marginTop: 8 }}>
                      Value to encode
                      <input
                        value={selectedElement.content ?? ''}
                        onChange={(e) => updateElement(selectedElement.id, { content: e.target.value })}
                        placeholder={selectedElement.type === 'qrcode' ? 'e.g. https://wa.me/91...' : 'e.g. a fixed code'}
                        style={inputStyle}
                      />
                    </label>
                  )}
                </>
              )}

              {selectedElement.type === 'barcode' && (
                <label style={{ ...labelStyle, marginTop: 8 }}>
                  Barcode type
                  <select value={selectedElement.barcodeType ?? 'code128'} onChange={(e) => updateElement(selectedElement.id, { barcodeType: e.target.value as DesignElement['barcodeType'] })} style={inputStyle}>
                    <option value="code128">Code 128</option>
                    <option value="code39">Code 39</option>
                    <option value="ean13">EAN-13</option>
                    <option value="upca">UPC-A</option>
                  </select>
                </label>
              )}

              {selectedElement.type === 'image' && (
                <label style={labelStyle}>
                  Image (PNG/JPG/WEBP, under 750KB)
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      try {
                        const dataUrl = await readLabelImageFile(file);
                        updateElement(selectedElement.id, { content: dataUrl });
                        setError(null);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Could not read image file.');
                      }
                    }}
                    style={inputStyle}
                  />
                  {selectedElement.content && (
                    <img src={selectedElement.content} alt="" style={{ maxWidth: 120, maxHeight: 60, marginTop: 6, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }} />
                  )}
                  <span style={{ fontSize: 11.5, color: color.inkFaint, lineHeight: 1.35 }}>
                    Use a clear logo PNG when possible. Colored poster backgrounds are cleaned for thermal print, but a plain background prints sharpest.
                  </span>
                </label>
              )}

              {selectedElement.type === 'text' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <label style={labelStyle}>
                    Font size
                    <input type="number" value={selectedElement.fontSize ?? 8} onChange={(e) => updateElement(selectedElement.id, { fontSize: Number(e.target.value) || 6 })} style={{ ...inputStyle, width: 70 }} />
                  </label>
                  <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end' }}>
                    <input type="checkbox" checked={selectedElement.bold ?? false} onChange={(e) => updateElement(selectedElement.id, { bold: e.target.checked })} />
                    Bold
                  </label>
                  <label style={labelStyle}>
                    Align
                    <select value={selectedElement.align ?? 'left'} onChange={(e) => updateElement(selectedElement.id, { align: e.target.value as DesignElement['align'] })} style={{ ...inputStyle, width: 90 }}>
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </label>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <label style={labelStyle}>
                  X (mm)
                  <input type="number" value={selectedElement.xMm} onChange={(e) => updateElement(selectedElement.id, { xMm: Number(e.target.value) || 0 })} style={{ ...inputStyle, width: 70 }} />
                </label>
                <label style={labelStyle}>
                  Y (mm)
                  <input type="number" value={selectedElement.yMm} onChange={(e) => updateElement(selectedElement.id, { yMm: Number(e.target.value) || 0 })} style={{ ...inputStyle, width: 70 }} />
                </label>
                <label style={labelStyle}>
                  Width (mm)
                  <input type="number" value={selectedElement.widthMm} onChange={(e) => updateElement(selectedElement.id, { widthMm: Number(e.target.value) || 1 })} style={{ ...inputStyle, width: 70 }} />
                </label>
                <label style={labelStyle}>
                  Height (mm)
                  <input type="number" value={selectedElement.heightMm} onChange={(e) => updateElement(selectedElement.id, { heightMm: Number(e.target.value) || 1 })} style={{ ...inputStyle, width: 70 }} />
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Item Selection panel */}
        <div style={{ background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 16, boxShadow: theme.shadowSm, minWidth: 320, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontFamily: theme.mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint }}>Item Selection</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11.5, color: color.inkFaint }}>
              <span>{selectedItemIds.size} selected · {filteredItems.length} visible</span>
              {selectedItemIds.size > 0 && (
                <button onClick={() => setSelectedItemIds(new Set())} style={{ border: 'none', background: 'transparent', color: color.brass, cursor: 'pointer', fontSize: 11.5, textDecoration: 'underline', padding: 0 }}>
                  Clear
                </button>
              )}
            </div>
          </div>
          <input
            value={itemSearch}
            onChange={(e) => setItemSearch(e.target.value)}
            placeholder="Search SKU, category, brand…"
            style={{ ...inputStyle, marginBottom: 10 }}
          />
          <div style={{ maxHeight: 380, overflowY: 'auto', border: `1px solid ${color.lineSoft}`, borderRadius: theme.radiusSm }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: `1px solid ${color.lineSoft}`, background: color.paper, position: 'sticky', top: 0 }}>
                  <th style={{ padding: 8, width: 28 }}></th>
                  <th style={{ padding: 8 }}>SKU</th>
                  <th style={{ padding: 8 }}>Category</th>
                  <th style={{ padding: 8 }}>Size/Color</th>
                  <th style={{ padding: 8 }}>Stock</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 14, textAlign: 'center', color: color.inkFaint }}>No items match.</td></tr>
                ) : (
                  filteredItems.map((i) => (
                    <tr
                      key={i.id}
                      onClick={() => setPreviewItemId(i.id)}
                      style={{
                        borderTop: `1px solid ${color.lineSoft}`,
                        cursor: 'pointer',
                        background: i.id === previewItemId ? color.paper : 'transparent',
                      }}
                    >
                      <td style={{ padding: 8 }} onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedItemIds.has(i.id)} onChange={() => toggleItemSelected(i.id)} />
                      </td>
                      <td style={{ padding: 8, fontFamily: theme.mono }}>{i.sku}</td>
                      <td style={{ padding: 8, color: color.inkSoft }}>{i.category ?? '-'}</td>
                      <td style={{ padding: 8, color: color.inkSoft }}>{[i.size, i.color].filter(Boolean).join(' / ') || '-'}</td>
                      <td style={{ padding: 8, fontFamily: theme.mono }}>{Number(i.stockQty)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
            <label style={labelStyle}>
              Copies (each)
              <input type="number" min={1} value={copies} onChange={(e) => setCopies(Number(e.target.value) || 1)} style={{ ...inputStyle, width: 90 }} />
            </label>
            <button onClick={() => void printSelectedLabels()} disabled={printing} style={primaryBtn}>
              <Printer size={13} /> {printing ? 'Printing…' : `Print Labels (${selectedItemIds.size})`}
            </button>
          </div>
        </div>
      </div>

      {setupOpen && (
        <SetupModal
          draft={draft}
          setDraft={setDraft}
          setSelectedElementId={setSelectedElementId}
          saving={saving}
          onSave={() => void saveTemplate()}
          onDuplicate={() => void duplicateTemplate()}
          onDelete={() => void deleteTemplate()}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </div>
  );
}

// Round 22 — everything that configures the *template itself* (as opposed to
// the elements on it, which stay on the main canvas) moved here from the old
// always-visible sidebar, opened by the header's "Setup" button — matches
// GoBilling's Label Designer top bar (Saved · Save as Copy · Setup · Preview
// · Print Labels).
function SetupModal({
  draft,
  setDraft,
  setSelectedElementId,
  saving,
  onSave,
  onDuplicate,
  onDelete,
  onClose,
}: {
  draft: LabelTemplateDto;
  setDraft: React.Dispatch<React.SetStateAction<LabelTemplateDto>>;
  setSelectedElementId: (id: string | null) => void;
  saving: boolean;
  onSave: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div
        style={{ background: color.paperRaised, borderRadius: theme.radius, boxShadow: theme.shadow, width: 480, maxHeight: '85vh', overflowY: 'auto', padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <strong style={{ fontSize: 16, color: color.ink }}>Label Setup</strong>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: color.inkFaint, cursor: 'pointer', display: 'flex' }}><X size={18} /></button>
        </div>

        <label style={labelStyle}>
          Template name
          <input value={draft.name} onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))} style={inputStyle} />
        </label>
        <label style={{ ...labelStyle, marginTop: 8 }}>
          Size preset
          <select
            value=""
            onChange={(e) => {
              const preset = SIZE_PRESETS[Number(e.target.value)];
              if (!preset) return;
              setDraft((p) => ({
                ...p,
                widthMm: preset.widthMm,
                heightMm: preset.heightMm,
                // A still-unsaved new template (no id yet) always gets a
                // fresh standard layout for whichever size is picked —
                // that's the whole point of picking a size before you've
                // started designing. Once a template is saved (has an
                // id), resizing it must never silently discard the
                // user's own work.
                elements: p.id ? p.elements : defaultElementsForSize(preset.widthMm, preset.heightMm),
              }));
              setSelectedElementId(null);
            }}
            style={inputStyle}
          >
            <option value="">Choose a preset…</option>
            {SIZE_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>{p.label}</option>
            ))}
          </select>
        </label>
        <label style={{ ...labelStyle, marginTop: 8 }}>
          Start from a professional template
          <select
            value=""
            onChange={(e) => {
              const tpl = PRESET_GALLERY.find((t) => t.id === e.target.value);
              if (!tpl) return;
              const replaceLayout = !draft.id || window.confirm('Replace this template layout with the selected professional template? Your current elements will be replaced after you click OK.');
              if (!replaceLayout) return;
              setDraft((p) => ({
                ...p,
                widthMm: tpl.widthMm,
                heightMm: tpl.heightMm,
                // Same rule as the Size preset picker above — never
                // clobber a template that's already been saved.
                elements: tpl.buildElements(),
                printConfig: { ...p.printConfig, loopZone: tpl.loopZone },
              }));
              setSelectedElementId(null);
            }}
            style={inputStyle}
            title="Applies a full curated layout, not just the size"
          >
            <option value="">Choose a template…</option>
            {PRESET_GALLERY.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.widthMm}×{t.heightMm}mm)</option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <label style={labelStyle}>
            Width (mm)
            <input type="number" value={draft.widthMm} onChange={(e) => setDraft((p) => ({ ...p, widthMm: Number(e.target.value) || 1 }))} style={{ ...inputStyle, width: 90 }} />
          </label>
          <label style={labelStyle}>
            Height (mm)
            <input type="number" value={draft.heightMm} onChange={(e) => setDraft((p) => ({ ...p, heightMm: Number(e.target.value) || 1 }))} style={{ ...inputStyle, width: 90 }} />
          </label>
          <label style={labelStyle}>
            Gap (mm)
            <input type="number" min={0} step={0.1} value={draft.printConfig.gapMm} onChange={(e) => setDraft((p) => ({ ...p, printConfig: { ...p.printConfig, gapMm: Number(e.target.value) || 0 } }))} style={{ ...inputStyle, width: 90 }} />
          </label>
        </div>
        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft((p) => ({ ...p, isDefault: e.target.checked }))} />
          Set as default template
        </label>

        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input
            type="checkbox"
            checked={!!draft.printConfig.loopZone}
            onChange={(e) =>
              setDraft((p) => ({
                ...p,
                printConfig: { ...p.printConfig, loopZone: e.target.checked ? { edge: 'top', sizeMm: 8 } : undefined },
              }))
            }
          />
          Loop / string-hole zone
        </label>
        {draft.printConfig.loopZone && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <label style={labelStyle}>
              Edge
              <select
                value={draft.printConfig.loopZone.edge}
                onChange={(e) => setDraft((p) => ({ ...p, printConfig: { ...p.printConfig, loopZone: { ...p.printConfig.loopZone!, edge: e.target.value as 'top' | 'bottom' | 'left' | 'right' } } }))}
                style={{ ...inputStyle, width: 90 }}
              >
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label style={labelStyle}>
              Size (mm)
              <input
                type="number"
                value={draft.printConfig.loopZone.sizeMm}
                onChange={(e) => setDraft((p) => ({ ...p, printConfig: { ...p.printConfig, loopZone: { ...p.printConfig.loopZone!, sizeMm: Number(e.target.value) || 1 } } }))}
                style={{ ...inputStyle, width: 70 }}
              />
            </label>
          </div>
        )}
        <p style={{ fontSize: 10.5, color: color.inkFaint, margin: '4px 0 0' }}>
          Marks a keep-clear guide for pre-punched hang-tag stock — a visual guide only, doesn't change what's printed.
        </p>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${color.lineSoft}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Crosshair size={14} color={color.brass} />
            <strong style={{ fontSize: 13 }}>Print Calibration</strong>
          </div>
          <p style={{ fontSize: 10.5, color: color.inkFaint, margin: '0 0 8px' }}>
            If labels print shifted or too light/dark on your printer, nudge these and reprint — no need to touch global printer settings.
          </p>
          <label style={{ ...labelStyle, marginBottom: 8 }}>
            Print direction
            <select
              value={draft.printConfig.printDirection ?? 'normal'}
              onChange={(e) => setDraft((p) => ({ ...p, printConfig: { ...p.printConfig, printDirection: e.target.value as LabelPrintDirection } }))}
              style={inputStyle}
            >
              {LABEL_PRINT_DIRECTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <p style={{ fontSize: 10.5, color: color.inkFaint, margin: '0 0 8px' }}>
            If left and right are reversed on the printed label, choose Mirror left/right. If the label is upside down, choose Rotate 180°.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label style={labelStyle}>
              X offset (mm)
              <input
                type="number"
                value={draft.printConfig.xOffsetMm}
                onChange={(e) => setDraft((p) => ({ ...p, printConfig: { ...p.printConfig, xOffsetMm: Number(e.target.value) || 0 } }))}
                style={{ ...inputStyle, width: 80 }}
              />
            </label>
            <label style={labelStyle}>
              Y offset (mm)
              <input
                type="number"
                value={draft.printConfig.yOffsetMm}
                onChange={(e) => setDraft((p) => ({ ...p, printConfig: { ...p.printConfig, yOffsetMm: Number(e.target.value) || 0 } }))}
                style={{ ...inputStyle, width: 80 }}
              />
            </label>
            <label style={labelStyle}>
              Darkness (0-15)
              <input
                type="number"
                min={0}
                max={15}
                value={draft.printConfig.darkness}
                onChange={(e) => setDraft((p) => ({ ...p, printConfig: { ...p.printConfig, darkness: Math.max(0, Math.min(15, Number(e.target.value) || 0)) } }))}
                style={{ ...inputStyle, width: 80 }}
              />
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          <button onClick={onSave} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save Template'}</button>
          {draft.id && (
            <>
              <button onClick={onDuplicate} style={secondaryBtn}><Copy size={13} /> Duplicate</button>
              <button onClick={onDelete} style={{ ...secondaryBtn, background: color.alert }}><Trash2 size={13} /> Delete</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Non-interactive keep-clear guide for pre-punched hang-tag stock — a
// diagonal-hatched strip + hole dot along the configured edge. Purely visual
// (pointer-events: none so elements can still be dragged over it); the
// physical hole is already part of the tag stock, so nothing is sent to the
// printer for this (see labelPrint.ts's PrintConfig.loopZone doc comment).
function LoopZoneOverlay({ loopZone, widthMm, heightMm }: { loopZone: NonNullable<import('../../lib/labelPrint').PrintConfig['loopZone']>; widthMm: number; heightMm: number }) {
  const { edge, sizeMm } = loopZone;
  const vertical = edge === 'left' || edge === 'right';
  const style: React.CSSProperties = {
    position: 'absolute',
    pointerEvents: 'none',
    background: 'repeating-linear-gradient(45deg, rgba(120,120,120,0.18), rgba(120,120,120,0.18) 4px, transparent 4px, transparent 8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...(edge === 'top' && { left: 0, top: 0, width: widthMm * ZOOM, height: sizeMm * ZOOM, borderBottom: `1px dashed ${color.inkFaint}` }),
    ...(edge === 'bottom' && { left: 0, bottom: 0, width: widthMm * ZOOM, height: sizeMm * ZOOM, borderTop: `1px dashed ${color.inkFaint}` }),
    ...(edge === 'left' && { left: 0, top: 0, width: sizeMm * ZOOM, height: heightMm * ZOOM, borderRight: `1px dashed ${color.inkFaint}` }),
    ...(edge === 'right' && { right: 0, top: 0, width: sizeMm * ZOOM, height: heightMm * ZOOM, borderLeft: `1px dashed ${color.inkFaint}` }),
  };
  return (
    <div style={style} title="Loop / string-hole zone">
      <div style={{ width: vertical ? Math.min(8, sizeMm * ZOOM * 0.4) : 8, height: vertical ? 8 : Math.min(8, sizeMm * ZOOM * 0.4), borderRadius: '50%', border: `1.5px solid ${color.inkFaint}` }} />
    </div>
  );
}

function CalibrationGridOverlay({ widthMm, heightMm }: { widthMm: number; heightMm: number }) {
  const verticals = [];
  const horizontals = [];
  for (let x = 5; x < widthMm; x += 5) verticals.push(x);
  for (let y = 5; y < heightMm; y += 5) horizontals.push(y);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
      {verticals.map((x) => (
        <div key={`v-${x}`} style={{ position: 'absolute', left: x * ZOOM, top: 0, width: 1, height: '100%', background: 'rgba(14,116,144,0.18)' }} />
      ))}
      {horizontals.map((y) => (
        <div key={`h-${y}`} style={{ position: 'absolute', left: 0, top: y * ZOOM, width: '100%', height: 1, background: 'rgba(14,116,144,0.18)' }} />
      ))}
      <div style={{ position: 'absolute', inset: 0, border: '2px solid rgba(220,38,38,0.85)' }} />
      <div style={{ position: 'absolute', left: widthMm * ZOOM / 2, top: 0, width: 1, height: '100%', background: 'rgba(220,38,38,0.55)' }} />
      <div style={{ position: 'absolute', left: 0, top: heightMm * ZOOM / 2, width: '100%', height: 1, background: 'rgba(220,38,38,0.55)' }} />
      <div style={{ position: 'absolute', left: 2, top: 2, fontSize: 9, color: '#dc2626', fontFamily: theme.mono, background: 'rgba(255,255,255,0.75)' }}>0,0</div>
      <div style={{ position: 'absolute', right: 2, bottom: 2, fontSize: 9, color: '#dc2626', fontFamily: theme.mono, background: 'rgba(255,255,255,0.75)' }}>{widthMm}x{heightMm}</div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft };
const inputStyle: React.CSSProperties = { padding: 7, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 13, width: '100%' };
const primaryBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const secondaryBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: color.ledger, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13 };
const addElementBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, padding: '8px 12px', background: color.paper, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: color.ink };
