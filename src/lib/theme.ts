// Shared design tokens — infrastructure, not a page (same exemption as api.ts/
// session.ts). RULES.md #1 mandates inline style objects, not CSS frameworks —
// this is a plain JS constant that pages spread into their own inline styles,
// not a stylesheet. Palette from the design review (ledger/paper structure,
// brass action color, money-green distinct from generic "success" green).

export const theme = {
  color: {
    ink: '#1B2A2E',
    inkSoft: '#55635F',
    inkFaint: '#8B9490',
    paper: '#FAF7F1',
    paperRaised: '#FFFFFF',
    ledger: '#0f172a',
    ledgerRaised: '#1e293b',
    line: '#E4DDD0',
    lineSoft: '#EEE8DD',
    brass: '#A9702B',
    brassStrong: '#8A5A21',
    brassTint: '#F3E6D2',
    money: '#1F7A5C',
    moneyTint: '#DCEFE7',
    amber: '#A9782B',
    amberTint: '#F3EBD2',
    alert: '#A93A2E',
    alertTint: '#F6E3DF',
  },
  radius: 10,
  radiusSm: 6,
  shadow: '0 1px 2px rgba(27,42,46,.06), 0 6px 20px -8px rgba(27,42,46,.18)',
  shadowSm: '0 1px 2px rgba(27,42,46,.08)',
  mono: "ui-monospace, 'SF Mono', Consolas, monospace",
  serif: "Georgia, 'Iowan Old Style', 'Palatino Linotype', Palatino, serif",
} as const;

/** DRAFT/HELD/POSTED/CANCELLED + LOW STOCK/OVERDUE badge colors, one lookup shared by every page that shows a status. */
export function statusColor(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'POSTED':
    case 'ACTIVE':
      return { bg: theme.color.moneyTint, fg: theme.color.money };
    case 'CANCELLED':
    case 'OVERDUE':
    case 'EXPIRED':
    case 'BLOCKED':
      return { bg: theme.color.alertTint, fg: theme.color.alert };
    case 'HELD':
    case 'ESTIMATE':
    case 'LOW STOCK':
    case 'TRIAL':
      return { bg: theme.color.amberTint, fg: theme.color.amber };
    case 'DRAFT':
    default:
      return { bg: theme.color.lineSoft, fg: theme.color.inkSoft };
  }
}
