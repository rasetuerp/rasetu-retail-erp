import { forwardRef, useEffect, useRef, useState } from 'react';
import { theme } from '../lib/theme';

const { color } = theme;

export type CategoryEntry = { name: string; code: string };

type Props = {
  categories: CategoryEntry[];
  defaultValue?: string;
  placeholder?: string;
  style?: React.CSSProperties;
  onSelect?: (entry: CategoryEntry) => void;
  onCreate?: (name: string) => Promise<CategoryEntry>;
};

// Round 11 — searchable Category dropdown. Deliberately built around an
// uncontrolled <input> (RULES.md #3's convention for item-form fields): the
// DOM value is the source of truth, so a parent's existing attrRefs-based
// read (handleAddItem) needs no change when this replaces a plain <input>.
// `query` state exists only to drive the filtered suggestion list below the
// input, never to set the input's own value.
export const CategoryPicker = forwardRef<HTMLInputElement, Props>(function CategoryPicker(
  { categories, defaultValue = '', placeholder, style, onSelect, onCreate },
  forwardedRef
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(defaultValue);
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function setRefs(el: HTMLInputElement | null) {
    inputRef.current = el;
    if (typeof forwardedRef === 'function') forwardedRef(el);
    else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
  }

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const q = query.trim().toLowerCase();
  const matches = q ? categories.filter((c) => c.name.toLowerCase().includes(q)) : categories;
  const exactMatch = categories.some((c) => c.name.toLowerCase() === q);
  const canOfferCreate = !!onCreate && q.length > 0 && !exactMatch;
  const rowCount = matches.length + (canOfferCreate ? 1 : 0);

  function selectEntry(entry: CategoryEntry) {
    if (inputRef.current) inputRef.current.value = entry.name;
    setQuery(entry.name);
    setOpen(false);
    onSelect?.(entry);
  }

  async function handleCreate() {
    if (!onCreate || !query.trim() || creating) return;
    setCreating(true);
    try {
      const entry = await onCreate(query.trim());
      selectEntry(entry);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        ref={setRefs}
        defaultValue={defaultValue}
        placeholder={placeholder}
        style={style}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, Math.max(rowCount - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            if (rowCount === 0) return;
            e.preventDefault();
            if (highlight < matches.length) selectEntry(matches[highlight]);
            else void handleCreate();
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && rowCount > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 20,
            marginTop: 2,
            background: color.paperRaised,
            border: `1px solid ${color.line}`,
            borderRadius: theme.radiusSm,
            boxShadow: theme.shadowSm,
            minWidth: 180,
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {matches.map((c, i) => (
            <div
              key={c.code}
              onMouseDown={(e) => {
                e.preventDefault();
                selectEntry(c);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: '7px 10px',
                fontSize: 13,
                cursor: 'pointer',
                background: highlight === i ? color.paper : 'transparent',
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span>{c.name}</span>
              <span style={{ color: color.inkFaint, fontFamily: theme.mono, fontSize: 11 }}>{c.code}</span>
            </div>
          ))}
          {canOfferCreate && (
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                void handleCreate();
              }}
              onMouseEnter={() => setHighlight(matches.length)}
              style={{
                padding: '7px 10px',
                fontSize: 13,
                cursor: 'pointer',
                color: color.brass,
                background: highlight === matches.length ? color.paper : 'transparent',
                borderTop: matches.length > 0 ? `1px solid ${color.line}` : undefined,
              }}
            >
              {creating ? 'Adding…' : `+ Add "${query.trim()}" as new category`}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
