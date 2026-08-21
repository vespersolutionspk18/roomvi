/**
 * The Precision executor's DB bridge.
 *
 * `lib/precision/execute.ts` is pure: buffers, masks and numbers in, JPEG out. This
 * is the layer that answers the questions that need the database — which surfaces can
 * this run on, which objects are standing on them, and does this material carry the
 * measurements the mode requires.
 *
 * WHY THE ELIGIBILITY CHECK LIVES HERE AND RUNS FIRST. Precision costs $0.00, so the
 * temptation is to just try it and fall back on failure. That is wrong for two
 * reasons: a wrongly-projected sofa is a plausible-looking lie rather than an error,
 * and by the time the warp has run the user has already seen a progress bar. Deciding
 * up front, from data, means the editor can grey the mode out before it is clicked.
 */
import type { Material, Surface, SurfacePlane } from "@/lib/db/schema";
import { decodeMask, type Mask } from "@/lib/mask";
import { renderPrecision, type PrecisionResult } from "@/lib/precision/execute";
import { snapTheta, type Bond, type TileSpec } from "@/lib/precision/tile";

/**
 * Surface kinds Precision can render.
 *
 * PLANAR ONLY, and the list is deliberately short. A floor, a wall, a countertop and
 * a backsplash are flat rectangles in the world; a homography describes them exactly.
 * A sofa, a cupboard front with a handle, a rug with a rucked corner are not planes,
 * and projecting a tile grid onto one produces geometry that is confidently wrong —
 * the worst failure mode for a feature whose selling point is measured accuracy.
 * Those fall back to the generative path, which does not claim millimetres.
 */
export const PLANAR_KINDS = new Set(["floor", "wall", "ceiling", "countertop", "backsplash", "island"]);

/**
 * Kinds that STAND ON a surface and must therefore be cut out of it.
 *
 * Semantic subtraction only catches what the segmenter actually found; the plane-depth
 * tier catches thin structure it missed. Both are needed, and this is the cheap half.
 */
export const OCCLUDER_KINDS = new Set(["rug", "furniture", "appliance", "lower_cabinets", "island", "door"]);

export type Eligibility =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: string };

/**
 * Can Precision render this pairing? Checked before anything is enqueued.
 *
 * Every branch names the missing datum rather than saying "not eligible", because
 * this string reaches the user in the editor as the reason the mode is unavailable,
 * and "the floor has no plane yet — drag the guides over it" is actionable where
 * "unsupported" is not.
 */
export function eligible(surface: Pick<Surface, "kind" | "plane">, material: Pick<Material, "tileWMm" | "tileHMm" | "textureKey" | "name">): Eligibility {
  if (!PLANAR_KINDS.has(surface.kind)) {
    return { ok: false, reason: `${surface.kind.replace(/_/g, " ")} is not a flat plane — use a generative render` };
  }
  if (!surface.plane) {
    return { ok: false, reason: "this surface has no measured plane yet — place the perspective guides over it" };
  }
  if (!material.textureKey) {
    return { ok: false, reason: `${material.name} has no texture bitmap on file` };
  }
  if (!material.tileWMm || !material.tileHMm) {
    return { ok: false, reason: `${material.name} has no tile size on file, so it cannot be laid to scale` };
  }
  return { ok: true };
}

/**
 * Material row -> tile spec.
 *
 * `theta` is snapped, not taken raw. A floor laid 2 degrees off true reads as a
 * mistake in a render where 0 or 45 reads as a decision, and the user is dragging a
 * quad by hand — their angle is always a degree or two off whatever they meant.
 */
export function tileSpecFor(material: Pick<Material, "tileWMm" | "tileHMm" | "groutMm" | "bond">, theta: number): TileSpec {
  return {
    tileWMm: material.tileWMm ?? 600,
    tileHMm: material.tileHMm ?? 600,
    groutMm: material.groutMm ?? 3,
    // `basketweave` exists in the DB enum but not yet in the tiler. Falling back to
    // stack is honest — it lays a real grid at the right pitch — where casting the
    // string through would throw deep inside the warp loop on the millionth pixel.
    bond: (["stack", "running", "herringbone"].includes(material.bond) ? material.bond : "stack") as Bond,
    theta: snapTheta(theta),
  };
}

export type PrecisionRunInput = {
  photo: Buffer;
  surface: Pick<Surface, "id" | "kind" | "maskKey" | "plane">;
  material: Pick<Material, "tileWMm" | "tileHMm" | "groutMm" | "bond" | "textureKey" | "name" | "colorLab">;
  /** Every other surface on the image — the ones standing on this one get subtracted. */
  siblings: Array<Pick<Surface, "id" | "kind" | "maskKey">>;
  loadMask: (key: string) => Promise<Buffer>;
  loadTexture: (key: string) => Promise<Buffer>;
  /** Grout colour override; defaults to a neutral cement. */
  groutRgb?: [number, number, number];
  onProgress?: (note: string) => Promise<void>;
};

export type PrecisionRunResult = PrecisionResult & {
  /** Ids of the surfaces that were cut out, for the audit trail. */
  occluders: string[];
  ms: number;
};

/**
 * Load everything from storage and run the warp.
 *
 * No fal, no network, no cost. The only failure modes are missing files and a
 * degenerate plane, both of which are permanent and should not be retried.
 */
export async function runPrecision(input: PrecisionRunInput): Promise<PrecisionRunResult> {
  const started = Date.now();
  const { surface, material } = input;
  const check = eligible(surface, material);
  if (!check.ok) throw new Error(`precision: ${check.reason}`);
  const plane = surface.plane as SurfacePlane;
  if (!material.textureKey) throw new Error("precision: no texture");

  const mask = await decodeMask(await input.loadMask(surface.maskKey));
  await input.onProgress?.("mask loaded");

  // Occluders: siblings that stand ON this surface. A mask whose dimensions disagree
  // is skipped rather than throwing — it means that one zone was segmented against a
  // different display copy, and losing one chair's cutout is a far better outcome
  // than losing the render.
  const occluders: Mask[] = [];
  const occluderIds: string[] = [];
  for (const sib of input.siblings) {
    if (sib.id === surface.id || !OCCLUDER_KINDS.has(sib.kind)) continue;
    const m = await decodeMask(await input.loadMask(sib.maskKey));
    if (m.width !== mask.width || m.height !== mask.height) continue;
    occluders.push(m);
    occluderIds.push(sib.id);
  }
  if (occluders.length) await input.onProgress?.(`${occluders.length} occluder(s) subtracted`);

  const texture = await input.loadTexture(material.textureKey);
  const result = await renderPrecision({
    photo: input.photo,
    mask,
    texture,
    plane,
    tile: tileSpecFor(material, plane.theta ?? 0),
    occluders,
    grout: { rgb: input.groutRgb ?? [186, 182, 174] },
  });

  return { ...result, occluders: occluderIds, ms: Date.now() - started };
}

/**
 * Turn the check numbers into the sentence the measurement overlay shows.
 *
 * This is a TRUST FEATURE, not a debug dump: the product's claim is that the tiles are
 * really 600mm, and this is where that claim is either substantiated or withdrawn. So
 * a count that disagrees with the arithmetic says so plainly instead of being rounded
 * into looking fine.
 */
export function measurementSummary(
  check: PrecisionResult["check"],
  tile: TileSpec,
  plane: SurfacePlane,
): { headline: string; verified: boolean; lines: string[] } {
  const acrossOk = check.tilesAcross === check.expectedAcross;
  const downOk = check.tilesDown === check.expectedDown;
  const geomOk = check.residualPx < 0.01;
  const verified = acrossOk && downOk && geomOk && check.outsideUntouched;

  const lines = [
    `${tile.tileWMm} x ${tile.tileHMm} mm, ${tile.groutMm} mm joint, ${tile.bond} bond`,
    `${(plane.refWidthMm / 1000).toFixed(2)} x ${(plane.refHeightMm / 1000).toFixed(2)} m reference span`,
    acrossOk && downOk
      ? `${check.tilesAcross} x ${check.tilesDown} courses, matching the arithmetic`
      : `counted ${check.tilesAcross} x ${check.tilesDown} courses, expected ${check.expectedAcross} x ${check.expectedDown}`,
    geomOk
      ? `perspective closes to ${check.residualPx.toExponential(1)} px`
      : `perspective is off by ${check.residualPx.toFixed(2)} px — re-place the guides`,
  ];
  // Only mention occlusion when it actually happened. "100% painted" as a line item
  // invites the question of why it would ever be less.
  if (check.painted < 0.995) {
    lines.push(`${((1 - check.painted) * 100).toFixed(0)}% left unpainted behind furniture`);
  }

  return {
    headline: verified ? "Laid to scale, measured" : "Scale could not be verified",
    verified,
    lines,
  };
}
