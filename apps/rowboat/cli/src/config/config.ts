import path from "path";
import fs from "fs";
import { homedir } from "os";

// Resolve app root relative to compiled file location (dist/...)
// ROWBOAT_HOME relocates all mutable state (agents/config/runs) — the
// UnifiedApp marketplace launcher points it at the writable per-app data dir
// because the install tree is read-only. Default unchanged: ~/.rowboat.
export const WorkDir = process.env.ROWBOAT_HOME || path.join(homedir(), ".rowboat");

function ensureDirs() {
    const ensure = (p: string) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
    ensure(WorkDir);
    ensure(path.join(WorkDir, "agents"));
    ensure(path.join(WorkDir, "config"));
    // FSRunsRepo appends run logs here on POST /runs/new, which can happen
    // before the agent runtime (which also mkdirs it) has ever executed.
    ensure(path.join(WorkDir, "runs"));
}

ensureDirs();