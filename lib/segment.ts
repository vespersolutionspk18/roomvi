/**
 * The segmentation prompt table — the deliverable of the Phase 3.5 spike.
 *
 * Every entry here was PAID FOR and looked at. The spike ($0.055) plus a wall
 * follow-up ($0.020) ran 15 calls against a real kitchen photograph, wrote a
 * tinted overlay per attempt, and a human confirmed each mask sat on the surface
 * it claimed. Do not edit a prompt in this file without re-running the spike and
 * checking the overlay — a plausible-sounding rephrase silently halved wall
 * coverage during the spike, and no number in the results table would have
 * caught it.
 *
 * WHAT THE SPIKE SETTLED. The load-bearing unknown was whether fal's promptable
 * segmenters resolve ARCHITECTURAL SURFACES ("the floor", "the countertop", "the
 * upper cabinets") or only the discrete objects in every doc example ("wheel",
 * "cat"). They resolve surfaces. Phases 4-7 are safe to build.
 *
 * THE FOUR FINDINGS THAT CHANGED THE DESIGN:
 *
 *  1. PROMPT STYLE PER ENDPOINT IS REAL, AND NOT WHAT I ASSUMED. evf-sam is
 *     documented as taking referring expressions, so "the painted wall surfaces
 *     of the room" looked right. It returned 5.3% of the frame — a fragment — on
 *     a photo whose wall spans a third of it. The bare singular "the wall"
 *     returned 14.6% and every visible wall region. Elaborate phrasing HURT.
 *     Singular and concrete beats descriptive and plural.
 *
 *  2. sam-3 BEATS evf-sam ON JOINERY, and it is not close. For upper cabinets
 *     evf-sam bled onto the wall and scattered into 10 components; sam-3 with
 *     `return_multiple_masks` returned tight per-door masks that union cleanly,
 *     and caught a cabinet evf-sam missed entirely. Architecture -> evf-sam,
 *     countable objects -> sam-3.
 *
 *  3. sam-3 IS THE WRONG TOOL FOR "STUFF". Best wall from sam-3 was 3.8%, versus
 *     14.6% from evf-sam. It is a detector; unbounded surfaces are not objects.
 *
 *  4. "the wall" ALSO GRABS THE BACKSPLASH. Expected, and free to fix: both are
 *     segmented anyway, so `subtract(wall, backsplash)` resolves it locally with
 *     no extra call. This is precisely why the plan forbids `negative_prompt`,
 *     which doubles the price of an evf-sam call to buy the same subtraction.
 *
 * COST: ~$0.005 per surface per photo, once, cached by (image sha256, prompt).
 * Masks are reused across every material trial — re-segmenting per swatch is
 * pure waste.
 */
import type { surfaceKindEnum } from "./db/schema";

type SurfaceKind = (typeof surfaceKindEnum.enumValues)[number];

/** fal endpoint ids. Referenced by id so a version bump is one edit. */
export const EVF_SAM = "fal-ai/evf-sam";
export const SAM3 = "fal-ai/sam-3/image";

/**
 * Surface kinds this module can segment.
 *
 * A strict subset of the `surface_kind` DB enum, which also carries kinds that
 * arrive by other routes — `custom` from the brush tool, `island`/`furniture`
 * from later phases. Typed against the enum so adding a recipe for a kind the
 * database cannot store is a compile error rather than an insert failure inside
 * a worker.
 */
export type SegmentableKind = Extract<
  SurfaceKind,
  "floor" | "wall" | "ceiling" | "countertop" | "backsplash" | "upper_cabinets" | "window"
>;

export type SurfaceRecipe = {
  kind: SegmentableKind;
  endpoint: typeof EVF_SAM | typeof SAM3;
  /** Human label for the zone chip in the editor. */
  label: string;
  /** The exact string that was measured. See the file header before changing it. */
  prompt: string;
  /**
   * Key into `judgeMask`'s per-surface expectations, which were calibrated
   * against the spike's own vocabulary. Only needed where the DB kind and the
   * judge's key differ.
   */
  judgeAs?: string;
  /**
   * Ask for several masks and union them. For joinery that arrives per-door or
   * per-pane, which is one surface to the user.
   */
  multi?: boolean;
  /**
   * Reduce to the single largest connected region.
   *
   * Off for surfaces that furniture legitimately cuts into pieces — a wall
   * behind cabinets came back as 13 real components, and keeping only the
   * largest would discard most of the actual wall.
   */
  largestOnly?: boolean;
  /**
   * Subtract these surfaces after segmenting, in this order.
   *
   * Cheaper and more exact than a negative prompt, which on evf-sam DOUBLES the
   * call price to compute what `subtract()` does locally for free.
   */
  subtract?: SegmentableKind[];
  /** Measured coverage on the spike photo — a sanity anchor, not a threshold. */
  measured: string;
};

/**
 * Ordered so that anything used as a subtrahend is segmented before the surface
 * that subtracts it. `wall` needs `backsplash` to already exist.
 */
export const RECIPES: SurfaceRecipe[] = [
  {
    kind: "floor",
    endpoint: EVF_SAM,
    label: "Floor",
    prompt: "the floor surface of the room",
    largestOnly: true,
    // 3.7% is CORRECT here, not a failure: an island and four stools hide almost
    // all of this floor. The judge's per-kind scale bounds allow for exactly this.
    measured: "3.7% — correct; island and stools occlude the rest",
  },
  {
    kind: "backsplash",
    endpoint: EVF_SAM,
    label: "Backsplash",
    prompt: "the tiled backsplash wall behind the countertop",
    largestOnly: true,
    // The one place a long descriptive phrase won — it has to be distinguished
    // from the wall it sits on, and "backsplash" alone is ambiguous.
    measured: "5.0% — tight to the tile field, stops correctly under the hood",
  },
  {
    kind: "wall",
    endpoint: EVF_SAM,
    label: "Walls",
    // Bare and singular, measured against three richer phrasings that all lost.
    prompt: "the wall",
    largestOnly: false,
    subtract: ["backsplash"],
    measured: "14.6% in 13 real pieces — vs 5.3% for 'the painted wall surfaces of the room'",
  },
  {
    kind: "ceiling",
    endpoint: EVF_SAM,
    label: "Ceiling",
    prompt: "the ceiling of the room",
    largestOnly: true,
    measured: "9.0% — clean, follows the crown moulding",
  },
  {
    kind: "countertop",
    endpoint: EVF_SAM,
    label: "Countertop",
    prompt: "the kitchen countertop work surface",
    // Kept: the island is the surface a user means. Known limit — it does NOT
    // pick up the perimeter counter by the stove in one call. Brush correction
    // covers the difference; a second call would double the cost for one edge case.
    largestOnly: true,
    measured: "13.7% — near-perfect on the island; misses the perimeter run",
  },
  {
    kind: "upper_cabinets",
    endpoint: SAM3,
    label: "Cabinets",
    prompt: "kitchen cabinet",
    // The spike judged this as "cupboard"; keep that key so the calibrated
    // bounds and the fragmentation exemption still apply under the DB's name.
    judgeAs: "cupboard",
    multi: true,
    largestOnly: false,
    measured: "13.2% in 3 pieces — clean per-door; evf-sam bled onto the wall at 18.5%/10 pieces",
  },
  {
    kind: "window",
    endpoint: SAM3,
    label: "Windows",
    prompt: "window",
    multi: true,
    largestOnly: false,
    measured: "5.2% — precise, including mullions; correctly excludes the chandelier",
  },
];

/** Look up one recipe. Throws rather than silently segmenting the wrong thing. */
export function recipeFor(kind: SegmentableKind): SurfaceRecipe {
  const r = RECIPES.find((x) => x.kind === kind);
  if (!r) throw new Error(`No segmentation recipe for surface kind "${kind}"`);
  return r;
}

/**
 * Build the endpoint input for a recipe.
 *
 * Centralised because two of these flags cost money or silently break the
 * result, and both defaults are wrong for us:
 *
 *   `apply_mask` defaults to TRUE on sam-3 — leave it and you get the mask
 *   painted onto the photo, which is useless as a mask and easy to mistake for
 *   success in a thumbnail.
 *
 *   `negative_prompt` is absent everywhere on purpose: it DOUBLES the price of
 *   an evf-sam call, and `subtract()` does the same job locally for free.
 */
export function inputFor(recipe: SurfaceRecipe, imageUrl: string): Record<string, unknown> {
  if (recipe.endpoint === EVF_SAM) {
    return {
      image_url: imageUrl,
      prompt: recipe.prompt,
      // Semantic level is what covers "stuff" classes (floor, wall) rather than
      // countable instances.
      semantic_type: true,
      fill_holes: true,
      mask_only: true,
    };
  }
  return {
    image_url: imageUrl,
    prompt: recipe.prompt,
    apply_mask: false,
    include_scores: true,
    include_boxes: true,
    ...(recipe.multi ? { return_multiple_masks: true, max_masks: 8 } : {}),
  };
}
