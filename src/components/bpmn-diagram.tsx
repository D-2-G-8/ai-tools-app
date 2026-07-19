"use client";

import { useEffect, useRef, useState } from "react";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css";

/**
 * Renders a BPMN 2.0 XML string as an interactive (pan/zoom) diagram using
 * bpmn-js's NavigatedViewer.
 *
 * The XML itself is what's actually persisted -- it lives as plain text
 * inside a ```bpmn fenced block in the surrounding document's markdown (see
 * lib/markdown/split-fences.ts). This component only renders that stored
 * text as a picture at view time; nothing about the diagram is stored in
 * any other form.
 *
 * bpmn-js is imported dynamically (not at module top-level) because it
 * manipulates the DOM directly on construction and has no server-side
 * render -- doing the import inside the effect keeps it out of the
 * server-rendered bundle for this (client) component.
 */
export function BpmnDiagram({ xml }: { xml: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let viewer: { destroy: () => void } | null = null;

    async function render() {
      const container = containerRef.current;
      if (!container) return;
      container.innerHTML = "";

      const { default: NavigatedViewer } = await import("bpmn-js/lib/NavigatedViewer");
      if (cancelled) return;

      const instance = new NavigatedViewer({ container });
      viewer = instance;

      try {
        await instance.importXML(xml);
        if (cancelled) return;
        instance.get<{ zoom: (arg: string) => void }>("canvas").zoom("fit-viewport");
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    render();

    return () => {
      cancelled = true;
      viewer?.destroy();
    };
  }, [xml]);

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      {error && (
        <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">
          Couldn&apos;t render this BPMN diagram: {error}
        </p>
      )}
      <div ref={containerRef} className="h-[420px] w-full" />
      <div className="border-t border-neutral-100 px-4 py-2">
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="text-xs text-neutral-400 hover:underline"
        >
          {showSource ? "Hide" : "Show"} BPMN XML source
        </button>
        {showSource && (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-50 p-3 font-mono text-xs text-neutral-600">
            {xml}
          </pre>
        )}
      </div>
    </div>
  );
}
