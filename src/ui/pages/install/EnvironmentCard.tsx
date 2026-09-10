/**
 * The environment preflight, rendered: every check that is not simply fine,
 * with its evidence and what to do. Shared by the install preview and the
 * Doctor page, so both say the same thing about the same machine.
 */

import * as React from "react";

import { Card, Pill } from "../../components";
import type { EnvironmentCheck } from "../../../core/environment/environmentChecks";
import type { EnvironmentReport } from "../../../core/environment/preflight";

/** Blocked checks become verdict blockers; warnings become verdict lines. */
export function summarizeEnvironment(report: EnvironmentReport | undefined): {
  blockers: string[];
  warnings: string[];
} {
  const checks = report?.checks ?? [];
  return {
    blockers: checks.filter((c) => c.status === "blocked").map((c) => c.title),
    warnings: checks.filter((c) => c.status === "warning").map((c) => c.title),
  };
}

const INTENT: Record<EnvironmentCheck["status"], "danger" | "warning" | "neutral" | "success"> = {
  blocked: "danger",
  warning: "warning",
  unknown: "neutral",
  ok: "success",
};

export function EnvironmentCard(props: {
  report: EnvironmentReport | undefined;
  /** Show passing checks too (the Doctor does; the preview only needs problems). */
  showOk?: boolean;
}): JSX.Element | null {
  const checks = (props.report?.checks ?? []).filter((c) => props.showOk === true || c.status !== "ok");
  if (props.report === undefined || checks.length === 0) return null;
  return (
    <Card title={`Game setup — ${props.report.gameName}`} inert>
      <div className="eh-stack">
        {checks.map((c) => (
          <div key={c.id} className="eh-stack eh-stack--sm">
            <div className="eh-row">
              <Pill intent={INTENT[c.status]}>{c.status}</Pill>
              <strong className="eh-strong">{c.title}</strong>
            </div>
            {c.lines.length > 0 && (
              <ul className="eh-list" style={{ margin: 0 }}>
                {c.lines.map((l, i) => (
                  <li key={i} className="eh-secondary" style={{ whiteSpace: "pre-wrap" }}>
                    {l}
                  </li>
                ))}
              </ul>
            )}
            {c.steps.length > 0 && (
              <ol style={{ margin: 0 }}>
                {c.steps.map((s, i) => (
                  <li key={i} className="eh-secondary">
                    {s}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
