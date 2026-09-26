import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { checkRequest, startControlServer, type ControlServer, type ControlVerb } from "./controlServer";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-control-"));
let server: ControlServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function raw(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function start(verbs: Record<string, ControlVerb>, infoFile = path.join(dir, `c-${Math.random()}.json`)) {
  const mutated: string[] = [];
  const failed: string[] = [];
  server = await startControlServer({
    infoFile,
    verbs,
    version: "test",
    onMutated: (s) => mutated.push(s),
    onFailed: (v) => failed.push(v),
  });
  const auth = { authorization: `Bearer ${server.token}`, host: `127.0.0.1:${server.port}` };
  return { server, auth, infoFile, mutated, failed };
}

describe("checkRequest", () => {
  const good = { host: "127.0.0.1:5000", authorization: "Bearer tok" };
  it("accepts the right host and token", () => {
    expect(checkRequest(good, 5000, "tok").ok).toBe(true);
    expect(checkRequest({ ...good, host: "localhost:5000" }, 5000, "tok").ok).toBe(true);
  });
  it("refuses a browser request even with the right token", () => {
    expect(checkRequest({ ...good, origin: "https://evil.example" }, 5000, "tok")).toMatchObject({ status: 403 });
  });
  it("refuses a rebinding host name", () => {
    expect(checkRequest({ ...good, host: "evil.example:5000" }, 5000, "tok")).toMatchObject({ code: "host-refused" });
  });
  it("refuses a missing, wrong or partial token", () => {
    expect(checkRequest({ host: good.host }, 5000, "tok")).toMatchObject({ status: 401 });
    expect(checkRequest({ ...good, authorization: "Bearer tak" }, 5000, "tok")).toMatchObject({ status: 401 });
    expect(checkRequest({ ...good, authorization: "Bearer to" }, 5000, "tok")).toMatchObject({ status: 401 });
  });
});

describe("startControlServer", () => {
  it("writes control.json with a working token, and removes it on close", async () => {
    const { server: s, infoFile } = await start({});
    const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
    expect(info).toMatchObject({ port: s.port, token: s.token, url: `http://127.0.0.1:${s.port}/v1/` });
    const r = await raw(s.port, { path: "/v1/health", headers: { authorization: `Bearer ${info.token}` } });
    expect(r).toMatchObject({ status: 200, json: { ok: true, result: { version: "test" } } });
    await s.close();
    server = undefined;
    expect(fs.existsSync(infoFile)).toBe(false);
  });

  it("refuses requests without the token over a real socket", async () => {
    const { server: s } = await start({});
    const r = await raw(s.port, { path: "/v1/health" });
    expect(r.status).toBe(401);
  });

  it("runs a verb and reports a mutation once", async () => {
    const { server: s, auth, mutated } = await start({
      echo: { mutates: true, run: async (b) => ({ got: b["x"] }), describe: (b) => `echoed ${String(b["x"])}` },
    });
    const r = await raw(s.port, { method: "POST", path: "/v1/echo", headers: auth, body: '{"x":7}' });
    expect(r).toMatchObject({ status: 200, json: { ok: true, result: { got: 7 } } });
    expect(mutated).toEqual(["echoed 7"]);
  });

  it("passes a verb's refusal through with its code and status", async () => {
    const { server: s, auth, failed } = await start({
      nope: {
        mutates: true,
        run: async () => {
          throw Object.assign(new Error("game is running"), { code: "game-running", status: 409 });
        },
      },
    });
    const r = await raw(s.port, { method: "POST", path: "/v1/nope", headers: auth, body: "{}" });
    expect(r).toMatchObject({ status: 409, json: { ok: false, code: "game-running", message: "game is running" } });
    expect(failed).toEqual(["nope"]);
  });

  it("rejects bad JSON, unknown verbs, and GET on a mutating verb", async () => {
    const { server: s, auth } = await start({ m: { mutates: true, run: async () => ({}) } });
    expect((await raw(s.port, { method: "POST", path: "/v1/m", headers: auth, body: "[1]" })).status).toBe(400);
    expect((await raw(s.port, { method: "POST", path: "/v1/zzz", headers: auth, body: "{}" })).status).toBe(404);
    expect((await raw(s.port, { method: "GET", path: "/v1/m", headers: auth })).status).toBe(405);
  });

  it("runs commands one at a time, in arrival order", async () => {
    const log: string[] = [];
    const slow = (name: string, ms: number): ControlVerb => ({
      mutates: false,
      run: async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}:end`);
        return {};
      },
    });
    const { server: s, auth } = await start({ a: slow("a", 80), b: slow("b", 5) });
    const pa = raw(s.port, { method: "POST", path: "/v1/a", headers: auth, body: "{}" });
    await new Promise((r) => setTimeout(r, 10));
    const pb = raw(s.port, { method: "POST", path: "/v1/b", headers: auth, body: "{}" });
    await Promise.all([pa, pb]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("keeps serving after a verb throws", async () => {
    const { server: s, auth } = await start({
      boom: { mutates: false, run: async () => Promise.reject(new Error("x")) },
      ok: { mutates: false, run: async () => ({ fine: true }) },
    });
    await raw(s.port, { method: "POST", path: "/v1/boom", headers: auth, body: "{}" });
    const r = await raw(s.port, { method: "POST", path: "/v1/ok", headers: auth, body: "{}" });
    expect(r.json).toMatchObject({ ok: true, result: { fine: true } });
  });
});
