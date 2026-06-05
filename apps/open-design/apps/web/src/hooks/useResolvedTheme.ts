import { useEffect, useState } from 'react';

// Resolve the live UI theme from `<html data-theme>` (set by state/appearance.ts
// for explicit light/dark), falling back to the OS `prefers-color-scheme` when
// the user is on the implicit "system" mode (no attribute set). Lightweight on
// purpose — picking a logo/icon variant doesn't deserve a full theme context.
// Listens for both the data attribute changing and the OS-level scheme toggling
// so dependent chrome (provider logos, brand marks) stays in lockstep.
export function useResolvedTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => {
    if (typeof document === 'undefined') return 'dark';
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  };
  const [theme, setTheme] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const update = () => setTheme(read());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', update);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', update);
    };
  }, []);
  return theme;
}
