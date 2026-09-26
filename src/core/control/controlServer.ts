/**
 * The local control channel: a small HTTP server inside Vortex that lets the
 * owner's agents read state and run the verbs in `verbs.ts`.
 *
 * Vortex has no way to be driven from outside while it runs (its CLI only
 * edits state while it is CLOSED), so agents could not deploy, switch
 * profiles or repoint a game, and the owner clicked every step.
 *
 * The trust boundary, all of it enforced here:
 *   - bound to 127.0.0.1 only, on a port the OS picks;
 *   - a fresh random token every start, written with the port to
 *     <Vortex userData>/event-horizon/control.json and required as
 *     `Authorization: Bearer <token>` on every request;
 *   - any request carrying an `Origin` header is refused, and the `Host`
 *     header must name this loopback port: a web page can reach localhost,
 *     but it cannot send the token, and this closes DNS rebinding too;
 *   - off unless the user turns it on (poll, 2026-09-26).
 *
 * Commands run one at a time. Vortex cannot purge and deploy at once, and
 * concurrency is exactly how it lost files in bulk before.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import { envelope, MAX_OPS, OpLog, type OpStatus } from "./ops";

export type ControlVerb = {
  mutates: boolean;
  run: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  describe?: (body: Record<string, unknown>, result: Record<string, unknown>) => string;
};

export type ControlErrorShape = { code?: unknown; status?: unknown; message?: unknown; details?: unknown };

export type ControlServerOptions = {
  /** Where control.json goes (port + token for clients). */
  infoFile: string;
  /** Where finished operations are appended (JSON lines); none in tests. */
  opsJournal?: string;
  verbs: Record<string, ControlVerb>;
  version: string;
  /** Called after a mutating verb succeeds (Vortex notification). */
  onMutated?: (summary: string) => void;
  /** Called after a mutating verb fails. */
  onFailed?: (verb: string, message: string) => void;
};

export type ControlServer = { port: number; token: string; close: () => Promise<void> };

const MAX_BODY = 1024 * 1024;

export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The request checks, pure so they can be tested without a socket. */
export function checkRequest(
  headers: http.IncomingHttpHeaders,
  port: number,
  token: string,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (headers.origin !== undefined) {
    return { ok: false, status: 403, code: "origin-refused", message: "Browser requests are not accepted." };
  }
  const host = String(headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 403, code: "host-refused", message: "Wrong Host header." };
  }
  const auth = String(headers.authorization ?? "");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m === null || !tokensEqual(m[1]!.trim(), token)) {
    return { ok: false, status: 401, code: "unauthorized", message: "Missing or wrong token (see control.json)." };
  }
  return { ok: true };
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request body over 1 MB."), { code: "too-large", status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") return resolve({});
      try {
        const v = JSON.parse(text) as unknown;
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        resolve(v as Record<string, unknown>);
      } catch {
        reject(Object.assign(new Error("Body must be a JSON object."), { code: "bad-json", status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const token = crypto.randomBytes(32).toString("hex");
  let queue: Promise<unknown> = Promise.resolve();
  const ops = new OpLog(opts.opsJournal);
  let port = 0;

  const server = http.createServer((req, res) => {
    void (async (): Promise<void> => {
      const check = checkRequest(req.headers, port, token);
      if (!check.ok) return send(res, check.status, { ok: false, code: check.code, message: check.message });

      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const m = /^\/v1\/([A-Za-z.]+)$/.exec(url.pathname);
      const verbName = m?.[1];
      if (verbName === "health" && req.method === "GET") {
        return send(res, 200, {
          ok: true,
          result: {
            version: opts.version,
            verbs: Object.fromEntries(Object.entries(opts.verbs).map(([k, v]) => [k, v.mutates ? "mutates" : "reads"])),
            running: ops.list({ status: "running", limit: 5 }).map((o) => o.opId),
            queued: ops.list({ status: "queued", limit: 50 }).length,
          },
        });
      }

      let body: Record<string, unknown>;
      try {
        body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readBody(req);
      } catch (err) {
        const e = err as ControlErrorShape;
        return send(res, Number(e.status) || 400, { ok: false, code: e.code, message: String(e.message) });
      }

      // The op log answers straight away, never behind a queued command:
      // it is how an agent watches a long one.
      if (verbName === "ops.get") {
        const op = ops.get(String(body["opId"] ?? ""));
        return op === undefined
          ? send(res, 404, { ok: false, code: "no-such-op", message: `No operation ${String(body["opId"])} (kept: the last ${MAX_OPS}).` })
          : send(res, 200, { ok: true, result: { ...envelope(op), body: op.body, queuedAt: op.queuedAt, startedAt: op.startedAt, endedAt: op.endedAt } });
      }
      if (verbName === "ops.list") {
        const status = typeof body["status"] === "string" ? (body["status"] as OpStatus) : undefined;
        const list = ops.list({
          ...(typeof body["verb"] === "string" ? { verb: body["verb"] } : {}),
          ...(status !== undefined ? { status } : {}),
          limit: Number(body["limit"]) || 50,
          ...(body["includeReads"] === true || body["includeReads"] === "true"
            ? {}
            : { mutatingOnly: (v: string) => opts.verbs[v]?.mutates === true }),
        });
        return send(res, 200, { ok: true, result: { ops: list.map(envelope) } });
      }

      const verb = verbName !== undefined ? opts.verbs[verbName] : undefined;
      if (verbName === undefined || verb === undefined) {
        return send(res, 404, { ok: false, code: "no-such-verb", message: `Unknown path ${url.pathname}.` });
      }
      if (req.method !== "POST" && !(req.method === "GET" && !verb.mutates)) {
        return send(res, 405, { ok: false, code: "method", message: "Use POST (GET only for read verbs)." });
      }

      const asyncMode = body["async"] === true;
      const op = ops.create(verbName, body);
      const execute = async (): Promise<void> => {
        ops.start(op);
        try {
          const result = await verb.run(body);
          ops.finish(op, { ok: true, result });
          ehLog("info", "control.verb.ok", { verb: verbName, opId: op.opId, ms: op.ms });
          if (verb.mutates) opts.onMutated?.(verb.describe?.(body, result) ?? verbName);
        } catch (err) {
          const e = err as ControlErrorShape;
          const message = String(e?.message ?? err);
          const code = typeof e?.code === "string" ? e.code : "error";
          ops.finish(op, {
            ok: false,
            code,
            message,
            httpStatus: typeof e?.status === "number" ? e.status : 500,
            ...(e?.details !== null && typeof e?.details === "object" ? { details: e.details as Record<string, unknown> } : {}),
          });
          ehLog("warn", "control.verb.fail", { verb: verbName, opId: op.opId, code, message, ms: op.ms });
          if (verb.mutates) opts.onFailed?.(verbName, message);
        }
      };

      // Changes run one at a time: the next starts when the previous settles.
      // Reads do not wait behind them, so an agent can watch a long deploy.
      let run: Promise<void>;
      if (verb.mutates) {
        run = queue.then(execute);
        queue = run.catch(() => undefined);
      } else {
        run = execute();
      }

      if (asyncMode) return send(res, 202, envelope(op));
      await run;
      send(res, op.httpStatus ?? 500, envelope(op));
    })().catch((err) => {
      ehLog("error", "control.request.crash", { err });
      if (!res.headersSent) send(res, 500, { ok: false, code: "crash", message: String((err as Error)?.message) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;

  fs.mkdirSync(path.dirname(opts.infoFile), { recursive: true });
  const info = {
    url: `http://127.0.0.1:${port}/v1/`,
    port,
    token,
    pid: process.pid,
    version: opts.version,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(opts.infoFile, JSON.stringify(info, null, 2), "utf8");
  ehLog("info", "control.start", { port, infoFile: opts.infoFile, verbs: Object.keys(opts.verbs).length });

  return {
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          // Only our own file: a newer instance may already have written its own.
          const cur = JSON.parse(fs.readFileSync(opts.infoFile, "utf8")) as { token?: string };
          if (cur.token === token) fs.unlinkSync(opts.infoFile);
        } catch {
          // Already gone.
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
        ehLog("info", "control.stop", { port });
      }),
  };
}
