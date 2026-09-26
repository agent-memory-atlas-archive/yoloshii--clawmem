/**
 * Hydrated vector-daemon wire protocol constants (codex #28 t83–t88 design).
 *
 * ONE shared module imported by the daemon (server), the hook client, the
 * store projection scan, and the tests — so the two ends of the wire can
 * never skew. Under `responseProtocol: "hydrated-v1"` the daemon accepts
 * ONLY these exact values (t86 CR-6): the request carries them as an
 * attestation of what the client expects, and a mismatch is a loud
 * `bad_request`, never a divergent projection.
 *
 * Zero imports on purpose — everything may import this.
 */

/** Version tag of the projection-complete response protocol. */
export const HYDRATED_PROTOCOL = "hydrated-v1";

/**
 * Hard cap on projected results per response (t85). The hook's largest ask is
 * the deep profile's maxResults=15; a hydrated-v1 request whose limit is not
 * an integer in [1, HYDRATED_MAX_RESULTS] is REFUSED as `bad_request` (t89
 * P3) — an out-of-contract value is version/config skew, never something to
 * silently clamp into a different candidate-count contract. (Legacy raw
 * requests keep their compatibility clamp.)
 */
export const HYDRATED_MAX_RESULTS = 16;

/**
 * Per-entry serialized cap (t87): each projected entry is one newline-framed
 * JSON line; the reader rejects a longer line BEFORE parsing it, so a single
 * synchronous parse slice is bounded by construction — the enforced
 * supported-platform decode bound (t86 CR-3), not a host benchmark.
 * Worst-case arithmetic: 2000+4000+450 chars of body-derived text at 6
 * bytes/char JSON escaping ≈ 40 KB, plus metadata.
 */
export const HYDRATED_MAX_ENTRY_BYTES = 64 * 1024;

/**
 * Cumulative response cap across header + entries + end line (t86). Raw-hit
 * and legacy frames keep the original 256 KiB MAX_FRAME_BYTES.
 */
export const HYDRATED_MAX_FRAME_BYTES = 1024 * 1024;

/**
 * Phase-1 admission ceiling on a SOURCE body (t87 F1): a selected result
 * whose stored body exceeds this is rejected BEFORE its body is fetched
 * (`oversized` → client FTS fallback, distinct trace) — the genuine finite
 * bound on daemon peak allocation. 3× the observed corpus maximum (1.36 MB).
 * UTF-8 BYTES via `length(CAST(content.doc AS BLOB))` — used ONLY for this
 * admission check, never as the projected `bodyLength` (t87 F3: bodyLength
 * stays UTF-16 `body.length`, byte-identical to in-process hydration).
 */
export const HYDRATED_MAX_SOURCE_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The snippet lengths the daemon precomputes per result — exactly the hook's
 * injection tiers (HOT 300 / WARM 150; COLD injects no snippet). The hook
 * picks one at the FINAL tier and smart-truncates, exactly as it does today.
 */
export const HYDRATED_SNIPPET_LENS = [300, 150] as const;

/** Rerank transmitted-text slice — `body.slice(0, 2000)`, the hook's exact slice. */
export const HYDRATED_RERANK_TEXT_LEN = 2000;

/** Gate-token source slice — `body.slice(0, 4000)`, passesCurrentQueryGate's exact slice. */
export const HYDRATED_GATE_TEXT_LEN = 4000;
