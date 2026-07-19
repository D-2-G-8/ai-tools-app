import { generateText } from "ai";
import { getAnthropicClient } from "@/lib/llm/client";

/**
 * Model used to turn an embedded image into text for the vector index (see
 * describeImagesInMarkdown in images.ts). This is a mechanical
 * image -> text conversion, not a reasoning task, so the cheapest capable
 * model is the right call here, not the workspace's configured tool model
 * (see models.ts for the catalog) -- keeping the ingest-time cost low is the
 * whole point of doing this with a "light, cheap model" as requested.
 */
const IMAGE_CAPTION_MODEL = "claude-haiku-4-5";

const IMAGE_CAPTION_SYSTEM_PROMPT = `You convert an image embedded in a software project's documentation into
plain text, so the image's content becomes searchable in a semantic (vector) search index. Look at the image and
write a thorough, factual description -- this text is the ONLY thing that will represent the image in search, so
don't leave out details someone might later search for (button labels, field names, error messages, status
values, step names).

Images in this context are usually one of these kinds -- identify which one applies and describe accordingly:
- A screenshot or export of a BPMN-style business process diagram (boxes and arrows depicting steps, decision
  diamonds/gateways): describe it as an ordered sequence of steps -- the actors/roles involved, each step in
  order, every decision point and what happens on each of its branches/outcomes.
- A screenshot or export of a sequence/interaction diagram (participants or lifelines with arrows passing
  between them over time): describe it as an ordered list of interactions -- who calls/sends to whom, with what,
  and what response or return message follows, including any alternative/error branches shown.
- A screenshot of an application UI (a page, form, dashboard, dialog, etc.): state what screen or section this
  is, transcribe the visible text/labels/values verbatim where legible, describe the main UI elements and their
  layout, and note any state shown (a filled-in form, a validation error, a loading/empty state, etc.).
- Anything else: describe what is depicted, factually and completely.

Do not add commentary about the image quality, your confidence, or that you are describing an image -- write
only the description itself, as plain text (no markdown formatting).`;

export interface ImageToDescribe {
  /** Base64-encoded image bytes, no "data:...;base64," prefix. */
  data: string;
  /** e.g. "image/png" */
  mediaType: string;
  /** The markdown alt text for this image, if any -- passed as a hint only. */
  alt?: string;
}

/**
 * Describes a single image with a cheap vision model. Never throws for
 * "the model didn't like this image" style failures the caller can't do
 * anything about -- callers are expected to decide how to handle a thrown
 * error (currently: skip that one image, see images.ts).
 */
export async function describeImage(image: ImageToDescribe): Promise<string> {
  const anthropic = await getAnthropicClient();

  const result = await generateText({
    model: anthropic(IMAGE_CAPTION_MODEL),
    system: IMAGE_CAPTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", image: image.data, mediaType: image.mediaType },
          {
            type: "text",
            text: image.alt
              ? `The document's alt text for this image is: "${image.alt}". Describe the image itself.`
              : "Describe this image.",
          },
        ],
      },
    ],
  });

  return result.text.trim();
}
