import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import 'jspdf-autotable';

// jspdf-autotable v3's ESM/Vite-resolved build patches jsPDF's prototype as a
// side effect rather than exporting a clean default function (confirmed via
// browser test — `import autoTable from 'jspdf-autotable'` resolved but threw
// "autoTable is not a function"). Call it as doc.autoTable(...) instead.
type JsPdfWithAutoTable = jsPDF & { autoTable: (options: Record<string, unknown>) => void };

// Shared export toolbar (docs/RULES.md #8) — infrastructure, not a page, same
// exemption as api.ts/session.ts. Every list/report page uses this instead of
// writing its own export code.

export type ExportColumn = { key: string; label: string };

export function exportToExcel(filename: string, sheetName: string, columns: ExportColumn[], rows: Record<string, unknown>[]) {
  const data = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of columns) out[col.label] = row[col.key];
    return out;
  });
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}

export function exportToPdf(filename: string, title: string, columns: ExportColumn[], rows: Record<string, unknown>[]) {
  const doc = new jsPDF() as JsPdfWithAutoTable;
  doc.setFontSize(14);
  doc.text(title, 14, 16);
  doc.autoTable({
    startY: 22,
    head: [columns.map((c) => c.label)],
    body: rows.map((row) => columns.map((c) => String(row[c.key] ?? ''))),
    styles: { fontSize: 9 },
  });
  doc.save(`${filename}.pdf`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function printRows(title: string, columns: ExportColumn[], rows: Record<string, unknown>[]) {
  const win = window.open('', '_blank', 'width=800,height=600');
  if (!win) return;

  const safeTitle = escapeHtml(title);
  const headerHtml = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const bodyHtml = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${escapeHtml(String(row[c.key] ?? ''))}</td>`).join('')}</tr>`)
    .join('');

  win.document.write(`
    <html>
      <head>
        <title>${safeTitle}</title>
        <style>
          body { font-family: Segoe UI, system-ui, sans-serif; padding: 24px; }
          h1 { font-size: 18px; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #cbd5e1; padding: 6px 8px; font-size: 12px; text-align: left; }
          th { background: #f1f5f9; }
        </style>
      </head>
      <body>
        <h1>${safeTitle}</h1>
        <table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  win.print();
}
