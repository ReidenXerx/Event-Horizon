/**
 * ──────────────────────────────────────────────────────────────────────
 * SHA-256 of files on every core, off Vortex's thread.
 *
 * Hashing used to run in Vortex's renderer, whose one JS thread also runs
 * Vortex's UI and everything else: every 8 MB chunk waited its turn on that
 * loop, and `hash.update` ran on it. Parallel callers only overlapped the
 * reads. Measured 2026-09-27 on the curator's Meridia staging (1751 mods,
 * ~357k files): the live build hashed ~126 files/s at ~3 MB/s with the disks
 * 99% idle; the same files in a pool of 11 worker processes went 2.6 GB/s.
 *
 * So hashing runs in N worker processes (cores - 1, leaving one for Vortex's
 * UI). A worker is Vortex's own executable in Node mode (ELECTRON_RUN_AS_NODE,
 * the same way the MCP connector runs), started with its code inline (`-e`),
 * so nothing extra ships and nothing is written to disk. The answer is the
 * same SHA-256 of the same bytes: caches, identities and manifests are
 * untouched (NS-4); only where the work runs changes.
 *
 * If the pool cannot start, or a worker dies, the file is hashed in-process
 * exactly as before. A pool that fails to start is not retried for this
 * Vortex session: one log line, then the old path, never a failed hash.
 * Workers exit after IDLE_MS without work.
 * ──────────────────────────────────────────────────────────────────────
 */

import { spawn, type ChildProcess } from "child_process";
import * as os from "os";

import { ehLog } from "./logging/ehLog";
import { AbortError } from "../utils/abortError";

/** The worker, plain CommonJS on Node built-ins only. One file at a time, async reads so a cancel lands between chunks. */
export const WORKER_SOURCE = String.raw`
const fs = require("fs");
const crypto = require("crypto");
const CHUNK = 8 * 1024 * 1024;
const buf = Buffer.allocUnsafe(CHUNK);
const queue = [];
const cancelled = new Set();
let busy = false;
async function hashOne(job) {
  const h = crypto.createHash("sha256");
  const fh = await fs.promises.open(job.path, "r");
  let bytes = 0;
  try {
    for (;;) {
      if (cancelled.has(job.id)) return { id: job.id, cancelled: true };
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return { id: job.id, sha256: h.digest("hex"), bytes };
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length > 0) {
    const job = queue.shift();
    if (cancelled.delete(job.id)) { process.send({ id: job.id, cancelled: true }); continue; }
    try {
      const r = await hashOne(job);
      cancelled.delete(job.id);
      process.send(r);
    } catch (e) {
      process.send({ id: job.id, error: { message: String((e && e.message) || e), code: e && e.code } });
    }
  }
  busy = false;
}
process.on("message", (m) => {
  if (m && m.cancel !== undefined) { cancelled.add(m.cancel); return; }
  if (m && m.path !== undefined) { queue.push(m); pump(); }
});
process.on("disconnect", () => process.exit(0));
process.send({ ready: true });
`;

type Job = {
  id: number;
  path: string;
  resolve: (sha256: string) => void;
  reject: (err: Error) => void;
  worker?: PoolWorker;
};
type PoolWorker = { child: ChildProcess; inFlight: Map<number, Job>; ready: boolean };

/** Why a pooled hash could not be done in the pool; the caller hashes in-process instead. */
export class PoolUnavailable extends Error {}

const IDLE_MS = 30_000;
/** Jobs queued on one worker at once: enough that it never waits for the next file. */
const PER_WORKER = 4;

export type HashPoolOptions = {
  workers?: number;
  /** The executable to run workers with. Vortex's own by default. */
  execPath?: string;
  idleMs?: number;
};

export class HashPool {
  private workers: PoolWorker[] = [];
  private waiting: Job[] = [];
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | undefined;
  private broken: string | undefined;
  private starting: Promise<void> | undefined;
  private stats = { files: 0, bytes: 0, since: 0 };

  constructor(private readonly options: HashPoolOptions = {}) {}

  /** Worker count: every core but one, which Vortex's UI keeps. */
  get size(): number {
    return this.options.workers ?? Math.max(1, (os.cpus()?.length ?? 2) - 1);
  }

  /** How many hashes callers should keep in flight to keep every worker busy. */
  get parallelism(): number {
    return this.workers.length > 0 ? this.size * PER_WORKER : 0;
  }

  /** Starts the pool and waits for it (a few hundred ms). False when it cannot start. */
  async whenReady(): Promise<boolean> {
    if (this.broken !== undefined) return false;
    try {
      await this.ensureStarted();
      this.armIdle();
      return true;
    } catch {
      return false;
    }
  }

  /** True once every worker has started; until then callers hash in-process. */
  get ready(): boolean {
    return this.workers.length > 0;
  }

  /**
   * Starts the workers in the background. A first hash does not wait for
   * processes to start (a one-file hash would only get slower): it runs
   * in-process while the pool comes up, and the pool takes over when ready.
   */
  warmUp(): void {
    if (this.broken !== undefined || this.workers.length > 0) return;
    void this.ensureStarted().then(
      () => this.armIdle(),
      () => undefined,
    );
  }

  get unavailableReason(): string | undefined {
    return this.broken;
  }

  hash(filePath: string, signal?: AbortSignal): Promise<string> {
    if (this.broken !== undefined) return Promise.reject(new PoolUnavailable(this.broken));
    return new Promise<string>((resolve, reject) => {
      const job: Job = { id: this.nextId++, path: filePath, resolve, reject };
      if (signal !== undefined) {
        if (signal.aborted) return reject(abortError());
        const onAbort = (): void => this.cancel(job);
        signal.addEventListener("abort", onAbort, { once: true });
        const done = (): void => signal.removeEventListener("abort", onAbort);
        job.resolve = (v) => (done(), resolve(v));
        job.reject = (e) => (done(), reject(e));
      }
      this.waiting.push(job);
      void this.ensureStarted().then(
        () => this.dispatch(),
        (err: Error) => this.failAll(new PoolUnavailable(err.message)),
      );
    });
  }

  /** Stops every worker; waiting and running hashes fall back to in-process. */
  shutdown(reason = "shutdown"): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const workers = this.workers;
    this.workers = [];
    this.starting = undefined;
    for (const w of workers) {
      for (const job of w.inFlight.values()) job.reject(new PoolUnavailable(`hash pool ${reason}`));
      w.inFlight.clear();
      try {
        w.child.kill();
      } catch {
        // already gone
      }
    }
    if (workers.length > 0) {
      ehLog("info", "hash-pool.stop", {
        reason,
        files: this.stats.files,
        mb: Math.round(this.stats.bytes / 1048576),
        mbPerS: this.stats.since > 0 ? Math.round(this.stats.bytes / 1048576 / ((Date.now() - this.stats.since) / 1000)) : undefined,
      });
    }
    this.stats = { files: 0, bytes: 0, since: 0 };
  }

  private ensureStarted(): Promise<void> {
    if (this.workers.length > 0) return Promise.resolve();
    if (this.starting !== undefined) return this.starting;
    const startedAt = Date.now();
    this.starting = new Promise<void>((resolve, reject) => {
      const n = this.size;
      const spawned: PoolWorker[] = [];
      let readyCount = 0;
      let settled = false;
      const fail = (why: string): void => {
        if (settled) return;
        settled = true;
        for (const w of spawned) {
          try {
            w.child.kill();
          } catch {
            // already gone
          }
        }
        this.broken = why;
        this.starting = undefined;
        ehLog("warn", "hash-pool.unavailable", { why, consequence: "files are hashed in Vortex's own process, as before" });
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail(`workers did not start within 15 s (${readyCount}/${n} ready)`), 15_000);
      timer.unref?.();
      // One spawn per tick: each blocks the thread for a few ms on Windows,
      // and eleven in a row froze Vortex's UI (and delayed the first hash).
      const spawnOne = (i: number): void => {
        if (settled || i >= n) return;
        let child: ChildProcess;
        try {
          child = spawn(this.options.execPath ?? process.execPath, ["-e", WORKER_SOURCE], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
          });
        } catch (err) {
          clearTimeout(timer);
          fail(`could not start a worker: ${String((err as Error)?.message ?? err)}`);
          return;
        }
        const w: PoolWorker = { child, inFlight: new Map(), ready: false };
        spawned.push(w);
        child.on("message", (m: WorkerReply) => {
          if (m?.ready === true) {
            w.ready = true;
            readyCount += 1;
            if (readyCount === n && !settled) {
              settled = true;
              clearTimeout(timer);
              this.workers = spawned;
              this.starting = undefined;
              this.stats.since = Date.now();
              // Held while starting; from here only a worker with work holds the process open.
              for (const x of spawned) if (x.inFlight.size === 0) hold(x, false);
              ehLog("info", "hash-pool.start", { workers: n, ms: Date.now() - startedAt });
              resolve();
            }
            return;
          }
          this.onReply(w, m);
        });
        child.on("error", (err) => (settled ? this.onWorkerGone(w, err.message) : fail(`worker error: ${err.message}`)));
        child.on("exit", (code) => (settled ? this.onWorkerGone(w, `exited with ${String(code)}`) : fail(`a worker exited while starting (code ${String(code)})`)));
        setTimeout(() => spawnOne(i + 1), 0);
      };
      spawnOne(0);
    });
    return this.starting;
  }

  private dispatch(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    while (this.waiting.length > 0) {
      const w = this.workers.filter((x) => x.ready && x.inFlight.size < PER_WORKER).sort((a, b) => a.inFlight.size - b.inFlight.size)[0];
      if (w === undefined) return;
      const job = this.waiting.shift()!;
      job.worker = w;
      if (w.inFlight.size === 0) hold(w, true);
      w.inFlight.set(job.id, job);
      try {
        w.child.send({ id: job.id, path: job.path });
      } catch (err) {
        w.inFlight.delete(job.id);
        job.reject(new PoolUnavailable(`could not reach a worker: ${String((err as Error)?.message ?? err)}`));
      }
    }
    this.armIdle();
  }

  private onReply(w: PoolWorker, m: WorkerReply): void {
    const job = m?.id !== undefined ? w.inFlight.get(m.id) : undefined;
    if (job === undefined) return;
    w.inFlight.delete(m.id!);
    if (w.inFlight.size === 0) hold(w, false);
    if (m.sha256 !== undefined) {
      this.stats.files += 1;
      this.stats.bytes += m.bytes ?? 0;
      job.resolve(m.sha256);
    } else if (m.cancelled === true) {
      job.reject(abortError());
    } else {
      const err = new Error(m.error?.message ?? "hash failed") as NodeJS.ErrnoException;
      if (m.error?.code !== undefined) err.code = m.error.code;
      job.reject(err);
    }
    this.dispatch();
  }

  private onWorkerGone(w: PoolWorker, why: string): void {
    const i = this.workers.indexOf(w);
    if (i < 0) return;
    this.workers.splice(i, 1);
    ehLog("warn", "hash-pool.worker-lost", { why, inFlight: w.inFlight.size, left: this.workers.length });
    // Its files are hashed in-process by the caller; the rest carry on in the pool.
    for (const job of w.inFlight.values()) job.reject(new PoolUnavailable(`a hash worker ${why}`));
    w.inFlight.clear();
    if (this.workers.length === 0) this.failAll(new PoolUnavailable(`every hash worker is gone (${why})`));
    else this.dispatch();
  }

  private cancel(job: Job): void {
    const i = this.waiting.indexOf(job);
    if (i >= 0) this.waiting.splice(i, 1);
    if (job.worker !== undefined && job.worker.inFlight.delete(job.id)) {
      try {
        job.worker.child.send({ cancel: job.id });
      } catch {
        // the worker is gone; nothing to cancel
      }
    }
    job.reject(abortError());
    this.dispatch();
  }

  private failAll(err: Error): void {
    const jobs = this.waiting;
    this.waiting = [];
    for (const job of jobs) job.reject(err);
  }

  private armIdle(): void {
    if (this.idleTimer !== undefined || this.waiting.length > 0) return;
    if (this.workers.some((w) => w.inFlight.size > 0)) return;
    this.idleTimer = setTimeout(() => this.shutdown("idle"), this.options.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }
}

type WorkerReply = {
  id?: number;
  ready?: boolean;
  sha256?: string;
  bytes?: number;
  cancelled?: boolean;
  error?: { message?: string; code?: string };
};

/**
 * A worker keeps Vortex's process alive only while it has work: an idle
 * worker's process and IPC channel are unreferenced, so they never hold
 * anything open on their own.
 */
function hold(w: PoolWorker, busy: boolean): void {
  const channel = (w.child as unknown as { channel?: { ref?: () => void; unref?: () => void } }).channel;
  if (busy) {
    w.child.ref();
    channel?.ref?.();
  } else {
    w.child.unref();
    channel?.unref?.();
  }
}

function abortError(): Error {
  return new AbortError();
}

/** `EH_HASH_POOL=0` turns the pool off (a support escape hatch). */
export function hashPoolEnabled(): boolean {
  return process.env["EH_HASH_POOL"] !== "0";
}

let shared: HashPool | undefined;

/** The one pool Event Horizon hashes with. */
export function getHashPool(): HashPool {
  shared ??= new HashPool();
  return shared;
}

/** Tests swap the pool (or pass undefined to go back to the default). */
export function setHashPoolForTests(pool: HashPool | undefined): void {
  shared?.shutdown("replaced");
  shared = pool;
}
