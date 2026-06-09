"""Regression tests: settings.json writes must be serialized (no lost updates).

``save_settings()`` does a read-modify-write of settings.json: ``load_settings()``
reads the whole file, the POSTed fields are merged in, then the full dict is
written back. The HTTP server is a ``ThreadingHTTPServer`` (see server.py), so
two near-simultaneous ``POST /api/settings`` requests run on separate threads —
e.g. the appearance autosave in static/panels.js writing ``{theme, skin,
font_size}`` while any other settings writer posts a different field.

Without a lock the two read-modify-write sequences interleave so the later
write clobbers the earlier one (a classic lost update). ``save_settings()`` now
serializes the whole sequence under ``config._settings_lock``; these tests pin
that behaviour. They are written to fail against the unlocked implementation
(``config._save_settings_unlocked``) and pass against the locked public entry
point.
"""
import threading

from api import config


def _reset_settings_baseline():
    """Start each scenario from a clean settings file (defaults only)."""
    try:
        config.SETTINGS_FILE.unlink()
    except FileNotFoundError:
        pass
    # Establish the file with no overrides; load_settings() fills in defaults.
    config.save_settings({})


def test_concurrent_dashboard_plugin_writes_are_not_clobbered():
    """Each thread deep-merges a unique plugin; all must survive.

    dashboard_plugins is a deep-merged dict, so every save reads the current
    map, adds its one entry, and writes the whole thing back — the exact
    read-modify-write the lock protects. With N threads racing on a barrier,
    the unlocked implementation drops almost every entry; the locked one keeps
    all N.
    """
    original = config.SETTINGS_FILE.read_text() if config.SETTINGS_FILE.exists() else None
    try:
        _reset_settings_baseline()

        n = 24
        barrier = threading.Barrier(n)

        def worker(i):
            # Maximise overlap: every thread blocks until all are ready, then
            # they all enter the read-modify-write at once.
            barrier.wait()
            config.save_settings({"dashboard_plugins": {f"plugin_{i}": True}})

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        stored = config.load_settings().get("dashboard_plugins", {})
        missing = [f"plugin_{i}" for i in range(n) if stored.get(f"plugin_{i}") is not True]
        assert not missing, (
            f"concurrent save_settings() lost {len(missing)}/{n} plugin writes "
            f"(missing: {missing[:5]}{'...' if len(missing) > 5 else ''}) — "
            "the read-modify-write of settings.json is not serialized"
        )
    finally:
        if original is not None:
            config.SETTINGS_FILE.write_text(original)
        else:
            try:
                config.SETTINGS_FILE.unlink()
            except FileNotFoundError:
                pass


def test_theme_autosave_and_concurrent_settings_change_do_not_clobber():
    """The named scenario: appearance autosave racing another settings writer.

    One thread posts the appearance-autosave payload ({theme, skin, font_size})
    while another posts disjoint fields. After each barrier-synced round both
    sides' fields must be present — neither write may clobber the other.
    """
    original = config.SETTINGS_FILE.read_text() if config.SETTINGS_FILE.exists() else None
    try:
        rounds = 40
        for _ in range(rounds):
            # Reset to defaults so a clobber visibly reverts a field rather than
            # silently leaving a value a previous round already set.
            _reset_settings_baseline()

            barrier = threading.Barrier(2)

            def autosave():
                barrier.wait()
                config.save_settings(
                    {"theme": "system", "skin": "charizard", "font_size": "large"}
                )

            def other_change():
                barrier.wait()
                config.save_settings(
                    {"show_token_usage": True, "sidebar_density": "detailed"}
                )

            t1 = threading.Thread(target=autosave)
            t2 = threading.Thread(target=other_change)
            t1.start()
            t2.start()
            t1.join()
            t2.join()

            final = config.load_settings()
            # Appearance writer's fields survived...
            assert final.get("theme") == "system", "appearance theme write was clobbered"
            assert final.get("font_size") == "large", "appearance font_size write was clobbered"
            # ...and so did the concurrent non-appearance writer's fields.
            assert final.get("show_token_usage") is True, "concurrent show_token_usage write was clobbered"
            assert final.get("sidebar_density") == "detailed", "concurrent sidebar_density write was clobbered"
    finally:
        if original is not None:
            config.SETTINGS_FILE.write_text(original)
        else:
            try:
                config.SETTINGS_FILE.unlink()
            except FileNotFoundError:
                pass
