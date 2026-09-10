// File collection. Port of collect() from the Python pgrag ingest:
// walk roots, skip dirs/exts, cap file size, utf-8 only, tag each file with
// a project name derived from its path relative to $HOME.

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".mypy_cache",
  "dist",
  "build",
  ".cache",
  ".pi",
  ".npm",
  "stale-20260908",
  ".next",
  "out",
  "target",
  ".turbo",
  ".parcel-cache",
]);

export const SKIP_EXT = new Set([
  ".lock",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".mp3",
  ".m4a",
  ".wav",
  ".zip",
  ".tar",
  ".gz",
  ".ttf",
  ".woff",
  ".woff2",
  ".so",
  ".pyc",
  ".bin",
  ".gguf",
  ".sqlite",
  ".db",
  ".wasm",
]);

export const MAX_BYTES = 1_000_000;

export interface CollectedFile {
  project: string;
  source: string;
  content: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export function collect(roots: string[], home = os.homedir()): CollectedFile[] {
  const files: CollectedFile[] = [];

  const add = (filePath: string) => {
    const ext = path.extname(path.basename(filePath)).toLowerCase();
    if (SKIP_EXT.has(ext)) return;
    let content: string;
    try {
      if (statSync(filePath).size > MAX_BYTES) return;
      content = decoder.decode(readFileSync(filePath));
    } catch {
      return;
    }
    if (!content.trim()) return;
    const parts = path.relative(home, filePath).split(path.sep);
    let project = parts[0];
    // ~/projects/<name>/... -> tag with the project dir, not "projects"
    if (parts[0] === "projects" && parts.length > 2) project = parts[1];
    files.push({ project, source: filePath, content });
  };

  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) {
        add(p);
      }
    }
  };

  for (const root of roots) {
    const abs = path.resolve(root);
    if (statSync(abs).isFile()) {
      add(abs);
      continue;
    }
    walk(abs);
  }
  return files;
}
