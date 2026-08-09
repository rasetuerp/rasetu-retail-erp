// Round 13 — searchable in-app Help/FAQ store (Settings → Help). Seeded from
// the Round 13 product audit (docs/PRODUCT_REVIEW.md) — the questions here
// are the ones an experienced shop owner actually asked while reviewing each
// page. Plain static data, no backend: matches this app's local-first bias
// for content that doesn't change per-shop (see docs/RULES.md).
export type FaqEntry = {
  id: string;
  question: string;
  answer: string;
  category: string;
  tags: string[];
};

export const FAQ_CATEGORIES = [
  'Getting started',
  'Billing',
  'Items & Stock',
  'Purchase & Suppliers',
  'Parties & Ledger',
  'Reports & GST',
  'Labels & Printing',
  'Team & Access',
  'Settings',
  'Account recovery',
] as const;

export const FAQ_ENTRIES: FaqEntry[] = [
  {
    id: 'sku-auto-vs-manual',
    question: 'Should I let RaSetu auto-generate my SKUs, or type my own?',
    answer:
      'Auto (the default) builds a SKU as ShopCode-Category-Year-Serial, e.g. FTS-SHI-26-0001, and the field is locked so it can\'t be accidentally overwritten. Switch to Manual next to the SKU field if you already have your own numbering system (e.g. matching an old billing app) - the field unlocks for free typing, and RaSetu still blocks duplicates when you save.',
    category: 'Items & Stock',
    tags: ['sku', 'auto', 'manual', 'category', 'duplicate'],
  },
  {
    id: 'sku-duplicate-error',
    question: 'Why am I getting "This SKU already exists in this shop"?',
    answer:
      'Every SKU must be unique within your shop. This happens most often in Manual mode when two items are typed with the same code. Check Item / Stock Master\'s search for the existing SKU, or switch back to Auto to get a guaranteed-unique one.',
    category: 'Items & Stock',
    tags: ['sku', 'duplicate', 'error'],
  },
  {
    id: 'preview-before-print',
    question: 'Can I see what a bill will look like before printing it?',
    answer:
      'Yes - after posting or saving an Estimate, click "Preview" next to either Print Receipt or Print A4/A5 Invoice. It shows the exact text/layout that will be sent to the printer, with a Print now button inside if it looks right.',
    category: 'Billing',
    tags: ['preview', 'print', 'receipt', 'invoice', 'thermal', 'a4'],
  },
  {
    id: 'add-item-mid-sale',
    question: 'A customer wants something that isn\'t in my catalog yet - do I have to leave Billing?',
    answer:
      'No - click "+ Add new item" inside Billing. It has the same fields as Item / Stock Master (SKU, category, unit, rates, HSN, GST%) so the item is fully set up, not a placeholder, and it\'s added to the current bill immediately.',
    category: 'Billing',
    tags: ['billing', 'add item', 'new item', 'inline'],
  },
  {
    id: 'new-supplier-fields',
    question: 'What details can I capture when adding a new supplier from Purchase Entry?',
    answer:
      'The quick "+ New supplier" panel in Purchase Entry now takes Name, GSTIN, Phone, Address, and Opening Balance - enough to record a real supplier bill without switching to the full Parties & Ledger page. Credit Limit is only on the full Parties form, since it\'s a customer-facing control.',
    category: 'Purchase & Suppliers',
    tags: ['supplier', 'purchase entry', 'gstin', 'opening balance'],
  },
  {
    id: 'credit-limit-not-on-ledger',
    question: 'Where did the Credit Limit number on a customer\'s ledger page go?',
    answer:
      'It\'s been removed from the profile stat tiles to keep that panel focused on activity (lifetime value, invoices, last visit). Credit Limit is still fully in effect - it\'s set from the Add Party / Edit Party forms, and Billing still warns you at checkout if a bill would take a customer over their limit.',
    category: 'Parties & Ledger',
    tags: ['credit limit', 'ledger', 'customer profile'],
  },
  {
    id: 'gst-month-picker',
    question: 'How do I generate the GST Pack for a specific month?',
    answer:
      'Reports & GST Pack → GST Pack tab has a month picker (calendar icon) - pick the month and click Generate. It shows B2B/B2C invoice counts, the HSN summary, and GSTR-3B-style CGST/SGST totals for that month.',
    category: 'Reports & GST',
    tags: ['gst pack', 'month', 'gstr'],
  },
  {
    id: 'dashboard-quick-actions',
    question: 'Is there a faster way to start a new bill or purchase than going through the sidebar?',
    answer:
      'Yes - the Dashboard now has New Bill / New Purchase / New Item buttons at the top right, next to the page title, so you can jump straight into the most common actions from the home screen.',
    category: 'Getting started',
    tags: ['dashboard', 'quick actions', 'shortcuts'],
  },
  {
    id: 'delete-category-warning',
    question: 'What happens to existing items if I delete a Category or a custom Item Field?',
    answer:
      'Nothing on those items is lost - a deleted category just stops being pickable/auto-generating SKUs going forward, and existing items keep it as plain text; a deleted custom field keeps its saved value on each item, it just stops showing on the form. Both now ask you to confirm before removing, since it affects every item using them.',
    category: 'Settings',
    tags: ['category', 'delete', 'custom field', 'item fields'],
  },
  {
    id: 'deactivate-vs-delete-user',
    question: 'Can I delete a staff account, or only deactivate it?',
    answer:
      'Only deactivate, from Team & Access - this keeps their history (who billed what) intact for your records. A deactivated user can\'t log in until you reactivate them. RaSetu now asks you to confirm before deactivating someone.',
    category: 'Team & Access',
    tags: ['users', 'deactivate', 'delete', 'staff'],
  },
  {
    id: 'forgot-password-flow',
    question: 'I forgot my password/PIN and I\'m locked out - what do I do?',
    answer:
      'On the login screen, click "Forgot password / PIN?" and submit a request (needs internet). RaSetu support reviews it and issues a reset code by hand - once you have the code, use "I already have a reset code" on the same screen to set a new password (and PIN, optionally). Both steps need an internet connection, but not a live support call.',
    category: 'Account recovery',
    tags: ['forgot password', 'pin', 'reset', 'locked out'],
  },
  {
    id: 'license-trial-status',
    question: 'How do I check how many days are left on my trial or AMC?',
    answer:
      'Settings → License shows your license type, status, and (for Trial or an active AMC) a days-remaining countdown that changes color as it gets close to expiry. There\'s also a manual "Recheck" button if you\'ve just renewed and want the status to update immediately.',
    category: 'Settings',
    tags: ['license', 'trial', 'amc', 'expiry'],
  },
  {
    id: 'bulk-stock-entry-when',
    question: 'When should I use Bulk Stock Entry instead of Item / Stock Master?',
    answer:
      'Use Bulk Stock Entry when you\'re onboarding many variants of the same product at once (e.g. one shirt design in 5 sizes x 4 colours) - fill the shared details (category, rates, GST) once, generate rows, and only edit what differs (SKU/size/colour/opening stock) per row. Item / Stock Master is for adding or editing one item at a time.',
    category: 'Items & Stock',
    tags: ['bulk stock entry', 'item master', 'variants'],
  },
];

export function searchFaq(query: string): FaqEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return FAQ_ENTRIES;
  return FAQ_ENTRIES.filter(
    (e) =>
      e.question.toLowerCase().includes(q) ||
      e.answer.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      e.tags.some((t) => t.includes(q))
  );
}
