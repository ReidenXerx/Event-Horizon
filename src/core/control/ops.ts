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
};

export const MAX_OPS = 500;

export class OpLog {
  private readonly ops = new Map<string, OpRecord>();

  constructor(private readonly journalFile?: string) {}

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
    return op;
  }

  start(op: OpRecord): void {
    op.status = "running";
    op.startedAt = new Date().toISOString();
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

/** The reply every command gets: the op record, shaped for a client. */
export function envelope(op: OpRecord): Record<string, unknown> {
  const base = { ok: op.status === "succeeded", opId: op.opId, verb: op.verb, status: op.status };
  if (op.status === "queued" || op.status === "running") return { ...base, queuedAt: op.queuedAt };
  return op.status === "succeeded"
    ? { ...base, ms: op.ms, result: op.result }
    : { ...base, ms: op.ms, code: op.code, message: op.message, ...(op.details ? { details: op.details } : {}) };
}
