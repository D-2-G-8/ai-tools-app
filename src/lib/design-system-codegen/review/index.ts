import "server-only";
import { runDeterministicGates, applyDeterministicFixes } from "./deterministic";
import { reviewWithLlm } from "./reviewer";
import type { Finding, GeneratedFiles, ReviewContext, ReviewResult } from "./types";

export type { GeneratedFiles, ReviewContext, ReviewResult, Finding, FileKind } from "./types";

export interface ReviewAndFixArgs {
  model: string;
  files: GeneratedFiles;
  ctx: ReviewContext;
  spec: string | undefined;
  /** Holistically fix the component to satisfy ALL current findings. May change
   *  multiple files together (e.g. add a missing class to css AND keep the tsx
   *  reference). Returns the updated file set + its token usage. */
  applyFix: (files: GeneratedFiles, findings: Finding[]) => Promise<{ files: GeneratedFiles; inputTokens: number; outputTokens: number }>;
  maxIterations?: number;
}

export async function reviewAndFix(args: ReviewAndFixArgs): Promise<ReviewResult> {
  const { model, ctx, spec } = args;
  const maxIterations = args.maxIterations ?? 3;
  let files = args.files;
  let findings: Finding[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 1; i <= maxIterations; i++) {
    // 1) deterministic gates + free fixes, then re-gate
    let det = runDeterministicGates(files, ctx);
    files = applyDeterministicFixes(files, det);
    det = runDeterministicGates(files, ctx);

    // 2) LLM DoD review (best-effort)
    const llm = await reviewWithLlm(model, files, spec, ctx.componentName);
    inputTokens += llm.inputTokens;
    outputTokens += llm.outputTokens;
    findings = [...det, ...llm.findings];

    if (findings.length === 0) {
      return { files, findings: [], passed: true, iterations: i, inputTokens, outputTokens };
    }

    // One holistic fix over ALL findings -- may change multiple files coherently.
    try {
      const fixed = await args.applyFix(files, findings);
      files = fixed.files;
      inputTokens += fixed.inputTokens;
      outputTokens += fixed.outputTokens;
    } catch {
      // fix failed -> keep current files; the loop bound / terminal re-gate handles it
    }
  }

  // bound hit: re-gate once more so `passed` reflects the final files
  const finalDet = runDeterministicGates(files, ctx);
  const finalFixed = applyDeterministicFixes(files, finalDet);
  files = finalFixed;
  const residual = runDeterministicGates(files, ctx);
  const passed = !residual.some((f) => f.severity === "build-breaking");
  return { files, findings: [...residual, ...findings.filter((f) => f.severity === "quality")], passed, iterations: maxIterations, inputTokens, outputTokens };
}
