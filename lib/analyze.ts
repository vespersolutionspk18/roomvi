/**
 * The analyze pipeline: photo in, stored surface masks out.
 *
 * Separated from the job handler so it can be driven from a script without a
 * worker, a queue, or a database row — which is how it gets verified against a
 * real photo. The handler adds persistence and heartbeats; the segmentation
 * itself lives here.
 *
 * WHAT MAKES THIS COST MONEY, AND WHAT KEEPS IT DOWN:
 *
 *  - One fal call per surface, seven surfaces, ~$0.035 per photo. Once. Masks are
 *    reused by every subsequent material trial, so re-segmenting per swatch
 *    would multiply the entire product's cost by the number of swatches a user
 *    clicks. `analyzedAt` on the image row is the guard.
 *
 *  - The IMAGE IS UPLOADED TO fal ONCE and its URL reused across all seven
 *    calls. Uploading per call would be seven transfers of the same bytes.
 *
 *  - Everything runs at DISPLAY resolution (~1MP), not original. A mask is only
 *    ever consumed at display size or scaled from it, and fal bills by
 *    megapixel, so sending 12MP would raise the bill for a boundary no more
 *    accurate than the segmenter's own precision.
 *
 * WHAT MAKES IT SURVIVE FAILURE: a surface that fails does not fail the photo.
 * Six good masks and one missing countertop is a usable editor session; throwing
 * away six paid masks because the seventh came back empty is not. Failures are
 * collected and reported per surface.
 */
import {
  analyzeMask,
  cleanMask,
  decodeMask,
  judgeMask,
  largestComponent,
  resizeMask,
  subtract,
  union,
  type Mask,
  type MaskStats,
} from "./mask";
import * as fal from "./fal";
import { EVF_SAM, RECIPES, inputFor, type SegmentableKind, type SurfaceRecipe } from "./segment";

/** evf-sam returns a single mask file, under one of three keys. */
type EvfOutput = { image?: { url: string }; mask?: { url: string }; url?: string };

/** sam-3 returns masks[] plus optional scores[]. */
type Sam3Output = {
  masks?: Array<{ url: string; width?: number; height?: number }>;
  scores?: number[];
};

export type SurfaceResult = {
  kind: SegmentableKind;
  label: string;
  prompt: string;
  endpoint: string;
  mask: Mask;
  stats: MaskStats;
  /** Whether the mask passed `judgeMask`. Unusable ones are still returned. */
  usable: boolean;
  note: string;
  /** Mean sam-3 detection score, where the endpoint reports one. */
  confidence: number | null;
  /** How many raw masks were unioned. >1 means per-door or per-pane. */
  maskCount: number;
  falRequestId: string;
  ms: number;
};

export type SurfaceFailure = {
  kind: SegmentableKind;
  prompt: string;
  endpoint: string;
  error: string;
  /** True when fal answered but produced nothing usable, vs. the call erroring. */
  answered: boolean;
};

export type AnalyzeResult = {
  surfaces: SurfaceResult[];
  failures: SurfaceFailure[];
  width: number;
  height: number;
  /** fal billable units consumed, for reconciliation. */
  costUnits: number;
  imageUrl: string;
  ms: number;
};

export type AnalyzeOptions = {
  /** Restrict to a subset of surfaces. Defaults to all seven recipes. */
  kinds?: SegmentableKind[];
  /** Called between surfaces. The worker uses this to renew its lease. */
  onProgress?: (done: number, total: number, kind: SegmentableKind) => void | Promise<void>;
  /** Per-call ceiling. A stuck fal job must not pin a worker indefinitely. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Segment every configured surface in a display-sized photo.
 *
 * `display` must be the SAME bytes the editor canvas draws and the same
 * dimensions recorded in `images.displayWidth/Height`. Masks are stored in that
 * coordinate space, so segmenting a differently-scaled copy would offset every
 * mask the client renders.
 */
export async function analyzePhoto(
  display: Buffer,
  dimensions: { width: number; height: number },
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const started = Date.now();
  const { width, height } = dimensions;
  const recipes = opts.kinds
    ? // Preserve RECIPES order, not the caller's: `wall` subtracts `backsplash`
      // and must run after it.
      RECIPES.filter((r) => opts.kinds!.includes(r.kind))
    : RECIPES;

  // One upload, reused by every call below.
  const imageUrl = await fal.upload(display, "room.jpg", "image/jpeg");
  const unitsPerCall = fal.billableUnits(width, height);

  const surfaces: SurfaceResult[] = [];
  const failures: SurfaceFailure[] = [];
  /** Masks already produced this run, so `subtract` can reference them. */
  const bank = new Map<SegmentableKind, Mask>();
  let costUnits = 0;

  for (const [i, recipe] of recipes.entries()) {
    opts.signal?.throwIfAborted();
    const callStarted = Date.now();

    try {
      const raw = await callEndpoint(recipe, imageUrl, opts);
      costUnits += unitsPerCall;

      if (raw.urls.length === 0) {
        failures.push({
          kind: recipe.kind,
          prompt: recipe.prompt,
          endpoint: recipe.endpoint,
          error: "fal returned no mask",
          answered: true,
        });
        continue;
      }

      const mask = await assemble(raw.urls, recipe, { width, height }, bank);
      const stats = analyzeMask(mask);
      const verdict = judgeMask(recipe.judgeAs ?? recipe.kind, stats);

      // Banked even when unusable: a poor backsplash mask is still the right
      // thing to subtract from the wall, and withholding it would leave the
      // backsplash tiles inside the wall surface.
      bank.set(recipe.kind, mask);

      surfaces.push({
        kind: recipe.kind,
        label: recipe.label,
        prompt: recipe.prompt,
        endpoint: recipe.endpoint,
        mask,
        stats,
        usable: verdict.usable,
        note: verdict.note,
        confidence: meanScore(raw.scores),
        maskCount: raw.urls.length,
        falRequestId: raw.requestId,
        ms: Date.now() - callStarted,
      });
    } catch (err) {
      // One surface failing must not cost the other six. Their masks are already
      // paid for.
      failures.push({
        kind: recipe.kind,
        prompt: recipe.prompt,
        endpoint: recipe.endpoint,
        error: err instanceof Error ? err.message : String(err),
        answered: false,
      });
    }

    await opts.onProgress?.(i + 1, recipes.length, recipe.kind);
  }

  return {
    surfaces,
    failures,
    width,
    height,
    costUnits,
    imageUrl,
    ms: Date.now() - started,
  };
}

/** Submit one recipe and collect the mask URLs from whichever shape came back. */
async function callEndpoint(
  recipe: SurfaceRecipe,
  imageUrl: string,
  opts: AnalyzeOptions,
): Promise<{ urls: string[]; scores?: number[]; requestId: string }> {
  const { requestId, data } = await fal.run<EvfOutput | Sam3Output>(
    recipe.endpoint,
    inputFor(recipe, imageUrl),
    { timeoutMs: opts.timeoutMs ?? 180_000, signal: opts.signal },
  );

  if (recipe.endpoint === EVF_SAM) {
    const d = data as EvfOutput;
    const url = d.mask?.url ?? d.image?.url ?? d.url;
    return { urls: url ? [url] : [], requestId };
  }

  const d = data as Sam3Output;
  return {
    urls: (d.masks ?? []).map((m) => m.url).filter(Boolean),
    scores: d.scores,
    requestId,
  };
}

/**
 * Download, normalise and combine the raw masks for one surface.
 *
 * Order is deliberate. Union before clean, so the morphology closes the seams
 * BETWEEN unioned cabinet doors rather than rounding each door separately.
 * Subtract after clean, so a dilate does not push the wall back over the
 * backsplash it just gave up.
 */
async function assemble(
  urls: string[],
  recipe: SurfaceRecipe,
  dims: { width: number; height: number },
  bank: Map<SegmentableKind, Mask>,
): Promise<Mask> {
  const decoded: Mask[] = [];
  for (const url of urls) {
    let m = await decodeMask(await fal.download(url));
    // fal may return a mask at the model's working resolution rather than the
    // input's. Masks must be comparable to the photo and to each other.
    if (m.width !== dims.width || m.height !== dims.height) {
      m = await resizeMask(m, dims.width, dims.height);
    }
    decoded.push(m);
  }

  let mask = decoded.length > 1 ? union(decoded) : decoded[0];
  mask = await cleanMask(mask, 3);
  if (recipe.largestOnly) mask = largestComponent(mask);

  for (const other of recipe.subtract ?? []) {
    const b = bank.get(other);
    // Missing subtrahend is not fatal — a wall with the backsplash still in it
    // beats no wall at all, and the user can brush it out.
    if (b) mask = subtract(mask, b);
  }

  return mask;
}

function meanScore(scores?: number[]): number | null {
  if (!scores?.length) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/** Normalized [x0,y0,x1,y1] for the DB, from a pixel-space bbox. */
export function normalizedBbox(
  stats: MaskStats,
): [number, number, number, number] {
  const b = stats.bboxAll;
  return [
    b.x / stats.width,
    b.y / stats.height,
    (b.x + b.w) / stats.width,
    (b.y + b.h) / stats.height,
  ];
}

/**
 * Rough floor/wall area from mask coverage, as a RANGE.
 *
 * Single-photo area from an uncalibrated camera is ±15-25%, so this returns a
 * band and never a point value — the mockups' "18.4 m² · 98% confidence" is a
 * claim the geometry cannot support, and a number that precise next to a price
 * is a promise. A real figure needs the Precision-mode plane fit, where the user
 * names one true distance; until then this is for ordering zones by size and
 * showing a hedged estimate.
 *
 * The reference is a deliberately crude assumption: a typical interior wide shot
 * frames roughly 12 m² of floor. Wrong for any specific room, right to within
 * the stated band for most.
 */
export function estimateAreaM2(
  kind: SegmentableKind,
  coverage: number,
): { low: number; high: number } | null {
  const FRAME_M2: Partial<Record<SegmentableKind, number>> = {
    floor: 12,
    wall: 18,
    ceiling: 12,
    countertop: 6,
    backsplash: 6,
  };
  const reference = FRAME_M2[kind];
  if (!reference) return null;

  const mid = coverage * reference;
  return { low: Math.round(mid * 0.75 * 10) / 10, high: Math.round(mid * 1.25 * 10) / 10 };
}

/** Stable per-surface tint for overlays and zone chips, from the design tokens. */
export function tintFor(kind: SegmentableKind): [number, number, number] {
  switch (kind) {
    case "floor":
      return [39, 76, 62]; // pine
    case "wall":
      return [169, 131, 79]; // brass
    case "ceiling":
      return [80, 120, 200];
    case "countertop":
      return [200, 60, 90];
    case "backsplash":
      return [220, 150, 40];
    case "upper_cabinets":
      return [120, 60, 190];
    default:
      return [40, 190, 190];
  }
}
