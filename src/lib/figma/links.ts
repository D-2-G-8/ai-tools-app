/**
 * Builds a link that opens a specific node in the Figma UI, from a file key
 * and a REST-API node ID (e.g. "1:23") -- Figma's own web URLs use "1-23"
 * (colon replaced by a dash) for the node-id query param. Used to make the
 * "Figma node IDs" shown on the component detail page and each token's row
 * clickable, so it's easy to jump back into Figma and see exactly what a
 * sync actually picked up -- handy when a component's name/shape looks
 * unexpected (see e.g. the component list's "why does this look like an
 * HTML tag" case: jumping to the node in Figma shows it's an internal
 * anatomy piece of a bigger composite component, not a naming bug here).
 *
 * Deliberately not tagged "server-only" -- it's pure string formatting, no
 * secrets/network involved, safe to import from either a server or client
 * component.
 */
export function figmaNodeUrl(fileKey: string, nodeId: string): string {
  return `https://www.figma.com/file/${encodeURIComponent(fileKey)}/?node-id=${encodeURIComponent(nodeId.replace(/:/g, "-"))}`;
}
