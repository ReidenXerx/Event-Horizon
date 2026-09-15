/**
 * ──────────────────────────────────────────────────────────────────────
 * How a collection presents itself inside Event Horizon.
 *
 * Owner request 2026-09-15, settled by poll: a curator can give a collection a
 * header banner, a card (tile) image, a screenshot gallery, theme colours and
 * a markdown About page, and the people installing it see them in Event
 * Horizon.
 *
 * ─── DATA, NEVER CODE ──────────────────────────────────────────────────
 * Event Horizon runs inside Vortex's renderer, which can reach the whole disk.
 * HTML, CSS or script taken from a package would run with that reach, so none
 * is accepted: images are recognised by their bytes, colours must be #rrggbb,
 * links must be http(s), and the About page is markdown turned into React
 * elements by Event Horizon's own renderer.
 *
 * ─── A PRESENTATION NEVER STOPS AN INSTALL ─────────────────────────────
 * Everything here is read leniently: whatever is malformed is left out and
 * said, so a collection with a damaged banner still installs and just looks
 * plainer. Older Event Horizon ignores `package.presentation` and the
 * `presentation/` folder altogether.
 * ──────────────────────────────────────────────────────────────────────
 */

export const PRESENTATION_DIR = "presentation";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_GALLERY_IMAGES = 12;
export const MAX_ABOUT_CHARS = 100_000;
export const MAX_LINKS = 8;
export const MAX_CAPTION_CHARS = 200;
export const MAX_LINK_LABEL_CHARS = 80;

export type ImageFormat = "png" | "jpeg" | "webp" | "gif";

/** The extension an image of each format is stored under. */
export const IMAGE_EXTENSIONS: Record<ImageFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  gif: "gif",
};

/** One image carried in the package. */
export type PresentationImage = {
  /** Entry inside the package: `presentation/<name>`. */
  file: string;
  sha256: string;
  size: number;
  caption?: string;
};

export type PresentationTheme = {
  /** Buttons, borders and highlights of the collection's own surfaces. */
  accent?: string;
  /** A tint behind the collection's own surfaces. */
  background?: string;
};

export type PresentationLink = { label: string; url: string };

/** `package.presentation` in a manifest. */
export type PackagePresentation = {
  header?: PresentationImage;
  tile?: PresentationImage;
  gallery: PresentationImage[];
  theme?: PresentationTheme;
  about?: string;
  links: PresentationLink[];
};

/**
 * What the curator's collection config holds. Images are file names inside
 * the collection's presentation folder, copied there when picked, so moving
 * or deleting the original does not break the next build.
 */
export type PresentationConfig = {
  header?: string;
  tile?: string;
  gallery?: Array<{ file: string; caption?: string }>;
  theme?: PresentationTheme;
  about?: string;
  links?: PresentationLink[];
};

// ===========================================================================
// Checks
// ===========================================================================

/** The format an image's first bytes say it is. Twelve bytes are enough. */
export function imageFormatOf(head: Uint8Array): ImageFormat | undefined {
  const b = (i: number): number => head[i] ?? -1;
  if (
    b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 &&
    b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a
  ) {
    return "png";
  }
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "jpeg";
  if (
    b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38 &&
    (b(4) === 0x37 || b(4) === 0x39) && b(5) === 0x61
  ) {
    return "gif";
  }
  if (
    b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
    b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50
  ) {
    return "webp";
  }
  return undefined;
}

export const isHexColor = (v: unknown): v is string =>
  typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

/** http and https only: a `file:` or `javascript:` link from a package is never followed. */
export function isSafeLink(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** A plain image file name: no folders, no dot-dot, an image extension. */
export const isPresentationFileName = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}[.](png|jpg|jpeg|webp|gif)$/i.test(v) &&
  !v.includes("..");

/** An image entry inside a package: `presentation/` and a plain file name. */
export const isPresentationEntry = (v: unknown): v is string =>
  typeof v === "string" &&
  v.startsWith(`${PRESENTATION_DIR}/`) &&
  isPresentationFileName(v.slice(PRESENTATION_DIR.length + 1));

const isSha256 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

// ===========================================================================
// Reading
// ===========================================================================

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined;

export function isEmptyPresentation(p: PackagePresentation): boolean {
  return (
    p.header === undefined &&
    p.tile === undefined &&
    p.gallery.length === 0 &&
    p.theme === undefined &&
    p.about === undefined &&
    p.links.length === 0
  );
}

function readTheme(raw: unknown, problems: string[]): PresentationTheme | undefined {
  if (raw === undefined) return undefined;
  const o = record(raw);
  if (o === undefined) {
    problems.push("theme is not an object");
    return undefined;
  }
  const theme: PresentationTheme = {};
  for (const key of ["accent", "background"] as const) {
    const value = o[key];
    if (value === undefined) continue;
    if (isHexColor(value)) theme[key] = value;
    else problems.push(`theme ${key} is not a #rrggbb colour`);
  }
  return theme.accent !== undefined || theme.background !== undefined ? theme : undefined;
}

function readLinks(raw: unknown, problems: string[]): PresentationLink[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push("links is not a list");
    return [];
  }
  const links: PresentationLink[] = [];
  raw.forEach((item, i) => {
    const o = record(item);
    const label = text(o?.label, MAX_LINK_LABEL_CHARS);
    if (o === undefined || label === undefined || !isSafeLink(o.url)) {
      problems.push(`link ${i + 1} is not a label with an http(s) address`);
      return;
    }
    links.push({ label, url: o.url });
  });
  if (links.length > MAX_LINKS) {
    problems.push(`${links.length} links; the first ${MAX_LINKS} are kept`);
    links.length = MAX_LINKS;
  }
  return links;
}

/**
 * Read `package.presentation` from a manifest, keeping what is usable and
 * naming what is not. Undefined when the manifest has none.
 */
export function readPresentation(
  raw: unknown,
): { presentation?: PackagePresentation; problems: string[] } | undefined {
  if (raw === undefined) return undefined;
  const problems: string[] = [];
  const o = record(raw);
  if (o === undefined) return { problems: ["presentation is not an object"] };

  const image = (v: unknown, where: string): PresentationImage | undefined => {
    if (v === undefined) return undefined;
    const r = record(v);
    if (
      r === undefined ||
      !isPresentationEntry(r.file) ||
      !isSha256(r.sha256) ||
      typeof r.size !== "number" ||
      !(r.size > 0) ||
      r.size > MAX_IMAGE_BYTES
    ) {
      problems.push(`${where} is not a usable image entry`);
      return undefined;
    }
    const caption = text(r.caption, MAX_CAPTION_CHARS);
    return {
      file: r.file,
      sha256: r.sha256,
      size: r.size,
      ...(caption !== undefined ? { caption } : {}),
    };
  };

  const header = image(o.header, "header");
  const tile = image(o.tile, "tile");
  const gallery: PresentationImage[] = [];
  if (o.gallery !== undefined) {
    if (!Array.isArray(o.gallery)) {
      problems.push("gallery is not a list");
    } else {
      o.gallery.forEach((g, i) => {
        const img = image(g, `gallery image ${i + 1}`);
        if (img !== undefined) gallery.push(img);
      });
    }
  }
  if (gallery.length > MAX_GALLERY_IMAGES) {
    problems.push(`${gallery.length} gallery images; the first ${MAX_GALLERY_IMAGES} are kept`);
    gallery.length = MAX_GALLERY_IMAGES;
  }
  const theme = readTheme(o.theme, problems);
  if (o.about !== undefined && typeof o.about !== "string") problems.push("about is not text");
  const about = typeof o.about === "string" && o.about.trim() !== "" ? o.about.slice(0, MAX_ABOUT_CHARS) : undefined;
  const links = readLinks(o.links, problems);

  const presentation: PackagePresentation = {
    ...(header !== undefined ? { header } : {}),
    ...(tile !== undefined ? { tile } : {}),
    gallery,
    ...(theme !== undefined ? { theme } : {}),
    ...(about !== undefined ? { about } : {}),
    links,
  };
  return isEmptyPresentation(presentation) ? { problems } : { presentation, problems };
}

/** Read the curator's presentation settings from a collection config, dropping what is unusable. */
export function readPresentationConfig(raw: unknown): PresentationConfig | undefined {
  const o = record(raw);
  if (o === undefined) return undefined;
  const ignored: string[] = [];
  const gallery = Array.isArray(o.gallery)
    ? o.gallery
        .map(record)
        .filter((g): g is Record<string, unknown> => g !== undefined && isPresentationFileName(g.file))
        .map((g) => {
          const caption = text(g.caption, MAX_CAPTION_CHARS);
          return { file: g.file as string, ...(caption !== undefined ? { caption } : {}) };
        })
    : [];
  const theme = readTheme(o.theme, ignored);
  const links = readLinks(o.links, ignored);
  const about = typeof o.about === "string" ? o.about.slice(0, MAX_ABOUT_CHARS) : undefined;
  return {
    ...(isPresentationFileName(o.header) ? { header: o.header } : {}),
    ...(isPresentationFileName(o.tile) ? { tile: o.tile } : {}),
    ...(gallery.length > 0 ? { gallery } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(about !== undefined && about.trim() !== "" ? { about } : {}),
    ...(links.length > 0 ? { links } : {}),
  };
}

/** Every image a presentation carries, header and tile first, each file once. */
export function presentationImages(p: PackagePresentation): PresentationImage[] {
  const seen = new Set<string>();
  const out: PresentationImage[] = [];
  for (const img of [p.header, p.tile, ...p.gallery]) {
    if (img === undefined || seen.has(img.file)) continue;
    seen.add(img.file);
    out.push(img);
  }
  return out;
}

/**
 * Keep only the images whose files are actually in the package. What is named
 * but absent is dropped and returned, so the reader can say so.
 */
export function withImagesPresent(
  p: PackagePresentation,
  present: ReadonlySet<string>,
): { presentation?: PackagePresentation; missing: string[] } {
  const missing = new Set<string>();
  const keep = (img: PresentationImage | undefined): PresentationImage | undefined => {
    if (img === undefined) return undefined;
    if (present.has(img.file)) return img;
    missing.add(img.file);
    return undefined;
  };
  const header = keep(p.header);
  const tile = keep(p.tile);
  const next: PackagePresentation = {
    ...p,
    gallery: p.gallery.filter((g) => keep(g) !== undefined),
  };
  delete next.header;
  delete next.tile;
  if (header !== undefined) next.header = header;
  if (tile !== undefined) next.tile = tile;
  return {
    ...(isEmptyPresentation(next) ? {} : { presentation: next }),
    missing: [...missing],
  };
}

// ===========================================================================
// Theme
// ===========================================================================

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminanceOf(hex: string): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Text colour that stays readable on `hex`. */
export function readableOn(hex: string): string {
  return luminanceOf(hex) > 0.4 ? "#0b0a12" : "#ffffff";
}

/**
 * The CSS custom properties a collection's theme sets on its own surfaces.
 * Only these: the rest of Event Horizon keeps its own colours, so a warning
 * still looks like a warning inside a pink collection.
 */
export function themeVariables(theme: PresentationTheme | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (theme?.accent !== undefined && isHexColor(theme.accent)) {
    const [r, g, b] = rgbOf(theme.accent);
    vars["--eh-accent"] = theme.accent;
    vars["--eh-accent-soft"] = `rgba(${r}, ${g}, ${b}, 0.14)`;
    vars["--eh-showcase-accent-text"] = readableOn(theme.accent);
  }
  if (theme?.background !== undefined && isHexColor(theme.background)) {
    const [r, g, b] = rgbOf(theme.background);
    vars["--eh-showcase-tint"] = `rgba(${r}, ${g}, ${b}, 0.22)`;
  }
  return vars;
}
