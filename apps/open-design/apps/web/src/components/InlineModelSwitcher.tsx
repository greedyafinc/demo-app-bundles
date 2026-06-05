// InlineModelSwitcher — top-bar chip exposing CLI/BYOK + model picker.
//
// Lives in the entry view's sticky top-bar so users can swap between a
// local CLI and BYOK (and the active model under either) without having
// to open the full Settings dialog. The chip is intentionally narrow —
// it shows the active mode + agent/provider + model in one line and
// opens a compact popover for switching. All persistence is delegated
// upward through the same callbacks `AvatarMenu` already uses, so the
// switcher inherits autosave + daemon sync without re-implementing it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { KNOWN_PROVIDERS } from '../state/config';
import type {
  AgentInfo,
  AgentModelOption,
  ApiProtocol,
  AppConfig,
  ExecMode,
} from '../types';
import { apiProtocolLabel } from '../utils/apiProtocol';
import { AgentIcon } from './AgentIcon';
import { Icon } from './Icon';
import { ModelLogo } from './ModelLogo';
import { renderModelOptions } from './modelOptions';

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onApiProtocolChange: (protocol: ApiProtocol) => void;
  onApiModelChange: (model: string) => void;
  onOpenSettings: (
    section?:
      | 'execution'
      | 'media'
      | 'composio'
      | 'language'
      | 'appearance'
      | 'notifications'
      | 'pet'
      | 'about',
  ) => void;
}

const API_PROTOCOL_TABS: Array<{ id: ApiProtocol; title: string }> = [
  { id: 'anthropic', title: 'Anthropic' },
  { id: 'openai', title: 'OpenAI' },
  { id: 'azure', title: 'Azure' },
  { id: 'google', title: 'Google' },
];

export function InlineModelSwitcher({
  config,
  agents,
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onApiProtocolChange,
  onApiModelChange,
  onOpenSettings,
}: Props) {
  const t = useT();
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

  const installedAgents = useMemo(
    () => agents.filter((a) => a.available),
    [agents],
  );
  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );
  // Inside the UnifiedAI ecosystem the daemon surfaces only the platform
  // agent. Collapse the switcher to a single model picker — no CLI/BYOK
  // toggle, no agent grid, no API-key entry — so auth and routing are
  // entirely seamless.
  const unifiedEcosystem = useMemo(
    () => agents.some((a) => a.id === 'unified'),
    [agents],
  );

  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const currentModelId =
    currentChoice.model ?? currentAgent?.models?.[0]?.id ?? null;
  const currentModelLabel =
    currentAgent?.models?.find((m) => m.id === currentModelId)?.label ?? null;
  // Author/provider of the active gateway model — drives the chip's brand
  // logo inside the unified ecosystem. Undefined falls back to a neutral mark.
  const currentModelAuthor = useMemo(
    () => currentAgent?.models?.find((m) => m.id === currentModelId)?.author,
    [currentAgent, currentModelId],
  );

  const apiProtocol = config.apiProtocol ?? 'anthropic';
  const providerForProtocol = useMemo(
    () =>
      KNOWN_PROVIDERS.find(
        (p) =>
          p.protocol === apiProtocol &&
          (config.apiProviderBaseUrl
            ? p.baseUrl === config.apiProviderBaseUrl
            : false),
      ) ?? KNOWN_PROVIDERS.find((p) => p.protocol === apiProtocol),
    [apiProtocol, config.apiProviderBaseUrl],
  );
  const apiModelOptions = providerForProtocol?.models ?? [];

  // Chip text — keep it tight so the pill doesn't wrap on small viewports.
  // CLI: "Claude · Sonnet 4.5"; BYOK: "Anthropic · sonnet-4.5".
  const chipMode =
    config.mode === 'daemon'
      ? t('inlineSwitcher.chipCli')
      : t('inlineSwitcher.chipByok');
  const chipPrimary =
    config.mode === 'daemon'
      ? currentAgent?.name ?? t('inlineSwitcher.noAgent')
      : apiProtocolLabel(apiProtocol);
  const chipModel =
    config.mode === 'daemon'
      ? currentModelLabel && currentModelId !== 'default'
        ? currentModelLabel
        : t('inlineSwitcher.modelDefault')
      : config.model.trim() || t('inlineSwitcher.modelDefault');

  return (
    <div className="inline-switcher" ref={wrapRef}>
      <button
        type="button"
        className="inline-switcher__chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('inlineSwitcher.chipTitle')}
      >
        <span className="inline-switcher__chip-icon" aria-hidden="true">
          {unifiedEcosystem ? (
            <ModelLogo author={currentModelAuthor} size={18} />
          ) : config.mode === 'daemon' && currentAgent ? (
            <AgentIcon id={currentAgent.id} size={18} />
          ) : (
            <span className="inline-switcher__byok-glyph">
              <Icon name="link" size={12} />
            </span>
          )}
        </span>
        <span className="inline-switcher__chip-text">
          {!unifiedEcosystem ? (
            <>
              <span className="inline-switcher__chip-mode">{chipMode}</span>
              <span className="inline-switcher__chip-sep" aria-hidden="true">
                ·
              </span>
            </>
          ) : null}
          <span className="inline-switcher__chip-primary">{chipPrimary}</span>
          <span className="inline-switcher__chip-sep" aria-hidden="true">
            ·
          </span>
          <span className="inline-switcher__chip-model">{chipModel}</span>
        </span>
        <Icon
          name="chevron-down"
          size={12}
          className="inline-switcher__chip-chevron"
        />
      </button>

      {open ? (
        <div className="inline-switcher__popover" role="menu">
          {!unifiedEcosystem ? (
          <div className="inline-switcher__row">
            <span className="inline-switcher__label">
              {t('inlineSwitcher.modeLabel')}
            </span>
            <div className="inline-switcher__seg" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={config.mode === 'daemon'}
                className={
                  'inline-switcher__seg-btn' +
                  (config.mode === 'daemon' ? ' is-active' : '')
                }
                disabled={!daemonLive && config.mode !== 'daemon'}
                onClick={() => {
                  // Optional-call so a transient Fast Refresh state where a
                  // parent has not yet re-rendered with the new prop signature
                  // does not crash the entire entry view. The same defensive
                  // pattern is applied to every callback below.
                  onModeChange?.('daemon');
                  if (!daemonLive) {
                    setOpen(false);
                    onOpenSettings?.('execution');
                  }
                }}
                title={
                  !daemonLive
                    ? t('inlineSwitcher.daemonOffline')
                    : t('inlineSwitcher.useCli')
                }
              >
                {t('inlineSwitcher.chipCli')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={config.mode === 'api'}
                className={
                  'inline-switcher__seg-btn' +
                  (config.mode === 'api' ? ' is-active' : '')
                }
                onClick={() => onModeChange?.('api')}
                title={t('inlineSwitcher.useByok')}
              >
                {t('inlineSwitcher.chipByok')}
              </button>
            </div>
          </div>
          ) : null}

          {config.mode === 'daemon' ? (
            <>
              {!unifiedEcosystem ? (
              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.agentLabel')}
                </span>
                {installedAgents.length === 0 ? (
                  <span className="inline-switcher__hint">
                    {t('inlineSwitcher.noAgentsDetected')}
                  </span>
                ) : (
                  <div
                    className="inline-switcher__agent-grid"
                    role="radiogroup"
                  >
                    {installedAgents.map((a) => {
                      const active = config.agentId === a.id;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={
                            'inline-switcher__agent' +
                            (active ? ' is-active' : '')
                          }
                          onClick={() => onAgentChange?.(a.id)}
                          title={a.version ? `${a.name} · ${a.version}` : a.name}
                        >
                          <AgentIcon id={a.id} size={20} />
                          <span className="inline-switcher__agent-name">
                            {a.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              ) : null}

              {currentAgent &&
              currentAgent.models &&
              currentAgent.models.length > 0 ? (
                unifiedEcosystem ? (
                  // Gateway models carry a provider/author, so render a custom
                  // listbox with brand logos (native <option> can't hold an
                  // image) instead of the plain <select> used for local CLIs.
                  <div className="inline-switcher__row inline-switcher__row--stack">
                    <span className="inline-switcher__label">
                      {t('inlineSwitcher.modelLabel')}
                    </span>
                    <UnifiedModelList
                      models={currentAgent.models}
                      currentModelId={currentModelId}
                      onPick={(id) => {
                        onAgentModelChange?.(currentAgent.id, { model: id });
                        // Dismiss the popover on selection — a dropdown is
                        // expected to close once the user picks, and it keeps
                        // the custom listbox in step with a native <select>.
                        setOpen(false);
                      }}
                    />
                  </div>
                ) : (
                  <div className="inline-switcher__row">
                    <span className="inline-switcher__label">
                      {t('inlineSwitcher.modelLabel')}
                    </span>
                    <select
                      className="inline-switcher__select"
                      value={currentModelId ?? ''}
                      onChange={(e) =>
                        onAgentModelChange?.(currentAgent.id, {
                          model: e.target.value,
                        })
                      }
                    >
                      {renderModelOptions(currentAgent.models)}
                      {currentModelId &&
                      !currentAgent.models.some(
                        (m) => m.id === currentModelId,
                      ) ? (
                        <option value={currentModelId}>
                          {currentModelId} {t('inlineSwitcher.customSuffix')}
                        </option>
                      ) : null}
                    </select>
                  </div>
                )
              ) : null}
            </>
          ) : (
            <>
              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.providerLabel')}
                </span>
                <div className="inline-switcher__chips" role="tablist">
                  {API_PROTOCOL_TABS.map((tab) => {
                    const active = apiProtocol === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={
                          'inline-switcher__chip-tab' +
                          (active ? ' is-active' : '')
                        }
                        onClick={() => onApiProtocolChange?.(tab.id)}
                      >
                        {tab.title}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.modelLabel')}
                </span>
                {apiModelOptions.length > 0 ? (
                  <select
                    className="inline-switcher__select"
                    value={config.model}
                    onChange={(e) => onApiModelChange?.(e.target.value)}
                  >
                    {apiModelOptions.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                    {config.model &&
                    !apiModelOptions.includes(config.model) ? (
                      <option value={config.model}>
                        {config.model} {t('inlineSwitcher.customSuffix')}
                      </option>
                    ) : null}
                  </select>
                ) : (
                  <span className="inline-switcher__hint">
                    {t('inlineSwitcher.openSettingsForModel')}
                  </span>
                )}
              </div>

              {!config.apiKey ? (
                <div className="inline-switcher__warn" role="status">
                  {t('inlineSwitcher.missingApiKey')}
                </div>
              ) : null}
            </>
          )}

          <button
            type="button"
            className="inline-switcher__more"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.('execution');
            }}
          >
            <Icon name="settings" size={13} />
            <span>{t('inlineSwitcher.openFullSettings')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Custom model listbox for the UnifiedAI gateway. Unlike a native <select>
// (whose <option>s can't carry an <img>), this renders each model as a row
// with its provider brand logo + label + selected check. A search field
// appears once the catalog grows past a handful of models so a long gateway
// list stays scannable.
function UnifiedModelList({
  models,
  currentModelId,
  onPick,
}: {
  models: AgentModelOption[];
  currentModelId: string | null;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const showFilter = models.length > 8;
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? models.filter(
            (m) =>
              m.label.toLowerCase().includes(q) ||
              m.id.toLowerCase().includes(q) ||
              (m.author ?? '').toLowerCase().includes(q),
          )
        : models,
    [models, q],
  );
  // A previously-chosen id that isn't in the live catalog (e.g. a custom model
  // selected before) — keep it visible so the selection isn't silently lost.
  const currentIsKnown =
    !currentModelId || models.some((m) => m.id === currentModelId);
  const showCustomRow =
    !currentIsKnown &&
    !!currentModelId &&
    (!q || currentModelId.toLowerCase().includes(q));

  // Move focus into the picker on open — the filter when present, otherwise the
  // selected (or first) option — so keyboard users land in the list instead of
  // tabbing past the whole popover. Mount-time only: the popover (and this list)
  // unmounts when closed, and selecting a model closes it, so `currentModelId`
  // cannot change while the list is mounted via the picker — re-running on it
  // would steal focus, so it is intentionally not a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-time focus only
  useEffect(() => {
    if (showFilter) {
      filterRef.current?.focus();
      return;
    }
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLButtonElement>('button[aria-selected="true"]');
    const first = list.querySelector<HTMLButtonElement>('button[role="option"]');
    (active ?? first)?.focus();
  }, [showFilter]);

  // Roving arrow-key navigation for the custom listbox (a native <select>
  // gives this for free; <button role="option"> rows do not). Enter/Space
  // already activate a focused button, and Escape bubbles to the popover.
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
    <div className="inline-switcher__model-picker">
      {showFilter ? (
        <input
          ref={filterRef}
          type="text"
          className="inline-switcher__model-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusOption('first');
            }
          }}
          placeholder={t('inlineSwitcher.modelSearch')}
          aria-label={t('inlineSwitcher.modelSearch')}
        />
      ) : null}
      <div
        className="inline-switcher__model-list"
        role="listbox"
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
        {filtered.length === 0 && !showCustomRow ? (
          <div className="inline-switcher__model-empty">
            {t('inlineSwitcher.noModels')}
          </div>
        ) : (
          filtered.map((m) => {
            const active = m.id === currentModelId;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={active}
                className={
                  'inline-switcher__model-item' + (active ? ' is-active' : '')
                }
                onClick={() => onPick(m.id)}
                title={m.author ? `${m.label} · ${m.author}` : m.label}
              >
                <ModelLogo
                  author={m.author}
                  size={18}
                  className="inline-switcher__model-item-logo"
                />
                <span className="inline-switcher__model-item-label">
                  {m.label}
                </span>
                {active ? (
                  <Icon
                    name="check"
                    size={14}
                    className="inline-switcher__model-item-check"
                  />
                ) : null}
              </button>
            );
          })
        )}
        {showCustomRow ? (
          <button
            type="button"
            role="option"
            aria-selected={true}
            className="inline-switcher__model-item is-active"
            onClick={() => onPick(currentModelId)}
            title={currentModelId}
          >
            <ModelLogo
              size={18}
              className="inline-switcher__model-item-logo"
            />
            <span className="inline-switcher__model-item-label">
              {currentModelId} {t('inlineSwitcher.customSuffix')}
            </span>
            <Icon
              name="check"
              size={14}
              className="inline-switcher__model-item-check"
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}
