// Push docs/NEXUS_MOD_PAGE.bbcode (and package.json's description as the
// summary) onto the mod's Nexus page, through a browser logged into Nexus.
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

function connect(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error("could not connect to the tab"));
  });
}

async function editPage(ws, { editUrl, summary, bbcode, save, gameDomain, modId }) {
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

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: editUrl });
  await sleep(9000);
  const where = await evalJs("location.href");
  if (!where.includes("/edit/")) {
    console.error(`Not on the edit page (landed on ${where}). Is this profile logged into Nexus as the mod's owner?`);
    return 2;
  }

  // Summary: a React-controlled textarea — native setter + input event.
  await evalJs(`(() => {
    const sd = document.querySelector('#short-description');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(sd, ${JSON.stringify(summary)});
    sd.dispatchEvent(new Event('input', { bubbles: true }));
    return sd.value.length;
  })()`);

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
  console.log(`Filled: description ${state.descLen} chars, summary ${state.summaryLen} chars, Save ${state.saveEnabled ? "enabled" : "DISABLED"}.`);

  if (!save) {
    console.log("Dry run: nothing saved. Re-run with --save to submit.");
    return 0;
  }
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save' && !x.disabled); b && b.click(); return !!b; })()`);
  await sleep(6000);
  await send("Page.navigate", { url: editUrl });
  await sleep(9000);
  const back = await evalJs(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t._sceditor);
    return { description: ta.value, summary: document.querySelector('#short-description').value };
  })()`);
  const summaryDiff = firstDifference(summary, back.summary);
  const descriptionDiff = firstDifference(bbcode, back.description);
  if (summaryDiff === undefined && descriptionDiff === undefined) {
    console.log(`Saved and verified: the page holds exactly the ${normalizeText(bbcode).length}-character description and the summary.`);
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
  const save = process.argv.includes("--save");
  const port = process.env.CDP_PORT ?? "9222";
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const { gameDomain, modId } = pkg.nexus ?? {};
  if (!gameDomain || !modId) {
    console.error('package.json needs "nexus": { "gameDomain", "modId" } to know which page to edit.');
    return 2;
  }
  const bbcode = fs.readFileSync(path.join(root, "docs", "NEXUS_MOD_PAGE.bbcode"), "utf8").replace(/\r\n/g, "\n");
  const summary = pkg.description ?? "";
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
        return await editPage(ws, { editUrl, summary, bbcode, save, gameDomain, modId });
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
