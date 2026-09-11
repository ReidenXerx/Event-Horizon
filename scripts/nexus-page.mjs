// Push docs/NEXUS_MOD_PAGE.bbcode (and package.json's description as the
// summary) onto the mod's Nexus page, through YOUR browser.
//
// The Nexus v3 API exposes mods read-only, so the description can only be
// written through the website. This drives a browser you are already logged
// into over the DevTools Protocol; it never touches cookies or passwords.
//
//   1. Close the browser completely.
//   2. Start it with the debugging port on its normal profile, e.g. Brave:
//        "%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe" ^
//            --remote-debugging-port=9222 ^
//            --user-data-dir="%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data"
//      (Edge: "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" with
//       --user-data-dir="%LOCALAPPDATA%\Microsoft\Edge\User Data".)
//   3. node scripts/nexus-page.mjs            # dry run: fills, reports, does not save
//      node scripts/nexus-page.mjs --save     # fills, saves, reloads and verifies
//
// The editor is SCEditor; the text goes in through its SOURCE mode with real
// input events, so the BBCode is stored exactly as written (the WYSIWYG mode
// re-serialises and used to nest [center][left][center] around everything).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const save = process.argv.includes("--save");
const port = process.env.CDP_PORT ?? "9222";
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const { gameDomain, modId } = pkg.nexus ?? { gameDomain: "site", modId: 2235 };
const bbcode = fs.readFileSync(path.join(root, "docs", "NEXUS_MOD_PAGE.bbcode"), "utf8").replace(/\r\n/g, "\n");
const summary = pkg.description ?? "";
const editUrl = `https://www.nexusmods.com/games/${gameDomain}/mods/${modId}/edit/general`;

const base = `http://127.0.0.1:${port}`;
let list;
try {
  list = await (await fetch(`${base}/json/list`)).json();
} catch {
  console.error(`No browser is listening on port ${port}. Start it with --remote-debugging-port=${port} (see the header of this script).`);
  process.exit(2);
}
const page = list.find((t) => t.type === "page") ?? (await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json());
const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(page.webSocketDebuggerUrl);
  s.onopen = () => resolve(s);
  s.onerror = () => reject(new Error("could not connect to the page"));
});
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
  console.error(`Not on the edit page (landed on ${where}). Are you logged in as the mod's owner?`);
  process.exit(2);
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
  ws.close();
  process.exit(0);
}
await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save' && !x.disabled); b && b.click(); return !!b; })()`);
await sleep(6000);
await send("Page.navigate", { url: editUrl });
await sleep(9000);
const back = await evalJs(`(() => {
  const ta = [...document.querySelectorAll('textarea')].find((t) => t._sceditor);
  return { descLen: ta.value.length, summary: document.querySelector('#short-description').value };
})()`);
const ok = back.summary === summary && Math.abs(back.descLen - bbcode.length) < 64;
console.log(ok ? `Saved and verified: ${back.descLen} chars on the page.` : `Saved, but the page reads back differently: ${JSON.stringify(back).slice(0, 300)}`);
console.log(`Public page: https://www.nexusmods.com/${gameDomain}/mods/${modId}?tab=description`);
ws.close();
process.exit(ok ? 0 : 1);
