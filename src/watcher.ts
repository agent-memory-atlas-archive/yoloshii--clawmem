/**
 * ClawMem File Watcher - fs.watch with debounce for incremental reindex
 *
 * Walks each directory tree at startup, skipping excluded dirs (gits/,
 * node_modules/, .git/, etc.), and watches only non-excluded directories.
 * This prevents inotify FD exhaustion on trees with large cloned repos.
 *
 * Every event also schedules a rescan of its directory (v0.40.2): the file
 * name an event carries is not reliable enough to act on alone.
 */

import { watch, readdirSync, statSync, lstatSync, type Stats, type WatchEventType } from "fs";
import { readdir } from "fs/promises";
import { join, relative, resolve } from "path";
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

/** A file name the watcher acts on: `.md` (indexing), or `.jsonl` within `.beads/` (Dolt backend). */
function watchesName(filename: string): boolean {
  return filename.endsWith(".md") || (filename.endsWith(".jsonl") && filename.includes(".beads/"));
}

/** Whether a directory entry is a file the watcher acts on, judged from the collection root. */
function accepts(root: string, watchDir: string, name: string): boolean {
  return watchesName(name) && !shouldExclude(relative(root, join(watchDir, name)));
}

/**
 * What a listing records for one file: inode, size, mtime and ctime from lstat, so a rename over it, a write,
 * a touch or a chmod each changes it. Null when the path is gone or is not a file or symlink.
 */
function statOf(path: string): string | null {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile() && !st.isSymbolicLink()) return null;
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A directory listing (file name → `statOf`), and each file that appeared (`rename`), changed (`change`) or disappeared (`rename`) since the previous one. */
export type Listing = { files: Map<string, string>; changes: [name: string, event: WatchEventType][] };

/**
 * List the files the watcher acts on in one watched directory and compare them with `previous`. A directory that
 * is gone lists as empty; null when it cannot be read for another reason. Synchronous: the watcher lists each
 * directory as its watch starts.
 */
export function listWatchedFiles(root: string, watchDir: string, previous: Map<string, string> | null): Listing | null {
  let names: string[];
  try {
    names = readdirSync(watchDir);
  } catch (err) {
    if (!isGone(err)) return null;
    names = [];
  }
  const listing: Listing = { files: new Map(), changes: [] };
  for (const name of names) {
    if (!accepts(root, watchDir, name)) continue;
    const stat = statOf(join(watchDir, name));
    if (stat === null) continue;
    listing.files.set(name, stat);
    const before = previous?.get(name);
    if (previous && before === undefined) listing.changes.push([name, "rename"]);
    else if (previous && before !== stat) listing.changes.push([name, "change"]);
  }
  if (previous) for (const name of previous.keys()) if (!listing.files.has(name)) listing.changes.push([name, "rename"]);
  return listing;
}

/** Directory entries a rescan looks at before it lets timers and I/O run again. */
const RESCAN_CHUNK = 256;

/**
 * One watched directory's rescan state. Registrations whose collection paths overlap share it: a directory is
 * only reached through names neither walk excludes, so they agree on which of its files the watcher acts on.
 */
type WatchedDir = {
  root: string;
  listing: Map<string, string>;   // file → `statOf` when last compared or delivered
  listed: boolean;                // the startup listing is taken
  timer: ReturnType<typeof setTimeout> | null;
  scanning: boolean;
  again: boolean;                 // an event arrived during the rescan: run one more when it ends
};

export function startWatcher(
  directories: string[],
  options: WatcherOptions
): { close: () => void } {
  const { debounceMs = 2000, onChanged, onError } = options;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const rescans = new Set<ReturnType<typeof setTimeout>>();
  const watched = new Map<string, WatchedDir>();
  const watchers: ReturnType<typeof watch>[] = [];
  let closed = false;

  // Debounced per file: the last event for a path wins, `debounceMs` after it. `onFire` runs just before
  // onChanged and records the file in its directory's listing as it is now, the state about to be indexed.
  const schedule = (fullPath: string, event: WatchEventType, onFire: () => void) => {
    if (closed) return;
    const existing = pending.get(fullPath);
    if (existing) clearTimeout(existing);

    pending.set(fullPath, setTimeout(async () => {
      pending.delete(fullPath);
      onFire();
      try {
        await onChanged(fullPath, event);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }, debounceMs));
  };

  const recordAsDelivered = (watchDir: string, state: WatchedDir, name: string) => () => {
    const stat = statOf(join(watchDir, name));
    if (stat === null) state.listing.delete(name);
    else state.listing.set(name, stat);
  };

  // Compare one file with its listing entry, both as they are at this moment; on a difference, record the file's
  // state and deliver it, unless its own per-file timer is pending (that timer indexes the file when it fires).
  const compareAndDeliver = (watchDir: string, state: WatchedDir, name: string) => {
    const now = statOf(join(watchDir, name));
    const before = state.listing.get(name);
    if ((now ?? undefined) === before) return;
    if (now === null) state.listing.delete(name);
    else state.listing.set(name, now);
    const fullPath = join(watchDir, name);
    if (!pending.has(fullPath)) {
      schedule(fullPath, before === undefined || now === null ? "rename" : "change", recordAsDelivered(watchDir, state, name));
    }
  };

  const rescan = async (watchDir: string, state: WatchedDir) => {
    state.scanning = true;
    try {
      const known = [...state.listing.keys()];
      let names: string[];
      try {
        names = await readdir(watchDir);
      } catch (err) {
        if (!isGone(err)) return;      // unreadable for now: the next event rescans it
        names = [];
      }
      const seen = new Set<string>();
      for (let i = 0; i < names.length; i += RESCAN_CHUNK) {
        if (i > 0) await new Promise<void>((done) => setImmediate(done));
        if (closed) return;
        for (const name of names.slice(i, i + RESCAN_CHUNK)) {
          if (!accepts(state.root, watchDir, name)) continue;
          seen.add(name);
          compareAndDeliver(watchDir, state, name);
        }
      }
      // Files listed before the read that the read did not see, in the same batches; one first recorded since
      // is newer than the read.
      const missing = known.filter((name) => !seen.has(name));
      for (let i = 0; i < missing.length; i += RESCAN_CHUNK) {
        await new Promise<void>((done) => setImmediate(done));
        if (closed) return;
        for (const name of missing.slice(i, i + RESCAN_CHUNK)) {
          if (state.listing.has(name)) compareAndDeliver(watchDir, state, name);
        }
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      state.scanning = false;
    }
    if (!closed && state.again) {
      state.again = false;
      armRescan(watchDir, state);
    }
  };

  // One rescan per directory, `debounceMs` after the first event; a later event does not push it back, so a busy
  // directory cannot starve it. An event during a rescan earns one more after it: the rescan may have read that
  // file before the change.
  const armRescan = (watchDir: string, state: WatchedDir) => {
    if (closed || state.timer) return;
    if (state.scanning) {
      state.again = true;
      return;
    }
    const timer = setTimeout(() => {
      rescans.delete(timer);
      state.timer = null;
      void rescan(watchDir, state);
    }, debounceMs);
    state.timer = timer;
    rescans.add(timer);
  };
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
      // Bun before 1.4.0 folds the events that reach one directory together into one callback per event type,
      // named after the first file: an atomic save (a temp file renamed over the target) arrives under the temp
      // file's name, a rename under the old name only, and the second of two files written back-to-back not at
      // all. So every event, whatever name it carries, also arms a rescan of its directory, which compares each
      // file the watcher acts on with the directory's listing and delivers what appeared, changed or disappeared.
      // Keyed by the resolved path: `/v/./notes` and `/v/notes` are one directory, as `join` already treats them.
      let state = watched.get(resolve(watchDir));
      if (!state) {
        state = { root: dir, listing: new Map(), listed: false, timer: null, scanning: false, again: false };
        watched.set(resolve(watchDir), state);
      }
      const dirState = state;
      try {
        const before = dirState.listed ? null : listWatchedFiles(dir, watchDir, null);
        // Non-recursive watch — each dir watched individually
        const watcher = watch(watchDir, (event, filename) => {
          if (closed) return;
          armRescan(watchDir, dirState);
          if (!filename) return;
          if (!watchesName(filename)) return;

          const relativeToDirRoot = relative(dir, join(watchDir, filename));
          if (shouldExclude(relativeToDirRoot)) return;

          schedule(join(watchDir, filename), event, recordAsDelivered(watchDir, dirState, filename));
        });
        watcher.on("error", (err) => {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        });
        watchers.push(watcher);
        if (!dirState.listed) {
          // Listed again now that the watch is live. A change between the two listings may have reached the
          // watch under another file's name, so it is delivered here; a later change reaches a rescan.
          const after = listWatchedFiles(dir, watchDir, before?.files ?? null);
          const initial = after ?? before;
          if (initial) for (const [name, stat] of initial.files) dirState.listing.set(name, stat);
          if (after) {
            for (const [name, event] of after.changes) {
              const fullPath = join(watchDir, name);
              if (!pending.has(fullPath)) schedule(fullPath, event, recordAsDelivered(watchDir, dirState, name));
            }
          }
          dirState.listed = true;
        }
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
      closed = true;
      for (const w of watchers) w.close();
      for (const t of rescans) clearTimeout(t);
      rescans.clear();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}
