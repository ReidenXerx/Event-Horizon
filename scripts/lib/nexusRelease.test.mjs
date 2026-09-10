/**
 * The release path's contracts: Vortex's version comparison (a prerelease
 * suffix is invisible to it), the zip Vortex reads, and the Nexus v3 upload
 * sequence — whose presigned PUT is rejected unless Content-Disposition and
 * Content-MD5 match what was declared. The fake Nexus here THROWS on a wrong
 * shape instead of tolerating it.
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  coerceVersion,
  findMainFile,
  isReleasableVersion,
  nexusClient,
  readZipEntry,
  vortexWouldOfferUpdate,
} from "./nexusRelease.mjs";

describe("versions, as Vortex compares them", () => {
  it("coerces like semver.coerce: the prerelease suffix disappears", () => {
    expect(coerceVersion("0.1.0-alpha.150")).toEqual([0, 1, 0]);
    expect(coerceVersion("v2")).toEqual([2, 0, 0]);
    expect(coerceVersion("no digits")).toBeUndefined();
  });

  it("never offers alpha.N → alpha.N+1, and does offer 0.1.151 over alpha.150", () => {
    expect(vortexWouldOfferUpdate("0.1.0-alpha.149", "0.1.0-alpha.150")).toBe(false);
    expect(vortexWouldOfferUpdate("0.1.0-alpha.150", "0.1.151")).toBe(true);
    expect(vortexWouldOfferUpdate("0.1.151", "0.1.151")).toBe(false);
    expect(vortexWouldOfferUpdate("0.1.152", "0.1.151")).toBe(false);
    expect(vortexWouldOfferUpdate(undefined, "0.1.151")).toBe(true);
  });

  it("releases only plain x.y.z", () => {
    expect(isReleasableVersion("0.1.151")).toBe(true);
    expect(isReleasableVersion("0.1.0-alpha.151")).toBe(false);
    expect(isReleasableVersion("0.1")).toBe(false);
  });
});

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("readZipEntry", () => {
  it("reads info.json at the archive root, stored or deflated", () => {
    const buf = zip([
      ["dist/index.js", "x", true],
      ["info.json", '{"version":"0.1.151"}', true],
      ["assets/a.txt", "y", false],
    ]);
    expect(JSON.parse(readZipEntry(buf, "info.json").toString()).version).toBe("0.1.151");
    expect(readZipEntry(buf, "assets/a.txt").toString()).toBe("y");
  });

  it("does not accept info.json one folder down — Vortex would not either", () => {
    expect(readZipEntry(zip([["event-horizon/info.json", "{}", false]]), "info.json")).toBeUndefined();
  });
});

/** A strict fake of the v3 upload sequence. */
function fakeNexus({ stateSequence = ["created", "available"] } = {}) {
  const calls = [];
  const bytesSeen = {};
  const json = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify({ data }) });
  let states = [...stateSequence];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url.replace("https://api.nexusmods.com/v3", "")}`);
    if (url.startsWith("https://storage.example/")) {
      const h = init.headers;
      if (h["content-disposition"] !== 'attachment; filename="event-horizon-0.1.151.zip"') throw new Error("bad Content-Disposition");
      if (h["content-md5"] !== bytesSeen.md5b64) throw new Error("bad Content-MD5");
      // Signed by the presigned URL; the live storage rejects any other value.
      if (h["content-type"] !== "application/octet-stream") {
        return { ok: false, status: 403, text: async () => "<Error><Code>SignatureDoesNotMatch</Code></Error>" };
      }
      return { ok: true, status: 200, text: async () => "" };
    }
    if (init.headers.apikey !== "KEY") throw new Error("missing apikey header");
    if (url.endsWith("/uploads") && init.method === "POST") {
      const body = JSON.parse(init.body);
      if (typeof body.size_bytes !== "number" || !/^[0-9a-f]{32}$/.test(body.md5) || !body.filename) throw new Error("bad createUpload body");
      bytesSeen.md5b64 = Buffer.from(body.md5, "hex").toString("base64");
      return json(201, { id: "u-1", state: "created", presigned_url: "https://storage.example/put?sig=secret" });
    }
    if (url.endsWith("/uploads/u-1/finalise")) return json(200, { id: "u-1", state: "created" });
    if (url.endsWith("/uploads/u-1")) return json(200, { id: "u-1", state: states.shift() ?? "available" });
    if (url.endsWith("/mod-files/f-1/versions") && init.method === "POST") {
      const body = JSON.parse(init.body);
      for (const k of ["upload_id", "name", "version", "file_category"]) if (!body[k]) throw new Error(`missing ${k}`);
      return json(201, { file: { id: "f-1" }, version: { id: "v-new", position: "2" } });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ title: "Not Found", detail: url }) };
  };
  return { fetchImpl, calls };
}

describe("nexusClient.uploadArchive", () => {
  it("creates, PUTs with the signed headers, finalises, waits for available", async () => {
    const { fetchImpl, calls } = fakeNexus({ stateSequence: ["created", "created", "available"] });
    const client = nexusClient({ apiKey: "KEY", fetchImpl, sleep: async () => undefined });
    const bytes = Buffer.from("zip bytes");
    const id = await client.uploadArchive({ bytes, filename: "event-horizon-0.1.151.zip" });
    expect(id).toBe("u-1");
    expect(calls).toEqual([
      "POST /uploads",
      "PUT https://storage.example/put?sig=secret",
      "POST /uploads/u-1/finalise",
      "GET /uploads/u-1",
      "GET /uploads/u-1",
      "GET /uploads/u-1",
    ]);
    expect(createHash("md5").update(bytes).digest("hex")).toHaveLength(32);
  });

  it("surfaces Nexus's problem details on an error", async () => {
    const client = nexusClient({ apiKey: "KEY", fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ title: "Forbidden", detail: "not your mod" }) }) });
    await expect(client.getMod("site", "2235")).rejects.toThrow(/403: Forbidden — not your mod/);
  });

  it("refuses to run without a key", () => {
    expect(() => nexusClient({ apiKey: "  " })).toThrow(/No Nexus API key/);
  });
});

describe("findMainFile", () => {
  const client = (files, versionsById) => ({
    getModFiles: async () => ({ mod_files: files }),
    getModFileVersions: async (id) => ({ versions: versionsById[id] ?? [] }),
  });

  it("picks the single active file whose newest version is main", async () => {
    const found = await findMainFile(
      client(
        [{ id: "f-1", name: "Event Horizon" }, { id: "f-2", name: "Old", is_active: true }],
        {
          "f-1": [
            { id: "v1", version: "0.1.0-alpha.149", category: "archived", uploaded_at: "2026-09-01" },
            { id: "v2", version: "0.1.0-alpha.150", category: "main", uploaded_at: "2026-09-11" },
          ],
          "f-2": [{ id: "v0", version: "0.0.1", category: "archived", uploaded_at: "2026-01-01" }],
        },
      ),
      "m-1",
    );
    expect(found.file.id).toBe("f-1");
    expect(found.latest.version).toBe("0.1.0-alpha.150");
  });

  it("uses the only chain even when its newest version was archived — the real page's state", async () => {
    // site/mods/2235 as the API returned it: alpha.94 archived, alpha.85 old_version, alpha.20 archived.
    const found = await findMainFile(
      client([{ id: "7906317", name: "Event Horizon 0.1.0 Alpha.20", is_active: false }], {
        "7906317": [
          { id: "v94", version: "0.1.2", category: "archived", position: "3.0", uploaded_at: "2026-09-07T01:40:24.000+00:00" },
          { id: "v85", version: "0.1.1", category: "old_version", position: "2.0", uploaded_at: "2026-09-06T23:08:20.000+00:00" },
          { id: "v20", version: "0.1.0", category: "archived", position: "1.0", uploaded_at: "2026-09-03T19:51:31.000+00:00" },
        ],
      }),
      "m",
    );
    expect(found.file.id).toBe("7906317");
    expect(found.latest.id).toBe("v94");
  });

  it("orders a chain by position, not by upload time", async () => {
    const found = await findMainFile(
      client([{ id: "f-1", name: "A" }], {
        "f-1": [
          { id: "moved-later", category: "main", position: "2.0", uploaded_at: "2026-01-01" },
          { id: "uploaded-later", category: "old_version", position: "1.0", uploaded_at: "2026-09-01" },
        ],
      }),
      "m",
    );
    expect(found.latest.id).toBe("moved-later");
  });

  it("refuses when there is no chain, or several and not exactly one in Main Files", async () => {
    await expect(findMainFile(client([{ id: "f-1", name: "A" }], { "f-1": [] }), "m")).rejects.toThrow(/0 chain/);
    const two = { "f-1": [{ id: "a", category: "main", uploaded_at: "1" }], "f-2": [{ id: "b", category: "main", uploaded_at: "1" }] };
    await expect(findMainFile(client([{ id: "f-1", name: "A" }, { id: "f-2", name: "B" }], two), "m")).rejects.toThrow(/2 with a main/);
  });
});
