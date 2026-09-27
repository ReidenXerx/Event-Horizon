/** A control-channel refusal or failure: a code an agent can act on, an HTTP status, and what DID happen. */
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    /** Facts the caller needs even though the command failed (what DID happen). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
