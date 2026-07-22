import "server-only";
import { db } from "@/db";
import { workspace, designComponent, run as runTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getEffectiveModel } from "@/lib/tools/model-settings";
import { getTypecheckAnnotations, getBranchFile, commitFiles } from "@/lib/github/client";
import { groupAnnotationsByComponent, importSlug } from "./ci-map";
import { parseCompositionImports } from "./review/prop-types";
import { fixComponentFiles, type ComponentForCodegen, type ChildContract, type ComponentContract } from "./component";
import { componentSourcePaths } from "./paths";
import { loadTokensForCss } from "./data";

// Bound: ~1 LLM call each, keeps the whole round comfortably under the
// route's 60s budget even for the slowest components.
const MAX_FIX_PER_CLICK = 4;
// Consecutive non-green rounds -> stop looping and hand off to a human
// instead of burning LLM calls against an error the autofix can't resolve.
const ESCALATE_AFTER = 3;

export interface CiAutofixResult {
  status: "green" | "fixed" | "pending" | "no-pr" | "escalate";
  fixed: string[];
  skippedIcons: string[];
  remaining: number;
  errorCount: number;
  failed: string[];
}

/**
 * Reads the design-system CI's latest typecheck result for the workspace's
 * currently-open PR branch and, on failure, feeds the affected components'
 * real tsc errors into the same holistic fixer the generation review loop
 * uses (fixComponentFiles), committing the fix back onto that branch.
 *
 * Deliberately does NOT call getOrOpenSessionBranch (session.ts) -- that
 * function OPENS a new session branch/PR as a side effect when none exists,
 * which this read-only-until-a-fix-is-needed flow must never do on its own.
 * If there's no pending PR branch yet, there's nothing to typecheck against,
 * so this returns "no-pr" rather than minting one.
 *
 * Icons are skipped (not fed to the LLM) -- they're generated
 * deterministically from a real Figma SVG (see icon.ts), so a tsc error in
 * one is either a bug in that deterministic generator (needs a code fix, not
 * an LLM patch) or a hand-authored icon, not something this autofix should
 * guess at. They're reported back via `skippedIcons` for a human to handle.
 */
export async function autofixTypeErrorsFromCi(workspaceId: string, userId: string): Promise<CiAutofixResult> {
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const branch = ws?.designSystemPendingPrBranch || null;
  if (!branch) return { status: "no-pr", fixed: [], skippedIcons: [], remaining: 0, errorCount: 0, failed: [] };

  const tc = await getTypecheckAnnotations(branch);
  if (tc.conclusion === "pending")
    return { status: "pending", fixed: [], skippedIcons: [], remaining: 0, errorCount: 0, failed: [] };
  if (tc.conclusion === "success" || tc.conclusion === "missing") {
    await db.update(workspace).set({ ciAutofixAttempts: 0 }).where(eq(workspace.id, workspaceId));
    return { status: "green", fixed: [], skippedIcons: [], remaining: 0, errorCount: 0, failed: [] };
  }

  // failure
  if ((ws?.ciAutofixAttempts ?? 0) >= ESCALATE_AFTER) {
    return { status: "escalate", fixed: [], skippedIcons: [], remaining: 0, errorCount: tc.annotations.length, failed: [] };
  }

  const groups = groupAnnotationsByComponent(tc.annotations);
  const iconGroups = groups.filter((g) => g.isIcon); // deterministic SVG -> human, not LLM
  const fixable = groups.filter((g) => !g.isIcon).slice(0, MAX_FIX_PER_CLICK);

  const model = await getEffectiveModel(workspaceId, "design-system-codegen");
  // The synced tokens, so a fix for an "unknown token var" error can map to a
  // real token (or know to inline when none matches) instead of re-inventing.
  const availableTokens = await loadTokensForCss(workspaceId);
  const fixed: string[] = [];
  const failed: string[] = [];

  // Committed components -> contracts, for children lookup (a fixed
  // component may compose other design-system components; the fixer needs
  // their real prop APIs the same way generation does).
  const committed = await db
    .select({
      slug: designComponent.slug,
      name: designComponent.name,
      isIcon: designComponent.isIcon,
      contractJson: designComponent.contractJson,
      variants: designComponent.variants,
      states: designComponent.states,
      description: designComponent.description,
    })
    .from(designComponent)
    .where(eq(designComponent.workspaceId, workspaceId));
  const bySlug = new Map(committed.map((c) => [c.slug, c]));

  for (const g of fixable) {
    try {
      const row = bySlug.get(g.slug);
      if (!row || !row.contractJson) continue; // no persisted contract -> can't fix safely; leave for regen

      const paths = componentSourcePaths(g.slug, g.isIcon);
      const [tsx, css, stories] = await Promise.all([
        getBranchFile(branch, paths.tsxPath),
        getBranchFile(branch, paths.cssPath),
        getBranchFile(branch, paths.storiesPath),
      ]);
      if (tsx == null) continue;

      // Children this component composes come from its OWN tsx imports (no
      // Figma refetch -- CI annotations carry no design-spec context).
      const childSlugs = parseCompositionImports(tsx)
        .map((i) => importSlug(i.path))
        .filter((s): s is string => !!s);
      const uses = [...new Set(childSlugs)]
        .map((slug) => bySlug.get(slug))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({ slug: c.slug, componentName: componentSourcePaths(c.slug, c.isIcon).componentName, isIcon: c.isIcon }));
      const childContracts = new Map<string, ChildContract>();
      for (const u of uses) {
        const c = bySlug.get(u.slug);
        if (c?.contractJson) childContracts.set(u.slug, c.contractJson);
      }

      const component: ComponentForCodegen = {
        slug: row.slug,
        name: row.name,
        description: row.description ?? undefined,
        variants: row.variants,
        states: row.states,
        isIcon: row.isIcon,
        designSpec: undefined,
        uses,
      };
      const contract: ComponentContract = {
        // StoredComponentContract's props.description is optional (older rows
        // predate it); the fixer's contract schema requires it, so default to
        // an empty string rather than dropping the prop.
        props: row.contractJson.props.map((p) => ({ name: p.name, type: p.type, description: p.description ?? "" })),
        cssVariables: row.contractJson.cssVariables ?? [],
        classNames: row.contractJson.classNames ?? [],
      };

      const result = await fixComponentFiles(
        model,
        component,
        contract,
        { tsx, css: css ?? "", stories: stories ?? "", index: "" },
        g.findings,
        childContracts,
        availableTokens,
      );

      await commitFiles(branch, `Fix type errors in ${paths.componentName} (CI)`, [
        { path: paths.tsxPath, content: result.files.tsx },
        { path: paths.cssPath, content: result.files.css },
        { path: paths.storiesPath, content: result.files.stories },
      ]);
      // costEstimateUsd is omitted -- it has a DB default ("0") and this run
      // (a targeted CI fix, not a full generation) doesn't compute a cost the
      // way generateComponentCode's estimateCostUsd call does.
      await db.insert(runTable).values({
        workspaceId,
        toolKey: "design-system-codegen",
        model,
        userId,
        status: "completed",
        inputSummary: `CI type-fix ${row.name}`.slice(0, 500),
        outputSummary: `Fixed ${g.findings.length} tsc error(s)`.slice(0, 500),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      fixed.push(g.slug);
    } catch (err) {
      // One flaky component (LLM timeout, commit 422, ...) must not throw out
      // of the whole batch -- the rest of `fixable` still deserves a shot, and
      // the end-of-loop attempts bump below must still run.
      console.warn(`[ci-autofix] failed to fix ${g.slug}:`, err);
      failed.push(g.slug);
    }
  }

  await db
    .update(workspace)
    .set({ ciAutofixAttempts: (ws?.ciAutofixAttempts ?? 0) + 1 })
    .where(eq(workspace.id, workspaceId));

  return {
    status: "fixed",
    fixed,
    skippedIcons: iconGroups.map((g) => g.slug),
    remaining: Math.max(0, groups.filter((g) => !g.isIcon).length - fixed.length),
    errorCount: tc.annotations.length,
    failed,
  };
}
