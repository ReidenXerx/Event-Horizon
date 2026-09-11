// Write a mod page's description (and summary) on Nexus, through a browser
// logged into Nexus. By default the page is Event Horizon's own: the text is
// docs/NEXUS_MOD_PAGE.bbcode and the summary is package.json's description.
//
// The Nexus v3 API exposes mods read-only, so the description can only be
// written through the website. This drives a browser over the DevTools
// Protocol; it never reads cookies or passwords. It opens its OWN tab and
// closes it at the end, so no tab you have open is navigated away.
//
// Use a DEDICATED browser profile, never your everyday one. While a browser
// listens on a debugging port, any program running on this machine — not only
// this script — can connect without a password, read that profile's cookies
// for every site and act as you on each of them. A profile that is only ever
// logged into Nexus limits that to Nexus, and closing it closes the port.
//
//   1. Start the browser on its own profile folder, with the port. The first
//      time, log into Nexus in the window it opens; the profile keeps the login.
//      Brave:
//        "%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe" ^
//            --user-data-dir="%LOCALAPPDATA%\EventHorizon\nexus-browser-profile" ^
//            --remote-debugging-port=9222
//      (Edge: "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" with
//       the same two switches.) It runs as a separate browser beside any you
//      already have open; those are not touched and get no port.
//   2. node scripts/nexus-page.mjs            # dry run: fills, reports, does not save
//      node scripts/nexus-page.mjs --save     # fills, saves, reloads and verifies
//
//      Another page (a collection's landing page) — its text is not in this
//      repository, so read it first, edit the file, then write it back:
//      node scripts/nexus-page.mjs --game fallout4 --mod 108944 --dump page.bbcode
//      node scripts/nexus-page.mjs --game fallout4 --mod 108944 --description-file page.bbcode [--save]
//      Its summary is left as it is unless --summary-file is given.
//   3. Close that browser when you are done. The port is open for as long as it runs.
//
// The editor is SCEditor; the text goes in through its SOURCE mode with real
// input events, so the BBCode is stored exactly as written (the WYSIWYG mode
// re-serialises and used to nest [center][left][center] around everything).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Open a fresh tab through the DevTools HTTP endpoint, hand it to `fn`, and
 * close it afterwards whatever `fn` did. The first version took over
 * whichever tab the browser listed first — an open tab of the user's own.
 */
export async function withNewTab({ base, fetchImpl = fetch, warn = (m) => console.error(m) }, fn) {
  // Chromium answers GET /json/new with 405 since version 111; it must be PUT.
  const res = await fetchImpl(`${base}/json/new?about:blank`, { method: "PUT" });
  if (!res.ok) throw new Error(`The browser refused to open a tab: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const target = await res.json();
  if (typeof target?.id !== "string" || typeof target?.webSocketDebuggerUrl !== "string") {
    throw new Error("The browser opened a tab but did not say how to connect to it");
  }
  try {
    return await fn(target);
  } finally {
    try {
      const closed = await fetchImpl(`${base}/json/close/${encodeURIComponent(target.id)}`);
      if (!closed.ok) warn(`Could not close the tab this script opened (HTTP ${closed.status}); close it by hand.`);
    } catch (err) {
      warn(`Could not close the tab this script opened (${err.message}); close it by hand.`);
    }
  }
}

/** Text as compared after a save: line endings and trailing whitespace are not content. */
export function normalizeText(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * Where the page's text first differs from what was written, or undefined when
 * they are the same text. "Saved and verified" used to mean the lengths were
 * within 64 characters of each other, which any same-length edit passes.
 */
export function firstDifference(expected, actual) {
  const a = normalizeText(expected).split("\n");
  const b = normalizeText(actual).split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return { line: i + 1, expected: a[i] ?? "(end of text)", actual: b[i] ?? "(end of text)" };
  }
  return undefined;
}

/**
 * Which page, which text, and what to do with it. Returns `{ error }` for a
 * command line that would do something other than what it says.
 *
 * Without --game/--mod the page is Event Horizon's own (package.json "nexus"),
 * with its description file and summary. Any other page's text lives only on
 * Nexus, so writing one needs an explicit --description-file (read it first
 * with --dump), and its summary is not touched unless --summary-file is given.
 */
export function parseArgs(argv, pkg) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? null : v;
  };
  const flags = ["--game", "--mod", "--description-file", "--summary-file", "--dump"];
  for (const f of flags) {
    if (value(f) === null) return { error: `${f} needs a value` };
  }
  const known = new Set([...flags, "--save"]);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    if (!known.has(argv[i])) return { error: `Unknown option ${argv[i]}` };
  }
  const save = argv.includes("--save");
  const dumpFile = value("--dump");
  const game = value("--game");
  const mod = value("--mod");
  if ((game === undefined) !== (mod === undefined)) return { error: "--game and --mod go together" };
  if (dumpFile !== undefined && save) return { error: "--dump only reads the page; it cannot be combined with --save" };

  const own = pkg?.nexus ?? {};
  const gameDomain = game ?? own.gameDomain;
  const modId = mod ?? own.modId;
  if (!gameDomain || !modId) return { error: 'package.json needs "nexus": { "gameDomain", "modId" }, or pass --game and --mod' };
  if (!/^\d+$/.test(String(modId))) return { error: `--mod must be the page's number, not ${JSON.stringify(modId)}` };
  const isOwnPage = game === undefined || (game === own.gameDomain && String(mod) === String(own.modId));

  const descriptionFile = value("--description-file") ?? (isOwnPage ? path.join("docs", "NEXUS_MOD_PAGE.bbcode") : undefined);
  if (dumpFile === undefined && descriptionFile === undefined) {
    return { error: "Another page's text is not in this repository: read it with --dump <file>, edit the file, then pass --description-file <file>" };
  }
  const summaryFile = value("--summary-file");
  return {
    save,
    dumpFile,
    gameDomain,
    modId: String(modId),
    descriptionFile: dumpFile === undefined ? descriptionFile : undefined,
    summaryFile,
    // The own page's summary is package.json's description unless a file says otherwise.
    useOwnSummary: isOwnPage && summaryFile === undefined && dumpFile === undefined,
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error("could not connect to the tab"));
  });
}

async function editPage(ws, { editUrl, summary, bbcode, save, dumpFile, gameDomain, modId }) {
  let seq = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        ws.removeEventListener("message", onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readPage = () =>
    evalJs(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t._sceditor);
      return { description: ta ? ta.value : null, summary: document.querySelector('#short-description')?.value ?? null };
    })()`);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: editUrl });
  await sleep(9000);
  const where = await evalJs("location.href");
  if (!where.includes("/edit/")) {
    console.error(`Not on the edit page (landed on ${where}). Is this profile logged into Nexus as the mod's owner?`);
    return 2;
  }

  if (dumpFile !== undefined) {
    const page = await readPage();
    if (page.description === null) {
      console.error("The edit page has no description editor that this script recognises; nothing was written.");
      return 2;
    }
    fs.writeFileSync(dumpFile, normalizeText(page.description) + "\n", "utf8");
    if (page.summary !== null) fs.writeFileSync(`${dumpFile}.summary.txt`, normalizeText(page.summary) + "\n", "utf8");
    console.log(`Read ${gameDomain}/${modId}: description (${normalizeText(page.description).length} chars) → ${dumpFile}` +
      (page.summary !== null ? `; summary → ${dumpFile}.summary.txt` : ""));
    return 0;
  }

  // Summary: a React-controlled textarea — native setter + input event. Left
  // alone when no summary was given for this page.
  if (summary !== undefined) {
    await evalJs(`(() => {
      const sd = document.querySelector('#short-description');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(sd, ${JSON.stringify(summary)});
      sd.dispatchEvent(new Event('input', { bubbles: true }));
      return sd.value.length;
    })()`);
  }

  // Description: SCEditor source mode, select all, real text insertion.
  await evalJs(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t._sceditor);
    const inst = window.sceditor.instance(ta);
    inst.sourceMode(true);
    const src = document.querySelector('.sceditor-container textarea');
    src.focus(); src.select();
    return true;
  })()`);
  await send("Input.insertText", { text: bbcode });
  const state = await evalJs(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t._sceditor);
    const inst = window.sceditor.instance(ta);
    document.querySelector('.sceditor-container textarea').blur();
    return { descLen: inst.val().length, summaryLen: document.querySelector('#short-description').value.length,
             saveEnabled: [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Save').some((b) => !b.disabled) };
  })()`);
  console.log(`Filled ${gameDomain}/${modId}: description ${state.descLen} chars, summary ${state.summaryLen} chars${summary === undefined ? " (left as it was)" : ""}, Save ${state.saveEnabled ? "enabled" : "DISABLED"}.`);

  if (!save) {
    console.log("Dry run: nothing saved. Re-run with --save to submit.");
    return 0;
  }
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save' && !x.disabled); b && b.click(); return !!b; })()`);
  await sleep(6000);
  await send("Page.navigate", { url: editUrl });
  await sleep(9000);
  const back = await readPage();
  const summaryDiff = summary === undefined ? undefined : firstDifference(summary, back.summary);
  const descriptionDiff = firstDifference(bbcode, back.description);
  if (summaryDiff === undefined && descriptionDiff === undefined) {
    console.log(`Saved and verified: the page holds exactly the ${normalizeText(bbcode).length}-character description${summary === undefined ? "" : " and the summary"}.`);
  } else {
    for (const [what, d] of [["summary", summaryDiff], ["description", descriptionDiff]]) {
      if (d !== undefined) console.log(`Saved, but the page's ${what} differs at line ${d.line}:\n  written: ${JSON.stringify(d.expected)}\n  on page: ${JSON.stringify(d.actual)}`);
    }
  }
  console.log(`Public page: https://www.nexusmods.com/${gameDomain}/mods/${modId}?tab=description`);
  return summaryDiff === undefined && descriptionDiff === undefined ? 0 : 1;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const port = process.env.CDP_PORT ?? "9222";
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const args = parseArgs(process.argv.slice(2), pkg);
  if (args.error !== undefined) {
    console.error(args.error);
    return 2;
  }
  const readText = (file) => fs.readFileSync(path.isAbsolute(file) ? file : path.join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
  const bbcode = args.descriptionFile === undefined ? undefined : readText(args.descriptionFile);
  const summary = args.summaryFile !== undefined ? readText(args.summaryFile).trim() : args.useOwnSummary ? (pkg.description ?? "") : undefined;
  const { gameDomain, modId } = args;
  const editUrl = `https://www.nexusmods.com/games/${gameDomain}/mods/${modId}/edit/general`;
  const base = `http://127.0.0.1:${port}`;
  try {
    const version = await fetch(`${base}/json/version`);
    if (!version.ok) throw new Error(`HTTP ${version.status}`);
  } catch {
    console.error(`No browser is listening on port ${port}. Start the dedicated profile with --remote-debugging-port=${port} (see the header of this script).`);
    return 2;
  }
  try {
    return await withNewTab({ base }, async (tab) => {
      const ws = await connect(tab.webSocketDebuggerUrl);
      try {
        return await editPage(ws, { editUrl, summary, bbcode, save: args.save, dumpFile: args.dumpFile, gameDomain, modId });
      } finally {
        ws.close();
      }
    });
  } finally {
    console.log(`Done with the browser: close the one you started with --remote-debugging-port=${port}. Until it is closed, any program on this machine can drive it.`);
  }
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invoked) process.exit(await main());
