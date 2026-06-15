#!/usr/bin/env node
// Repair workspace-manager symlinks that escape the bundle root.
//
// `bun install` (like `pnpm deploy --legacy`) materializes workspace self-links
// under node_modules whose `../` count is computed for the ORIGINAL monorepo
// layout. In the shallower staged bundle those targets can climb above the
// bundle root, so the UnifiedApp installer's symlink-containment guard
// (symlink_target_within in installer.rs) rejects the *entire* archive with
// "Unsafe symlink target in archive".
//
// This pass rewrites every symlink whose relative target escapes the root by
// clamping the excess `..` at the root (how the link was *meant* to resolve
// once the bundle root is the effective root) and re-expressing it as an
// equivalent in-bundle relative link. Safe (non-escaping) links are untouched.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
if (!fs.existsSync(root)) {
  console.error(`[normalize-symlinks] root not found: ${root}`);
  process.exit(1);
}

let scanned = 0;
let rewritten = 0;
let removed = 0;

// Resolve `target` from `linkDir`, clamping any `..` that would climb above
// `root`. Returns { escapes, destRel } where destRel is the clamped path
// relative to root ('' means it resolved to the root itself).
function resolveClamped(linkDir, target) {
  const stack = path
    .relative(root, linkDir)
    .split(path.sep)
    .filter((c) => c && c !== '.');
  let escapes = false;
  for (const comp of target.split('/')) {
    if (comp === '' || comp === '.') continue;
    if (comp === '..') {
      if (stack.length > 0) stack.pop();
      else escapes = true; // would climb above root → clamp here
    } else {
      stack.push(comp);
    }
  }
  return { escapes, destRel: stack.join(path.sep) };
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      scanned++;
      const target = fs.readlinkSync(p);
      const linkDir = path.dirname(p);
      let escapes;
      let destRel;
      if (path.isAbsolute(target)) {
        const rel = path.relative(root, target);
        escapes = rel.startsWith('..');
        destRel = escapes ? '' : rel;
        if (!escapes) {
          // Absolute but inside root: re-express as relative (portable).
          fs.unlinkSync(p);
          fs.symlinkSync(path.relative(linkDir, path.join(root, destRel)) || '.', p);
          rewritten++;
        } else {
          fs.unlinkSync(p);
          removed++;
        }
        continue;
      }
      ({ escapes, destRel } = resolveClamped(linkDir, target));
      if (!escapes) continue; // safe link, leave as-is
      fs.unlinkSync(p);
      if (destRel === '') {
        removed++; // nothing sensible inside the bundle to point at
      } else {
        fs.symlinkSync(path.relative(linkDir, path.join(root, destRel)) || '.', p);
        rewritten++;
      }
    } else if (e.isDirectory()) {
      walk(p);
    }
  }
}

walk(root);
console.log(
  `[normalize-symlinks] scanned ${scanned} symlink(s); rewrote ${rewritten}, removed ${removed} escaping link(s) under ${root}`,
);
