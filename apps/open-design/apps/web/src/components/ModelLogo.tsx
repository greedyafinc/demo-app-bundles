import { getProviderLogo } from '@unifiedai/sdk';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

interface Props {
  /**
   * Provider / model-author name (e.g. "Anthropic", "OpenAI"). Unknown or
   * missing values resolve to the SDK's neutral fallback mark.
   */
  author?: string | null;
  size?: number;
  className?: string;
}

// Brand mark for a UnifiedAI gateway model, sourced from the platform SDK's
// logo set. `getProviderLogo` returns an inline data-URI (with a built-in
// fallback), so there is no asset to bundle, no network request, and no 404
// to handle — it renders synchronously and always succeeds. Theme-aware: the
// dark variant is used under the dark chrome. Decorative by default; the
// adjacent model label carries the accessible name.
export function ModelLogo({ author, size = 18, className }: Props) {
  const theme = useResolvedTheme();
  const src = getProviderLogo(author ?? null, theme);
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={'model-logo' + (className ? ' ' + className : '')}
      aria-hidden="true"
      draggable={false}
    />
  );
}
