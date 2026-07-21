import "server-only";
import { runDeterministicGates, applyDeterministicFixes } from "./deterministic";
import { reviewWithLlm } from "./reviewer";
import type { Finding, FileKind, GeneratedFiles, ReviewContext, ReviewResult } from "./types";

export type { GeneratedFiles, ReviewContext, ReviewResult, Finding, FileKind } from "./types";

export interface ReviewAndFixArgs {
  model: string;
  files: GeneratedFiles;
  ctx: ReviewContext;
  spec: string | undefined;
  regenerateFile: (kind: FileKind, feedback: string) => Promise<string>;
  maxIterations?: number;
}

function feedbackFor(file: FileKind, findings: Finding[]): string {
  return findings
    .filter((f) => f.file === file)
    .map((f) => `- ${f.message}${f.suggestion ? ` (fix: ${f.suggestion})` : ""}`)
    .join("\n");
}

export async function reviewAndFix(args: ReviewAndFixArgs): Promise<ReviewResult> {
  const { model, ctx, spec, regenerateFile } = args;
  const maxIterations = args.maxIterations ?? 3;
  let files = args.files;
  let findings: Finding[] = [];

  for (let i = 1; i <= maxIterations; i++) {
    // 1) deterministic gates + free fixes, then re-gate
    let det = runDeterministicGates(files, ctx);
    files = applyDeterministicFixes(files, det);
    det = runDeterministicGates(files, ctx);

    // 2) LLM DoD review (best-effort)
    const llm = await reviewWithLlm(model, files, spec, ctx.componentName);
    findings = [...det, ...llm];

    if (findings.length === 0) {
      return { files, findings: [], passed: true, iterations: i };
    }

    // 3) regenerate each affected file with its feedback (only files with
    //    non-deterministically-fixed findings remaining)
    const affected = new Set<FileKind>(findings.map((f) => f.file));
    for (const kind of affected) {
      if (kind === "index") continue; // index is deterministic; never LLM-regenerated
      const fb = feedbackFor(kind, findings);
      if (!fb) continue;
      try {
        const next = await regenerateFile(kind, fb);
        files = { ...files, [kind]: next };
      } catch {
        // regeneration failed -> keep current file; loop/terminal handles it
      }
    }
  }

  // bound hit: re-gate once more so `passed` reflects the final files
  const finalDet = runDeterministicGates(files, ctx);
  const finalFixed = applyDeterministicFixes(files, finalDet);
  files = finalFixed;
  const residual = runDeterministicGates(files, ctx);
  const passed = !residual.some((f) => f.severity === "build-breaking");
  return { files, findings: [...residual, ...findings.filter((f) => f.severity === "quality")], passed, iterations: maxIterations };
}
