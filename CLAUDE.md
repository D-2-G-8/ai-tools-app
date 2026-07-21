@AGENTS.md

# Language

Write everything in this project in English only — code, comments, string
literals, UI text, commit messages, and documentation.

# Design-system codegen — everything must be GENERAL (no per-component rules)

This workspace has ~30 distinct design-system components, plus hundreds of
icons and many tokens — all different from each other. Every gate, check,
prompt, heuristic, and fix in the codegen/review layer
(`src/lib/design-system-codegen/`) MUST be general and data-driven: derived at
runtime from each component's own contract, distilled Figma spec, and the
synced tokens. NEVER special-case a specific component, icon, or token by name
or by hardcoded value (no `if (slug === "avatar")`, no baked-in prop-value
lists, no per-component branches). A rule that does not generalize across all
components + icons + tokens is wrong — fix the general mechanism instead.
This applies to LLM prompts too: ground them in the passed-in contract/spec/
token data, not in assumptions about particular components.
