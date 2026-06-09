# Marketplace app icons

Public, CORS-enabled (`raw.githubusercontent.com` sends `access-control-allow-origin: *`)
brand glyphs for the UnifiedAI marketplace. The desktop fetches these for the
catalog tile AND to rasterize the synthesized solo `.app`'s Dock icon (UNI-48),
so `public.apps.icon` in unified-db can be a pure-data remote URL — adding a new
app needs no UnifiedApp change.

Reference from `apps.icon` (or `apps.solo_icon_url`) as:

    https://raw.githubusercontent.com/greedyafinc/demo-app-bundles/main/icons/<slug>.<ext>

Add a new app's icon = drop `<slug>.<ext>` here. Keep glyphs small + square
(SVG or a ≥512px raster). Release-asset URLs are NOT usable — they lack CORS.
