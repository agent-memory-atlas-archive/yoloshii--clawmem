/**
 * Vector-query daemon (BACKLOG Source 46) — HARD cap on the cold synchronous sqlite-vec MATCH.
 *
 * The context-surfacing UserPromptSubmit hook runs a SYNCHRONOUS sqlite-vec MATCH (searchVecMatch).
 * bun:sqlite exposes no interrupt/progress handler, so a cold scan on a large vault blocks the hook's
 * single event loop past its 8-15s budget — an in-thread `Promise.race(vectorTimeout)` cannot fire
 * while a synchronous call runs. This daemon relocates the MATCH — and, since v0.38's hydrated-v1
 * protocol (codex #28 t83–t88), the hydration + snippet PROJECTION too — onto the long-lived
 * watcher process: the hook sends the query + presentation inputs over a per-vault unix socket and
 * races the reply against a REAL setTimeout (its own event loop stays free); the daemon answers with
 * fully projected results, so the hook performs ZERO synchronous sqlite inside its vector deadline.
 * Client-side hydration survives only as the raw-hit COMPATIBILITY path (a legacy daemon answering
 * raw hits to a hydrated request, or a request that never asked for hydration).
 *
 * The daemon is a strict OPTIMIZATION LAYER, never a dependency:
 *   - daemon absent/refused  → the hook uses the in-process searchVec path UNCHANGED (today's behavior;
 *                              users who don't run the watcher lose nothing).
 *   - daemon busy/error/timeout → the hook returns [] and falls back to FTS (it must NOT re-run the scan
 *                              in-process, which would reintroduce the very block this exists to avoid).
 *
 * Design record: BACKLOG.md Source 46 "DESIGN-gate outcome + build contract" (2026-07-05, codex-cleared).
 */

import { existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Socket } from "bun";
import { searchVecMatch, hydrateVecResults, projectVecResults, HydratedBodyOversizedError, VecReadModelMismatchError, type Store, type SearchResult, type ProjectedVecResult } from "./store.ts";
import type { LegacyWallDeadline } from "./clock-legacy.ts";
import { HYDRATED_PROTOCOL, HYDRATED_MAX_RESULTS, HYDRATED_MAX_ENTRY_BYTES, HYDRATED_MAX_FRAME_BYTES, HYDRATED_MAX_SOURCE_BODY_BYTES, HYDRATED_SNIPPET_LENS, HYDRATED_RERANK_TEXT_LEN, HYDRATED_GATE_TEXT_LEN } from "./vector-protocol.ts";

// Newline-delimited JSON, one request/response per connection. A query string and a list of
// {hash_seq, distance} are both small; anything over this cap is a protocol violation, so both sides
// reject it rather than buffer unbounded on a runaway/hostile peer.
const MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_IPC_TIMEOUT_MS = 5000;
// A stray/hostile `limit` (same-user socket) must not become an unbounded `k = limit * 3` scan. The
// hook only ever asks for ~5-10; clamp anything outside a sane range.
const MAX_VEC_LIMIT = 500;

/** Per-connection server reader state — RAW BYTES (t87 F3): the cap is enforced on received
 * UTF-8 bytes, the newline is located at the byte level, and each complete line is decoded with
 * a FATAL TextDecoder — a code point split across socket chunks can never corrupt, and invalid
 * UTF-8 is refused (`bad_request`), never U+FFFD-substituted into query text. */
type DaemonSocketData = { pending: Uint8Array; total: number };

/** Decode one complete line strictly; null = invalid UTF-8 (fail-closed, t87 CR-6). */
function decodeLineStrict(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

// Env-gated phase timing (CLAWMEM_VEC_TIMING=1): logs each hook vector leg's outcome + elapsed to
// stderr so a future `UserPromptSubmit hook timed out` is attributable — daemon engaged & fast, vs
// daemon-absent in-process fallback (the old slow path), vs daemon busy/error → FTS. Off by default.
const VEC_TIMING = process.env.CLAWMEM_VEC_TIMING === "1" || process.env.CLAWMEM_VEC_TIMING === "true";

type VecHit = { hash_seq: string; distance: number };
type VecReq = {
  query: string; model: string; limit: number; deadlineMs?: LegacyWallDeadline;
  // hydrated-v1 (codex #28 t83–t88, projection-complete daemon hydration). A request carrying
  // `responseProtocol` asks the daemon to hydrate + project server-side and answer with the
  // multi-line hydrated response (header + n entry lines + end line). The projection params are
  // an ATTESTATION of the exact protocol constants — the daemon validates them EXACTLY and
  // refuses anything else as `bad_request` (t87 F1), so a version-skewed peer fails loudly
  // instead of computing a divergent projection. An old daemon ignores the unknown fields and
  // answers raw hits — the client detects that shape and falls back to client-side hydration
  // (the "raw-hit" path of the t84 negotiation matrix).
  responseProtocol?: string;
  /** The RAW CURRENT PROMPT — snippet construction input on EVERY leg (t87 F4: the prior leg
   * searches with joined priors and deep legs with expansion variants, but buildContext always
   * extracts snippets against the current prompt + session topic). */
  presentationQuery?: string;
  /** The resolved session topic (buildContext's intent input). */
  intent?: string;
  snippetLens?: number[];
  rerankTextLen?: number;
  gateTextLen?: number;
  collectionId?: number;
  collections?: string[];
  dateRange?: { start: string; end: string };
};
type VecResp =
  | { results: VecHit[] }
  | { error: string; storedModels?: string[]; activeModel?: string }
  // Readiness/identity probe answer (eval daemon child, codex t76 constraint 3): the exact DB path
  // this daemon serves and the pid that owns the socket — a parent verifies both before trusting.
  // `protocols` (v0.38 hydrated daemon) advertises the response protocols this daemon can serve —
  // the watcher-preflight capability attestation (t84: only a `live` daemon attesting hydrated-v1
  // makes a daemon-required run authoritative; old clients ignore the extra field).
  | { pong: true; db: string; pid: number; protocols?: string[] }
  // Hydrated response lines (each is its own newline-delimited frame):
  | { protocol: typeof HYDRATED_PROTOCOL; count: number }
  | { entry: ProjectedVecResult }
  | { end: true };

/** Classified outcome of one daemon-routed vector leg — recorded per leg in the surfacing trace.
 * `oversized` (t84/t87): the daemon refused hydrated projection on a size cap (source-body ceiling,
 * entry cap, or frame cap) — the hook falls back to FTS with the vector candidates LOST for the
 * turn; traced distinctly from generic `error` so the degradation is attributable. */
export type VecExecStatus = "ok" | "busy" | "error" | "absent" | "model_mismatch" | "oversized";

/** Which response protocol actually served an `ok` leg (run-identity input, t84 CR-5/t85):
 * "hydrated-v1" = daemon-side projection; "raw-hit" = raw VecHit list + client-side hydration
 * (legacy daemon, or a request that never asked for hydration). */
export type VecResponseProtocol = typeof HYDRATED_PROTOCOL | "raw-hit";

/**
 * Strict structural validation of one hydrated entry (t89 S1): the wire is a same-user
 * socket, but a half-written peer, a version skew, or a corrupted frame must degrade to
 * FTS — never flow a malformed object into the hook's consumer branches as if it were a
 * projection. Every field the five consumer sites read is checked.
 */
export function isValidProjectedEntry(e: unknown): e is ProjectedVecResult {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return r.projected === true
    && typeof r.filepath === "string" && typeof r.displayPath === "string" && typeof r.title === "string"
    && typeof r.hash === "string" && typeof r.docid === "string" && typeof r.collectionName === "string"
    && typeof r.modifiedAt === "string"
    && typeof r.bodyLength === "number" && Number.isInteger(r.bodyLength) && r.bodyLength >= 0
    && typeof r.score === "number" && Number.isFinite(r.score)
    && r.source === "vec"
    && (r.chunkPos === undefined || (typeof r.chunkPos === "number" && Number.isFinite(r.chunkPos)))
    && (r.fragmentType === undefined || typeof r.fragmentType === "string")
    && (r.fragmentLabel === undefined || typeof r.fragmentLabel === "string")
    && (r.context === null || typeof r.context === "string")
    && !!r.snippets && typeof r.snippets === "object" && !Array.isArray(r.snippets)
    && HYDRATED_SNIPPET_LENS.every(l => typeof (r.snippets as Record<number, unknown>)[l] === "string")
    && typeof r.rerankText === "string"
    && typeof r.noise === "boolean" && typeof r.hasBody === "boolean" && typeof r.sanitizeFiltered === "boolean"
    && Array.isArray(r.gateTokens) && (r.gateTokens as unknown[]).every(t => typeof t === "string");
}

/** Strict shape check for one raw VecHit (t89 S1) — a malformed hit list degrades to FTS. */
export function isValidVecHit(h: unknown): h is VecHit {
  if (!h || typeof h !== "object") return false;
  const r = h as Record<string, unknown>;
  return typeof r.hash_seq === "string" && typeof r.distance === "number" && Number.isFinite(r.distance);
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS): a SYNCHRONOUS busy-wait standing in for
 * the duration of the blocking sqlite-vec MATCH, applied wherever that scan would run — the eval
 * daemon child's scan and the in-process fallback below — so the CR-3 production-boundary test can
 * make the scan deterministically exceed a profile timeout in EITHER topology and prove that only
 * the daemon-backed one returns within budget. A no-op unless the env is set to a positive number.
 */
export function testSyncScanDelay(): void {
  const raw = process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = Date.now() + ms;
  while (Date.now() < until) { /* synchronous — the caller's race timer cannot fire, by design */ }
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_HYDRATE_SYNC_DELAY_MS): a SYNCHRONOUS busy-wait standing in for
 * a cold hydration first-touch. Under hydrated-v1 (the primary path) it runs inside the DAEMON's
 * projection — modeling a cold sqlite first-touch there so the CR-3 locks can prove the CLIENT's
 * deadline timer wins while the daemon is mid-projection. On the raw-hit COMPAT path it runs before
 * the client-side hydrate — the pre-v0.38 shape whose synchronous client hydration produced the
 * observed 1235/2906/3130ms late-`ok` daemon-required legs (codex t80 P1).
 */
export function testSyncHydrateDelay(): void {
  const raw = process.env.CLAWMEM_TEST_VEC_HYDRATE_SYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = Date.now() + ms;
  while (Date.now() < until) { /* synchronous — models a cold hydration first-touch (daemon-side projection under hydrated-v1; client-side hydrate on the raw-hit compat path) */ }
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_ENTRY_DECODE_SYNC_DELAY_MS): a SYNCHRONOUS busy-wait injected
 * before ONE hydrated entry line's JSON.parse — the t88 lock-(b) shape: a synchronous intra-entry
 * decode stall must NEVER produce a late `ok` (the per-entry before/after absolute-deadline checks
 * reclassify to error → FTS), and when its measured overrun exceeds the tolerance the independent
 * hard vector_deadline_ok gate FAILS the member. Not deadline-adherent by design — the protocol's
 * 64 KiB per-line bound is what makes a REAL parse slice sub-ms.
 */
export function testSyncEntryDecodeDelay(): void {
  const raw = process.env.CLAWMEM_TEST_VEC_ENTRY_DECODE_SYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = Date.now() + ms;
  while (Date.now() < until) { /* synchronous — models a pathologically slow single-line decode */ }
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_INTER_ENTRY_ASYNC_DELAY_MS): an AWAITED delay between hydrated
 * entry parses — the t88 lock-(a) shape: an inter-entry stall yields the event loop, so the IPC
 * deadline timer WINS within tolerance and the remaining entries are never parsed (decode
 * cancelled mid-stream).
 */
export async function testInterEntryAsyncDelay(): Promise<void> {
  const raw = process.env.CLAWMEM_TEST_VEC_INTER_ENTRY_ASYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise<void>(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket path — shared by daemon + hook client, keyed per vault DB path
// ─────────────────────────────────────────────────────────────────────────────

/** Parent dir for all clawmem daemon sockets ($XDG_RUNTIME_DIR/clawmem, fallback tmpdir). */
export function vecDaemonSocketDir(): string {
  const base = process.env.XDG_RUNTIME_DIR || tmpdir();
  return join(base, "clawmem");
}

/**
 * Per-vault socket path, keyed by a short hash of the vault DB path so multiple vaults
 * (general/work/personal) never collide on one socket. The daemon and the hook client both derive
 * the SAME path from the SAME `store.dbPath`, so they rendezvous without any shared registry.
 */
/**
 * Cheap PRE-CHECK heuristic: a daemon socket file exists for this vault.
 * This is an optimization to skip supplementary legs fast when no daemon was
 * ever started — it is NOT the correctness guard. A stale socket file passes
 * this check, so callers that must never run the in-process synchronous MATCH
 * (the hook's prior-turns leg, BUILD-1) route through searchVecDaemonRequired,
 * whose refused/absent outcome returns [] instead of falling back in-process
 * (codex turn-7 STANDARDS-1).
 */
export function vectorDaemonLikelyAvailable(dbPath: string): boolean {
  try {
    return existsSync(vecDaemonSocketPath(dbPath));
  } catch {
    return false;
  }
}

export function vecDaemonSocketPath(dbPath: string): string {
  const key = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  return join(vecDaemonSocketDir(), `vec-${key}.sock`);
}

/** Brief liveness probe: true if a listener accepts a connection on `sockPath`, false if refused/timeout. */
function isSocketAlive(sockPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish(false), 250);
    Bun.connect<undefined>({
      unix: sockPath,
      socket: {
        // Resolve BEFORE ending the probe connection: end() can dispatch `close`
        // synchronously, and a close-first settle would report a LIVE daemon as
        // dead — whereupon the caller unlinks its socket and strands it.
        open(s) { finish(true); try { s.end(); } catch { /* ignore */ } },
        // Bun REQUIRES a data (or drain) handler: without one Bun.connect throws
        // synchronously ("Expected at least data or drain callback"), which the
        // caller's try/catch turned into "socket dir prep failed" — so any STALE
        // socket file silently prevented the watcher's daemon from ever binding
        // (codex t76 arc; caught by the eval child's foreign-daemon refusal test).
        data() { /* the probe sends nothing and reads nothing */ },
        close() { finish(false); },
        connectError() { finish(false); },
        error() { finish(false); },
      },
    }).catch(() => finish(false));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon (server) — hosted in the long-lived watcher (cmdWatch)
// ─────────────────────────────────────────────────────────────────────────────

export type VectorDaemonHandle = { close: () => void };

/**
 * Start the vector-query daemon on `store`'s DB. Returns a handle whose close() stops the listener and
 * unlinks the socket, or null if the socket could not be bound (best-effort — the hook's in-process
 * fallback still works, so a bind failure degrades to today's behavior, it never breaks the hook).
 *
 * SINGLE-FLIGHT: at most one MATCH runs at a time per vault. A request arriving while a scan is in
 * flight gets {error:"busy"} immediately (→ hook falls to FTS), never queues — this is what stops
 * abandoned cold scans from serializing and starving the watcher. Paired with a deadline check on
 * receipt: a request whose deadline already elapsed is rejected WITHOUT scanning, so requests that
 * piled up behind a cold-scan freeze are dropped (their hooks already gave up) instead of each
 * triggering a fresh wasted scan.
 */
export async function startVectorDaemon(
  store: Store,
  log: (msg: string) => void = () => {},
  // The Step-1 scan is injectable so tests can exercise the socket/single-flight/framing logic without
  // a live embedding server. Production omits it → the real searchVecMatch on the watcher's warm store.
  scan: (query: string, model: string, limit: number, deadlineMs?: LegacyWallDeadline) => Promise<VecHit[]> =
    (query, model, limit, deadlineMs) => searchVecMatch(store.db, query, model, limit, deadlineMs),
): Promise<VectorDaemonHandle | null> {
  const sockPath = vecDaemonSocketPath(store.dbPath);
  try {
    // 0700 dir is the real access control (UnixSocketOptions has no `mode` field); the socket chmod
    // below is defense-in-depth. mkdir's `mode` only applies on CREATE, so chmod an existing dir too.
    mkdirSync(vecDaemonSocketDir(), { recursive: true, mode: 0o700 });
    try { chmodSync(vecDaemonSocketDir(), 0o700); } catch { /* best-effort */ }
    if (existsSync(sockPath)) {
      // A socket file already exists. If a LIVE daemon (another watcher for this vault) owns it, do NOT
      // clobber it — unlinking a live socket only makes the old listener unreachable-by-path while it
      // keeps running, stranding it. Probe first: bind only over a stale (dead) socket.
      if (await isSocketAlive(sockPath)) {
        log(`[vec-daemon] a live daemon already owns ${sockPath}; not starting a second`);
        return { close() { /* not ours — nothing to stop or unlink */ } };
      }
      rmSync(sockPath, { force: true }); // stale socket from a crashed watcher
    }
  } catch (e) {
    log(`[vec-daemon] socket dir prep failed: ${(e as Error).message}`);
    return null;
  }

  let scanInFlight = false;

  const respond = (socket: Socket<DaemonSocketData>, resp: VecResp) => {
    try {
      socket.write(JSON.stringify(resp) + "\n");
      socket.end();
    } catch { /* peer already gone — nothing to send */ }
  };

  /**
   * Hydrated multi-line response (t86): header + n entry lines + end line, each its own
   * newline-delimited JSON frame. Every entry is serialized INDIVIDUALLY and byte-accounted
   * (UTF-8 via TextEncoder) BEFORE anything is written: an entry over HYDRATED_MAX_ENTRY_BYTES
   * or a cumulative total over HYDRATED_MAX_FRAME_BYTES aborts to a single `oversized` frame —
   * never a partial response. Per-entry bounding is what makes the client's per-line parse a
   * bounded synchronous slice (t87 F2).
   */
  const respondHydrated = (socket: Socket<DaemonSocketData>, results: ProjectedVecResult[]) => {
    const enc = new TextEncoder();
    const header = JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: results.length });
    const endLine = JSON.stringify({ end: true });
    let total = enc.encode(header).length + 1 + enc.encode(endLine).length + 1;
    const entryLines: string[] = [];
    for (const r of results) {
      const line = JSON.stringify({ entry: r });
      const bytes = enc.encode(line).length + 1;
      if (bytes > HYDRATED_MAX_ENTRY_BYTES || total + bytes > HYDRATED_MAX_FRAME_BYTES) {
        respond(socket, { error: "oversized" });
        return;
      }
      total += bytes;
      entryLines.push(line);
    }
    try {
      socket.write(header + "\n" + entryLines.map(l => l + "\n").join("") + endLine + "\n");
      socket.end();
    } catch { /* peer already gone */ }
  };

  const handleRequest = async (socket: Socket<DaemonSocketData>, line: string) => {
    let req: VecReq;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown> | null;
      // Ping: answered WITHOUT scanning and outside single-flight — a readiness/identity probe must
      // not be starved by an in-flight cold scan, and it must name the process + DB behind the socket.
      // `protocols` is the capability attestation (t84): this daemon serves hydrated-v1.
      if (parsed && typeof parsed === "object" && parsed.ping === true) {
        respond(socket, { pong: true, db: store.dbPath, pid: process.pid, protocols: [HYDRATED_PROTOCOL] });
        return;
      }
      req = parsed as VecReq /* O1-DEBT-0007 */;
      // t90 S1: deadlineMs is a CONTROL field — a string/NaN/Infinity would bypass both
      // expiry comparisons and defeat the daemon's deadline contract; validate it on EVERY
      // request (raw and hydrated) before anything else can consult it.
      if (!req || typeof req.query !== "string" || typeof req.model !== "string" || typeof req.limit !== "number" || !Number.isFinite(req.limit)
        || (req.deadlineMs !== undefined && !(typeof req.deadlineMs === "number" && Number.isFinite(req.deadlineMs)))) {
        throw new Error("bad request shape");
      }
    } catch {
      respond(socket, { error: "malformed" });
      return;
    }
    // hydrated-v1 exact-constant validation (t87 F1): the request's projection params must equal
    // the protocol constants EXACTLY — never compute "what was asked" for arbitrary integers.
    const hydrated = req.responseProtocol !== undefined;
    if (hydrated && (
      req.responseProtocol !== HYDRATED_PROTOCOL
      || typeof req.presentationQuery !== "string"
      || JSON.stringify(req.snippetLens) !== JSON.stringify([...HYDRATED_SNIPPET_LENS])
      || req.rerankTextLen !== HYDRATED_RERANK_TEXT_LEN
      || req.gateTextLen !== HYDRATED_GATE_TEXT_LEN
      // t89 P3: hydrated-v1 REFUSES an out-of-contract limit — a non-integer or
      // out-of-range value is version/config skew, never a value to silently
      // clamp into a different candidate-count contract.
      || !Number.isInteger(req.limit) || req.limit < 1 || req.limit > HYDRATED_MAX_RESULTS
      // t89 S1: structural validation of the optional projection inputs — a
      // malformed shape must never reach the scan or the projection.
      || (req.intent !== undefined && typeof req.intent !== "string")
      || (req.collectionId !== undefined && !(typeof req.collectionId === "number" && Number.isFinite(req.collectionId)))
      || (req.collections !== undefined && !(Array.isArray(req.collections) && req.collections.every(c => typeof c === "string")))
      || (req.dateRange !== undefined && !(req.dateRange !== null && typeof req.dateRange === "object" && typeof req.dateRange.start === "string" && typeof req.dateRange.end === "string"))
    )) {
      respond(socket, { error: "bad_request" });
      return;
    }
    // Deadline-on-receipt: drop already-expired requests without scanning (the pile-up guard).
    if (req.deadlineMs !== undefined && Date.now() >= req.deadlineMs) {
      respond(socket, { error: "expired" });
      return;
    }
    if (scanInFlight) {
      respond(socket, { error: "busy" });
      return;
    }
    // Hydrated limits were validated EXACTLY above (t89 P3); only legacy raw requests keep the
    // compatibility clamp (a stray/hostile value must not drive an unbounded k = limit*3 scan).
    const safeLimit = hydrated ? req.limit : Math.min(Math.max(1, Math.trunc(req.limit)), MAX_VEC_LIMIT);
    scanInFlight = true;
    try {
      const results = await scan(req.query, req.model, safeLimit, req.deadlineMs);
      // t89 P4: a scan that finished past the client's absolute deadline must not proceed into
      // projection — the hook already fell back to FTS; answering `expired` releases single-flight
      // for the next request without touching a single body.
      if (req.deadlineMs !== undefined && Date.now() >= req.deadlineMs) {
        respond(socket, { error: "expired" });
        return;
      }
      if (hydrated) {
        // The projection compute is the daemon-side analogue of the old client hydrate — the
        // test seam models a cold first-touch here so the CR-3 locks can prove the CLIENT's
        // IPC timer wins at its deadline while the daemon is mid-projection (t86).
        testSyncHydrateDelay();
        const projected = projectVecResults(store.db, results, {
          limit: safeLimit,
          presentationQuery: req.presentationQuery!,
          intent: req.intent,
          snippetLens: [...HYDRATED_SNIPPET_LENS],
          rerankTextLen: HYDRATED_RERANK_TEXT_LEN,
          gateTextLen: HYDRATED_GATE_TEXT_LEN,
          maxSourceBodyBytes: HYDRATED_MAX_SOURCE_BODY_BYTES,
          collectionId: req.collectionId,
          collections: req.collections,
          dateRange: req.dateRange,
        });
        respondHydrated(socket, projected);
      } else {
        respond(socket, { results });
      }
    } catch (e) {
      // Preserve the v0.18 read-model-mismatch "warn loudly once" contract across the wire: return a
      // TYPED error the client reconstructs into VecReadModelMismatchError so the hook's
      // warnOnceOnVectorModelMismatch (an instanceof check) still fires. Other errors stay generic.
      if (e instanceof VecReadModelMismatchError) {
        respond(socket, { error: "read_model_mismatch", storedModels: e.storedModels, activeModel: e.activeModel });
      } else if (e instanceof HydratedBodyOversizedError) {
        // t87 F1: a selected result's stored body exceeded the source ceiling — refused BEFORE
        // its body was fetched. Distinct outcome so the hook traces the candidate loss.
        respond(socket, { error: "oversized" });
      } else {
        respond(socket, { error: `internal: ${(e as Error).message}` });
      }
    } finally {
      scanInFlight = false;
    }
  };

  let server: { stop: (closeActiveConnections?: boolean) => void };
  try {
    server = Bun.listen<DaemonSocketData>({
      unix: sockPath,
      socket: {
        open(socket) { socket.data = { pending: new Uint8Array(0), total: 0 }; },
        data(socket, chunk) {
          // Byte-accurate framing (t87 F3): accumulate RAW BYTES, cap on byte count, locate 0x0A
          // at the byte level, decode the complete line strictly. chunk.toString()+.length was
          // UTF-16 units and could split a code point across chunks.
          const u8 = chunk as unknown as Uint8Array;
          socket.data.total += u8.byteLength;
          if (socket.data.total > MAX_FRAME_BYTES) { respond(socket, { error: "oversized" }); return; }
          const merged = new Uint8Array(socket.data.pending.byteLength + u8.byteLength);
          merged.set(socket.data.pending, 0);
          merged.set(u8, socket.data.pending.byteLength);
          const nl = merged.indexOf(0x0A);
          if (nl < 0) { socket.data.pending = merged; return; } // partial frame — wait for the newline
          const line = decodeLineStrict(merged.subarray(0, nl));
          socket.data.pending = new Uint8Array(0); // one request per connection
          if (line === null) { respond(socket, { error: "bad_request" }); return; } // invalid UTF-8 — fail closed
          void handleRequest(socket, line);
        },
        error(_socket, err) { log(`[vec-daemon] socket error: ${err.message}`); },
      },
    });
  } catch (e) {
    log(`[vec-daemon] bind failed: ${(e as Error).message}`);
    return null;
  }

  try { chmodSync(sockPath, 0o600); } catch { /* best-effort; 0700 dir already restricts to owner */ }
  log(`[vec-daemon] listening on ${sockPath}`);

  return {
    close() {
      try { server.stop(true); } catch { /* already stopped */ }
      try { if (existsSync(sockPath)) rmSync(sockPath, { force: true }); } catch { /* best-effort */ }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook client + bounded search — used by BOTH context-surfacing vector legs
// ─────────────────────────────────────────────────────────────────────────────

type DaemonOutcome =
  | { status: "ok"; results: VecHit[] }                      // raw hits (legacy daemon or raw request) → client hydrates ("raw-hit" path)
  | { status: "ok-hydrated"; results: ProjectedVecResult[] } // daemon-side projection (hydrated-v1) → zero client-side sqlite on the timed path
  | { status: "oversized" }                                  // daemon refused on a size cap → FTS with vector-candidate LOSS (traced distinctly)
  | { status: "busy" }    // daemon busy/expired → hook falls to FTS (do NOT re-run in-process)
  | { status: "error" }   // daemon present but timed out/misbehaving → fall to FTS
  | { status: "absent" }  // daemon not running → hook uses the in-process path
  | { status: "model_mismatch"; storedModels: string[]; activeModel: string }; // typed → hook warns once

/**
 * Send one Step-1 request to the daemon and classify the outcome. Self-bounds to `ipcTimeoutMs`
 * (the caller passes the remaining wall-clock budget) so the client cleans up its own socket well
 * before the hook's outer timer fires. Every failure mode resolves — this promise never rejects.
 */
export async function daemonVecMatch(dbPath: string, req: VecReq, ipcTimeoutMs: number): Promise<DaemonOutcome> {
  const sockPath = vecDaemonSocketPath(dbPath);
  if (!existsSync(sockPath)) return { status: "absent" };
  if (ipcTimeoutMs <= 0) return { status: "error" }; // no budget left — don't even connect
  const hydratedReq = req.responseProtocol !== undefined;
  // Byte caps (t86/t87): a hydrated response may total up to HYDRATED_MAX_FRAME_BYTES with each
  // line ≤ HYDRATED_MAX_ENTRY_BYTES (the per-parse-slice bound); raw/legacy responses keep the
  // original single-frame cap. A legacy daemon answering a hydrated request sends one raw-hit
  // line (≤ ~30 KB at the 500-hit clamp) — under the entry cap, so the stricter line bound is
  // safe in hydrated mode.
  const frameCap = hydratedReq ? HYDRATED_MAX_FRAME_BYTES : MAX_FRAME_BYTES;
  const lineCap = hydratedReq ? HYDRATED_MAX_ENTRY_BYTES : MAX_FRAME_BYTES;
  const deadlineAbs = req.deadlineMs;

  return await new Promise<DaemonOutcome>((resolve) => {
    let settled = false;
    let opened = false;
    let closed = false;
    let sock: Socket<undefined> | null = null;
    // Byte-accurate framing (t87 F3): accumulate RAW bytes, locate 0x0A at the byte level,
    // enforce caps on byte counts BEFORE decode, strict-decode each complete line.
    let pending: Uint8Array = new Uint8Array(0);
    let totalBytes = 0;
    const lineQueue: Uint8Array[] = [];
    // Hydrated state machine: header → `count` entries → end line.
    let mode: "unknown" | "hydrated" = "unknown";
    let expected = 0;
    const entries: ProjectedVecResult[] = [];
    let pumping = false;

    const finish = (o: DaemonOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.end(); } catch { /* ignore */ }
      resolve(o);
    };
    const timer = setTimeout(() => finish({ status: "error" }), ipcTimeoutMs);

    const mapError = (resp: { error: string; storedModels?: string[]; activeModel?: string }): DaemonOutcome =>
      resp.error === "busy" || resp.error === "expired" ? { status: "busy" }
        : resp.error === "read_model_mismatch" ? { status: "model_mismatch", storedModels: resp.storedModels ?? [], activeModel: resp.activeModel ?? "" }
        : resp.error === "oversized" ? { status: "oversized" }
        : { status: "error" };

    // Incremental YIELDING decode (t86 CR-3 / t87 F2 / t88): one bounded line (≤ lineCap, enforced
    // pre-parse) per synchronous slice; an awaited macrotask between entries so the deadline timer
    // gets a scheduling slot; and an ABSOLUTE deadline check BEFORE and AFTER every parse — a
    // decode completing past `deadlineAbs` is never classified ok, and entries after a deadline
    // crossing are never parsed (decode cancelled mid-stream).
    const pump = async (): Promise<void> => {
      if (pumping || settled) return;
      pumping = true;
      try {
        while (lineQueue.length > 0 && !settled) {
          if (deadlineAbs !== undefined && Date.now() >= deadlineAbs) { finish({ status: "error" }); return; }
          const lineBytes = lineQueue.shift()!;
          testSyncEntryDecodeDelay(); // t88 lock (b): a sync intra-entry stall — caught by the check below, never a late ok
          let obj: VecResp;
          try {
            obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lineBytes)) as VecResp;
          } catch { finish({ status: "error" }); return; } // invalid UTF-8 or malformed JSON — fail closed (t87 CR-6)
          if (deadlineAbs !== undefined && Date.now() >= deadlineAbs) { finish({ status: "error" }); return; }
          if (process.env.CLAWMEM_TEST_VEC_PARSE_TRACE === "1") console.error(`[vec-parse] line mode=${mode} n=${entries.length}`);
          if (mode === "unknown") {
            if (obj && typeof obj === "object" && "protocol" in obj && obj.protocol === HYDRATED_PROTOCOL) {
              mode = "hydrated";
              expected = obj.count;
              // t89 S1: integer counts only — a fractional/NaN count is a malformed peer.
              if (!Number.isInteger(expected) || expected < 0 || expected > HYDRATED_MAX_RESULTS) { finish({ status: "error" }); return; }
            } else if (obj && "results" in obj) {
              // A raw-hit answer — a raw request, or a LEGACY daemon ignoring the hydrated ask
              // (the negotiation matrix's raw-hit path): the caller hydrates client-side.
              // t89 S1: validate every hit; a malformed/mixed list degrades to FTS, never ok.
              if (!Array.isArray(obj.results) || !obj.results.every(isValidVecHit)) { finish({ status: "error" }); return; }
              finish({ status: "ok", results: obj.results }); return;
            } else if (obj && "error" in obj) { finish(mapError(obj)); return; }
            else { finish({ status: "error" }); return; } // a pong (or anything else) is not a scan answer
          } else {
            if (obj && "entry" in obj) {
              // t89 S1: strict per-entry validation — a malformed entry can never become
              // ok-hydrated; the leg degrades to FTS.
              if (!isValidProjectedEntry(obj.entry)) { finish({ status: "error" }); return; }
              entries.push(obj.entry);
              if (entries.length > expected) { finish({ status: "error" }); return; }
            } else if (obj && "end" in obj) {
              if (entries.length !== expected) { finish({ status: "error" }); return; }
              finish({ status: "ok-hydrated", results: entries }); return;
            } else if (obj && "error" in obj) { finish(mapError(obj)); return; }
            else { finish({ status: "error" }); return; }
          }
          await testInterEntryAsyncDelay(); // t88 lock (a): an inter-entry stall lets the timer WIN
          await new Promise<void>(r => setTimeout(r, 0)); // macrotask yield — the deadline timer can fire here
        }
        // The daemon half-closed and every queued line is consumed without a conclusive frame.
        if (closed && !settled && lineQueue.length === 0) finish(opened ? { status: "error" } : { status: "absent" });
      } finally { pumping = false; }
    };

    Bun.connect<undefined>({
      unix: sockPath,
      socket: {
        open(socket) {
          opened = true;
          sock = socket;
          try { socket.write(JSON.stringify(req /* O1-DEBT-0011 */) + "\n"); }
          catch { finish({ status: "error" }); }
        },
        data(_socket, chunk) {
          if (settled) return;
          const u8 = chunk as unknown as Uint8Array;
          totalBytes += u8.byteLength;
          if (totalBytes > frameCap) { finish({ status: "error" }); return; } // cumulative byte cap, pre-parse
          // Cheap byte-level line extraction — NO decode, NO parse on this path.
          const merged = new Uint8Array(pending.byteLength + u8.byteLength);
          merged.set(pending, 0);
          merged.set(u8, pending.byteLength);
          let start = 0;
          for (let i = 0; i < merged.byteLength; i++) {
            if (merged[i] === 0x0A) {
              if (i - start > lineCap) { finish({ status: "error" }); return; } // per-line byte bound, pre-parse
              lineQueue.push(merged.slice(start, i));
              start = i + 1;
            }
          }
          pending = merged.slice(start);
          if (pending.byteLength > lineCap) { finish({ status: "error" }); return; } // an unterminated over-cap line never buffers on
          void pump();
        },
        // Connection refused / stale socket file (no live listener) → daemon effectively absent.
        connectError() { finish({ status: "absent" }); },
        // A close/error BEFORE the connection ever opened is a refused/stale socket
        // (absent — no listener); after open it is a listener that hung up (error).
        error() { finish(opened ? { status: "error" } : { status: "absent" }); },
        close() {
          // The daemon half-closes after writing its frames; lines may still sit in the local
          // queue. Let the pump drain them (it self-finishes on the end line) — conclude error
          // only when nothing conclusive remains in flight.
          closed = true;
          if (!settled && lineQueue.length === 0 && !pumping) finish(opened ? { status: "error" } : { status: "absent" });
        },
      },
    }).catch(() => finish({ status: "absent" })); // belt-and-suspenders for connect rejection
  });
}

/**
 * Readiness/identity probe (eval daemon child): one `{ping:true}` round trip. Resolves
 * `ok` with the DB path + pid the daemon reports, `absent` when no listener accepts (missing or
 * stale socket), `error` on timeout/malformed reply. Never rejects.
 */
export type DaemonPingResult =
  | { status: "ok"; db: string; pid: number; protocols: string[] }
  /** A LIVE clawmem daemon that predates the ping protocol (pre-v0.38): it answered the frame with its exact `malformed` refusal, so a listener speaking the daemon protocol serves this vault's path-keyed socket — but it cannot attest DB/pid. */
  | { status: "legacy" }
  | { status: "absent" | "error" };

export async function daemonPing(dbPath: string, timeoutMs: number): Promise<DaemonPingResult> {
  const sockPath = vecDaemonSocketPath(dbPath);
  if (!existsSync(sockPath)) return { status: "absent" };
  return await new Promise((resolve) => {
    let settled = false;
    let opened = false;
    // Byte-accurate framing here too (t89 S2): the pong carries the daemon's DB PATH — a
    // multibyte path split across socket chunks must never corrupt, and invalid UTF-8 is
    // refused, never U+FFFD-substituted into an identity comparison.
    let pending: Uint8Array = new Uint8Array(0);
    let totalBytes = 0;
    let sock: Socket<undefined> | null = null;
    const finish = (o: DaemonPingResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.end(); } catch { /* ignore */ }
      resolve(o);
    };
    const timer = setTimeout(() => finish({ status: "error" }), Math.max(1, timeoutMs));
    Bun.connect<undefined>({
      unix: sockPath,
      socket: {
        open(socket) {
          opened = true;
          sock = socket;
          try { socket.write(JSON.stringify({ ping: true }) + "\n"); } catch { finish({ status: "error" }); }
        },
        data(_socket, chunk) {
          const u8 = chunk as unknown as Uint8Array;
          totalBytes += u8.byteLength;
          if (totalBytes > MAX_FRAME_BYTES) { finish({ status: "error" }); return; }
          const merged = new Uint8Array(pending.byteLength + u8.byteLength);
          merged.set(pending, 0);
          merged.set(u8, pending.byteLength);
          const nl = merged.indexOf(0x0A);
          if (nl < 0) { pending = merged; return; }
          const line = decodeLineStrict(merged.subarray(0, nl));
          if (line === null) { finish({ status: "error" }); return; } // invalid UTF-8 — fail closed
          try {
            const resp = JSON.parse(line) as VecResp;
            // t90 S1: the pong is an IDENTITY frame — validate it fail-closed. A malformed
            // protocols array or a non-integer pid is a malformed peer (error), never
            // silently coerced/filtered into an attestation. `protocols` ABSENT is the
            // valid pre-capability shape (→ [] → live-raw tiering).
            if ("pong" in resp && resp.pong === true && typeof resp.db === "string"
              && typeof resp.pid === "number" && Number.isInteger(resp.pid) && resp.pid > 0
              && (resp.protocols === undefined || (Array.isArray(resp.protocols) && resp.protocols.every((p) => typeof p === "string")))) {
              finish({ status: "ok", db: resp.db, pid: resp.pid, protocols: (resp.protocols as string[] | undefined) ?? [] });
            }
            else if ("error" in resp && resp.error === "malformed" && Object.keys(resp).length === 1) finish({ status: "legacy" });
            else finish({ status: "error" });
          } catch { finish({ status: "error" }); }
        },
        connectError() { finish({ status: "absent" }); },
        error() { finish(opened ? { status: "error" } : { status: "absent" }); },
        // Closed before a frame arrived: a refused/stale socket that never opened is
        // ABSENT (no listener); a listener that opened then hung up is an error.
        close() { finish(opened ? { status: "error" } : { status: "absent" }); },
      },
    }).catch(() => finish({ status: "absent" }));
  });
}

/** Operational liveness/ownership state of a vault's vector daemon (codex t77 F5). */
export type VectorDaemonHealth =
  | { status: "live"; socket: string; db: string; pid: number; protocols: string[] }
  /** Attested (exact DB + pid) but WITHOUT the hydrated-v1 capability — a daemon serving the raw-hit execution (t84/t89 P1): live, NOT Path-A authoritative. */
  | { status: "live-raw"; socket: string; db: string; pid: number; protocols: string[] }
  /** A live clawmem daemon predating the ping protocol (pre-v0.38 watcher): serves this vault's path-keyed socket, cannot attest DB/pid — liveness is established, attestation is not. */
  | { status: "live-legacy"; socket: string }
  | { status: "absent" | "stale" | "unresponsive"; socket: string }
  | { status: "foreign-db"; socket: string; db: string; pid: number };

/**
 * Deployed-vault health check used by `clawmem doctor` and `clawmem
 * vec-daemon-health`: a REAL round trip, never a socket-file glob. "absent" =
 * no socket file; "stale" = a file nobody listens on (a crashed watcher);
 * "unresponsive" = a listener that did not answer within `timeoutMs`;
 * "foreign-db" = a listener serving a different DB path; "live" = the
 * watcher's daemon serving exactly `dbPath` AND attesting the hydrated-v1
 * capability; "live-raw" = attested DB/pid but WITHOUT hydrated-v1 (a daemon
 * serving the raw-hit execution); "live-legacy" = a pre-v0.38 daemon
 * (answers the frame protocol, has no ping) on this vault's path-keyed
 * socket — live, unattested. ONLY "live" makes the context-surfacing hook's
 * vector deadline authoritative on this host (t89 P1): the deadline contract
 * is certified for daemon-side projection, and live-raw/live-legacy daemons
 * execute the client-side-hydration timing instead.
 */
export async function vectorDaemonHealth(dbPath: string, timeoutMs = 2000): Promise<VectorDaemonHealth> {
  const socket = vecDaemonSocketPath(dbPath);
  if (!existsSync(socket)) return { status: "absent", socket };
  const pong = await daemonPing(dbPath, timeoutMs);
  if (pong.status === "legacy") return { status: "live-legacy", socket };
  if (pong.status !== "ok") return pong.status === "absent" ? { status: "stale", socket } : { status: "unresponsive", socket };
  if (pong.db !== dbPath) return { status: "foreign-db", socket, db: pong.db, pid: pong.pid };
  // t89 P1: `live` is reserved for the Path-A-authoritative daemon — exact DB/pid AND the
  // hydrated-v1 capability. An attested daemon without it serves the raw-hit execution
  // (client-side hydration timing): live, but NOT what the deadline contract certifies.
  return pong.protocols.includes(HYDRATED_PROTOCOL)
    ? { status: "live", socket, db: pong.db, pid: pong.pid, protocols: pong.protocols }
    : { status: "live-raw", socket, db: pong.db, pid: pong.pid, protocols: pong.protocols };
}

/**
 * Bounded vector search for the hook path. Tries the daemon (hydrated-v1: scan + hydration +
 * projection ALL daemon-side) and degrades cleanly per the design contract:
 *   - ok-hydrated      → return the daemon's projected results (zero client-side sqlite)
 *   - ok (raw-hit)     → a legacy daemon answered raw hits — hydrate client-side (compat path)
 *   - absent/refused   → in-process searchVec (today's self-bounded behavior; daemon not deployed)
 *   - model_mismatch   → throw VecReadModelMismatchError (mirrors in-process; the leg warns once → FTS)
 *   - busy/error/timeout → return [] so the caller falls back to FTS
 *
 * Used by BOTH the primary and deep-escalation vector legs in context-surfacing, so every hook vector
 * call is bounded — not just the first.
 */
export async function searchVecBounded(
  store: Store,
  query: string,
  model: string,
  limit: number,
  collectionId?: number,
  collections?: string[],
  dateRange?: { start: string; end: string },
  deadlineMs?: LegacyWallDeadline,
  /** Optional per-leg outcome recorder (the surfacing trace's vectorLegs) — called before any
   * fallback runs. `protocol` names which response protocol served an ok leg (t84 CR-5):
   * "hydrated-v1" = daemon-side projection; "raw-hit" = raw hits + client-side hydration. */
  onOutcome?: (status: VecExecStatus, protocol?: VecResponseProtocol) => void,
  /** Hydrated-v1 request inputs (t87 F4): the RAW CURRENT PROMPT (snippet construction on every
   * leg) + the resolved session topic. Present → the leg requests daemon-side projection; a
   * legacy daemon still answers raw hits and the client hydrates (raw-hit path). Absent → the
   * legacy raw request, byte-identical to pre-v0.38 behavior. */
  hydration?: { presentationQuery: string; intent?: string },
): Promise<(SearchResult | ProjectedVecResult)[]> {
  const startedAt = VEC_TIMING ? Date.now() : 0;
  const ipcTimeoutMs = deadlineMs !== undefined ? deadlineMs - Date.now() : DEFAULT_IPC_TIMEOUT_MS;
  const req: VecReq = hydration
    ? { query, model, limit, deadlineMs, responseProtocol: HYDRATED_PROTOCOL, presentationQuery: hydration.presentationQuery, intent: hydration.intent, snippetLens: [...HYDRATED_SNIPPET_LENS], rerankTextLen: HYDRATED_RERANK_TEXT_LEN, gateTextLen: HYDRATED_GATE_TEXT_LEN, collectionId, collections, dateRange }
    : { query, model, limit, deadlineMs };
  const outcome = await daemonVecMatch(store.dbPath, req, ipcTimeoutMs);
  const traceStatus: VecExecStatus = outcome.status === "ok-hydrated" ? "ok" : outcome.status;
  const protocol: VecResponseProtocol | undefined = outcome.status === "ok-hydrated" ? HYDRATED_PROTOCOL : outcome.status === "ok" ? "raw-hit" : undefined;
  if (onOutcome) { try { onOutcome(traceStatus, protocol); } catch { /* recorder must never break the leg */ } }
  let results: (SearchResult | ProjectedVecResult)[];
  switch (outcome.status) {
    case "ok-hydrated":
      // Projection-complete daemon hydration (t83–t88): ZERO synchronous sqlite on this event
      // loop — the daemon computed every body-derived field the hook consumes.
      results = outcome.results;
      break;
    case "ok":
      // Raw-hit path (legacy daemon, or no hydration requested): the daemon bounded the SCAN;
      // hydration is a SYNCHRONOUS client-side sqlite read the caller's race timer cannot
      // interrupt (codex t80 P1). The seam models a cold hydrate.
      testSyncHydrateDelay();
      results = hydrateVecResults(store.db, outcome.results, limit, collectionId, collections, dateRange);
      break;
    case "absent":
      // In-process path: the synchronous MATCH runs on THIS event loop (the caller's race timer
      // cannot fire during it). The test seam models that scan's duration deterministically.
      testSyncScanDelay();
      results = await store.searchVec(query, model, limit, collectionId, collections, dateRange, deadlineMs);
      break;
    case "model_mismatch":
      // Mirror the in-process path: throw the typed error so the leg's catch fires
      // warnOnceOnVectorModelMismatch (a persistent config error, warned loudly once), then FTS.
      throw new VecReadModelMismatchError(outcome.storedModels, outcome.activeModel);
    default: // "busy" | "error" | "oversized" → let the caller's FTS fallback take over
      results = [];
      break;
  }
  if (VEC_TIMING) {
    console.error(`[vec-timing] path=${traceStatus}${protocol ? ` protocol=${protocol}` : ""} elapsedMs=${Date.now() - startedAt} results=${results.length}`);
  }
  return results;
}

/**
 * Daemon-REQUIRED bounded vector search for SUPPLEMENTARY hook legs (the
 * prior-turns leg, BUILD-1). Unlike searchVecBounded it NEVER falls back to
 * the in-process synchronous MATCH: absent — including a STALE socket file
 * whose connect is refused — busy, error, and timeout all return [] so the
 * caller's FTS lanes carry the turn (codex turn-7 STANDARDS-1: the
 * existsSync pre-check alone let a stale socket route a supplementary leg
 * into the uninterruptible in-process scan).
 *   - ok             → hydrate the daemon's hits and return
 *   - model_mismatch → throw VecReadModelMismatchError (persistent config
 *                      error — same loud-once handling as the primary leg)
 *   - anything else  → []
 */
export async function searchVecDaemonRequired(
  store: Store,
  query: string,
  model: string,
  limit: number,
  collectionId?: number,
  collections?: string[],
  dateRange?: { start: string; end: string },
  deadlineMs?: LegacyWallDeadline,
  /** Optional per-leg outcome recorder (the surfacing trace's vectorLegs). `protocol` names which
   * response protocol served an ok leg (t84 CR-5). */
  onOutcome?: (status: VecExecStatus, protocol?: VecResponseProtocol) => void,
  /** Hydrated-v1 request inputs (t87 F4) — see searchVecBounded. */
  hydration?: { presentationQuery: string; intent?: string },
): Promise<(SearchResult | ProjectedVecResult)[]> {
  const startedAt = VEC_TIMING ? Date.now() : 0;
  const ipcTimeoutMs = deadlineMs !== undefined ? deadlineMs - Date.now() : DEFAULT_IPC_TIMEOUT_MS;
  const req: VecReq = hydration
    ? { query, model, limit, deadlineMs, responseProtocol: HYDRATED_PROTOCOL, presentationQuery: hydration.presentationQuery, intent: hydration.intent, snippetLens: [...HYDRATED_SNIPPET_LENS], rerankTextLen: HYDRATED_RERANK_TEXT_LEN, gateTextLen: HYDRATED_GATE_TEXT_LEN, collectionId, collections, dateRange }
    : { query, model, limit, deadlineMs };
  const outcome = await daemonVecMatch(store.dbPath, req, ipcTimeoutMs);
  const traceStatus: VecExecStatus = outcome.status === "ok-hydrated" ? "ok" : outcome.status;
  const protocol: VecResponseProtocol | undefined = outcome.status === "ok-hydrated" ? HYDRATED_PROTOCOL : outcome.status === "ok" ? "raw-hit" : undefined;
  if (onOutcome) { try { onOutcome(traceStatus, protocol); } catch { /* recorder must never break the leg */ } }
  let results: (SearchResult | ProjectedVecResult)[] = [];
  if (outcome.status === "ok-hydrated") {
    // Projection-complete daemon hydration — zero synchronous sqlite on this event loop.
    results = outcome.results;
  } else if (outcome.status === "ok") {
    // Raw-hit path: synchronous client-side hydrate — the daemon-required deadline bounds the
    // SCAN, not this rowid hydration (codex t80 P1); the seam models a cold hydrate.
    testSyncHydrateDelay();
    results = hydrateVecResults(store.db, outcome.results, limit, collectionId, collections, dateRange);
  } else if (outcome.status === "model_mismatch") {
    throw new VecReadModelMismatchError(outcome.storedModels, outcome.activeModel);
  }
  if (VEC_TIMING) {
    console.error(`[vec-timing] path=${traceStatus}${protocol ? ` protocol=${protocol}` : ""} (daemon-required) elapsedMs=${Date.now() - startedAt} results=${results.length}`);
  }
  return results;
}
