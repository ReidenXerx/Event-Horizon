/**
 * What a pasted link delivered, said above the screens that follow it.
 *
 * The SHA-256 is shown either way. With a published checksum it is the proof
 * that the file is the package; without one it is the only thing a person can
 * compare with the collection's page, and the notice says plainly that nothing
 * did that comparison for them.
 */

import * as React from "react";

import { Callout } from "../../components";
import { formatBytes } from "../../../utils/diskSpace";
import type { LinkReceipt } from "./fetchLink";

export function LinkReceiptNotice(props: { receipt: LinkReceipt }): JSX.Element {
  const { receipt } = props;
  if (receipt.verified === "match") {
    return (
      <Callout tone="success" title="Checksum verified" role="silent">
        <p>
          {receipt.fileName} ({formatBytes(receipt.size)}) is the file the link's published SHA-256 names.
        </p>
        <p className="eh-mono">SHA-256 {receipt.sha256}</p>
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title="Not verified against a published checksum" role="silent">
      <p>
        The link carried no #sha256=, so nothing checked that {receipt.fileName} ({formatBytes(receipt.size)}) is the
        package its publisher uploaded. Compare this SHA-256 with the one on the collection's page:
      </p>
      <p className="eh-mono">SHA-256 {receipt.sha256}</p>
    </Callout>
  );
}
