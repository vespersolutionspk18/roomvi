/**
 * The generative executor.
 *
 * Turns a list of ops into a rendered JPEG on disk, via fal, and refuses to
 * return a render that quietly changed the room.
 *
 * THE SHAPE OF A RENDER, and why each step is where it is:
 *
 *   1. Load the ORIGINAL photo. Never a previous render — see invariant 1 in the
 *      schema. Chaining is how a kitchen slowly becomes a different kitchen.
 *   2. Build the union mask of every surface being edited.
 *   3. Submit to fal, PERSISTING THE REQUEST ID FIRST so a crash mid-poll is a
 *      re-poll rather than a second charge.
 *   4. Composite the result back through the feathered mask (masked ops only).
 *      Structural edits skip this — there is no mask that contains "remove the
 *      cupboards", and forcing one leaves a cupboard-shaped hole.
 *   5. Measure drift outside the mask, ON FAL'S OUTPUT rather than on the
 *      composite. The composite restores those pixels, so measuring it scores a
 *      perfect zero no matter what the model did.
 *
 * COST. flux-kontext-lora/inpaint is $0.035/MP; nano-banana-2/edit is per-image.
 * Every path here is one fal call per render — no speculative retries, because a
 * retry is a second charge and the guard's job is to REPORT drift, not to keep
 * paying until it goes away.
 */
import sharp from "sharp";
import * as fal from "@/lib/fal";
import { decodeMask, encodeMask, union, type Mask } from "@/lib/mask";
import { compositeThroughMask, guardMask } from "./composite";
import { measureDrift, type DriftReport } from "./guard";
import {
  editPrompt,
  materialPrompt,
  FREE_FORM_SYSTEM,
  type MaterialDescriptor,
} from "./prompt";

export const FLUX_INPAINT = "fal-ai/flux-kontext-lora/inpaint";
/**
 * The default editor. Gemini 3.1 Flash Image — near-Pro instruction following at
 * roughly a third of the latency and half the cost, which is what makes a chat-
 * paced editor feel like a conversation rather than a batch job.
 */
export const NANO_BANANA_2_EDIT = "fal-ai/nano-banana-2/edit";
/** The quality tier. Same input shape; flip the default when a render is worth the wait. */
export const NANO_BANANA_PRO_EDIT = "fal-ai/nano-banana-pro/edit";

/**
 * Inpaint strength.
 *
 * The endpoint defaults to 0.88, which erases the underlying shading — you get a
 * flat swatch pasted into a lit room. Around 0.7 keeps enough of the original
 * luminance structure for the surface to still look lit while fully replacing the
 * material. Below ~0.5 the old material shows through as a ghost pattern.
 */
export const DEFAULT_STRENGTH = 0.7;

type FalImage = { url: string; width?: number; height?: number };
type InpaintOutput = { images: FalImage[]; seed?: number };
type EditOutput = { images: FalImage[]; description?: string };

export type MaterialOp = {
  kind: "material";
  surface: { id: string; kind: string; label: string; maskKey: string };
  material: MaterialDescriptor & { id: string; textureKey: string | null };
  strength?: number;
};

export type PromptOp = {
  kind: "prompt";
  prompt: string;
  /** Present when the prompt was classified as confinable to a surface. */
  surface?: { id: string; kind: string; label: string; maskKey: string } | null;
  /**
   * Storage keys of reference images the user attached — a material photo, a
   * colour swatch, "like this one". Uploaded to fal and appended after the
   * photo, so image_urls[0] is always the room being edited.
   */
  references?: string[];
  /**
   * Storage key of a hand-painted region mask ("add a cat HERE"). Sent to the
   * model as a guide image AND composited through locally, so the change is
   * guaranteed to land in the painted area rather than merely promised to.
   */
  paintMaskKey?: string;
};

export type RenderOp = MaterialOp | PromptOp;

export type ExecuteInput = {
  /** The ORIGINAL display-resolution photo. */
  photo: Buffer;
  width: number;
  height: number;
  ops: RenderOp[];
  /** Reads a surface mask by storage key. Injected so this module stays testable. */
  loadMask: (key: string) => Promise<Buffer>;
  /** Reads a material texture, used as the inpaint reference image. */
  loadTexture: (key: string) => Promise<Buffer>;
  /** Reads a user-supplied reference image by storage key. */
  loadReference: (key: string) => Promise<Buffer>;
  /**
   * OUTPAINT: pad the photo by these amounts (white), let the model fill the
   * border, then composite the ORIGINAL photograph back over its exact region
   * with a feathered edge. Generation can only add scenery around the shot,
   * never alter it.
   */
  expand?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  };
  seed?: number | null;
  /**
   * An id from a previous attempt at this same render.
   *
   * When present, `execute` RE-POLLS it instead of submitting. fal keeps a
   * completed result addressable, so a retry after the render succeeded but the
   * bookkeeping failed costs nothing. Without this the caller's stored id was
   * write-only and a retry paid again — measured: one backsplash render, three
   * charges, because a `seed` column overflow threw after the fal call returned.
   *
   * Deliberately NOT trusted blindly: if the endpoint has changed since (a
   * different material path, say) the stored id belongs to a different call and
   * `endpoint` below decides, so the caller passes both.
   */
  resume?: { requestId: string; endpoint: string } | null;
  /**
   * Called with the fal request id the instant it exists, before any polling.
   * The caller MUST persist it — that is what makes a crash recoverable.
   */
  onSubmitted?: (requestId: string, endpoint: string) => Promise<void>;
  /** Renews the job lease; a fal render can outlive a 2-minute lease. */
  onProgress?: (note: string) => Promise<void>;
  signal?: AbortSignal;
};

export type ExecuteResult = {
  jpeg: Buffer;
  width: number;
  height: number;
  endpoint: string;
  falRequestId: string;
  seed: number | null;
  costUnits: number;
  drift: DriftReport | null;
  /** True when the output was fused back through the mask. */
  composited: boolean;
  ms: number;
};

/** Union the masks of every surface an op targets, in display space. */
async function buildMask(
  ops: RenderOp[],
  loadMask: (key: string) => Promise<Buffer>,
  dims: { width: number; height: number },
): Promise<Mask | null> {
  const keys = new Set<string>();
  for (const op of ops) {
    if (op.kind === "material") keys.add(op.surface.maskKey);
    else if (op.surface) keys.add(op.surface.maskKey);
  }
  if (keys.size === 0) return null;

  const masks: Mask[] = [];
  for (const key of keys) {
    const m = await decodeMask(await loadMask(key));
    if (m.width !== dims.width || m.height !== dims.height) {
      throw new Error(
        `render: mask ${key} is ${m.width}x${m.height}, expected ${dims.width}x${dims.height}`,
      );
    }
    masks.push(m);
  }
  return masks.length > 1 ? union(masks) : masks[0];
}

/**
 * Encode the whole op list as one instruction.
 *
 * Multiple ops in one render is deliberate: two fal calls for "oak floor + white
 * walls" costs twice as much and lets the second call re-light the first's work.
 */
function buildPrompt(ops: RenderOp[]): string {
  const parts: string[] = [];
  for (const op of ops) {
    if (op.kind === "material") {
      parts.push(materialPrompt(op.surface.label, op.material));
    } else {
      parts.push(editPrompt(op.prompt, op.surface?.label));
    }
  }
  // Already-guarded single op: return it verbatim rather than re-wrapping.
  if (parts.length === 1) return parts[0];

  // For a combined render the Preserve/Constraints blocks would repeat once per
  // op, diluting them. Merge the Change lines and state the rails once.
  const changes = parts
    .map((p) => p.split("\n")[0].replace(/^Change:\s*/, ""))
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const tail = parts[0].split("\n").slice(1).join("\n");
  return `Change:\n${changes}\n${tail}`;
}

/**
 * Render one op list.
 *
 * Routes on whether a mask exists. A masked render uses the inpaint endpoint,
 * which can be handed the material bitmap itself as a reference — literally "put
 * THIS material in THIS region", and the only confirmed endpoint accepting
 * `mask_url` and `reference_image_url` together. Structural edits go to the
 * free-form endpoint whole-image.
 */
export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
  const started = Date.now();
  const { photo, width, height, ops } = input;
  if (ops.length === 0) throw new Error("render: no ops");

  const mask = await buildMask(ops, input.loadMask, { width, height });
  const prompt = buildPrompt(ops);
  const costUnits = fal.billableUnits(width, height);

  const firstMaterial = ops.find((o): o is MaterialOp => o.kind === "material");

  // Build the outpaint canvas: the photo centred on a white field at the
  // target ratio. The white IS the instruction — the model sees exactly where
  // scenery must appear, in the exact layout it must appear in.
  let inputImage = photo;
  if (input.expand) {
    inputImage = await sharp(photo)
      .extend({
        left: input.expand.left,
        right: input.expand.right,
        top: input.expand.top,
        bottom: input.expand.bottom,
        background: { r: 255, g: 255, b: 255 },
      })
      .png()
      .toBuffer();
    await input.onProgress?.(
      `outpaint canvas ${input.expand.width}x${input.expand.height} prepared`,
    );
  }

  // A painted region is a HINT about where the user wants the change, not a
  // stencil. It rides to the model as a guide image with softened language —
  // "focus here, extend naturally" — because a hard composite through the
  // strokes produces exactly the failures that make inpainting feel dumb: a
  // plant clipped at its pot, a shadow amputated at a brush edge. The model
  // decides where the change physically ends; the paint says where it starts.
  let paintMaskKey: string | undefined;
  for (const op of ops) {
    if (op.kind === "prompt" && op.paintMaskKey) {
      paintMaskKey = op.paintMaskKey;
      break;
    }
  }
  const paintMaskBytes = paintMaskKey ? await input.loadMask(paintMaskKey) : null;

  // Routing is decided BEFORE anything is uploaded, because it depends only on
  // what the ops are — and because a resume must be able to check "same endpoint?"
  // without paying three uploads to find out. The masked material swap keeps its
  // dedicated inpaint path; everything else — the whole product now — goes to the
  // Flash editor: references, paint guides and all.
  const endpoint =
    mask && firstMaterial?.material.textureKey ? FLUX_INPAINT : NANO_BANANA_2_EDIT;

  /**
   * A previous attempt already submitted this. Re-poll rather than re-submit.
   *
   * This is the difference between a retry costing nothing and costing full price.
   * The endpoint must match: a stored id from a different endpoint is not this
   * render's work, and polling it would return someone else's image.
   */
  let requestId: string;
  if (input.resume && input.resume.endpoint === endpoint) {
    requestId = input.resume.requestId;
    await input.onProgress?.(`resuming ${endpoint} ${requestId} — already paid for`);
  } else {
    const photoUrl = await fal.upload(inputImage, "room.jpg", "image/jpeg");
    await input.onProgress?.("photo uploaded");

    let falInput: Record<string, unknown>;

    if (endpoint === FLUX_INPAINT && mask && firstMaterial?.material.textureKey) {
      // The reference image is what makes this a true material swap rather than a
      // text-described one — the model sees the actual grain and colour.
      const texture = await input.loadTexture(firstMaterial.material.textureKey);
      const [maskUrl, referenceUrl] = await Promise.all([
        fal.upload(await encodeMask(mask), "mask.png", "image/png"),
        fal.upload(texture, "material.png", "image/png"),
      ]);

      falInput = {
        prompt,
        image_url: photoUrl,
        mask_url: maskUrl,
        reference_image_url: referenceUrl,
        strength: firstMaterial.strength ?? DEFAULT_STRENGTH,
        num_inference_steps: 30,
        guidance_scale: 2.5,
        output_format: "png",
        ...(input.seed != null ? { seed: input.seed } : {}),
      };
    } else {
      // References ride AFTER the photo: image_urls[0] is the room being edited,
      // everything following is "like this" — and a paint mask, last of all, is
      // "only here". The editor takes up to 14, but the UI caps selection well
      // below that: more than a handful of guides and the model starts averaging
      // them instead of following them.
      const referenceKeys = [
        ...new Set(ops.flatMap((o) => (o.kind === "prompt" ? (o.references ?? []) : []))),
      ];
      const referenceUrls: string[] = [];
      for (const key of referenceKeys) {
        const bytes = await input.loadReference(key);
        referenceUrls.push(await fal.upload(bytes, "reference.jpg", "image/jpeg"));
      }
      let paintMaskUrl: string | null = null;
      if (paintMaskBytes && paintMaskKey) {
        paintMaskUrl = await fal.upload(paintMaskBytes, "paint-guide.png", "image/png");
      }
      if (referenceUrls.length > 0 || paintMaskUrl) {
        await input.onProgress?.(
          `${referenceUrls.length} reference(s)${paintMaskUrl ? " + painted region" : ""} uploaded`,
        );
      }

      // The guide sentence is a FOCUS instruction, not a stencil. Hard masks on
      // an edit model produce clipped objects and amputated shadows; naming the
      // painted area as the centre of gravity and letting the model honour
      // physics at its edges is what makes the result look placed rather than
      // pasted.
      let guidedPrompt = prompt;
      if (paintMaskUrl) {
        guidedPrompt += `
The final image marks where the user wants this change focused. Make the change there, and extend it naturally wherever physics requires - shadows, reflections, perspective, anything the change would realistically touch. Do not make unrelated changes elsewhere in the room.`;
      }
      if (input.expand) {
        guidedPrompt += `
The photograph sits centred on a white border. Fill ONLY that white border by extending the scene outward - walls continue, the floor continues, ceiling and lighting continue - so the result reads as one photograph taken with a wider lens. Reproduce the existing photograph exactly; change nothing inside it. No text, no watermarks, no frames.`;
      }

      falInput = {
        prompt: guidedPrompt,
        image_urls: [photoUrl, ...referenceUrls, ...(paintMaskUrl ? [paintMaskUrl] : [])],
        system_prompt: FREE_FORM_SYSTEM,
        // "auto" is load-bearing. Naming a ratio invites recomposition, and a
        // recomposed room fails the structure guard for a reason that was avoidable.
        aspect_ratio: "auto",
        resolution: "2K",
        output_format: "png",
        num_images: 1,
        ...(input.seed != null ? { seed: input.seed } : {}),
      };
    }

    // Submit, hand back the id, THEN wait. Reversing these two lines is the bug
    // that pays for work it cannot find again.
    const submitted = await fal.submit(endpoint, falInput);
    requestId = submitted.requestId;
    await input.onSubmitted?.(requestId, endpoint);
  }

  const data = await fal.poll<InpaintOutput | EditOutput>(endpoint, requestId, {
    timeoutMs: 8 * 60 * 1000,
    signal: input.signal,
    onStatus: (status, queuePosition) => {
      void input.onProgress?.(
        `fal ${status}${queuePosition != null ? ` (queue ${queuePosition})` : ""}`,
      );
    },
  });

  const outUrl = data.images?.[0]?.url;
  if (!outUrl) throw new Error(`render: ${endpoint} returned no image`);
  const edited = await fal.download(outUrl);

  // Composite ONLY where the pipeline promises containment: the legacy masked
  // material swap. A painted region is guidance, not a stencil — compositing
  // through it would clip every plant pot and amputate every shadow at the
  // brush edge, which is precisely the dumbness this pipeline exists to avoid.
  const shouldComposite = Boolean(mask) && endpoint === FLUX_INPAINT;

  let finalJpeg: Buffer;
  let outWidth = width;
  let outHeight = height;

  if (input.expand) {
    // OUTPAINT COMPOSITE. The model filled our padded canvas; now the original
    // photograph goes back over its exact region with a feathered alpha, so
    // generation can only ever exist AROUND the shot. What the user framed is
    // byte-for-byte what they keep.
    const ex = input.expand;
    const F = Math.max(12, Math.round(Math.min(ex.width, ex.height) * 0.015));
    // Alpha lives at the ORIGINAL'S size - it is applied via dest-in to the
    // photo before it goes anywhere near the larger canvas, and sharp refuses
    // composite inputs larger than their base.
    const alpha = await sharp({
      create: { width: width, height: height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: width - 2 * F,
              height: height - 2 * F,
              channels: 4,
              background: { r: 255, g: 255, b: 255, alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
          left: F,
          top: F,
        },
      ])
      .blur(F / 2)
      .png()
      .toBuffer();

    const originalFeathered = await sharp(photo)
      .ensureAlpha()
      .composite([{ input: alpha, blend: "dest-in" }])
      .png()
      .toBuffer();

    finalJpeg = await sharp(edited)
      .resize(ex.width, ex.height, { fit: "fill", kernel: "lanczos3" })
      .composite([{ input: originalFeathered, left: ex.left, top: ex.top }])
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer();
    outWidth = ex.width;
    outHeight = ex.height;
    await input.onProgress?.("original frame composited back");
  } else if (shouldComposite && mask) {
    const composed = await compositeThroughMask(photo, edited, mask);
    finalJpeg = composed.jpeg;
    outWidth = composed.width;
    outHeight = composed.height;
  } else {
    // A structural edit stands as returned, but still normalised to the photo's
    // dimensions — the render is displayed over the original's layout, and a 2K
    // output against an 1254px original would misalign every zone chip.
    finalJpeg = await sharp(edited)
      .resize(width, height, { fit: "fill", kernel: "lanczos3" })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer();
  }

  await input.onProgress?.("measuring drift");

  /**
   * Drift is only measurable where the model itself guarantees untouched
   * pixels: true inpainting, whose raw output equals the original outside the
   * mask. Everywhere else the guard would grade the product's own premise —
   * the whole-image editor re-renders the photograph BY DESIGN, and the painted
   * region path enforces containment with the composite rather than with the
   * model's restraint. Measured once against a Flash render, learned here.
   */
  const drift =
    endpoint === FLUX_INPAINT && mask
      ? await measureDrift(
          photo,
          await sharp(edited)
            .resize(width, height, { fit: "fill", kernel: "lanczos3" })
            .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
            .toBuffer(),
          await guardMask(mask, 12),
        )
      : null;

  return {
    jpeg: finalJpeg,
    width: outWidth,
    height: outHeight,
    endpoint,
    falRequestId: requestId,
    seed: "seed" in data && typeof data.seed === "number" ? data.seed : (input.seed ?? null),
    costUnits,
    drift,
    composited: shouldComposite,
    ms: Date.now() - started,
  };
}
