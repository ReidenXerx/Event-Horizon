/**
 * How a collection looks, as its curator designed it: the banner with its
 * header and card images, the screenshot gallery, and the About page.
 *
 * The curator's colours apply to these surfaces only, through a few CSS custom
 * properties set on their wrapper. Everything around them keeps Event
 * Horizon's own colours, so a warning still looks like a warning inside a
 * pink collection.
 */

import * as React from "react";

import { Button } from "./Button";
import { MarkdownView } from "./Markdown";
import { Modal } from "./Modal";
import { themeVariables } from "../../core/presentation/presentation";
import type { ShownImage, ShownPresentation } from "../../core/presentation/presentationCache";
import { openExternalUrl } from "../../core/revealPath";

/** Whether a presentation has anything for a banner to show. */
export function hasBanner(p: ShownPresentation | undefined): p is ShownPresentation {
  return (
    p !== undefined &&
    (p.header !== undefined || p.tile !== undefined || p.theme !== undefined || p.links.length > 0)
  );
}

/** Puts the collection's colours on what is inside it, and on nothing else. */
export function ShowcaseTheme(props: {
  presentation: ShownPresentation | undefined;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  const vars = themeVariables(props.presentation?.theme);
  // The curator's colours reach the stylesheet only as these custom properties;
  // an unset colour leaves Event Horizon's own value in place.
  return (
    <div
      className={["eh-showcase", props.className].filter(Boolean).join(" ")}
      style={{
        ["--eh-accent" as string]: vars["--eh-accent"],
        ["--eh-accent-soft" as string]: vars["--eh-accent-soft"],
        ["--eh-showcase-accent-text" as string]: vars["--eh-showcase-accent-text"],
        ["--eh-showcase-tint" as string]: vars["--eh-showcase-tint"],
      }}
    >
      {props.children}
    </div>
  );
}

export function CollectionBanner(props: {
  name: string;
  version: string;
  author?: string;
  description?: string;
  presentation: ShownPresentation;
}): JSX.Element {
  const p = props.presentation;
  return (
    <ShowcaseTheme presentation={p} className="eh-showcase--banner">
      {p.header !== undefined && <img className="eh-showcase__header" src={p.header.url} alt="" />}
      <div className="eh-showcase__identity">
        {p.tile !== undefined && <img className="eh-showcase__tile" src={p.tile.url} alt="" />}
        <div className="eh-showcase__heading">
          <h2 className="eh-showcase__title">{props.name}</h2>
          <p className="eh-showcase__meta">
            v{props.version}
            {props.author !== undefined && props.author !== "" ? ` · by ${props.author}` : ""}
          </p>
          {props.description !== undefined && props.description !== "" && (
            <p className="eh-showcase__description">{props.description}</p>
          )}
          {p.links.length > 0 && (
            <div className="eh-row">
              {p.links.map((link) => (
                <Button
                  key={link.url}
                  intent="ghost"
                  size="sm"
                  title={link.url}
                  onClick={(): void => {
                    void openExternalUrl(link.url);
                  }}
                >
                  {link.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </ShowcaseTheme>
  );
}

/** Screenshots as thumbnails; one opens large, with previous and next. */
export function CollectionGallery(props: {
  images: readonly ShownImage[];
  presentation?: ShownPresentation;
}): JSX.Element | null {
  const [open, setOpen] = React.useState<number | undefined>(undefined);
  const { images } = props;
  if (images.length === 0) return null;
  const current = open !== undefined ? images[open] : undefined;
  const step = (by: number): void =>
    setOpen((i) => (i === undefined ? i : (i + by + images.length) % images.length));
  return (
    <ShowcaseTheme presentation={props.presentation}>
      <div className="eh-gallery">
        {images.map((img, i) => (
          <button
            key={`${i}-${img.url}`}
            type="button"
            className="eh-gallery__thumb"
            aria-label={img.caption ?? `Screenshot ${i + 1}`}
            title={img.caption}
            onClick={(): void => setOpen(i)}
          >
            <img src={img.url} alt="" />
          </button>
        ))}
      </div>
      <Modal
        open={current !== undefined}
        onClose={(): void => setOpen(undefined)}
        size="xl"
        title={current?.caption ?? `Screenshot ${(open ?? 0) + 1} of ${images.length}`}
        footer={
          images.length > 1 ? (
            <>
              <Button intent="ghost" onClick={(): void => step(-1)}>
                ← Previous
              </Button>
              <Button intent="ghost" onClick={(): void => step(1)}>
                Next →
              </Button>
            </>
          ) : undefined
        }
      >
        {current !== undefined && (
          <img className="eh-lightbox__image" src={current.url} alt={current.caption ?? ""} />
        )}
      </Modal>
    </ShowcaseTheme>
  );
}

export function CollectionAbout(props: { presentation: ShownPresentation }): JSX.Element | null {
  const { presentation } = props;
  if (presentation.about === undefined) return null;
  return (
    <ShowcaseTheme presentation={presentation}>
      <MarkdownView source={presentation.about} images={presentation.images} />
    </ShowcaseTheme>
  );
}
