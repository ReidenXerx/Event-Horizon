/**
 * The operation log: every command an agent sends gets an id and a record it
 * can ask about later.
 *
 * Without it, an agent whose connection dropped halfway through a deploy
 * could not tell "it failed" from "it finished and I missed the reply", so it
 * had to re-read and guess. With it, `ops.get` answers from the record, and
 * `async: true` lets a long command run without holding a connection open at
 * all.
 *
 * Kept in memory (the last MAX_OPS) and appended to control-ops.jsonl when
 * each one ends, so the owner can also read what agents did after the fact.
 */

import * as crypto from "crypto";
import * as fs from "fs";

export type OpStatus = "queued" | "running" | "succeeded" | "failed";

export type OpRecord = {
  opId: string;
  verb: string;
  status: OpStatus;
  body: Record<string, unknown>;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  ms?: number;
  /** The HTTP status the reply carried (or would have, for async). */
  httpStatus?: number;
  result?: Record<string, unknown>;
  code?: string;
  message?: string;
  /** On failure: what DID happen (steps completed, mods removed before the error, Vortex notifications). */
  details?: Record<string, unknown>;
  /** One line a person can read: the verb's own description of what it did. */
  summary?: string;
  /** Changes the setup (a read otherwise). */
  mutates?: boolean;
};

export const MAX_OPS = 500;

export class OpLog {
  private readonly ops = new Map<string, OpRecord>();
  private readonly listeners = new Set<(op: OpRecord) => void>();

  constructor(private readonly journalFile?: string) {
    // History survives a restart: the Agents page shows what agents did before this start too.
    if (journalFile !== undefined) {
      // Read first, then rotate: the history still shows on the start that moves it.
      for (const op of readOpsJournal(journalFile, 100)) this.ops.set(op.opId, op);
      rotateOpsJournal(journalFile);
    }
  }

  /** Called on every create/start/finish; returns an unsubscribe. */
  subscribe(fn: (op: OpRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(op: OpRecord): void {
    for (const fn of this.listeners) {
      try {
        fn(op);
      } catch {
        // A broken listener must not fail the command it is watching.
      }
    }
  }

  create(verb: string, body: Record<string, unknown>): OpRecord {
    const op: OpRecord = {
      opId: `op-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      verb,
      status: "queued",
      body,
      queuedAt: new Date().toISOString(),
    };
    this.ops.set(op.opId, op);
    while (this.ops.size > MAX_OPS) this.ops.delete(this.ops.keys().next().value as string);
    this.emit(op);
    return op;
  }

  start(op: OpRecord): void {
    op.status = "running";
    op.startedAt = new Date().toISOString();
    this.emit(op);
  }

  finish(
    op: OpRecord,
    end: { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string; httpStatus: number; details?: Record<string, unknown> },
  ): void {
    op.endedAt = new Date().toISOString();
    op.ms = Date.parse(op.endedAt) - Date.parse(op.startedAt ?? op.queuedAt);
    if (end.ok) {
      op.status = "succeeded";
      op.httpStatus = 200;
      op.result = end.result;
    } else {
      op.status = "failed";
      op.httpStatus = end.httpStatus;
      op.code = end.code;
      op.message = end.message;
      if (end.details !== undefined) op.details = end.details;
    }
    if (this.journalFile !== undefined) {
      try {
        fs.appendFileSync(this.journalFile, `${JSON.stringify(op)}\n`, "utf8");
      } catch {
        // The in-memory record still answers; a full disk must not fail the command.
      }
    }
    this.emit(op);
  }

  get(opId: string): OpRecord | undefined {
    return this.ops.get(opId);
  }

  /** Newest first. */
  list(filter: { verb?: string; status?: OpStatus; limit?: number; mutatingOnly?: (verb: string) => boolean } = {}): OpRecord[] {
    const out = [...this.ops.values()].reverse().filter(
      (o) =>
        (filter.verb === undefined || o.verb === filter.verb) &&
        (filter.status === undefined || o.status === filter.status) &&
        (filter.mutatingOnly === undefined || filter.mutatingOnly(o.verb)),
    );
    return out.slice(0, Math.max(1, Math.min(filter.limit ?? 50, MAX_OPS)));
  }
}

/**
 * How much of the journal's END is read for its last ops.
 *
 * The whole file was read before, at every start: by 11-15 it held 80,377 ops
 * (1.1 GB) and the Vortex window ran out of memory four times in a row and
 * stayed down. An op line is a few KB (a `state` reply a few hundred); the
 * tail read gets fewer than `limit` only for a journal of giant lines.
 */
export const JOURNAL_TAIL_BYTES = 16 * 1024 * 1024;

/** A journal past this is moved aside (one previous kept) when the log opens. */
export const JOURNAL_ROTATE_BYTES = 64 * 1024 * 1024;

/** Moves an oversized journal to `<name>.previous.jsonl`, replacing an older one. Returns whether it did. */
export function rotateOpsJournal(file: string, maxBytes: number = JOURNAL_ROTATE_BYTES): boolean {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.renameSync(file, file.replace(/\.jsonl$/, "") + ".previous.jsonl");
    return true;
  } catch {
    return false;
  }
}

/** The last `bytes` of a file as text; the first, possibly cut, line is dropped when the read starts mid-file. */
function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    fs.closeSync(fd);
  }
}

/** The last `limit` finished ops in a journal, oldest first. A broken line is skipped, a missing file is none. */
export function readOpsJournal(file: string, limit: number, tailBytes: number = JOURNAL_TAIL_BYTES): OpRecord[] {
  let text: string;
  try {
    text = readTail(file, tailBytes);
  } catch {
    return [];
  }
  const out: OpRecord[] = [];
  for (const line of text.split(/\r?\n/).slice(-limit - 1)) {
    if (line.trim() === "") continue;
    try {
      const op = JSON.parse(line) as OpRecord;
      if (typeof op.opId === "string" && typeof op.verb === "string") out.push(op);
    } catch {
      // A line cut short by a crash.
    }
  }
  return out.slice(-limit);
}

/** The reply every command gets: the op record, shaped for a client. */
export function envelope(op: OpRecord): Record<string, unknown> {
  const base = { ok: op.status === "succeeded", opId: op.opId, verb: op.verb, status: op.status };
  if (op.status === "queued" || op.status === "running") return { ...base, queuedAt: op.queuedAt };
  return op.status === "succeeded"
    ? { ...base, ms: op.ms, result: op.result }
    : { ...base, ms: op.ms, code: op.code, message: op.message, ...(op.details ? { details: op.details } : {}) };
}
