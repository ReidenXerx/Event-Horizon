/**
 * The Collection Doctor's face.
 *
 * Purely presentational: it takes verdicts and renders them. All the Vortex
 * reads and the healing live in the caller, which is what lets this be
 * screenshotted by the render harness without a running Vortex — the only way
 * to actually look at a screen while building it rather than imagining it.
 *
 * ─── THE ONE VISUAL RULE ───────────────────────────────────────────────
 * Colour means "act on this", never decoration. A healthy check is quiet —
 * plain text, no badge, no accent — so the eye lands on the two cards that are
 * wrong instead of scanning eight identical green ticks. That is the same
 * correction the dashboard needed: colouring facts that are fine trains people
 * to ignore colour exactly when it matters.
 */

import * as React from "react";

import { Button, Callout, Card, LinkButton, Pill, ProgressRing } from "../../components";
import type { PillIntent } from "../../components";
import type {
  HealAction,
  HealthCheck,
  HealthStatus,
} from "../../../core/doctor/health";
import { overallHealth } from "../../../core/doctor/health";

export interface DoctorPanelProps {
  packageName: string;
  packageVersion: string;
  checks: readonly HealthCheck[];
  /** Which check is being re-run or healed right now. */
  busyCheckId?: string;
  /** Deep scan is expensive, so it is a separate, explicit action. */
  onRunDeepScan?: () => void;
  onRecheck?: () => void;
  onHeal?: (action: HealAction, checkId: string) => void;
  /**
   * Set while an install is running. Every heal re-runs a pipeline step that
   * mutates Vortex, so they are disabled rather than hidden — a button that
   * vanishes reads as a missing feature, one that is disabled with a reason
   * reads as a system that knows what it is doing.
   */
  healingBlocked?: string;
  /**
   * Per-action veto, with the reason.
   *
   * Three of the six cures re-run pipeline steps that read the collection
   * manifest, so they cannot run when the `.ehcoll` is missing. Disabled with
   * the reason on the button rather than hidden: a cure that vanishes reads as
   * a missing feature, and the user cannot tell that pointing at the package
   * would bring it back.
   */
  unavailableHeal?: (action: HealAction) => string | undefined;
}

const STATUS_PILL: Record<HealthStatus, PillIntent> = {
  healthy: "success",
  drifted: "warning",
  broken: "danger",
  unknown: "neutral",
  "not-applicable": "neutral",
};

const STATUS_WORD: Record<HealthStatus, string> = {
  healthy: "OK",
  drifted: "Drifted",
  broken: "Broken",
  unknown: "Not checked",
  "not-applicable": "N/A",
};

/**
 * Maps a verdict to the `--success`/`--warning`/`--danger` suffix shared by
 * the `eh-dot--*` and `eh-tone--*` modifier classes; `undefined` keeps the
 * neutral dot / default text colour. Shared by the status dot, the quiet
 * status label, the VerdictRing value and the overall-health headline.
 */
const STATUS_TONE: Record<HealthStatus, "success" | "warning" | "danger" | undefined> = {
  healthy: "success",
  drifted: "warning",
  broken: "danger",
  unknown: undefined,
  "not-applicable": undefined,
};

/**
 * Two concrete builders instead of one generic `(prefix, status)` helper:
 * the static class-reference checker (theme/classes.test.ts) scans literal
 * eh-... tokens, and a bare prefix passed around as its own string argument
 * becomes exactly such a token, while a prefix immediately followed by --
 * inside one template literal is not. Build the full `eh-dot--<tone>` /
 * `eh-tone--<tone>` string in one place instead of assembling it from a
 * passed-in prefix.
 */
function dotToneClass(status: HealthStatus): string | undefined {
  const tone = STATUS_TONE[status];
  return tone === undefined ? undefined : `eh-dot--${tone}`;
}

function textToneClass(status: HealthStatus): string | undefined {
  const tone = STATUS_TONE[status];
  return tone === undefined ? undefined : `eh-tone--${tone}`;
}

/** A ring is worth more than a number here: it reads at a glance. */
function VerdictRing(props: { checks: readonly HealthCheck[] }): JSX.Element {
  const graded = props.checks.filter(
    (c) => c.status !== "not-applicable" && c.status !== "unknown",
  );
  const good = graded.filter((c) => c.status === "healthy").length;
  const pct = graded.length === 0 ? 0 : Math.round((good / graded.length) * 100);
  const overall = overallHealth(props.checks);
  // ProgressRing already centres a `label`, so no absolute overlay is needed.
  return (
    <ProgressRing
      size={104}
      value={pct / 100}
      label={
        <span className="eh-stack eh-stack--xs eh-stack--center">
          <span className={`eh-figure ${textToneClass(overall.status)}`.trim()}>
            {graded.length === 0 ? "—" : `${good}/${graded.length}`}
          </span>
          {/* "1/7" alone is a fraction of an unnamed thing. Name it. */}
          <span className="eh-label">
            {graded.length === 0 ? "checks" : "passing"}
          </span>
        </span>
      }
    />
  );
}

function CheckCard(props: {
  check: HealthCheck;
  busy: boolean;
  blocked: boolean;
  unavailableHeal?: (action: HealAction) => string | undefined;
  onHeal?: (action: HealAction, checkId: string) => void;
}): JSX.Element {
  const { check, busy, blocked } = props;
  const unavailable =
    check.heal !== undefined
      ? props.unavailableHeal?.(check.heal.action)
      : undefined;
  const [open, setOpen] = React.useState(false);
  const isProblem = check.status === "broken" || check.status === "drifted";

  return (
    <Card inert>
      <div className="eh-stack">
        <div className="eh-row eh-row--lg">
          {/* The status dot carries the whole verdict at a glance. */}
          <span
            aria-hidden="true"
            className={[
              "eh-dot",
              "eh-dot--lg",
              dotToneClass(check.status),
              isProblem ? "eh-dot--glow" : undefined,
            ]
              .filter(Boolean)
              .join(" ")}
          />
          <span className="eh-fill eh-strong">{check.title}</span>
          {/* Quiet when fine: no badge on a healthy check. */}
          {isProblem && (
            <Pill intent={STATUS_PILL[check.status]} withDot>
              {check.affectedCount > 0
                ? `${check.affectedCount}`
                : STATUS_WORD[check.status]}
            </Pill>
          )}
          {!isProblem && (
            <span
              className={["eh-label", textToneClass(check.status)]
                .filter(Boolean)
                .join(" ")}
            >
              {STATUS_WORD[check.status]}
            </span>
          )}
        </div>

        <p className="eh-body">{check.summary}</p>

        {check.detail.length > 0 && (
          <>
            <LinkButton variant="caps" onClick={() => setOpen((v) => !v)}>
              {open ? "Hide details" : `Show details (${check.detail.length})`}
            </LinkButton>
            {open && (
              <ul className="eh-list eh-mono eh-muted eh-scroll">
                {check.detail.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </>
        )}

        {check.heal !== undefined && (
          // Ghost, not primary. Six primary buttons on one screen is a wall of
          // orange in which nothing stands out — the same mistake as colouring
          // facts that are fine. The single primary action belongs in the
          // header; these are all equally available, so none of them shouts.
          <Button
            intent="ghost"
            size="sm"
            disabled={busy || blocked || unavailable !== undefined}
            onClick={() => props.onHeal?.(check.heal!.action, check.id)}
          >
            {busy
              ? "Working…"
              : blocked
                ? "Install in progress"
                : (unavailable ?? check.heal.label)}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function DoctorPanel(props: DoctorPanelProps): JSX.Element {
  const { checks } = props;
  const overall = overallHealth(checks);
  // Problems first. A user opening this wants the bad news at the top, not in
  // reading order behind six healthy cards.
  const ordered = [...checks].sort((a, b) => rank(a.status) - rank(b.status));

  return (
    <div className="eh-stack eh-stack--xl">
      <Card inert>
        <div className="eh-row eh-row--xl">
          <VerdictRing checks={checks} />
          <div className="eh-stack eh-stack--sm eh-fill">
            <span className="eh-label">Collection health</span>
            {/* h3, not h2: base.ts already sizes h3 at text-xl with zero
                margin (matching the inline style this replaces exactly);
                weight comes out 600 instead of the previous explicit 700 —
                close enough to not warrant its own style. Colour now comes
                from eh-tone--* (a real class beats base's :where() colour
                rule, so no cascade issue here unlike the two NOTEs above). */}
            <h3 className={textToneClass(overall.status)}>
              {overall.headline}
            </h3>
            <span className="eh-body">
              {props.packageName} v{props.packageVersion} — measured against the
              last install of this collection on this machine.
            </span>
          </div>
          <div className="eh-row">
            {props.onRecheck !== undefined && (
              <Button intent="ghost" onClick={props.onRecheck}>
                Re-check
              </Button>
            )}
            {props.onRunDeepScan !== undefined && (
              // Disabled during an install even though a scan only READS. It
              // would be hashing files the driver is still writing, and every
              // half-written mod would come back as drift — a scary, wrong
              // answer is worse than no answer.
              <Button
                intent="primary"
                disabled={props.healingBlocked !== undefined}
                onClick={props.onRunDeepScan}
              >
                Deep scan files
              </Button>
            )}
          </div>
        </div>
      </Card>

      {props.healingBlocked !== undefined && (
        <Callout tone="warning" icon="⏸">
          {props.healingBlocked}
        </Callout>
      )}

      <section
        className="eh-grid eh-grid--start"
        style={{ ["--eh-grid-min" as string]: "320px" }}
      >
        {ordered.map((c) => (
          <CheckCard
            key={c.id}
            check={c}
            busy={props.busyCheckId === c.id}
            blocked={props.healingBlocked !== undefined}
            {...(props.unavailableHeal !== undefined
              ? { unavailableHeal: props.unavailableHeal }
              : {})}
            {...(props.onHeal !== undefined ? { onHeal: props.onHeal } : {})}
          />
        ))}
      </section>
    </div>
  );
}

/** Broken, then drifted, then unknown, then the quiet ones. */
function rank(s: HealthStatus): number {
  return { broken: 0, drifted: 1, unknown: 2, healthy: 3, "not-applicable": 4 }[s];
}
