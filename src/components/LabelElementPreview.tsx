import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { resolveFieldValue, type DesignElement, type LabelPrintItem, type LabelPrintCompany } from '../lib/labelPrint';

// Round 20 — replaces the old `|||value|||` / `'QR'` text placeholders that
// both LabelDesignerPage.tsx and LabelsPage.tsx used to render for barcode/
// QR elements: a shop could never actually see what would print. The real
// print path (electron/printer-driver.ts) already emits genuine TSPL
// BARCODE/QRCODE commands, so this brings the on-screen preview up to match
// what already comes out of the printer — one implementation shared by both
// pages, same "shared render logic lives in one place" pattern as
// invoicePrint.ts/labelPrint.ts.
//
// Renders only the *inner content* of an element — the caller still owns the
// positioned/sized wrapper div (xMm/yMm/widthMm/heightMm, selection border,
// drag handlers) exactly as both pages already had it.

const BARCODE_FORMAT: Record<NonNullable<DesignElement['barcodeType']>, string> = {
  code128: 'CODE128',
  code39: 'CODE39',
  ean13: 'EAN13',
  upca: 'UPC',
};

export function LabelElementPreview({
  el,
  item,
  company,
}: {
  el: DesignElement;
  item: LabelPrintItem | null;
  company: LabelPrintCompany | null;
}) {
  if (el.type === 'text') {
    const value = el.sourceKey ? resolveFieldValue(el.sourceKey, item, company) : (el.content ?? '');
    const label = el.sourceKey && el.showLabel && el.displayLabel ? `${el.displayLabel}: ` : '';
    return <>{label}{value}</>;
  }
  if (el.type === 'barcode' || el.type === 'qrcode') {
    const value = el.sourceKey ? resolveFieldValue(el.sourceKey, item, company) : (el.content ?? '');
    return <CodePreview type={el.type} value={value} barcodeType={el.barcodeType} />;
  }
  if (el.type === 'image') {
    return el.content ? (
      <img src={el.content} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    ) : (
      <span style={{ fontSize: 9, color: '#94a3b8' }}>Image</span>
    );
  }
  // 'line'/'rectangle' — the wrapper div's solid background already renders these.
  return null;
}

function CodePreview({ type, value, barcodeType }: { type: 'barcode' | 'qrcode'; value: string; barcodeType?: DesignElement['barcodeType'] }) {
  // A plain DOM container manipulated imperatively (JsBarcode/qrcode both
  // want a real element to draw into) — kept in a SEPARATE node from the
  // React-rendered placeholder/error text below, and always mounted
  // regardless of error/empty state (only its `display` toggles). Letting
  // React conditionally unmount this node (e.g. "show error span instead")
  // was the original bug here: once an error/placeholder render replaced it,
  // the ref went stale and never got reattached, so the barcode silently
  // stopped updating on every prop change after the first failure.
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';
    setError(null);
    if (!value) return;

    if (type === 'barcode') {
      try {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        JsBarcode(svg, value, {
          format: BARCODE_FORMAT[barcodeType ?? 'code128'],
          displayValue: true,
          margin: 2,
          height: 40,
          fontSize: 12,
        });
        // JsBarcode sizes the SVG to its own intrinsic pixel dimensions —
        // capture those as a viewBox, then stretch width/height to 100% so
        // it fills whatever box the caller positioned it in.
        const w = svg.getAttribute('width');
        const h = svg.getAttribute('height');
        if (w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('preserveAspectRatio', 'none');
        container.appendChild(svg);
      } catch {
        // Non-numeric/wrong-length value for a checksummed format like
        // EAN-13/UPC-A (e.g. a bound SKU) — surface it clearly while
        // designing rather than only discovering it at print time.
        setError(`Invalid value for ${(barcodeType ?? 'code128').toUpperCase()}`);
      }
      return;
    }

    // qrcode
    let cancelled = false;
    QRCode.toString(value, { type: 'svg', margin: 1 })
      .then((svgMarkup) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svgMarkup.replace('<svg ', '<svg width="100%" height="100%" preserveAspectRatio="none" ');
      })
      .catch(() => {
        if (!cancelled) setError('Invalid QR value');
      });
    return () => {
      cancelled = true;
    };
  }, [type, value, barcodeType]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', display: !value || error ? 'none' : 'block' }} />
      {!value && (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#94a3b8' }}>
          {type === 'barcode' ? 'Barcode' : 'QR code'}
        </span>
      )}
      {error && (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 8, color: '#dc2626', padding: 2 }}>
          {error}
        </span>
      )}
    </div>
  );
}
