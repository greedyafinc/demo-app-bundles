#!/usr/bin/env node
// UnifiedApp marketplace service entrypoint for Rowboat (`node-service` kind).
//
// The desktop host (Tauri desktop_core/service.rs) spawns this with
// workingDir = bundle root:
//
//   manifest.json:
//     "service": { "command": "runtime/node/bin/node", "args": ["launch.mjs"], ... }
//
// Host-injected env (service.rs + broker.rs):
//   OD_PORT                 free port the host allocated — we MUST bind it
//   OD_BIND_HOST            127.0.0.1
//   OD_DATA_DIR             writable per-app data dir (install tree is read-only)
//   UNIFIED_APP_SLUG        our marketplace slug ("rowboat")
//   UNIFIED_BROKER_URL      loopback broker base url
//   UNIFIED_BROKER_TOKEN    per-launch shared secret (x-broker-token header)
//
// `UNIFIED_API_URL` is deliberately NOT injected by the host — cli/src/unified
// defaults it to the dev gateway (http://localhost:3141) and accepts overrides.
//
// Three jobs, in order (env + config seeding MUST precede the server import,
// which snapshots WorkDir and writes a default models.json on first resolve):
//
// 1. Env bridge: OD_* → PORT/HOST/ROWBOAT_HOME, plus ROWBOAT_UI_DIR so the
//    server serves the static dashboard same-origin.
// 2. Seed ~ROWBOAT_HOME/config/models.json with the `unified` provider flavor
//    (UnifiedAI gateway via the loopback broker) so chat works on install with
//    zero setup. Only when running inside UnifiedApp; never clobbers a config
//    the user has edited.
// 3. Mint a broker token (diagnostics + the host's .token handoff file), then
//    import the server, which serves until killed by the host.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`[rowboat-launch] ${msg}`);

// Default model the seeded unified provider chats with out of the box. A
// CONCRETE catalog id (not `auto` — keep parity with the Hermes bundle and
// pick a model every capability check understands). Override with
// UNIFIED_DEFAULT_MODEL; users can switch models in-app afterward.
const DEFAULT_GATEWAY_MODEL = process.env.UNIFIED_DEFAULT_MODEL || "gpt-5.4";

// ── 1. Env bridge ────────────────────────────────────────────────────────────
if (process.env.OD_PORT) process.env.PORT = process.env.OD_PORT;
process.env.HOST = process.env.OD_BIND_HOST || "127.0.0.1";

const dataDir = process.env.OD_DATA_DIR || "";
if (dataDir) {
    process.env.ROWBOAT_HOME = process.env.ROWBOAT_HOME || path.join(dataDir, "rowboat");
}
const workDir = process.env.ROWBOAT_HOME || path.join(process.env.HOME || "", ".rowboat");

// Relative to the process cwd (= bundle root, per manifest workingDir).
if (existsSync(path.join(BUNDLE_ROOT, "ui", "out"))) {
    process.env.ROWBOAT_UI_DIR = process.env.ROWBOAT_UI_DIR || "ui/out";
}

// ── 2. Seed the unified model provider (inside UnifiedApp only) ─────────────
const { isUnifiedConfigured, getUnifiedToken, unifiedApiBase } = await import(
    "./cli/dist/unified/auth.js"
);

function seedModelsConfig() {
    const configDir = path.join(workDir, "config");
    const modelsPath = path.join(configDir, "models.json");
    const seededMarker = path.join(configDir, ".models.unified-seeded");
    const seed = {
        providers: {
            unified: { flavor: "unified" },
        },
        defaults: { provider: "unified", model: DEFAULT_GATEWAY_MODEL },
    };

    mkdirSync(configDir, { recursive: true });

    if (existsSync(modelsPath)) {
        // Replace ONLY the untouched upstream default (provider "openai", no
        // key) left behind by a standalone run — chat would be dead anyway.
        // Anything else is user-owned config: respect it.
        try {
            const current = JSON.parse(readFileSync(modelsPath, "utf8"));
            const isUpstreamDefault =
                Object.keys(current.providers ?? {}).join(",") === "openai" &&
                !current.providers.openai?.apiKey &&
                current.defaults?.provider === "openai";
            if (!isUpstreamDefault) return;
            log("replacing untouched default models.json with the unified provider seed");
        } catch {
            return; // unreadable/invalid — leave it to the app to complain
        }
    }

    writeFileSync(modelsPath, JSON.stringify(seed, null, 2));
    writeFileSync(
        seededMarker,
        "models.json was seeded by the UnifiedApp launcher (launch.mjs). Delete models.json to re-seed.\n"
    );
    log(`seeded ${modelsPath} (provider=unified, model=${seed.defaults.model}, gateway=${unifiedApiBase()})`);
}

if (isUnifiedConfigured()) {
    seedModelsConfig();
} else {
    log("no broker env (running outside UnifiedApp?); model providers left to user config");
}

// ── 3. Broker token diagnostics + host .token handoff ───────────────────────
if (isUnifiedConfigured()) {
    try {
        const token = await getUnifiedToken();
        log("acquired Unified app token via broker");
        if (dataDir) {
            try {
                mkdirSync(dataDir, { recursive: true });
                writeFileSync(path.join(dataDir, ".token"), token);
            } catch (err) {
                log(`could not write host token file: ${err?.message ?? err}`);
            }
        }
    } catch (err) {
        log(`broker token mint failed (chat via unified provider will retry per-request): ${err?.message ?? err}`);
    }
}

// ── 4. Start the server (binds HOST:PORT, serves API + dashboard) ───────────
log(`starting rowboatx server on ${process.env.HOST}:${process.env.PORT || 3000} (home=${workDir})`);
await import("./cli/dist/server.js");
