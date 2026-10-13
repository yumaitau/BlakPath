/**
 * Worker runtime bounds shared by the process, the image probe, and the
 * manifests. Change these together: tests lock the manifests to the numbers.
 *
 * The longest in-flight job is a retention sweep (one batch of 500 records
 * per policy, including evidence object deletes) or a ClamAV scan (30s
 * deadline inside a larger download). Ten minutes covers that work. The
 * shutdown deadline sits above it, and the orchestrator grace sits above the
 * deadline, so SIGKILL cannot land before the drain logs "shutdown complete".
 */
export const LONGEST_JOB_MS = 10 * 60 * 1000;

/** Hard cap on the SIGTERM drain. Exceeding it forces exit 1. */
export const SHUTDOWN_GRACE_MS = LONGEST_JOB_MS + 15_000;

/**
 * Pod / compose grace. Longer than SHUTDOWN_GRACE_MS so the process can
 * finish logging and exit before the runtime sends SIGKILL.
 */
export const TERMINATION_GRACE_SECONDS = SHUTDOWN_GRACE_MS / 1000 + 15;

export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Probe fails when the file is older than this. Several missed beats. */
export const HEARTBEAT_MAX_AGE_SECONDS = 30;

export const DEFAULT_HEARTBEAT_PATH = '/tmp/blakpath-worker-heartbeat';
