/**
 * ClawMem File Watcher - fs.watch with debounce for incremental reindex
 *
 * Walks each directory tree at startup, skipping excluded dirs (gits/,
 * node_modules/, .git/, etc.), and watches only non-excluded directories.
 * This prevents inotify FD exhaustion on trees with large cloned repos.
 *
 * Every event also schedules a rescan of its directory (v0.40.2): the file
 * name an event carries is not reliable enough to act on alone. The rescan
 * also starts watching a subdirectory created since the watcher started,
 * and stops watching one that is gone (v0.40.3).
 */

import { watch, readdirSync, statSync, lstatSync, type Dirent, type Stats, type WatchEventType } from "fs";
import { readdir } from "fs/promises";
import { basename, dirname, join, relative, resolve } from "path";
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

/** Whether the walk enters a directory of this name: not an excluded name, and not `.`-prefixed. */
function walksInto(name: string): boolean {
  return !EXCLUDED_DIRS.has(name) && !(name.startsWith(".") && name !== ".");
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
      if (!walksInto(entry)) continue;

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

/**
 * A directory's identity: device, inode and birth time, following a symlink as the walk does. The inode alone does
 * not tell a directory from one deleted and made again at the same path (ext4 hands the inode straight back); the
 * birth time does. Null when the path is gone or is not a directory.
 */
function dirIdentity(path: string): string | null {
  let st: Stats;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  return `${st.dev}:${st.ino}:${st.birthtimeMs}`;
}

/** Whether `path` is itself a directory, not a symlink to one. */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
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

/** The registrations that take on a directory, and whether it is taken on as a collection path of its own. */
type Taking = { regs: Registration[]; collectionPath: boolean };

/**
 * One collection path passed to startWatcher. It counts the directories it watches against the cap, and watches
 * directories created after the start only if its startup walk fit under the cap: the directories the cap left
 * out at the start stay unwatched.
 */
type Registration = {
  dir: string;
  watching: number;
  adopts: boolean;
  warned: boolean;                // the at-cap warning for new directories is logged once
};

/**
 * One watched directory. Registrations whose collection paths overlap share it: a directory is only reached
 * through names neither walk excludes, so they agree on which of its files the watcher acts on.
 */
type WatchedDir = {
  key: string;                    // the resolved path
  path: string;                   // the path it was first watched under
  root: string;                   // the collection path it was first reached from
  id: string | null;              // `dirIdentity` when its watch started
  regs: Set<Registration>;        // the registrations that count it against their cap
  linked: Set<Registration>;      // those that reach it through a symlink below their collection path
  handles: ReturnType<typeof watch>[];
  children: Set<string>;          // keys of its watched subdirectories
  failed: Map<string, string | null>;   // subdirectory whose watch failed → its identity then (reported once)
  listing: Map<string, string>;   // file → `statOf` when last compared or delivered
  listed: boolean;                // the startup listing is taken
  timer: ReturnType<typeof setTimeout> | null;
  scanning: boolean;
  again: boolean;                 // an event arrived during the rescan: run one more when it ends
  retired: boolean;               // gone or replaced: no longer watched
};

export function startWatcher(
  directories: string[],
  options: WatcherOptions
): { close: () => void } {
  const { debounceMs = 2000, onChanged, onError } = options;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const rescans = new Set<ReturnType<typeof setTimeout>>();
  const watched = new Map<string, WatchedDir>();
  const watchers = new Set<ReturnType<typeof watch>>();
  const byRoot = new Map<string, Registration[]>();        // resolved collection path → its registrations
  let closed = false;
  const maxDirs = resolveMaxWatchDirs(process.env, (raw) =>
    console.log(`[watcher] WARNING: CLAWMEM_WATCH_MAX_DIRS=${JSON.stringify(raw)} is not a positive integer — using ${DEFAULT_MAX_WATCH_DIRS}`));

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

  // One fs.watch on `watchDir` for `state`, reached from the collection path `root`. Any event arms the
  // directory's rescan; one that names a file the watcher acts on is also scheduled on its own.
  const watchOne = (watchDir: string, root: string, state: WatchedDir) => {
    const watcher = watch(watchDir, (event, filename) => {
      if (closed || state.retired) return;
      armRescan(watchDir, state);
      if (!filename) return;
      if (!watchesName(filename)) return;

      const relativeToDirRoot = relative(root, join(watchDir, filename));
      if (shouldExclude(relativeToDirRoot)) return;

      schedule(join(watchDir, filename), event, recordAsDelivered(watchDir, state, filename));
    });
    watcher.on("error", (err) => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    });
    watchers.add(watcher);
    state.handles.push(watcher);
  };

  // Stop watching a directory that is gone or was replaced, and each watched directory under it. Every file a
  // listing holds is compared once more, so one that is gone is delivered as removed (unless its own timer is
  // pending); the watches close, and the directories stop counting against their registrations' caps. Returns, for
  // each retired directory, the registrations that counted it: a replacement re-watches, path by path, what each held.
  const retire = (top: WatchedDir): Map<string, Set<Registration>> => {
    const counted = new Map<string, Set<Registration>>();
    const states: WatchedDir[] = [];
    const stack = [top];
    while (stack.length > 0) {
      const state = stack.pop()!;
      if (state.retired) continue;
      state.retired = true;
      states.push(state);
      for (const key of state.children) {
        const child = watched.get(key);
        if (child) stack.push(child);
      }
    }
    for (const state of states) {
      for (const name of [...state.listing.keys()]) compareAndDeliver(state.path, state, name);
      for (const handle of state.handles) {
        try {
          handle.close();
        } catch {
          // already closed
        }
        watchers.delete(handle);
      }
      state.handles = [];
      if (state.timer) {
        clearTimeout(state.timer);
        rescans.delete(state.timer);
        state.timer = null;
      }
      if (watched.get(state.key) === state) watched.delete(state.key);
      watched.get(dirname(state.key))?.children.delete(state.key);
      for (const reg of state.regs) reg.watching--;
      counted.set(state.key, new Set(state.regs));
      state.regs.clear();
    }
    return counted;
  };

  // The registrations that watch directory `path` (key `key`, a child of `parent`) from now on, when it is new or has
  // taken the place of one they watched (`watchedBefore`: for a replacement, the registrations that watched each path
  // of the retired tree). A registration takes it on only if it adopts new directories or watched this same path
  // before (so a registration over the cap at the start never picks up a directory its startup walk left out), and
  // only if the index pass would reach what it holds: a symlink only when it is the registration's own collection path (the pass scans from a collection path
  // through a symlink, but never follows one below it); a real directory when it is the registration's collection
  // path, or the registration watches the parent other than through a symlink.
  const takersOf = (
    parent: WatchedDir | undefined, key: string, path: string, watchedBefore: ReadonlyMap<string, ReadonlySet<Registration>>,
  ): Taking => {
    const own = byRoot.get(key) ?? [];
    const before = watchedBefore.get(key) ?? new Set<Registration>();
    const wanted = (reg: Registration) => reg.adopts || before.has(reg);
    if (isSymlink(path)) return { regs: own.filter(wanted), collectionPath: true };
    const reaches = (reg: Registration) =>
      own.includes(reg) || (parent !== undefined && parent.regs.has(reg) && !parent.linked.has(reg));
    const regs = new Set<Registration>();
    for (const reg of [...(parent?.regs ?? []), ...own, ...before]) if (wanted(reg) && reaches(reg)) regs.add(reg);
    return { regs: [...regs], collectionPath: false };
  };

  // Watch a directory that appeared after the watcher started, and each directory under it the walk would enter,
  // breadth-first. Every directory is decided on its own (`takersOf`), so a collection path nested in a new tree is
  // taken on for its own collection even when the outer one is at its cap, and a symlink is followed only when it is a
  // collection path itself. Each directory is watched before it is listed, so a file or directory made in between
  // reaches the listing or the watch, and each file the watcher acts on that it already holds is delivered as new.
  // Like a rescan, it yields to the event loop every RESCAN_CHUNK entries. A directory counts against the cap of each
  // registration that takes it on and has room; one no such registration has room for is skipped with its subtree
  // (one warning per registration). Returns how many directories it watched.
  const adopt = async (
    top: string, root: string, parent: WatchedDir | undefined, watchedBefore: ReadonlyMap<string, ReadonlySet<Registration>>,
  ): Promise<number> => {
    const queue: { path: string; above: WatchedDir | undefined; root: string }[] = [{ path: top, above: parent, root }];
    const seen = new Set<string>();            // exclusion root + identity this call watched: a bind-mount loop ends here
    let added = 0;
    let work = 0;
    const breathe = async (entries: number) => {
      work += entries;
      if (work < RESCAN_CHUNK) return;
      work = 0;
      await new Promise<void>((done) => setImmediate(done));
    };
    while (queue.length > 0) {
      const item = queue.shift()!;
      await breathe(1);
      if (closed) break;
      if (item.above?.retired) continue;       // its parent went away while this call yielded
      const path = item.path;
      const key = resolve(path);
      if (watched.has(key)) continue;
      const taking = takersOf(item.above, key, path, watchedBefore);
      if (taking.regs.length === 0) continue;
      if (!taking.collectionPath && !isRealDirectory(path)) continue;
      const exclusionRoot = taking.collectionPath ? path : item.root;
      const id = dirIdentity(path);
      if (id === null || seen.has(`${exclusionRoot}\0${id}`)) continue;
      const counting = taking.regs.filter((reg) => reg.watching < maxDirs);
      if (counting.length === 0) {
        for (const reg of taking.regs) {
          if (reg.warned) continue;
          reg.warned = true;
          console.log(`[watcher] WARNING: ${reg.dir} is at its cap of ${maxDirs} watched dirs — ${path} is not watched, nor is any other directory made while it stays at the cap; changes there wait for the next full index pass (clawmem update). Raise the cap with CLAWMEM_WATCH_MAX_DIRS, or narrow the collection path.`);
        }
        continue;
      }
      seen.add(`${exclusionRoot}\0${id}`);
      const state: WatchedDir = {
        key, path, root: exclusionRoot, id, regs: new Set(counting), linked: new Set(), handles: [], children: new Set(),
        failed: new Map(), listing: new Map(), listed: false, timer: null, scanning: false, again: false, retired: false,
      };
      const name = basename(key);
      try {
        watchOne(path, exclusionRoot, state);
      } catch (err) {
        // Not watchable now (its permissions, the kernel's watch limit, or gone again): tried again at its parent's
        // next rescan, and reported once per directory identity.
        if (!isGone(err) && item.above?.failed.get(name) !== id) {
          onError?.(err instanceof Error ? err : new Error(`Failed to watch ${path}: ${err}`));
        }
        item.above?.failed.set(name, id);
        continue;
      }
      item.above?.failed.delete(name);
      watched.set(key, state);
      item.above?.children.add(key);
      for (const reg of counting) reg.watching++;
      added++;
      let entries: Dirent[];
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        entries = [];                          // gone again: its parent's next rescan stops watching it
      }
      for (let i = 0; i < entries.length && !closed && !state.retired; i += RESCAN_CHUNK) {
        const chunk = entries.slice(i, i + RESCAN_CHUNK);
        for (const entry of chunk) {
          // A file not in the (new, empty) listing is delivered as appeared; one a rescan delivered meanwhile is not
          // delivered again.
          if (accepts(exclusionRoot, path, entry.name)) compareAndDeliver(path, state, entry.name);
          if (walksInto(entry.name) && !entry.isFile()) queue.push({ path: join(path, entry.name), above: state, root: exclusionRoot });
        }
        await breathe(chunk.length);
      }
      state.listed = true;
    }
    return added;
  };

  const adoptAndLog = async (
    path: string, root: string, parent: WatchedDir | undefined,
    watchedBefore: ReadonlyMap<string, ReadonlySet<Registration>>, replaced: boolean,
  ) => {
    const added = await adopt(path, root, parent, watchedBefore);
    if (added > 0) {
      console.log(`[watcher] ${replaced ? "replaced" : "new"} directory ${path}: watching ${added} dir${added === 1 ? "" : "s"}`);
    }
  };

  // A subdirectory a rescan read: watched from now on if it is new, and watched anew if another directory took its
  // path (the old watch sees nothing more). Recorded in `present` when it is a directory.
  const lookAtSubdir = async (state: WatchedDir, watchDir: string, entry: Dirent, present: Set<string>) => {
    const path = join(watchDir, entry.name);
    const key = resolve(path);
    const id = dirIdentity(path);              // follows a symlink, as the startup walk does
    if (id === null) {                         // a file, a symlink to one, or gone
      state.failed.delete(entry.name);
      return;
    }
    present.add(key);
    const known = watched.get(key);
    if (known) {
      state.children.add(key);
      if (known.id === id) return;
      const watchedBefore = retire(known);
      await adoptAndLog(known.path, known.root, state, watchedBefore, true);
      return;
    }
    // New (a symlink is taken on only as a collection path of its own; the startup walk still watches one that is
    // there at the start).
    await adoptAndLog(path, state.root, state, new Map(), false);
  };

  const rescan = async (watchDir: string, state: WatchedDir) => {
    state.scanning = true;
    try {
      // The directory itself first. Gone, or taken over by another directory at its path (whose inode may be the old
      // one's), its watch sees nothing more: stop watching it and what lies under it, and watch a new one anew.
      const id = dirIdentity(watchDir);
      if (id !== state.id) {
        const parent = watched.get(dirname(state.key));
        const watchedBefore = retire(state);
        if (id !== null) await adoptAndLog(state.path, state.root, parent, watchedBefore, true);
        return;
      }
      const known = [...state.listing.keys()];
      const children = [...state.children].flatMap((key) => watched.get(key) ?? []);
      let entries: Dirent[];
      try {
        entries = await readdir(watchDir, { withFileTypes: true });
      } catch (err) {
        if (!isGone(err)) return;      // unreadable for now: the next event rescans it
        entries = [];
      }
      const seen = new Set<string>();
      const present = new Set<string>();
      for (let i = 0; i < entries.length; i += RESCAN_CHUNK) {
        if (i > 0) await new Promise<void>((done) => setImmediate(done));
        if (closed || state.retired) return;
        for (const entry of entries.slice(i, i + RESCAN_CHUNK)) {
          const name = entry.name;
          if (accepts(state.root, watchDir, name)) {
            seen.add(name);
            compareAndDeliver(watchDir, state, name);
          }
          if (walksInto(name) && !entry.isFile()) {
            await lookAtSubdir(state, watchDir, entry, present);
            if (closed || state.retired) return;
          }
        }
      }
      // Files listed before the read that the read did not see, in the same batches; one first recorded since
      // is newer than the read.
      const missing = known.filter((name) => !seen.has(name));
      for (let i = 0; i < missing.length; i += RESCAN_CHUNK) {
        await new Promise<void>((done) => setImmediate(done));
        if (closed || state.retired) return;
        for (const name of missing.slice(i, i + RESCAN_CHUNK)) {
          if (state.listing.has(name)) compareAndDeliver(watchDir, state, name);
        }
      }
      // A failed watch is remembered only while its directory is there.
      if (state.failed.size > 0) {
        const read = new Set(entries.map((entry) => entry.name));
        for (const name of [...state.failed.keys()]) if (!read.has(name)) state.failed.delete(name);
      }
      // Watched subdirectories the read did not see are gone. One watched since the read (a new directory that took
      // a gone one's path) is newer than the read, so only the states watched before it are retired here.
      for (const child of children) {
        if (present.has(child.key) || child.retired || watched.get(child.key) !== child) continue;
        retire(child);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      state.scanning = false;
    }
    if (!closed && !state.retired && state.again) {
      state.again = false;
      armRescan(watchDir, state);
    }
  };

  // One rescan per directory, `debounceMs` after the first event; a later event does not push it back, so a busy
  // directory cannot starve it. An event during a rescan earns one more after it: the rescan may have read that
  // file before the change.
  const armRescan = (watchDir: string, state: WatchedDir) => {
    if (closed || state.retired || state.timer) return;
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

  for (const dir of directories) {
    const reg: Registration = { dir, watching: 0, adopts: true, warned: false };
    const rootKey = resolve(dir);
    byRoot.set(rootKey, [...(byRoot.get(rootKey) ?? []), reg]);

    // Walk the tree, skipping excluded dirs — watch each non-excluded dir individually
    const watchableDirs = walkNonExcludedDirs(dir);

    // Cap the dirs one collection path watches (CLAWMEM_WATCH_MAX_DIRS, default 500). Dirs past the cap
    // go unwatched: a change there waits for the collection's next full index pass. Such a collection path
    // watches no directory created later either.
    if (watchableDirs.length > maxDirs) {
      console.log(`[watcher] WARNING: ${dir} has ${watchableDirs.length} dirs — watching the first ${maxDirs}; changes in the others wait for the next full index pass (clawmem update). Raise the cap with CLAWMEM_WATCH_MAX_DIRS, or narrow the collection path.`);
      watchableDirs.length = maxDirs;
      reg.adopts = false;
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
      const key = resolve(watchDir);
      let state = watched.get(key);
      if (!state) {
        state = {
          key, path: watchDir, root: dir, id: dirIdentity(watchDir), regs: new Set(), linked: new Set(), handles: [],
          children: new Set(), failed: new Map(), listing: new Map(), listed: false, timer: null, scanning: false,
          again: false, retired: false,
        };
        watched.set(key, state);
      }
      const dirState = state;
      try {
        const before = dirState.listed ? null : listWatchedFiles(dir, watchDir, null);
        // Non-recursive watch — each dir watched individually
        watchOne(watchDir, dir, dirState);
        dirState.regs.add(reg);
        reg.watching++;
        // Reached through a symlink below this collection path (the walk follows symlinks; the index pass does not)?
        if (key !== rootKey && (isSymlink(watchDir) || watched.get(dirname(key))?.linked.has(reg))) dirState.linked.add(reg);
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
        // Individual dir watch failure is non-fatal — skip it. Untracked unless another collection path watches
        // it, so its parent's rescan tries it again, and reports it only as another directory (a new identity).
        if (dirState.handles.length === 0) watched.delete(key);
        watched.get(dirname(key))?.failed.set(basename(key), dirIdentity(watchDir));
        if (onError) {
          onError(err instanceof Error ? err : new Error(`Failed to watch ${watchDir}: ${err}`));
        }
      }
    }
  }

  // Link each watched directory to its watched parent: the parent's rescan stops watching a child that is gone.
  for (const state of watched.values()) {
    const parent = watched.get(dirname(state.key));
    if (parent && parent !== state) parent.children.add(state.key);
  }

  return {
    close: () => {
      closed = true;
      for (const w of watchers) w.close();
      watchers.clear();
      for (const t of rescans) clearTimeout(t);
      rescans.clear();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}
