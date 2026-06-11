"use client";

// Gateway model picker for the composer — the "native UnifiedAI app" model
// selector. The options are the UnifiedAI gateway catalog (served by the
// rowboatx server's GET /unified/models, which queries the gateway through
// @unifiedai/sdk), each rendered with its author's brand logo via the SDK's
// bundled data-URI logos. Picking a model persists it as the workspace default
// (PUT /models/default on the `unified` provider), which is what the agent
// runtime resolves for every run that doesn't pin its own model.
//
// Outside the UnifiedApp desktop host there is no broker (GET /unified/models
// → 503): the picker stays visible but disabled, showing whatever default the
// user configured in models.json.

import * as React from "react";
// The /browser subpath is explicit: Next compiles client components for the
// server too, where the package's `node` export condition would win and drag
// in OAuth/keychain machinery (@napi-rs/keyring) that breaks the build.
import { getModelLogo } from "@unifiedai/sdk/browser";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type CatalogModel = {
  id: string;
  name?: string;
  type?: string;
  logo?: string | null;
  owned_by?: string | null;
  model_author?: { name?: string | null } | null;
};

export function ModelSelect({ apiBase }: { apiBase: string }) {
  const [models, setModels] = React.useState<CatalogModel[]>([]);
  const [current, setCurrent] = React.useState<string>("");
  const [unifiedAvailable, setUnifiedAvailable] = React.useState(false);

  React.useEffect(() => {
    if (!apiBase) return;
    const abort = new AbortController();
    const load = async () => {
      // Current workspace default (works in every mode).
      try {
        const res = await fetch(new URL("/models", apiBase), { signal: abort.signal });
        if (res.ok) {
          const config = await res.json();
          if (config?.defaults?.model) setCurrent(config.defaults.model);
        }
      } catch {
        /* server not up yet — the next apiBase change retries */
      }
      // Gateway catalog (only inside the UnifiedApp desktop host).
      try {
        const res = await fetch(new URL("/unified/models", apiBase), { signal: abort.signal });
        if (!res.ok) {
          setUnifiedAvailable(false);
          return;
        }
        const payload = await res.json();
        const chatModels = (Array.isArray(payload?.data) ? payload.data : []).filter(
          (m: CatalogModel) => !m.type || m.type === "text",
        );
        setModels(chatModels);
        setUnifiedAvailable(chatModels.length > 0);
      } catch {
        setUnifiedAvailable(false);
      }
    };
    load();
    return () => abort.abort();
  }, [apiBase]);

  const handleChange = async (modelId: string) => {
    // Radix's hidden native <select> can emit a spurious empty change during
    // mount/form-reset; never persist an empty or no-op selection.
    if (!modelId || modelId === current) return;
    const previous = current;
    setCurrent(modelId);
    try {
      // Make sure the unified provider exists even in a user-owned config —
      // upsert is idempotent — then persist the new workspace default.
      await fetch(new URL("/models/providers/unified", apiBase), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flavor: "unified" }),
      });
      const res = await fetch(new URL("/models/default", apiBase), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "unified", model: modelId }),
      });
      if (!res.ok) throw new Error(`set default failed: ${res.status}`);
    } catch (error) {
      console.error("Failed to set default model", error);
      setCurrent(previous);
    }
  };

  // Brand icon resolution, in order:
  //   1. a self-contained gateway logo (absolute/data: URL — the server nulls
  //      origin-relative paths, which only resolve inside the UnifiedApp client),
  //   2. the author brand data-URI bundled in @unifiedai/sdk (always renders).
  // The onError swap covers a gateway URL that exists but fails to load.
  const logoTheme = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? ("dark" as const)
      : ("light" as const);
  const logoFor = (m: CatalogModel) => m.logo || getModelLogo(m, logoTheme());
  const handleLogoError = (m: CatalogModel) => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const fallback = getModelLogo(m, logoTheme());
    if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback;
  };
  const selected = models.find((m) => m.id === current);

  return (
    <Select value={current || undefined} onValueChange={handleChange} disabled={!unifiedAvailable}>
      <SelectTrigger
        className="w-44"
        title={
          unifiedAvailable
            ? "Default model (UnifiedAI gateway)"
            : "Model picker needs the UnifiedAI gateway — launch from the UnifiedApp desktop"
        }
      >
        <SelectValue placeholder={current || "Model"}>
          {current ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {selected && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoFor(selected)}
                  onError={handleLogoError(selected)}
                  alt=""
                  className="h-3.5 w-3.5 shrink-0 rounded-sm"
                />
              )}
              <span className="truncate">{selected?.name || current}</span>
            </span>
          ) : (
            "Model"
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              <span className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoFor(model)}
                  onError={handleLogoError(model)}
                  alt=""
                  className="h-4 w-4 shrink-0 rounded-sm"
                />
                <span className="truncate">{model.name || model.id}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
