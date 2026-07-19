import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/* eslint-disable @typescript-eslint/no-unused-vars -- every renderer below
   destructures `node` (react-markdown's internal mdast node) purely to
   exclude it from the DOM element's prop spread; it's intentionally never
   read past that. */

/**
 * Renders markdown document content with real typographic styling --
 * headings, bold/italic, lists, tables, blockquotes, links, code -- instead
 * of the raw markdown source. Used for the plain-text segments of a
 * document's content (see split-fences.ts, which already pulls out bpmn/
 * mermaid/image blocks before this ever sees them).
 *
 * remark-gfm adds GitHub-flavored markdown on top of the CommonMark base:
 * tables, strikethrough, task lists, and autolinked URLs -- all things a
 * generated business document plausibly contains.
 */
const markdownComponents: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1 className="mt-2 text-2xl font-semibold text-neutral-900 first:mt-0" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 className="mt-2 text-xl font-semibold text-neutral-900 first:mt-0" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 className="mt-2 text-lg font-semibold text-neutral-900 first:mt-0" {...props} />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 className="mt-2 text-base font-semibold text-neutral-900 first:mt-0" {...props} />
  ),
  h5: ({ node: _node, ...props }) => (
    <h5 className="mt-2 text-sm font-semibold uppercase tracking-wide text-neutral-700 first:mt-0" {...props} />
  ),
  h6: ({ node: _node, ...props }) => (
    <h6 className="mt-2 text-sm font-semibold uppercase tracking-wide text-neutral-500 first:mt-0" {...props} />
  ),
  p: ({ node: _node, ...props }) => <p className="leading-relaxed" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-neutral-900" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic" {...props} />,
  del: ({ node: _node, ...props }) => <del className="text-neutral-400" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a className="text-blue-600 underline hover:text-blue-700" target="_blank" rel="noopener noreferrer" {...props} />
  ),
  ul: ({ node: _node, ...props }) => <ul className="ml-5 list-disc space-y-1" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="ml-5 list-decimal space-y-1" {...props} />,
  li: ({ node: _node, ...props }) => <li className="leading-relaxed" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="border-l-2 border-neutral-300 pl-3 text-neutral-600 italic" {...props} />
  ),
  hr: ({ node: _node, ...props }) => <hr className="border-neutral-200" {...props} />,
  code: ({ node: _node, className, children, ...rest }) => {
    // react-markdown (v9+) no longer passes an `inline` flag -- the
    // documented way to tell fenced ("```lang") code from inline (`code`)
    // is that fenced blocks get a `language-xxx` className and inline
    // spans don't. A language-less fenced block is the one edge case this
    // misses (it renders with the inline chip style instead of the block
    // style) -- acceptable, since generated documents overwhelmingly tag
    // their code fences.
    const isFenced = /language-/.test(className ?? "");
    return isFenced ? (
      <code className={`${className ?? ""} font-mono text-sm`} {...rest}>
        {children}
      </code>
    ) : (
      <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[13px] text-neutral-800" {...rest}>
        {children}
      </code>
    );
  },
  pre: ({ node: _node, ...props }) => (
    <pre className="overflow-x-auto rounded-md bg-neutral-900 p-3 text-neutral-100" {...props} />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-neutral-50" {...props} />,
  th: ({ node: _node, ...props }) => (
    <th className="border border-neutral-200 px-3 py-1.5 font-medium text-neutral-700" {...props} />
  ),
  td: ({ node: _node, ...props }) => <td className="border border-neutral-200 px-3 py-1.5 align-top" {...props} />,
};

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-neutral-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
