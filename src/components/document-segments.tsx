import type { MarkdownSegment } from "@/lib/markdown/split-fences";
import { BpmnDiagram } from "./bpmn-diagram";
import { MermaidDiagram } from "./mermaid-diagram";
import { MarkdownContent } from "./markdown-content";

/**
 * Renders a document's already-split segments (see split-fences.ts): bpmn/
 * mermaid diagrams, embedded images, and everything else as styled markdown.
 * Shared between the real document view page and the format-preview panel
 * (document-format-button.tsx) so the preview shows exactly what applying it
 * would actually look like -- no separate, divergent rendering logic to keep
 * in sync.
 */
export function DocumentSegments({ segments }: { segments: MarkdownSegment[] }) {
  return (
    <div className="flex flex-col gap-4">
      {segments.map((segment, i) =>
        segment.type === "bpmn" ? (
          <BpmnDiagram key={i} xml={segment.content} />
        ) : segment.type === "mermaid" ? (
          <MermaidDiagram key={i} definition={segment.content} />
        ) : segment.type === "image" ? (
          <section key={i} className="rounded-lg border border-neutral-200 bg-white p-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- image
                sources here are arbitrary Blob URLs / data URIs supplied
                at runtime, not static assets next/image can optimize. */}
            <img src={segment.src} alt={segment.alt || "Embedded image"} className="max-w-full rounded" />
            {segment.alt && <p className="mt-2 text-xs text-neutral-400">{segment.alt}</p>}
          </section>
        ) : segment.content.trim() ? (
          <section key={i} className="rounded-lg border border-neutral-200 bg-white p-5">
            <MarkdownContent content={segment.content} />
          </section>
        ) : null,
      )}
    </div>
  );
}
