/**
 * Minimal type surface for the subset of `@unifiedai/sdk/node` that Grist
 * Desktop consumes.
 *
 * Why a local shim instead of importing `@unifiedai/sdk/node` directly:
 * grist-core's build uses classic `moduleResolution: node` and emits
 * CommonJS, while the SDK is published as ESM exposed only through a
 * package.json `"exports"` map (no physical `node/` subpath at the package
 * root). Classic node resolution ignores `"exports"`, and a CommonJS
 * `require()` of the SDK's ESM build would fail at runtime. So we type against
 * this declaration at compile time and load a CommonJS bundle (`_sdk.js`,
 * produced by `build-bundle.sh` via esbuild) at runtime.
 *
 * Keep this in sync with the SDK's node entry if the consumed surface grows.
 */

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
};

export type KeychainAdapter = {
  get(clientId: string): Promise<TokenSet | null>;
  set(clientId: string, tokens: TokenSet): Promise<void>;
  clear(clientId: string): Promise<void>;
};

export type UnifiedAIOptions = {
  apiUrl?: string;
  appId?: string;
  keychain?: KeychainAdapter;
  authorizeUrl?: string;
  tokenUrl?: string;
};

export class UnifiedAI {
  constructor(options?: UnifiedAIOptions);
  /** keychain cache -> UnifiedApp-desktop handoff -> browser PKCE sign-in. */
  bootstrap(): Promise<void>;
  signOut(): Promise<void>;
  /** Protected subclass seam: the current access token (after bootstrap). */
  protected getInitialAccessToken(): Promise<string>;
  /** Protected subclass seam: force a refresh and return the new token. */
  protected refreshAccessToken(): Promise<string>;
}

/** Bundled, offline author/provider logo as a data:image/svg+xml URI. */
export function getProviderLogo(
  input: string | { author?: string | null; model_author?: { name?: string | null } | null } | null,
  theme?: "light" | "dark"
): string;
export function getModelLogo(
  model: { model_author?: { name?: string | null } | null; owned_by?: string | null } | null,
  theme?: "light" | "dark"
): string;
