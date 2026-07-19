"use client";

import { useEffect, useRef, useState } from "react";

let idCounter = 0;

/**
 * Renders a Mermaid diagram definition (e.g. a `sequenceDiagram`) as an SVG
 * using mermaid.js.
 *
 * The Mermaid text itself is what's actually persisted -- it lives as plain
 * text inside a ```mermaid fenced block in the surrounding document's
 * markdown (see lib/markdown/split-fences.ts). This component only renders
 * that stored text as a picture at view time; nothing about the diagram is
 * stored in any other form.
 *
 * mermaid is imported dynamically (not at module top-level) because it
 * touches the DOM directly and has no meaningful server-side render.
 */
export function MermaidDiagram({ definition }: { definition: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const idRef = useRef(`mermaid-diagram-${++idCounter}`);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const { default: mermaid } = await import("mermaid");
      if (cancelled) return;

      // "strict" sanitizes any HTML that shows up inside diagram labels --
      // the diagram source is either model-generated or user-edited text
      // living in this app's own documents, but there's no reason to trust
      // it any more than that.
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

      try {
        const { svg: renderedSvg } = await mermaid.render(idRef.current, definition);
        if (cancelled) return;
        setSvg(renderedSvg);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    render();

    return () => {
      cancelled = true;
    };
  }, [definition]);

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      {error && (
        <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">
          Couldn&apos;t render this diagram: {error}
        </p>
      )}
      <div ref={containerRef} className="overflow-auto p-4">
        {svg && <div dangerouslySetInnerHTML={{ __html: svg }} />}
      </div>
      <div className="border-t border-neutral-100 px-4 py-2">
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="text-xs text-neutral-400 hover:underline"
        >
          {showSource ? "Hide" : "Show"} diagram source
        </button>
        {showSource && (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-50 p-3 font-mono text-xs text-neutral-600">
            {definition}
          </pre>
        )}
      </div>
    </div>
  );
}
