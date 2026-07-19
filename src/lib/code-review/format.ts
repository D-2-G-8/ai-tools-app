import type { CodeReviewFindingRecord } from "@/db/schema";

/**
 * Formats findings into the Markdown comment posted back to the MR --
 * ported from the Python prototype's format_comment/_findings_table/
 * _escape_cell. Kept in its own plain module (not code-review-actions.ts,
 * which has "use server" at the top): Next.js only allows Server Action
 * files to export async functions, and this is a pure sync formatter.
 */

const SEVERITY_LABEL: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium" };
const SEVERITY_EMOJI: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡" };

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>").trim();
}

function findingsTable(findings: CodeReviewFindingRecord[], cross: boolean): string[] {
  const rows: string[] = [];
  if (cross) {
    rows.push("| File | Severity | Agreement | Issue | Why fix it |");
    rows.push("| --- | --- | --- | --- | --- |");
  } else {
    rows.push("| File | Severity | Issue | Why fix it |");
    rows.push("| --- | --- | --- | --- |");
  }
  for (const f of findings) {
    const label = `${SEVERITY_EMOJI[f.severity] ?? ""} ${SEVERITY_LABEL[f.severity] ?? f.severity}`;
    if (cross) {
      rows.push(
        `| \`${escapeTableCell(f.file)}\` | ${label} | ${f.agreement ?? 1}× | ${escapeTableCell(f.bug)} | ${escapeTableCell(f.why)} |`,
      );
    } else {
      rows.push(`| \`${escapeTableCell(f.file)}\` | ${label} | ${escapeTableCell(f.bug)} | ${escapeTableCell(f.why)} |`);
    }
  }
  return rows;
}

export function formatReviewComment(findings: CodeReviewFindingRecord[], truncated: boolean): string {
  const lines = ["## 🤖 AI review", ""];
  const cross = findings.some((f) => f.agreement !== undefined);
  const confirmed = findings.filter((f) => f.verdict !== "needs_verification");
  const toVerify = findings.filter((f) => f.verdict === "needs_verification");

  if (confirmed.length === 0) {
    lines.push(toVerify.length > 0 ? "No confirmed issues ✅" : "No issues found ✅");
  } else {
    lines.push(...findingsTable(confirmed, cross));
  }

  if (toVerify.length > 0) {
    lines.push("", "### ⚠️ Needs verification", "_Plausible but not confirmed from the diff alone — a human should check these._", "");
    lines.push(...findingsTable(toVerify, cross));
  }

  if (truncated) {
    lines.push("", "> ⚠️ The diff was truncated due to a size limit — not all changes were analyzed.");
  }
  lines.push("", "> _Automated comment. Verify the findings before fixing._");
  return lines.join("\n");
}
