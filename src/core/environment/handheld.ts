/**
 * Is this a handheld PC (Steam Deck, ROG Ally, Legion Go, MSI Claw, ...)?
 *
 * Owner poll, 2026-10-09: an optional mod the curator marks for handhelds
 * (Meridia - Handheld Settings) starts ticked only on one. A wrong answer only
 * changes which box starts ticked; the player sees it and decides.
 *
 * Read from the machine's own product name, never guessed from the OS:
 *  - Windows: the BIOS product name in the registry (ROG Ally "RC71L",
 *    Ally X "RC72LA", Legion Go "83E1", MSI Claw "MS-1T41", ...).
 *  - Proton: Linux's DMI product name through Wine's Z: drive (Steam Deck
 *    "Jupiter" LCD, "Galileo" OLED), or Steam's own SteamDeck=1.
 */

import { execFileSync } from "child_process";

import { ehLog } from "../logging/ehLog";
import { linuxDmiProductName, looksLikeWine } from "../proton/detect";

/** Product names of handheld PCs, matched anywhere in the name, case-insensitively. */
const HANDHELD_PRODUCTS =
  /(^|[^a-z0-9])(jupiter|galileo|rog ally|rc71l|rc72l|legion go|83e1|83l3|83n6|83q2|83q3|claw|ms-1t4|ayaneo|gpd win|onexplayer|onexfly|zotac zone)/i;

export type HandheldVerdict = { handheld: boolean; product?: string; how: string };

let cached: HandheldVerdict | undefined;

/** Whether a product name is a known handheld. */
export function isHandheldProduct(product: string): boolean {
  return HANDHELD_PRODUCTS.test(product);
}

function windowsProductName(): string | undefined {
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS", "/v", "SystemProductName"],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    );
    const m = /SystemProductName\s+REG_SZ\s+(.+)/.exec(out);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Detect once per session. Never throws. */
export function detectHandheld(): HandheldVerdict {
  if (cached !== undefined) return cached;
  let verdict: HandheldVerdict;
  if (process.env["SteamDeck"] === "1") {
    verdict = { handheld: true, product: "Steam Deck", how: "SteamDeck=1" };
  } else {
    const wine = looksLikeWine();
    const product = wine ? linuxDmiProductName() ?? windowsProductName() : windowsProductName();
    verdict =
      product !== undefined
        ? { handheld: isHandheldProduct(product), product, how: wine ? "dmi" : "bios" }
        : { handheld: false, how: "unknown" };
  }
  cached = verdict;
  ehLog("info", "environment.handheld", verdict);
  return verdict;
}
