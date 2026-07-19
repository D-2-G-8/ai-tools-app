import { z } from "zod";

/**
 * Structured-output schemas for AI Review (V1/V2/V3), forced via
 * generateObject (Vercel AI SDK) -- see v1.ts/v2.ts/v3.ts. Ported from the
 * reference Python prototype's REVIEW_TOOL / RECONCILE_TOOL Anthropic
 * tool-use schemas.
 *
 * Shapes here must stay structurally compatible with
 * CodeReviewFindingRecord in src/db/schema.ts (that's a plain TS interface,
 * not a zod-inferred type, to keep the schema module independent of this
 * one -- see its comment for why).
 */

export const findingSeverityValues = ["critical", "high", "medium"] as const;
export type FindingSeverity = (typeof findingSeverityValues)[number];

export const findingVerdictValues = ["confirmed", "needs_verification"] as const;
export type FindingVerdict = (typeof findingVerdictValues)[number];

// Kept here (a plain module, not a "use server" action file) so it can be
// used as a runtime value -- Next.js Server Action files may only export
// async functions, so this can't live in code-review-actions.ts.
export const reviewVersionValues = ["v1", "v2", "v3"] as const;
export type ReviewVersion = (typeof reviewVersionValues)[number];

export const findingSchema = z.object({
  file: z.string().describe("File path exactly as it appears in the diff."),
  severity: z.enum(findingSeverityValues),
  bug: z.string().describe("What exactly is broken."),
  why: z.string().describe("Why it matters to fix it."),
});
export type Finding = z.infer<typeof findingSchema>;

export const reviewFindingsSchema = z.object({
  findings: z.array(findingSchema).describe("All defects found. Empty if none."),
});
export type ReviewFindings = z.infer<typeof reviewFindingsSchema>;

export const reconciledFindingSchema = findingSchema.extend({
  agreement: z.number().int().min(1).describe("How many independent reviewers reported this defect."),
  verdict: z
    .enum(findingVerdictValues)
    .describe("confirmed = verified from the diff; needs_verification = plausible but needs a human to check."),
});
export type ReconciledFinding = z.infer<typeof reconciledFindingSchema>;

export const reconciledFindingsSchema = z.object({
  findings: z
    .array(reconciledFindingSchema)
    .describe("Reconciled, verified defects. Empty if none survive verification."),
});
export type ReconciledFindings = z.infer<typeof reconciledFindingsSchema>;
