import { useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';
import { LabelElementPreview } from '../LabelElementPreview';
import { buildPrinterTemplate, buildDataForItem, type LabelTemplateDto, type LabelPrintItem as Item, type LabelPrintCompany } from '../../lib/labelPrint';

// RULES.md #2: types declared inline (shared shapes in src/lib/labelPrint.ts).
// Round 7 — this page is now the day-to-day "print labels for these items"
// quick-print flow; designing/editing a template's layout happens on the
// separate Label Designer page (RULES.md #11: one page = one file, distinct
// workflows stay in distinct pages).

const { color } = theme;

export function LabelsPage() {
  const { session } = useSession();
  const [templates, setTemplates] = useState<LabelTemplateDto[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [copies, setCopies] = useState(1);
  const [company, setCompany] = useState<LabelPrintCompany | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const hasDesktopBridge = typeof window !== 'undefined' && !!window.rasetu;

  async function loadAll() {
    if (!session) return;
    try {
      const [templatesRes, itemsRes, companyRes] = await Promise.all([
        apiRequest<{ templates: LabelTemplateDto[] }>(`/companies/${session.companyId}/labels/label-templates`, { token: session.token }),
        apiRequest<{ items: Item[] }>(`/companies/${session.companyId}/items`, { token: session.token }),
        apiRequest<{ company: LabelPrintCompany }>(`/companies/${session.companyId}`, { token: session.token }).catch(() => null),
      ]);
      setTemplates(templatesRes.templates);
      setSelectedTemplateId((prev) => prev || templatesRes.templates.find((t) => t.isDefault)?.id || templatesRes.templates[0]?.id || '');
      setItems(itemsRes.items);
      if (companyRes) setCompany(companyRes.company);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load labels data');
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.companyId]);

  async function printSelected() {
    setStatus(null);
    setError(null);
    const item = items.find((i) => i.id === selectedItemId);
    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!item || !template) return;

    if (!window.rasetu) {
      setStatus('Printing is only available in the desktop app - this preview runs in a plain browser tab.');
      return;
    }
    try {
      const result = await window.rasetu.printer.printLabel('default', {
        template: await buildPrinterTemplate(template),
        data: buildDataForItem(template, item, company),
        copies,
      });
      setStatus(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Print failed');
    }
  }

  const selectedItem = items.find((i) => i.id === selectedItemId) ?? null;
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const ZOOM = 3;

  return (
    <div style={{ padding: 28, fontFamily: 'Segoe UI, system-ui, sans-serif' }}>
      <h1 style={{ fontFamily: theme.serif, fontWeight: 400, fontSize: 26, margin: '0 0 4px', color: color.ink }}>Barcode Labels</h1>
      <p style={{ color: color.inkFaint, fontSize: 13, marginBottom: 18 }}>
        Pick a saved template and an item to print.
        {!hasDesktopBridge && ' Printing works from the installed RaSetu app on your shop PC - this preview screen is for checking the layout only.'}
      </p>

      {error && <div style={{ background: color.alertTint, color: color.alert, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {status && <div style={{ background: color.moneyTint, color: color.money, padding: 10, borderRadius: theme.radiusSm, fontSize: 13, marginBottom: 12 }}>{status}</div>}

      {templates.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: color.inkFaint, fontSize: 13, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius }}>
          No label templates yet - create one in Label Designer first.
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ width: 260, background: color.paperRaised, border: `1px solid ${color.line}`, borderRadius: theme.radius, padding: 16, boxShadow: theme.shadowSm }}>
            <h2 style={{ fontFamily: theme.mono, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: color.inkFaint, marginBottom: 12 }}>Template</h2>
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedTemplateId(t.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4, border: `1px solid ${selectedTemplateId === t.id ? color.brass : color.line}`,
                  borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, background: selectedTemplateId === t.id ? color.brass : color.paperRaised, color: selectedTemplateId === t.id ? '#fff' : color.ink,
                }}
              >
                {t.name}
                {t.isDefault ? ' ★' : ''}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                Item
                <select value={selectedItemId} onChange={(e) => setSelectedItemId(e.target.value)} style={{ width: 240, padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm, fontSize: 14 }}>
                  <option value="">Select item to label</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>{i.sku}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: color.inkSoft }}>
                Copies
                <input type="number" min={1} value={copies} onChange={(e) => setCopies(Number(e.target.value) || 1)} style={{ width: 70, padding: 8, border: `1px solid ${color.line}`, borderRadius: theme.radiusSm }} />
              </label>
            </div>

            {selectedItem && selectedTemplate && (
              <div
                style={{
                  position: 'relative',
                  width: selectedTemplate.widthMm * ZOOM,
                  height: selectedTemplate.heightMm * ZOOM,
                  padding: 0,
                  border: `1px dashed ${color.inkFaint}`,
                  borderRadius: theme.radiusSm,
                  background: '#fff',
                  marginBottom: 16,
                  boxShadow: theme.shadowSm,
                  overflow: 'hidden',
                }}
              >
                {selectedTemplate.elements.map((el) => {
                  return (
                    <div
                      key={el.id}
                      style={{
                        position: 'absolute', left: el.xMm * ZOOM, top: el.yMm * ZOOM, width: el.widthMm * ZOOM, height: el.heightMm * ZOOM,
                        display: 'flex', alignItems: 'center', justifyContent: el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start',
                        overflow: 'hidden', background: el.type === 'line' || el.type === 'rectangle' ? color.ink : 'transparent',
                        fontSize: el.type === 'text' ? (el.fontSize ?? 8) * 1.1 : 8, fontWeight: el.bold ? 700 : 400,
                        color: color.ink, whiteSpace: el.type === 'text' ? 'nowrap' : undefined,
                      }}
                    >
                      <LabelElementPreview el={el} item={selectedItem} company={company} />
                    </div>
                  );
                })}
              </div>
            )}

            <button
              onClick={() => void printSelected()}
              disabled={!selectedItemId || !selectedTemplateId}
              style={{ padding: '9px 18px', background: color.brass, color: '#fff', border: 'none', borderRadius: theme.radiusSm, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              Print Label
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
