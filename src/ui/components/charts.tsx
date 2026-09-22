/**
 * Chart primitives, drawn by hand in SVG.
 *
 * ─── WHY NOT A CHART LIBRARY ────────────────────────────────────────────
 * Event Horizon is NOT bundled: what ships is the compiled source plus the
 * dependencies Vortex happens to provide, so a new runtime dependency is a
 * module that may simply not be there on a user's machine (the peerDependency
 * scar). These four shapes are a few dozen lines each and need nothing.
 *
 * Every one of them takes numbers that are already true — none of them
 * invents a scale, a projection or an interpolation the caller did not ask
 * for, and a series with no data renders nothing rather than a flat line at
 * zero, which would read as a measurement.
 */
import * as React from "react";

/** The house gradient, used by every chart so they read as one family. */
/** The accretion-disk palette from the theme tokens, in the same order. */
export const CHART_COLORS = ["#ffb15c", "#f0386b", "#a93289", "#5f2ca5", "#4cc9f0"] as const;

export type RingTone = "brand" | "good" | "warn" | "bad";

const RING_STOPS: Record<RingTone, [string, string, string]> = {
  brand: ["#ffb15c", "#ff6b3d", "#f0386b"],
  good: ["#3ddc84", "#4cc9f0", "#4cc9f0"],
  warn: ["#ffb15c", "#ff6b3d", "#ff6b3d"],
  bad: ["#ff5b78", "#f0386b", "#f0386b"],
};

let uid = 0;
const nextId = (): string => `eh-c-${(uid += 1)}`;

/**
 * Black or white text on a given fill, by WCAG relative luminance.
 *
 * Contrast is measurable, so it is measured rather than guessed: the palette
 * runs from a light amber to a deep violet, and one fixed ink cannot serve
 * both ends of it.
 */
export function inkOn(hex: string): string {
  const v = hex.replace("#", "");
  const channel = (i: number): number => {
    const c = parseInt(v.slice(i * 2, i * 2 + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  // The crossover where both candidates are equally readable is ~0.18; the
  // dark ink is preferred there because these fills are saturated.
  return luminance > 0.18 ? "#1b0f27" : "#f5f7ff";
}

/**
 * A ring gauge.
 *
 * `value` is a percentage the caller has already decided is meaningful.
 * `label` names what it measures, because a bare percentage on a dashboard is
 * the easiest number in the world to misread.
 */
export function Ring(props: {
  /**
   * The percentage, or `undefined` when it could not be measured.
   *
   * ─── WHY THIS ACCEPTS UNDEFINED ───────────────────────────────────────
   * It used to take a number, so the one caller wrote `percent ?? 0` and an
   * unmeasured value rendered as an empty arc with a bold "0%" inside it.
   * That is the worst reading of "we did not check": 0% does not look like
   * a missing measurement, it looks like everything is broken — on the
   * first screen the app opens, beside a Play button. The model layer goes
   * to real trouble to return `undefined` rather than 0 or 100; the chart
   * has to be able to say it.
   */
  value: number | undefined;
  size?: number;
  stroke?: number;
  label?: string;
  sub?: string;
  tone?: RingTone;
  glow?: boolean;
}): JSX.Element {
  const size = props.size ?? 120;
  const stroke = props.stroke ?? Math.max(8, Math.round(size / 11));
  const tone = props.tone ?? "brand";
  const given = props.value;
  const unmeasured = given === undefined;
  const pct = given === undefined ? 0 : Math.max(0, Math.min(100, given));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const ids = React.useMemo(() => ({ g: nextId(), f: nextId() }), []);
  const [g1, g2, g3] = RING_STOPS[tone];

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={
        unmeasured ? `${props.label ?? "value"}: not measured` : `${props.label ?? "value"}: ${Math.round(pct)}%`
      }
    >
      <defs>
        <linearGradient id={ids.g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={g1} />
          <stop offset="55%" stopColor={g2} />
          <stop offset="100%" stopColor={g3} />
        </linearGradient>
        {props.glow === true && (
          <filter id={ids.f} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={size / 34} result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={`url(#${ids.g})`}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        {...(props.glow === true ? { filter: `url(#${ids.f})` } : {})}
      />
      <text x="50%" y={props.label !== undefined ? "47%" : "54%"} textAnchor="middle" className="eh-ring-value">
        {unmeasured ? "—" : `${Math.round(pct)}%`}
      </text>
      {props.label !== undefined && (
        <text x="50%" y="62%" textAnchor="middle" className="eh-ring-label">
          {props.label}
        </text>
      )}
      {props.sub !== undefined && (
        <text x="50%" y="75%" textAnchor="middle" className="eh-ring-sub">
          {props.sub}
        </text>
      )}
    </svg>
  );
}

/**
 * A sparkline over a series of points.
 *
 * Fewer than two points is not a trend, so it draws the dots and no line —
 * a single value joined to itself is a horizontal line that reads as "flat",
 * which is a claim about history we do not have.
 */
export function Sparkline(props: {
  points: readonly { label: string; value: number }[];
  width?: number;
  height?: number;
  color?: string;
}): JSX.Element | null {
  const { points } = props;
  if (points.length === 0) return null;
  const w = props.width ?? 260;
  const h = props.height ?? 44;
  const color = props.color ?? CHART_COLORS[0];
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const xs = (i: number): number => (points.length === 1 ? w / 2 : 6 + (i * (w - 12)) / (points.length - 1));
  /**
   * An unchanged series is drawn down the MIDDLE, not along the floor.
   * With every value equal, scaling put every point at the bottom edge, so
   * four revisions that all shipped 963 mods read as a collapse.
   */
  const ys = (v: number): number => (span === 0 ? h / 2 : h - 6 - ((v - min) / span) * (h - 16));
  const dots = points.map((p, i) => <circle key={i} cx={xs(i)} cy={ys(p.value)} r={2.2} fill={color} />);
  if (points.length === 1) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`${points[0].label}: ${points[0].value}`}>
        {dots}
      </svg>
    );
  }
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${xs(points.length - 1).toFixed(1)},${h} L${xs(0).toFixed(1)},${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img"
      aria-label={`${points[0].label} ${points[0].value} to ${points[points.length - 1].label} ${points[points.length - 1].value}`}>
      <path d={area} fill={color} opacity={0.13} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      {dots}
    </svg>
  );
}

/** One horizontal bar split by share. Zero total renders nothing. */
export function StackBar(props: {
  parts: readonly { label: string; value: number }[];
  height?: number;
}): JSX.Element | null {
  const total = props.parts.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return null;
  const h = props.height ?? 16;
  let x = 0;
  const segments = props.parts.map((p, i) => {
    const w = (p.value / total) * 100;
    const seg = (
      <rect key={i} x={`${x}%`} y="0" width={`${Math.max(w - 0.4, 0.4)}%`} height={h} rx="4"
        fill={CHART_COLORS[i % CHART_COLORS.length]}>
        <title>{`${p.label}: ${p.value.toLocaleString()}`}</title>
      </rect>
    );
    x += w;
    return seg;
  });
  return (
    <svg viewBox={`0 0 100 ${h}`} width="100%" height={h} preserveAspectRatio="none">
      {segments}
    </svg>
  );
}

/**
 * A row-of-slices "treemap": proportional blocks, biggest first.
 *
 * A real squarified treemap buys nothing at four or five parts and makes the
 * smallest slice unreadable; this keeps every label legible by giving each
 * block the full height and clipping its text when the block is narrow.
 */
export function SliceMap(props: {
  parts: readonly { label: string; value: number; hint?: string }[];
  height?: number;
  format?: (value: number) => string;
}): JSX.Element | null {
  const parts = [...props.parts].filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  const total = parts.reduce((a, p) => a + p.value, 0);
  // Ids are document-global and this renders inside Vortex, beside Vortex's
  // own chrome: "clip-0-0" would be claimed by whoever emitted it first, and
  // a block's text would then be clipped to someone else's rectangle.
  const clipIds = React.useMemo(() => parts.map(() => nextId()), [parts.length]);
  if (total <= 0) return null;
  const h = props.height ?? 130;
  const fmt = props.format ?? ((v: number) => String(v));
  let x = 0;
  return (
    <svg viewBox={`0 0 1000 ${h}`} width="100%" height={h} preserveAspectRatio="none">
      {parts.map((p, i) => {
        const w = (p.value / total) * 1000;
        const fill = CHART_COLORS[i % CHART_COLORS.length];
        /**
         * The ink is chosen from the fill, not assumed.
         *
         * The labels were a fixed dark violet "on the bright slice fills,
         * which are light by design" — but the palette ends in violet and
         * every slice after the first was drawn at a lower opacity, so the
         * third and fourth blocks measured 1.99:1 and 1.44:1 and could not be
         * read at all. Those are the blocks the chart exists to name. Full
         * opacity now, and the ink follows the fill's luminance.
         */
        const ink = inkOn(fill);
        const block = (
          <g key={i}>
            <rect x={x + 3} y={3} width={Math.max(w - 6, 2)} height={h - 6} rx="10" fill={fill} />
            <clipPath id={clipIds[i]}>
              <rect x={x + 3} y={3} width={Math.max(w - 6, 2)} height={h - 6} />
            </clipPath>
            <g clipPath={`url(#${clipIds[i]})`}>
              <text x={x + 16} y={30} className="eh-slice-label" fill={ink}>{p.label}</text>
              <text x={x + 16} y={58} className="eh-slice-value" fill={ink}>{fmt(p.value)}</text>
              {p.hint !== undefined && (
                <text x={x + 16} y={80} className="eh-slice-hint" fill={ink}>{p.hint}</text>
              )}
            </g>
            <title>{`${p.label}: ${fmt(p.value)}`}</title>
          </g>
        );
        x += w;
        return block;
      })}
    </svg>
  );
}
