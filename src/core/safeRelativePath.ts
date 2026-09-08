/**
 * Moved to the path service.
 *
 * The containment rule now lives in `core/paths/modPath.ts` beside the
 * separator and case handling it shares logic with — a path a stranger
 * supplied is checked, split and compared by one module rather than three.
 *
 * Kept as a re-export rather than deleted so the two call sites that guard the
 * actual write — the manifest parser and the mirror applier — do not move in
 * the same change that moves the rule. They are the least interesting lines to
 * have churn in a diff about path handling.
 */
export { isSafeRelativePath, unsafePathReason } from "./paths";
