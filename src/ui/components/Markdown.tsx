/**
 * Markdown from a collection, rendered by Event Horizon itself.
 *
 * The text comes from a package someone else wrote, and Event Horizon runs with
 * disk access inside Vortex, so nothing here reaches the page as markup: every
 * block and span becomes a React element, and raw HTML shows as the text it
 * is. There is no markdown library underneath to trust.
 *
 * The subset a collection page needs: headings, paragraphs, bold, italic,
 * inline code, bullet and numbered lists, quotes, rules, links (http and https
 * only, opened in the browser rather than in Vortex's window), and images the
 * package itself carries.
 */

import * as React from "react";

import { isSafeLink } from "../../core/presentation/presentation";
import { openExternalUrl } from "../../core/revealPath";

export interface MarkdownViewProps {
  source: string;
  /**
   * Package entry to URL, for the images the text may show. An image not in
   * here (a web address, a path on someone's disk) is shown as its alt text.
   */
  images?: Readonly<Record<string, string>>;
  className?: string;
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "image"; alt: string; src: string };

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

/** Split the source into blocks. Exported for tests. */
export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  let quote: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    if (list !== undefined) blocks.push({ kind: "list", ...list });
    if (quote.length > 0) blocks.push({ kind: "quote", text: quote.join(" ") });
    paragraph = [];
    list = undefined;
    quote = [];
  };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image !== null) {
      flush();
      blocks.push({ kind: "image", alt: image[1]!, src: image[2]! });
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    const item = bullet ?? numbered;
    if (item !== null) {
      const ordered = numbered !== null && bullet === null;
      if (list === undefined || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(item[1]!);
      continue;
    }
    if (line.startsWith(">")) {
      if (quote.length === 0) flush();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    if (list !== undefined || quote.length > 0) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function resolveImage(src: string, images: Readonly<Record<string, string>> | undefined): string | undefined {
  if (images === undefined) return undefined;
  return images[src] ?? images[`presentation/${src}`];
}

function InlineLink(props: { url: string; children: React.ReactNode }): JSX.Element {
  const open = (e: React.SyntheticEvent): void => {
    // Never let the click navigate: in Vortex that would replace the whole app.
    e.preventDefault();
    void openExternalUrl(props.url);
  };
  return (
    <a href={props.url} onClick={open} onAuxClick={open} title={props.url}>
      {props.children}
    </a>
  );
}

/** Inline spans: bold, italic, code, links and images. Exported for tests. */
export function renderInline(
  text: string,
  images: Readonly<Record<string, string>> | undefined,
  keyPrefix = "i",
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buffer = "";
  let n = 0;
  const key = (): string => `${keyPrefix}-${n++}`;
  const flush = (): void => {
    if (buffer !== "") out.push(buffer);
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        const k = key();
        out.push(<strong key={k}>{renderInline(text.slice(i + 2, end), images, k)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("`")) {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push(<code key={key()}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (image !== null) {
      flush();
      const url = resolveImage(image[2]!, images);
      out.push(
        url !== undefined ? (
          <img key={key()} className="eh-markdown__image" src={url} alt={image[1]!} />
        ) : (
          <span key={key()} className="eh-note">
            {image[1] !== "" ? image[1] : "image"}
          </span>
        ),
      );
      i += image[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      flush();
      const k = key();
      const label = renderInline(link[1]!, images, k);
      out.push(
        isSafeLink(link[2]) ? (
          <InlineLink key={k} url={link[2]!}>
            {label}
          </InlineLink>
        ) : (
          <span key={k}>{label}</span>
        ),
      );
      i += link[0].length;
      continue;
    }
    const mark = rest[0];
    if ((mark === "*" || mark === "_") && rest[1] !== mark) {
      const end = text.indexOf(mark, i + 1);
      if (end > i + 1) {
        flush();
        const k = key();
        out.push(<em key={k}>{renderInline(text.slice(i + 1, end), images, k)}</em>);
        i = end + 1;
        continue;
      }
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return out;
}

export function MarkdownView(props: MarkdownViewProps): JSX.Element {
  const blocks = React.useMemo(() => parseBlocks(props.source), [props.source]);
  const { images } = props;
  return (
    <div className={["eh-markdown", props.className].filter(Boolean).join(" ")}>
      {blocks.map((block, b) => {
        const k = `b${b}`;
        switch (block.kind) {
          case "heading": {
            const Tag = (["h2", "h3", "h4"] as const)[block.level - 1]!;
            return <Tag key={k}>{renderInline(block.text, images, k)}</Tag>;
          }
          case "paragraph":
            return <p key={k}>{renderInline(block.text, images, k)}</p>;
          case "quote":
            return <blockquote key={k}>{renderInline(block.text, images, k)}</blockquote>;
          case "rule":
            return <hr key={k} />;
          case "image": {
            const url = resolveImage(block.src, images);
            return url !== undefined ? (
              <img key={k} className="eh-markdown__image" src={url} alt={block.alt} />
            ) : (
              <p key={k} className="eh-note">
                {block.alt !== "" ? block.alt : "image"}
              </p>
            );
          }
          case "list": {
            const items = block.items.map((item, j) => (
              <li key={`${k}-${j}`}>{renderInline(item, images, `${k}-${j}`)}</li>
            ));
            return block.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>;
          }
          default:
            return null;
        }
      })}
    </div>
  );
}
