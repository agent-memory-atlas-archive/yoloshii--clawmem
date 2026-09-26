#!/usr/bin/env bash
# Experiment-level frozen evaluation clock (codex t56 F1 + t57 F1).
# ONE experiment = ONE clock: every draw of a replicated A/B must compute
# composite policy inputs on the same CLAWMEM_EVAL_NOW, or the
# replicated-member identity check refuses the aggregate. Sourcing this
# script pins the clock in EXPERIMENT_DIR/EVAL_NOW so SEPARATELY LAUNCHED
# draw invocations share it. Persistence is ATOMIC and FAIL-CLOSED:
#   - first write uses noclobber (O_EXCL) — exactly ONE concurrent
#     initializer wins; losers adopt the durable winner (or refuse when a
#     conflicting explicit CLAWMEM_EVAL_NOW was demanded);
#   - the DURABLE file value is what gets exported — never a local intention
#     that failed to persist;
#   - an empty/corrupt/noncanonical pin REFUSES (exit 72) — never silently
#     reseeded; inspect and remove it deliberately to start a new experiment;
#   - an unpersistable pin (unwritable dir) REFUSES (exit 73);
#   - a conflicting explicit CLAWMEM_EVAL_NOW REFUSES (exit 71);
#   - a noncanonical explicit CLAWMEM_EVAL_NOW REFUSES (exit 74).
# Canonical shape mirrors parseEvalNowTimestamp (YYYY-MM-DDTHH:mm:ss[.sss]Z);
# calendar-impossible values that pass the shape are refused by the runner's
# assertEvalNowConfig preflight before scoring.
EXPERIMENT_DIR="${EXPERIMENT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
CLOCK_FILE="$EXPERIMENT_DIR/EVAL_NOW"

_ec_valid() {
  case "$1" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) return 0;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z) return 0;;
    *) return 1;;
  esac
}
_ec_read() { _EC_P=""; IFS= read -r _EC_P < "$CLOCK_FILE" || true; }

if [ ! -e "$CLOCK_FILE" ]; then
  _EC_INTENDED="${CLAWMEM_EVAL_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  if ! _ec_valid "$_EC_INTENDED"; then
    echo "experiment-clock: CLAWMEM_EVAL_NOW (\"$_EC_INTENDED\") is not canonical ISO-8601 UTC (YYYY-MM-DDTHH:mm:ss[.sss]Z)" >&2
    exit 74
  fi
  # ATOMIC first write (codex t57 F1): O_EXCL via noclobber — a concurrent
  # initializer cannot fork the experiment clock; the redirect either creates
  # the file exclusively or fails, and the durable value below decides.
  if ( set -C; printf '%s\n' "$_EC_INTENDED" > "$CLOCK_FILE" ) 2>/dev/null; then :; fi
fi
if [ ! -e "$CLOCK_FILE" ]; then
  echo "experiment-clock: could not persist the experiment clock at $CLOCK_FILE — refusing to run with an unpersisted pin" >&2
  exit 73
fi
_ec_read
if ! _ec_valid "$_EC_P"; then
  echo "experiment-clock: persisted pin at $CLOCK_FILE is empty or corrupt (\"$_EC_P\") — refusing to reseed silently; inspect and remove it deliberately to start a new experiment" >&2
  exit 72
fi
if [ -n "${CLAWMEM_EVAL_NOW:-}" ] && [ "$CLAWMEM_EVAL_NOW" != "$_EC_P" ]; then
  echo "experiment-clock: CLAWMEM_EVAL_NOW ($CLAWMEM_EVAL_NOW) != persisted experiment clock ($_EC_P at $CLOCK_FILE) — one experiment, one clock; rm the file to start a new experiment" >&2
  exit 71
fi
# The DURABLE value is authoritative — export what the file holds, never a
# local intention (a lost no-env race adopts the winner).
export CLAWMEM_EVAL_NOW="$_EC_P"
unset _EC_P _EC_INTENDED
