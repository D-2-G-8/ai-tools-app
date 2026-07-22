import "server-only";

// Kept well under the visual-review route's maxDuration=60 so a merely-slow
// screenshot can't push the whole request past the function limit (a 504 would
// bypass the graceful never-500 guarantee) -- it leaves room for the Figma
// render + vision + fix LLM calls in the same request.
const SCREENSHOT_TIMEOUT_MS = 25_000;

/** Screenshot a public URL via an external service (ScreenshotOne by default;
 *  override the base with SCREENSHOT_API_URL). Returns raw PNG bytes. Throws a
 *  clear error if the key is missing or the service fails -- the caller surfaces
 *  it (e.g. "stand not deployed yet, retry"). */
export async function captureScreenshot(url: string): Promise<{ bytes: Uint8Array; mediaType: "image/png" }> {
  const key = process.env.SCREENSHOT_API_KEY;
  if (!key) throw new Error("SCREENSHOT_API_KEY is not set -- add it to enable visual review (see .env.example).");
  const base = process.env.SCREENSHOT_API_URL || "https://api.screenshotone.com/take";
  const api = `${base}?access_key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}&format=png&viewport_width=1280&device_scale_factor=2&full_page=false&block_ads=true&cache=false`;
  let res: Response;
  try {
    res = await fetch(api, { signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Screenshot service unreachable for ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Screenshot service returned ${res.status} for ${url}: ${text.slice(0, 300)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error(`Screenshot service returned an empty image for ${url}.`);
  return { bytes: buf, mediaType: "image/png" };
}
