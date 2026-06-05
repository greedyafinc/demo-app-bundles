// Compact account-usage meter for the entry top-bar. Sits next to the
// InlineModelSwitcher and reflects the signed-in user's UnifiedAI usage
// (proxied by the daemon from the gateway). The chip shows today's
// consumption against the plan's daily cap as a thin meter; clicking it opens
// a popover with the full breakdown (period tokens / requests / cost, daily
// reset, and remaining credits).
//
// All numbers come pre-formatted from the SDK's summarizeUsage() view-model, so
// the chip never re-derives ratios, thresholds, or labels — it stays in lockstep
// with the rest of the platform.
//
// It renders nothing when usage is unavailable (OpenDesign running outside the
// UnifiedApp host) or before the first successful load, so it never flashes a
// placeholder or an error into the chrome.

import { summarizeUsage } from '@unifiedai/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useUnifiedUsage } from '../hooks/useUnifiedUsage';
import { Icon } from './Icon';

export function UsageChip() {
  const t = useT();
  const { data, unavailable } = useUnifiedUsage();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Derive the display view-model once per data change (memoized so a render
  // that doesn't change `data` — e.g. opening the popover — doesn't rebuild it).
  // Computed before the early return to satisfy the Rules of Hooks.
  const summary = useMemo(() => (data ? summarizeUsage(data) : null), [data]);

  // Nothing to show outside the UnifiedApp host or before the first load.
  if (unavailable || !data || !summary) return null;

  const { planName, daily, period, credits } = summary;
  const nearLimit = daily.isNearLimit;
  const percent = daily.percent ?? 0;

  // Chip value: daily used/limit when the plan is metered, otherwise this
  // period's total token volume (a $0.00 cost is a valid state, so we don't
  // branch the chip on it — the popover carries the full cost breakdown).
  const chipValue = daily.isMetered
    ? `${daily.usedLabel} / ${daily.limitLabel}`
    : period.totalLabel;

  const resetsIn = daily.resetsInLabel ?? period.resetsInLabel;

  return (
    <div className="usage-chip" ref={wrapRef}>
      <button
        type="button"
        className={'usage-chip__button' + (nearLimit ? ' is-warn' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('usage.chipAria')}
        title={t('usage.chipAria')}
      >
        <Icon name="activity" size={13} className="usage-chip__icon" />
        {daily.isMetered ? (
          <span className="usage-chip__meter" aria-hidden="true">
            <span className="usage-chip__meter-fill" style={{ width: `${percent}%` }} />
          </span>
        ) : null}
        <span className="usage-chip__value">{chipValue}</span>
      </button>

      {open ? (
        <div className="usage-chip__popover" role="menu">
          <div className="usage-chip__header">
            <span className="usage-chip__title">{t('usage.title')}</span>
            <span className="usage-chip__plan">{planName}</span>
          </div>

          <div className="usage-chip__section">
            <div className="usage-chip__section-head">
              <span className="usage-chip__section-label">{t('usage.today')}</span>
              {resetsIn ? (
                <span className="usage-chip__hint">
                  {t('usage.resetsIn', { when: resetsIn })}
                </span>
              ) : null}
            </div>
            {daily.isMetered ? (
              <>
                <span className="usage-chip__meter usage-chip__meter--lg" aria-hidden="true">
                  <span
                    className={'usage-chip__meter-fill' + (nearLimit ? ' is-warn' : '')}
                    style={{ width: `${percent}%` }}
                  />
                </span>
                <span className="usage-chip__metric">
                  {daily.usedLabel} / {daily.limitLabel}
                </span>
              </>
            ) : (
              <span className="usage-chip__metric">
                {daily.usedLabel} · {t('usage.unlimited')}
              </span>
            )}
          </div>

          <div className="usage-chip__section">
            <span className="usage-chip__section-label">{t('usage.period')}</span>
            <dl className="usage-chip__stats">
              <div className="usage-chip__stat">
                <dt>{t('usage.input')}</dt>
                <dd>{period.inputLabel}</dd>
              </div>
              <div className="usage-chip__stat">
                <dt>{t('usage.output')}</dt>
                <dd>{period.outputLabel}</dd>
              </div>
              <div className="usage-chip__stat">
                <dt>{t('usage.requests')}</dt>
                <dd>{period.requestsLabel}</dd>
              </div>
              <div className="usage-chip__stat">
                <dt>{t('usage.cost')}</dt>
                <dd>{period.costLabel}</dd>
              </div>
            </dl>
          </div>

          {credits.hasBalance ? (
            <div className="usage-chip__section usage-chip__section--credits">
              <span className="usage-chip__section-label">{t('usage.credits')}</span>
              <span className="usage-chip__metric">{credits.balanceLabel}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
