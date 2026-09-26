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

export type ControlVerb = {
  mutates: boolean;
  run: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  describe?: (body: Record<string, unknown>, result: Record<string, unknown>) => string;
};

export type ControlErrorShape = { code?: unknown; status?: unknown; message?: unknown };

export type ControlServerOptions = {
  /** Where control.json goes (port + token for clients). */
  infoFile: string;
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
  let port = 0;

  const server = http.createServer((req, res) => {
    void (async (): Promise<void> => {
      const check = checkRequest(req.headers, port, token);
      if (!check.ok) return send(res, check.status, { ok: false, code: check.code, message: check.message });

      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const m = /^\/v1\/([A-Za-z.]+)$/.exec(url.pathname);
      if (url.pathname === "/v1/health" && req.method === "GET") {
        return send(res, 200, { ok: true, result: { version: opts.version, verbs: Object.keys(opts.verbs) } });
      }
      const verbName = m?.[1] === undefined ? undefined : m[1];
      const verb = verbName !== undefined ? opts.verbs[verbName] : undefined;
      if (verbName === undefined || verb === undefined) {
        return send(res, 404, { ok: false, code: "no-such-verb", message: `Unknown path ${url.pathname}.` });
      }
      if (req.method !== "POST" && !(req.method === "GET" && !verb.mutates)) {
        return send(res, 405, { ok: false, code: "method", message: "Use POST (GET only for read verbs)." });
      }

      let body: Record<string, unknown>;
      try {
        body = req.method === "GET" ? {} : await readBody(req);
      } catch (err) {
        const e = err as ControlErrorShape;
        return send(res, Number(e.status) || 400, { ok: false, code: e.code, message: String(e.message) });
      }

      // One at a time: the next command starts when the previous settles.
      const run = queue.then(async () => {
        const started = Date.now();
        try {
          const result = await verb.run(body);
          ehLog("info", "control.verb.ok", { verb: verbName, ms: Date.now() - started });
          if (verb.mutates) opts.onMutated?.(verb.describe?.(body, result) ?? verbName);
          return { status: 200, payload: { ok: true, result } };
        } catch (err) {
          const e = err as ControlErrorShape;
          const message = String(e?.message ?? err);
          ehLog("warn", "control.verb.fail", { verb: verbName, code: e?.code, message, ms: Date.now() - started });
          if (verb.mutates) opts.onFailed?.(verbName, message);
          return {
            status: typeof e?.status === "number" ? e.status : 500,
            payload: { ok: false, code: typeof e?.code === "string" ? e.code : "error", message },
          };
        }
      });
      queue = run.catch(() => undefined);
      const out = await run;
      send(res, out.status, out.payload);
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
