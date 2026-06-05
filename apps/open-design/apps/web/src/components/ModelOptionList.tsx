// Logo-bearing model listbox — the home-screen media composer's analogue of
// the gateway picker's UnifiedModelList and of UnifiedApp's ModelPicker.vue.
//
// A native <select> can't render a per-option <img>, so model dropdowns that
// want provider brand marks render this custom listbox instead: one row per
// model showing its author logo (via the platform SDK), label, and a check on
// the active row. A filter input appears once the list grows past a handful of
// entries so long catalogues (the image surface ships ~30 models) stay
// scannable. The container is expected to already be an open popover/menu, so
// this renders the rows directly rather than its own trigger + dropdown.

import { useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ModelLogo } from './ModelLogo';

export interface ModelOption {
  value: string;
  label: string;
  /** Provider / model-author name for the brand logo (SDK getProviderLogo). */
  author?: string | undefined;
}

interface Props {
  options: ModelOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Show the filter input above this many options. */
  filterThreshold?: number;
  searchPlaceholder?: string;
}

export function ModelOptionList({
  options,
  value,
  onChange,
  ariaLabel,
  filterThreshold = 8,
  searchPlaceholder = 'Search models',
}: Props) {
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const showFilter = options.length > filterThreshold;
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? options.filter(
            (m) =>
              m.label.toLowerCase().includes(q) ||
              m.value.toLowerCase().includes(q) ||
              (m.author ?? '').toLowerCase().includes(q),
          )
        : options,
    [options, q],
  );

  // Roving arrow-key navigation across the option buttons (a native <select>
  // gives this for free; <button role="option"> rows do not).
  const focusOption = (dir: 1 | -1 | 'first' | 'last') => {
    const opts = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? [],
    );
    if (opts.length === 0) return;
    const idx = opts.findIndex((el) => el === document.activeElement);
    let next: number;
    if (dir === 'first') next = 0;
    else if (dir === 'last') next = opts.length - 1;
    else if (idx < 0) next = dir === 1 ? 0 : opts.length - 1;
    else next = Math.min(opts.length - 1, Math.max(0, idx + dir));
    opts[next]?.focus();
  };

  return (
    <div className="model-option-list">
      {showFilter ? (
        <input
          type="text"
          className="model-option-list__filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusOption('first');
            }
          }}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
      ) : null}
      <div
        className="model-option-list__rows"
        role="listbox"
        aria-label={ariaLabel}
        ref={listRef}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusOption(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusOption(-1);
          } else if (e.key === 'Home') {
            e.preventDefault();
            focusOption('first');
          } else if (e.key === 'End') {
            e.preventDefault();
            focusOption('last');
          }
        }}
      >
        {filtered.length === 0 ? (
          <div className="model-option-list__empty">No models</div>
        ) : (
          filtered.map((m) => {
            const selected = m.value === value;
            return (
              <button
                key={m.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={'model-option-list__item' + (selected ? ' is-selected' : '')}
                onClick={() => onChange(m.value)}
                title={m.author ? `${m.label} · ${m.author}` : m.label}
              >
                <ModelLogo author={m.author ?? null} size={18} className="model-option-list__logo" />
                <span className="model-option-list__label">{m.label}</span>
                {selected ? (
                  <Icon name="check" size={14} className="model-option-list__check" />
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
