/**
 * PUT /api/images/[id]/surfaces/[surfaceId]/plane — record the measured plane.
 *
 * This is the one route where the user supplies a number the software cannot check
 * against anything else: "that counter run is 2400mm". Absolute metric scale is not
 * recoverable from a single photo — depth nets and vanishing points give
 * orientation with the scale left unitless — so this handful of bytes is the entire
 * basis for every millimetre Precision mode later claims out loud.
 *
 * Which is why THE SERVER SOLVES H, and the client's H (if it sends one) is
 * ignored. Same reasoning as the brush route refusing a posted PNG: the WebGL
 * preview computes its own H from the same quad through the same zero-import
 * module, so accepting the client's matrix buys nothing and makes a stale or
 * tampered preview authoritative over the render. The quad and two distances are
 * the irreducible input; everything else is derived here.
 *
 * The checks below are not input validation for its own sake. A plane that solves
 * but is wrong produces a render that is *confidently* mis-measured — the worst
 * failure this feature has, because the overlay will state a tile count in the
 * same voice whether or not the geometry underneath it means anything.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { images, surfaces, type SurfacePlane } from "@/lib/db/schema";
import { decodeMask } from "@/lib/mask";
import {
  footprint,
  isConvex,
  planeFromQuad,
  verify,
  type Quad,
  type Vec2,
} from "@/lib/precision/homography";
import { snapTheta } from "@/lib/precision/tile";
import { PLANAR_KINDS } from "@/lib/render/precision";
import * as storage from "@/lib/storage";

/**
 * Reference span limits, mm.
 *
 * Below 100mm the user has almost certainly typed cm or inches, and the tile
 * arithmetic that follows would divide by something meaningless. Above 50m it is
 * not a room. Both bounds are wide enough that no real kitchen touches them, so
 * hitting one is a units mistake rather than an unusual room.
 *
 * They are a floor and a ceiling on the NUMBER, though, and the common mistake is
 * off by exactly 10x — "240" for a 2400mm counter run sails through both. See
 * `MIN_MM_PER_PX` for the check that actually catches that.
 */
const MIN_REF_MM = 100;
const MAX_REF_MM = 50_000;

/**
 * Plausible millimetres-per-pixel along the quad's NEAR edge.
 *
 * This is the check that catches a 10x units error, and it works because the quad
 * pins mm against px: the near edge spans `refWidthMm` in the world and a known
 * number of pixels on screen, so their ratio says what this photo resolves. At
 * 0.25 mm/px a 1250px-wide room photo would be resolving a quarter of a millimetre
 * per pixel across the whole floor, which no phone photo of a room does — that is
 * a 2400mm counter typed as 240. At 25 mm/px the same photo would span thirty
 * metres, which is the same mistake in the other direction.
 *
 * Deliberately checked on the NEAR edge and not the far one. Far-field pixels
 * legitimately cover tens of millimetres — that is what perspective is, and what
 * the anisotropic sampler exists to handle. Gating on the far edge would reject
 * every real floor.
 *
 * A window rather than a point estimate, and a wide one: this rejects the order-of-
 * magnitude slip, not imprecision. A user who measured 2350mm and typed 2400 is
 * making a 2% error that no software can detect and that the render will simply
 * carry.
 */
const MIN_MM_PER_PX = 0.8;
const MAX_MM_PER_PX = 20;

/**
 * Worst-corner round-trip tolerance, px.
 *
 * A 4-point solve is exact, so the residual measures arithmetic rather than fit:
 * anything above a small fraction of a pixel means the normalization or the corner
 * ordering is wrong, not that the user was imprecise. Refusing to store it keeps a
 * broken H out of the database entirely, rather than letting `measurementSummary`
 * discover it later and quietly withdraw the claim.
 */
const MAX_RESIDUAL_PX = 0.5;

/**
 * How much of the reference rectangle must actually land on the surface.
 *
 * The quad does NOT have to cover the whole floor — placing the guides over a
 * clear patch and letting the courses extrapolate is the intended workflow. What
 * it must not do is sit somewhere else entirely: a quad dragged onto the wall
 * describes the wall's plane, and the floor would then be tiled by a homography
 * measured on a different surface. Half is a loose gate that still catches that.
 */
const MIN_QUAD_ON_MASK = 0.5;

function bad(code: string, message: string, status = 400) {
  return Response.json({ error: { code, message } }, { status });
}

type Body = {
  /** 4 points, normalized to the DISPLAY box, clockwise from top-left. */
  quad?: unknown;
  refWidthMm?: unknown;
  refHeightMm?: unknown;
  /** Course rotation in DEGREES. Snapped server-side. Optional, defaults to 0. */
  thetaDeg?: unknown;
};

/**
 * Parse the quad from normalized pairs.
 *
 * NORMALIZED on the wire, px in the column. The client is dragging handles over an
 * `<img>` whose on-screen size is whatever the layout gave it, and it already
 * normalizes brush strokes for exactly this reason — one convention for everything
 * the user points at means a display-size mismatch cannot silently offset one of
 * them. The conversion to px happens here, against the dimensions the mask was
 * built at, so the quad and the mask are in the same space by construction.
 */
function parseQuad(raw: unknown, width: number, height: number): Quad | string {
  if (!Array.isArray(raw) || raw.length !== 4) return "quad must be 4 points";
  const out: Vec2[] = [];
  for (const [i, p] of raw.entries()) {
    if (!Array.isArray(p) || p.length !== 2) return `quad point ${i} must be [x, y]`;
    const [x, y] = p;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      return `quad point ${i} must be two finite numbers`;
    }
    // A handle may sit slightly outside the frame — the far corners of a floor
    // often do — but not in another postcode. The margin is generous enough that a
    // legitimate drag never trips it and tight enough to catch un-normalized px
    // (which arrive here as values in the hundreds).
    if (x < -0.5 || x > 1.5 || y < -0.5 || y > 1.5) {
      return `quad point ${i} is outside the photo — points must be normalized to 0..1`;
    }
    out.push([x * width, y * height]);
  }
  return [out[0], out[1], out[2], out[3]] as Quad;
}

/** Is p inside the convex quad? Sign-consistent cross products, same test as `isConvex`. */
function inQuad(quad: Quad, px: number, py: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = quad[k];
    const [bx, by] = quad[(k + 1) % 4];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export async function PUT(
  request: Request,
  ctx: RouteContext<"/api/images/[id]/surfaces/[surfaceId]/plane">,
) {
  const { id, surfaceId } = await ctx.params;

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body) return bad("invalid_body", "Expected a JSON body.");

  const image = await db.query.images.findFirst({ where: eq(images.id, id) });
  if (!image) return bad("not_found", "Image not found.", 404);
  if (!image.displayWidth || !image.displayHeight) {
    return bad("not_ready", "That photo has no display copy yet.", 409);
  }

  // Scoped to the image, so a surfaceId belonging to another photo is a 404 rather
  // than a cross-photo write.
  const surface = await db.query.surfaces.findFirst({
    where: and(eq(surfaces.id, surfaceId), eq(surfaces.imageId, id)),
  });
  if (!surface) return bad("not_found", "No such surface on this photo.", 404);

  // Refused rather than stored. A plane on a sofa solves perfectly well and means
  // nothing, and storing it would flip `hasPlane` true — which is what the editor
  // reads to decide whether to offer Precision at all. The rejection carries the
  // same prose `eligible()` uses so the user hears one explanation, not two.
  if (!PLANAR_KINDS.has(surface.kind)) {
    return bad(
      "not_planar",
      `A ${surface.kind.replace(/_/g, " ")} is not a flat plane, so it cannot be measured — render it generatively instead.`,
      409,
    );
  }

  /* --------------------------------------------------------------- validate */

  const refWidthMm = body.refWidthMm;
  const refHeightMm = body.refHeightMm;
  for (const [name, v] of [["refWidthMm", refWidthMm], ["refHeightMm", refHeightMm]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return bad("invalid_ref", `${name} must be a number of millimetres.`);
    }
    if (v < MIN_REF_MM || v > MAX_REF_MM) {
      return bad(
        "invalid_ref",
        `${name} is ${v}mm. Give the span in millimetres, between ${MIN_REF_MM} and ${MAX_REF_MM}.`,
      );
    }
  }

  const quad = parseQuad(body.quad, image.displayWidth, image.displayHeight);
  if (typeof quad === "string") return bad("invalid_quad", quad);

  // A crossed quad still solves, and maps the interior to a bow-tie: the render
  // comes back folded through itself. Cheaper to catch here than to explain later.
  if (!isConvex(quad)) {
    return bad(
      "invalid_quad",
      "Those four corners cross over each other. Order them clockwise from the top-left of the surface.",
    );
  }

  const thetaDeg = body.thetaDeg == null ? 0 : body.thetaDeg;
  if (typeof thetaDeg !== "number" || !Number.isFinite(thetaDeg) || Math.abs(thetaDeg) > 360) {
    return bad("invalid_theta", "thetaDeg must be a rotation in degrees.");
  }

  /* ------------------------------------------------------------------ solve */

  const solved = planeFromQuad(quad, refWidthMm as number, refHeightMm as number);
  if (!solved) {
    return bad(
      "degenerate_quad",
      "Those corners are collinear or coincident, so no plane can be fitted. Spread them over the surface.",
      409,
    );
  }

  const residualPx = verify(solved.H, quad, refWidthMm as number, refHeightMm as number);
  if (!Number.isFinite(residualPx) || residualPx > MAX_RESIDUAL_PX) {
    return bad(
      "unstable_plane",
      `The perspective solve does not close (off by ${residualPx.toFixed(2)}px). Move the corners further apart.`,
      409,
    );
  }

  /* ------------------------------------------------------- sanity: the scale */

  // The near edge is the longest one in pixels and spans `refWidthMm` in the world,
  // so their ratio is what this photo resolves at its coarsest useful point. This is
  // the check that catches the 10x slip both MIN_REF_MM and the residual let past:
  // a wrong-by-10x span solves perfectly, closes to 1e-13, and produces a floor with
  // forty courses where there should be four. Nothing downstream can tell — the
  // arithmetic is self-consistent, so `measurementSummary` would report "laid to
  // scale, measured" about tiles that are 60mm.
  const topPx = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
  const botPx = Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]);
  const nearPx = Math.max(topPx, botPx);
  const mmPerPx = nearPx > 0 ? (refWidthMm as number) / nearPx : Infinity;
  if (!(mmPerPx >= MIN_MM_PER_PX && mmPerPx <= MAX_MM_PER_PX)) {
    // Phrased as the span the geometry implies rather than as a ratio, because
    // "0.28 mm/px" is not something a user can act on where "did you mean 2400mm?"
    // is. The suggestion is the same number scaled by the factor of ten that was
    // almost certainly dropped.
    const suggestion = mmPerPx < MIN_MM_PER_PX ? (refWidthMm as number) * 10 : (refWidthMm as number) / 10;
    return bad(
      "implausible_scale",
      `${refWidthMm}mm across ${Math.round(nearPx)}px works out to ${mmPerPx.toFixed(2)}mm per pixel, which is not a photo of a room. Did you mean ${Math.round(suggestion)}mm?`,
      409,
    );
  }

  /* --------------------------------------------- is the quad on the surface? */

  const mask = await decodeMask(await storage.get(surface.maskKey));
  if (mask.width !== image.displayWidth || mask.height !== image.displayHeight) {
    return bad(
      "size_mismatch",
      `Stored mask is ${mask.width}x${mask.height} but the photo displays at ${image.displayWidth}x${image.displayHeight}.`,
      409,
    );
  }

  // Bounded by the quad's own bbox, so this is a few hundred thousand point tests
  // at worst rather than a full-frame scan.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of quad) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(mask.width - 1, Math.ceil(x1));
  y1 = Math.min(mask.height - 1, Math.ceil(y1));

  let inside = 0;
  let onMask = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inQuad(quad, x + 0.5, y + 0.5)) continue;
      inside++;
      if (mask.data[y * mask.width + x]) onMask++;
    }
  }
  if (inside < 400) {
    return bad(
      "tiny_quad",
      "That reference rectangle covers almost none of the photo. Drag the corners out over the surface.",
      409,
    );
  }
  const coverage = onMask / inside;
  if (coverage < MIN_QUAD_ON_MASK) {
    return bad(
      "off_surface",
      `Only ${(coverage * 100).toFixed(0)}% of that rectangle is on the ${surface.label ?? surface.kind}. Place the corners on the surface you are measuring.`,
      409,
    );
  }

  /* ---------------------------------------------------------------- persist */

  const plane: SurfacePlane = {
    quad: quad as SurfacePlane["quad"],
    refWidthMm: refWidthMm as number,
    refHeightMm: refHeightMm as number,
    H: solved.H,
    // Snapped, for the same reason `tileSpecFor` snaps it: a hand-dragged angle is
    // always a degree or two off whatever the user meant, and a floor laid 2 degrees
    // out reads as a mistake where 0 or 45 reads as a decision.
    theta: snapTheta((thetaDeg * Math.PI) / 180),
    // 1, because this is not a fit. Four corners and two distances determine H
    // exactly; the number that describes how good it is, is `residualPx`. The field
    // exists for a future RANSAC fit over many correspondences.
    fitQuality: 1,
  };

  await db
    .update(surfaces)
    .set({ plane, updatedAt: new Date() })
    .where(eq(surfaces.id, surfaceId));

  /* -------------------------------------------------------------- feedback */

  // mm per pixel at the near and far edges of the quad. Reported because it is the
  // one number that predicts whether a material will be legible: at 40mm/px a 3mm
  // grout joint is a fourteenth of a pixel, so the far end of the floor will read as
  // flat colour no matter how good the sampler is. Better to say so while the user
  // is still holding the handles.
  const nearMid: Vec2 = [(quad[2][0] + quad[3][0]) / 2, (quad[2][1] + quad[3][1]) / 2];
  const farMid: Vec2 = [(quad[0][0] + quad[1][0]) / 2, (quad[0][1] + quad[1][1]) / 2];
  const near = footprint(solved.H, nearMid[0], nearMid[1]);
  const far = footprint(solved.H, farMid[0], farMid[1]);

  return Response.json({
    surfaceId,
    hasPlane: true,
    residualPx,
    /** Snapped, in degrees, so the UI can show what it actually stored. */
    thetaDeg: (plane.theta * 180) / Math.PI,
    refWidthMm,
    refHeightMm,
    /** Fraction of the reference rectangle that sits on this surface's mask. */
    coverage,
    scale: {
      nearMmPerPx: near ? near.minor : null,
      farMmPerPx: far ? far.major : null,
    },
  });
}

/**
 * DELETE — forget the plane.
 *
 * Not merely tidiness: `hasPlane` gates the Precision affordance, so a user who
 * placed the guides badly and cannot get them right needs a way back to the
 * generative path. Overwriting via PUT handles a correction; this handles giving up.
 */
export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/images/[id]/surfaces/[surfaceId]/plane">,
) {
  const { id, surfaceId } = await ctx.params;

  const surface = await db.query.surfaces.findFirst({
    where: and(eq(surfaces.id, surfaceId), eq(surfaces.imageId, id)),
  });
  if (!surface) return bad("not_found", "No such surface on this photo.", 404);

  await db
    .update(surfaces)
    .set({ plane: null, updatedAt: new Date() })
    .where(eq(surfaces.id, surfaceId));

  return Response.json({ surfaceId, hasPlane: false });
}
