/**
 * ClawMem File Watcher - fs.watch with debounce for incremental reindex
 *
 * Walks each directory tree at startup, skipping excluded dirs (gits/,
 * node_modules/, .git/, etc.), and watches only non-excluded directories.
 * This prevents inotify FD exhaustion on trees with large cloned repos.
 */

import { watch, readdirSync, statSync, type WatchEventType } from "fs";
import { join, relative } from "path";
import { shouldExclude, EXCLUDED_DIRS } from "./indexer.ts";

export type WatcherOptions = {
  debounceMs?: number;
  onChanged: (path: string, event: WatchEventType) => Promise<void>;
  onError?: (error: Error) => void;
};

/** Default cap on the directories watched under one collection path (`CLAWMEM_WATCH_MAX_DIRS` overrides it). */
export const DEFAULT_MAX_WATCH_DIRS = 500;

/**
 * The per-collection-path cap on watched directories: `CLAWMEM_WATCH_MAX_DIRS` when it is a positive
 * integer, else DEFAULT_MAX_WATCH_DIRS (an unusable value is reported through `onInvalid`). Each watched
 * directory costs one OS watch; on Linux that is an inotify watch, counted against the per-user
 * `fs.inotify.max_user_watches` limit every process shares, so size the cap against that limit.
 */
export function resolveMaxWatchDirs(
  env: Record<string, string | undefined> = process.env,
  onInvalid?: (raw: string) => void,
): number {
  const raw = env.CLAWMEM_WATCH_MAX_DIRS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_WATCH_DIRS;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (Number.isSafeInteger(n) && n > 0) return n;
  onInvalid?.(raw);
  return DEFAULT_MAX_WATCH_DIRS;
}

/**
 * Walk a directory tree, returning only directories that are NOT excluded.
 * Stops recursion into excluded subtrees (gits/, node_modules/, .git/, etc.).
 */
function walkNonExcludedDirs(root: string): string[] {
  const dirs: string[] = [root];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue; // Permission denied or deleted
    }

    for (const entry of entries) {
      // Skip excluded directory names before stat
      if (EXCLUDED_DIRS.has(entry) || (entry.startsWith(".") && entry !== ".")) continue;

      const fullPath = join(current, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          dirs.push(fullPath);
          queue.push(fullPath);
        }
      } catch {
        // stat failed — skip
      }
    }
  }

  return dirs;
}

export function startWatcher(
  directories: string[],
  options: WatcherOptions
): { close: () => void } {
  const { debounceMs = 2000, onChanged, onError } = options;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: ReturnType<typeof watch>[] = [];
  const maxDirs = resolveMaxWatchDirs(process.env, (raw) =>
    console.log(`[watcher] WARNING: CLAWMEM_WATCH_MAX_DIRS=${JSON.stringify(raw)} is not a positive integer — using ${DEFAULT_MAX_WATCH_DIRS}`));

  for (const dir of directories) {
    // Walk the tree, skipping excluded dirs — watch each non-excluded dir individually
    const watchableDirs = walkNonExcludedDirs(dir);

    // Cap the dirs one collection path watches (CLAWMEM_WATCH_MAX_DIRS, default 500). Dirs past the cap
    // go unwatched: a change there waits for the collection's next full index pass.
    if (watchableDirs.length > maxDirs) {
      console.log(`[watcher] WARNING: ${dir} has ${watchableDirs.length} dirs — watching the first ${maxDirs}; changes in the others wait for the next full index pass (clawmem update). Raise the cap with CLAWMEM_WATCH_MAX_DIRS, or narrow the collection path.`);
      watchableDirs.length = maxDirs;
    } else {
      console.log(`[watcher] ${dir}: watching ${watchableDirs.length} dirs`);
    }

    for (const watchDir of watchableDirs) {
      try {
        // Non-recursive watch — each dir watched individually
        const watcher = watch(watchDir, (event, filename) => {
          if (!filename) return;
          // Accept .md files (indexing) and .jsonl only within .beads/ (Dolt backend)
          const isMd = filename.endsWith(".md");
          const isBeadsJsonl = filename.endsWith(".jsonl") && filename.includes(".beads/");
          if (!isMd && !isBeadsJsonl) return;

          const relativeToDirRoot = relative(dir, join(watchDir, filename));
          if (shouldExclude(relativeToDirRoot)) return;

          const fullPath = join(watchDir, filename);
          const existing = pending.get(fullPath);
          if (existing) clearTimeout(existing);

          pending.set(fullPath, setTimeout(async () => {
            pending.delete(fullPath);
            try {
              await onChanged(fullPath, event);
            } catch (err) {
              onError?.(err instanceof Error ? err : new Error(String(err)));
            }
          }, debounceMs));
        });
        watcher.on("error", (err) => {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        });
        watchers.push(watcher);
      } catch (err) {
        // Individual dir watch failure is non-fatal — skip it
        if (onError) {
          onError(err instanceof Error ? err : new Error(`Failed to watch ${watchDir}: ${err}`));
        }
      }
    }
  }

  return {
    close: () => {
      for (const w of watchers) w.close();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}
