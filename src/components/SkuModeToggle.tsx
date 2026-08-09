import { theme } from '../lib/theme';

const { color } = theme;

export type SkuMode = 'auto' | 'manual';

// Round 13 — shared Auto/Manual SKU toggle used by ItemMasterPage,
// BulkStockEntryPage, and Billing's inline add-item form. Auto keeps the SKU
// input read-only and filled from /next-sku on category pick; Manual hands
// the field to the user and skips the auto-generate call entirely (the
// backend's own @@unique([companyId, sku]) still catches collisions on save).
export function SkuModeToggle({ mode, onChange }: { mode: SkuMode; onChange: (mode: SkuMode) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {(['auto', 'manual'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          style={{
            padding: '2px 8px',
            fontSize: 10.5,
            borderRadius: theme.radiusSm,
            border: `1px solid ${mode === m ? color.brass : color.line}`,
            background: mode === m ? color.brass : 'transparent',
            color: mode === m ? '#fff' : color.inkFaint,
            cursor: 'pointer',
            fontWeight: mode === m ? 600 : 400,
          }}
        >
          {m === 'auto' ? 'Auto' : 'Manual'}
        </button>
      ))}
    </div>
  );
}
