/**
 * End-to-end Precision render against the running app, the real queue, and a real
 * photo. `npm run test:precision:e2e`.
 *
 * `test:precision` proves the maths in isolation and `test:precision:render` proves
 * the executor against output pixels. Neither touches the seam this covers: the
 * plane route's solve, the surfaces route's round-trip, the submit route's
 * eligibility gate, the queue, the worker, and the `measurement` column all
 * agreeing about one render. Every one of those is a place where a coordinate space
 * or a column can be silently wrong while both other suites stay green.
 *
 * THE ASSERTION THAT MATTERS IS THE LAST GROUP: read the stored `measurement` back
 * out of Postgres and confirm it says the render was verified. Anything less tests
 * HTTP status codes. In particular this is where a missing migration surfaces —
 * the worker does all its work correctly and then throws on the success UPDATE, so
 * the render lands `failed` with the output already on disk.
 *
 * Free. Precision makes no fal calls, so this can be re-run as often as it takes.
 */
import { desc, eq, isNotNull } from "drizzle-orm";
import sharp from "sharp";
import { db, pool } from "../lib/db";
import { images, materials, renders, surfaces } from "../lib/db/schema";
import { decodeMask } from "../lib/mask";
import { PLANAR_KINDS } from "../lib/render/precision";
import * as storage from "../lib/storage";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** The worker has no fal call to wait on, so this is generous by a wide margin. */
const DEADLINE_MS = 120_000;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Json = Record<string, unknown>;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, body };
}

async function main() {
  const img = await db.query.images.findFirst({
    where: isNotNull(images.analyzedAt),
    orderBy: [desc(images.analyzedAt)],
  });
  if (!img?.displayWidth || !img.displayHeight) throw new Error("no analyzed image");

  const zones = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, img.id) });
  const planar = zones.filter((z) => PLANAR_KINDS.has(z.kind));
  if (planar.length === 0) throw new Error(`image ${img.id} has no planar surface`);

  const material = await db.query.materials.findFirst({
    where: eq(materials.precisionReady, true),
  });
  if (!material) throw new Error("no precision-ready material");

  // A plausible real span for the patch the quad will cover. The absolute numbers
  // are the user's to supply and cannot be checked by software — what the render
  // group asserts is that whatever they say propagates intact to the tile count.
  const REF_W = 2400;
  const REF_H = 2000;

  // A trapezoid inside a zone's own bbox, narrower at the far edge — the shape a
  // floor actually presents from standing height, and what `seedQuad` produces.
  // Not `seedQuad` itself: this script exercises the ROUTE's validation, and
  // reusing the seeder would test that the seeder agrees with itself.
  const candidateFor = (z: (typeof planar)[number]) => {
    const [bx0, by0, bx1, by1] = z.bbox ?? [0.1, 0.6, 0.9, 0.95];
    const cx = (bx0 + bx1) / 2;
    const halfNear = ((bx1 - bx0) / 2) * 0.86;
    const halfFar = halfNear * 0.62;
    const yFar = by0 + (by1 - by0) * 0.12;
    const yNear = by1 - (by1 - by0) * 0.04;
    const quad: [[number, number], [number, number], [number, number], [number, number]] = [
      [cx - halfFar, yFar],
      [cx + halfFar, yFar],
      [cx + halfNear, yNear],
      [cx - halfNear, yNear],
    ];
    return { zone: z, quad, nearPx: 2 * halfNear * img.displayWidth! };
  };

  // Which zone the units assertions CAN run against.
  //
  // Two independent gates, because the guard needs BOTH:
  //
  //  - Reach. The route's implausible-scale guard compares the user's span against
  //    how many pixels the quad's near edge crosses, so it only sees a 10x slip
  //    when that edge is long enough for the slipped value to drop under the
  //    plausible floor of ~0.8 mm/px — i.e. a near edge of at least
  //    (REF_W / 10) / 0.8 px. On a sliver zone no constant can help: 240mm across
  //    170px is exactly what a close photo resolves, and refusing it would reject
  //    real close-ups.
  //  - Landing. A bbox-seeded quad must actually sit on the mask. A wall whose
  //    bbox is punched through by cabinets and a splashback solves fine and then
  //    fails the route's own coverage gate.
  //
  // So the suite measures every planar zone first and targets one that passes
  // both, preferring the floor when it qualifies — it is the surface with the
  // strongest perspective, where a lost Hartley normalization or a wrong corner
  // order actually shows.
  const MIN_DETECTABLE_NEAR_PX = REF_W / 10 / 0.8;

  /** Is p inside the convex quad? Sign-consistent cross products, as the route tests it. */
  const inQuad = (
    q: Array<[number, number]>,
    px: number,
    py: number,
  ): boolean => {
    let sign = 0;
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = q[k];
      const [bx, by] = q[(k + 1) % 4];
      const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (cross === 0) continue;
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  };

  /** Fraction of the seeded quad that lands on the zone's own mask — the route's coverage gate. */
  const coverageOf = async (zoneKey: string, normalizedQuad: Array<[number, number]>) => {
    const m = await decodeMask(await storage.get(zoneKey));
    const q = normalizedQuad.map(
      ([x, y]) => [x * m.width, y * m.height] as [number, number],
    );
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [qx, qy] of q) {
      x0 = Math.min(x0, qx);
      y0 = Math.min(y0, qy);
      x1 = Math.max(x1, qx);
      y1 = Math.max(y1, qy);
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(m.width - 1, Math.ceil(x1));
    y1 = Math.min(m.height - 1, Math.ceil(y1));
    let inside = 0;
    let on = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inQuad(q, x + 0.5, y + 0.5)) continue;
        inside++;
        if (m.data[y * m.width + x]) on++;
      }
    }
    return inside > 0 ? on / inside : 0;
  };

  const candidates: Array<{
    zone: (typeof planar)[number];
    quad: ReturnType<typeof candidateFor>["quad"];
    nearPx: number;
    coverage: number;
  }> = [];
  for (const z of planar) {
    const c = candidateFor(z);
    candidates.push({ ...c, coverage: await coverageOf(z.maskKey, c.quad) });
  }

  const qualifies = (c: (typeof candidates)[number]) =>
    c.nearPx >= MIN_DETECTABLE_NEAR_PX && c.coverage >= 0.5;
  const floorC = candidates.find((c) => c.zone.kind === "floor");
  const pick =
    (floorC && qualifies(floorC) ? floorC : null) ??
    [...candidates].filter(qualifies).sort((a, b) => b.nearPx - a.nearPx)[0] ??
    floorC ??
    candidates[0];

  const { zone: target, quad } = pick;
  /** False when the target is too small for the guard to see a 10x slip on. */
  const unitsDetectable = pick.nearPx >= MIN_DETECTABLE_NEAR_PX;
  const nonPlanar = zones.find((z) => !PLANAR_KINDS.has(z.kind)) ?? null;

  console.log(
    `\nprecision e2e — image ${img.id} (${img.displayWidth}x${img.displayHeight}), ` +
      `zone ${target.kind} '${target.label}' (near edge ~${Math.round(pick.nearPx)}px, ` +
      `${(pick.coverage * 100).toFixed(0)}% on-mask), material ${material.name} ` +
      `(${material.tileWMm}x${material.tileHMm}mm)\n`,
  );

  /* ------------------------------------------------------- 1. the plane route */

  console.log("1. plane");

  const mask = await decodeMask(await storage.get(target.maskKey));

  const planePath = `/api/images/${img.id}/surfaces/${target.id}/plane`;
  const put = (body: Json) =>
    api(planePath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // Refusals first, and each one for a distinct reason. A route that accepts a bad
  // plane produces a render that is confidently mis-measured, which is strictly
  // worse than one that fails.
  //
  // The cm case is the sharpest of these and the reason this group exists: 240 for a
  // 2400mm run solves exactly, closes to 1e-13, passes every geometric check, and
  // lays 60mm tiles under a headline that says "laid to scale, measured". Only the
  // mm-per-pixel ratio can see it, because only that compares the user's number
  // against the photo — which is also why it is conditional on the target's size.
  if (unitsDetectable) {
    const cm = await put({ quad, refWidthMm: REF_W / 10, refHeightMm: REF_H / 10 });
    check(
      "a span in cm is refused as a units mistake",
      cm.status === 409,
      `got ${cm.status} ${JSON.stringify(cm.body.error ?? cm.body)}`,
    );
    check(
      "...and the refusal suggests the 10x correction",
      String((cm.body.error as Json)?.message ?? "").includes(String(REF_W)),
      String((cm.body.error as Json)?.message),
    );
  } else {
    console.log(
      `  skip cm refusal — the ${target.kind}'s near edge (~${Math.round(pick.nearPx)}px) is too short ` +
        `for any constant to see a 10x slip on; the guard is blind there by physics, not by bug`,
    );
  }

  const inches = await put({ quad, refWidthMm: 94, refHeightMm: 79 });
  check(
    "a span in inches is refused",
    inches.status === 400 || inches.status === 409,
    `got ${inches.status}`,
  );

  const crossed = await put({ quad: [quad[0], quad[1], quad[3], quad[2]], refWidthMm: REF_W, refHeightMm: REF_H });
  check("a self-crossing quad is refused", crossed.status === 400, `got ${crossed.status}`);

  const flat = await put({
    quad: [[0.2, 0.8], [0.4, 0.8], [0.6, 0.8], [0.8, 0.8]],
    refWidthMm: REF_W,
    refHeightMm: REF_H,
  });
  check(
    "four collinear corners are refused",
    flat.status === 400 || flat.status === 409,
    `got ${flat.status} ${JSON.stringify(flat.body.error)}`,
  );

  const unnormalized = await put({
    quad: quad.map(([x, y]) => [x * img.displayWidth!, y * img.displayHeight!]),
    refWidthMm: REF_W,
    refHeightMm: REF_H,
  });
  check("a quad in raw px is refused", unnormalized.status === 400, `got ${unnormalized.status}`);

  // The off-surface check, which is the one that catches a quad dragged onto the
  // wrong surface — a plane measured on the wall would tile the floor with the
  // wall's perspective and look almost right.
  if (nonPlanar) {
    const wrongKind = await api(`/api/images/${img.id}/surfaces/${nonPlanar.id}/plane`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quad, refWidthMm: REF_W, refHeightMm: REF_H }),
    });
    check(
      `a plane on a ${nonPlanar.kind} is refused as non-planar`,
      wrongKind.status === 409,
      `got ${wrongKind.status}`,
    );
  }

  const ok = await put({ quad, refWidthMm: REF_W, refHeightMm: REF_H, thetaDeg: 1.4 });
  check("the plane is accepted", ok.status === 200, JSON.stringify(ok.body.error ?? ok.body));
  if (ok.status !== 200) throw new Error("cannot continue without a plane");

  const residual = Number(ok.body.residualPx);
  check(`the solve closes (${residual.toExponential(1)} px)`, residual < 0.01, `${residual}`);

  // 1.4 degrees snaps to 0. A hand-dragged angle is always a degree or two off
  // whatever the user meant, and a floor laid 1.4 degrees out reads as a mistake.
  check(
    `1.4 degrees snaps to 0 (got ${Number(ok.body.thetaDeg).toFixed(2)})`,
    Math.abs(Number(ok.body.thetaDeg)) < 1e-9,
  );

  check(
    `most of the reference rectangle is on the ${target.kind} (${(Number(ok.body.coverage) * 100).toFixed(0)}%)`,
    Number(ok.body.coverage) >= 0.5,
  );

  const scale = ok.body.scale as { nearMmPerPx: number | null; farMmPerPx: number | null };
  // Perspective means the far edge covers more mm per pixel than the near edge. If
  // this comes back inverted the corner order is wrong, which is a bug no residual
  // check can see — a mirrored quad solves perfectly.
  check(
    `the far edge is coarser than the near edge (${scale.nearMmPerPx?.toFixed(1)} -> ${scale.farMmPerPx?.toFixed(1)} mm/px)`,
    scale.nearMmPerPx != null && scale.farMmPerPx != null && scale.farMmPerPx > scale.nearMmPerPx,
  );

  /* ------------------------------------------- 2. the plane survives the API */

  console.log("\n2. round-trip");

  const listed = await api(`/api/images/${img.id}/surfaces`);
  const zone = (listed.body.zones as Array<Json>).find((z) => z.id === target.id);
  check("the zone reports a plane", zone?.hasPlane === true);
  check("the zone reports itself planar", zone?.planar === true);

  const servedPlane = zone?.plane as { quad: number[][]; refWidthMm: number; H: number[] } | null;
  check("the quad comes back", Array.isArray(servedPlane?.quad) && servedPlane!.quad.length === 4);
  check(`the reference span comes back as ${REF_W}mm`, servedPlane?.refWidthMm === REF_W);
  check("H comes back as 9 numbers", servedPlane?.H?.length === 9);

  // Normalized on the wire in both directions. If the route stored px and served px,
  // the editor would place the handles at a fraction of a percent of the frame and
  // the user would see the guides collapse into the top-left corner.
  const maxServed = Math.max(...(servedPlane?.quad ?? []).flat().map(Math.abs));
  check(`the served quad is normalized (max |v| = ${maxServed.toFixed(3)})`, maxServed <= 1.5);

  // The convention only holds if it ROUND-TRIPS. The editor reads this quad to
  // re-show the handles and PUTs it back on the next drag, so a normalize on read
  // without a matching denormalize on write would walk the plane toward the top-left
  // corner by the display size every time the user touched it — and each step solves
  // fine, so nothing would complain until the tiles were the size of a fingernail.
  const reput = await put({
    quad: servedPlane!.quad,
    refWidthMm: servedPlane!.refWidthMm,
    refHeightMm: REF_H,
  });
  check("the served quad is accepted back unchanged", reput.status === 200, `got ${reput.status} ${JSON.stringify(reput.body.error)}`);

  const relisted = await api(`/api/images/${img.id}/surfaces`);
  const after = (relisted.body.zones as Array<Json>).find((z) => z.id === target.id);
  const afterQuad = (after?.plane as { quad: number[][] } | null)?.quad ?? [];
  const drift = Math.max(
    ...servedPlane!.quad.flat().map((v, i) => Math.abs(v - afterQuad.flat()[i])),
  );
  check(`a read/write round-trip does not move the plane (${drift.toExponential(1)})`, drift < 1e-6);

  /* ------------------------------------------------ 3. the eligibility gates */

  console.log("\n3. submit gates");

  const submit = (body: Json) =>
    api("/api/renders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const promptOp = await submit({
    imageId: img.id,
    executor: "precision",
    ops: [{ kind: "prompt", prompt: "make the floor look expensive" }],
  });
  check(
    "precision refuses a free-form prompt",
    promptOp.status === 409,
    `got ${promptOp.status} ${JSON.stringify(promptOp.body.error)}`,
  );

  if (nonPlanar) {
    const npMaterial = await submit({
      imageId: img.id,
      executor: "precision",
      ops: [{ kind: "material", surfaceId: nonPlanar.id, materialId: material.id }],
    });
    check(
      `precision refuses a ${nonPlanar.kind} with a reason`,
      npMaterial.status === 409 &&
        typeof (npMaterial.body.error as Json)?.message === "string" &&
        String((npMaterial.body.error as Json).message).includes("not a flat plane"),
      JSON.stringify(npMaterial.body.error),
    );
  }

  // A planar surface with no plane yet, if the photo has one. This is the branch the
  // editor turns into "place the perspective guides over it", so the reason text
  // reaching the client verbatim is the point rather than the status code.
  const unmeasured = planar.find((z) => z.id !== target.id && z.plane == null);
  if (unmeasured) {
    const noPlane = await submit({
      imageId: img.id,
      executor: "precision",
      ops: [{ kind: "material", surfaceId: unmeasured.id, materialId: material.id }],
    });
    check(
      `precision on an unmeasured ${unmeasured.kind} names the missing plane`,
      noPlane.status === 409 &&
        String((noPlane.body.error as Json)?.message ?? "").includes("no measured plane"),
      JSON.stringify(noPlane.body.error),
    );
  }

  const noMm = await db.query.materials.findFirst({
    where: eq(materials.precisionReady, false),
  });
  if (noMm) {
    const badMat = await submit({
      imageId: img.id,
      executor: "precision",
      ops: [{ kind: "material", surfaceId: target.id, materialId: noMm.id }],
    });
    check(
      `precision refuses ${noMm.name}, which has no tile size`,
      badMat.status === 409,
      `got ${badMat.status}`,
    );
  }

  /* ------------------------------------------------------------ 4. the render */

  console.log("\n4. render");

  const started = Date.now();
  const sub = await submit({
    imageId: img.id,
    executor: "precision",
    ops: [{ kind: "material", surfaceId: target.id, materialId: material.id }],
  });
  check(
    "the render is accepted",
    sub.status === 202 || sub.status === 200,
    `${sub.status} ${JSON.stringify(sub.body.error ?? sub.body)}`,
  );
  if (!sub.body.renderId) throw new Error("no renderId came back");
  const renderId = String(sub.body.renderId);
  check("it is queued as a precision render", sub.body.executor === "precision", String(sub.body.executor));
  if (sub.body.reused) console.log(`  note: reused an earlier identical render`);

  // Poll the same route the editor polls, so a shape mismatch shows up here rather
  // than as a blank overlay in the browser.
  let state: Json = {};
  for (;;) {
    const poll = await api(`/api/renders/${renderId}`);
    state = poll.body;
    if (state.status === "ready" || state.status === "failed" || state.status === "cancelled") break;
    if (state.queueStatus === "dead") break;
    if (Date.now() - started > DEADLINE_MS) {
      throw new Error(
        state.status === "queued"
          ? "still queued after 2 minutes — is the worker running? (npm run worker)"
          : "timed out",
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  check(
    `the render is ready (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    state.status === "ready",
    String(state.error ?? state.queueError ?? state.status),
  );
  if (state.status !== "ready") throw new Error("render did not complete");

  check("it cost nothing", state.costUnits === 0, String(state.costUnits));
  check("drift is exactly zero", state.driftScore === 0, String(state.driftScore));
  check("no drift warning is shown", state.driftWarning === null);
  check("the model is named precision/warp", state.model === "precision/warp", String(state.model));

  /* ------------------------------------------------------- 5. the measurement */

  console.log("\n5. measurement");

  // From the POLL first — this is the exact object the overlay will read, and it
  // travels through JSON, where a Date or a NaN would not survive intact.
  const m = state.measurement as Json | null;
  check("the poll route serves a measurement", m != null);
  if (!m) throw new Error("no measurement on the poll response");

  check(`it is verified — "${m.headline}"`, m.verified === true, JSON.stringify(m.lines));
  check("nothing outside the mask was touched", m.outsideUntouched === true);
  check(
    `the region was actually painted (${(Number(m.changedInside) * 100).toFixed(1)}%)`,
    Number(m.changedInside) > 0.9,
    "a no-op composite satisfies outsideUntouched vacuously",
  );
  check(
    `the courses match the arithmetic (${m.tilesAcross}x${m.tilesDown})`,
    m.tilesAcross === m.expectedAcross && m.tilesDown === m.expectedDown,
    `expected ${m.expectedAcross}x${m.expectedDown}`,
  );

  const tile = m.tile as Json;
  check(
    `the tile is the material's own size (${tile.widthMm}x${tile.heightMm}mm)`,
    tile.widthMm === material.tileWMm && tile.heightMm === material.tileHMm,
    `material says ${material.tileWMm}x${material.tileHMm}`,
  );

  // The arithmetic behind the claim, checked independently of the executor: the
  // reference span divided by the tile pitch is how many courses must appear. If
  // this and the render disagree, one of them is lying to the user in millimetres.
  const pitchW = Number(tile.widthMm) + Number(tile.groutMm);
  const expectAcross = Math.floor(REF_W / pitchW) + 1;
  check(
    `${REF_W}mm / ${pitchW}mm pitch independently predicts ${expectAcross} courses`,
    m.expectedAcross === expectAcross,
    `route says ${m.expectedAcross}`,
  );

  // And from POSTGRES, which is the assertion a missing migration fails. The worker
  // writes this column on the success UPDATE; without it the render does all its
  // work correctly and then throws, landing `failed` with the output on disk.
  const row = await db.query.renders.findFirst({ where: eq(renders.id, renderId) });
  check("the column persisted it", row?.measurement != null);
  check(
    "the stored headline matches what was served",
    row?.measurement?.headline === m.headline,
    `${row?.measurement?.headline} vs ${m.headline}`,
  );
  check(
    `the stored residual is sub-pixel (${row?.measurement?.residualPx?.toExponential(1)})`,
    (row?.measurement?.residualPx ?? Infinity) < 0.01,
  );

  /* ------------------------------------------------------------- 6. the image */

  console.log("\n6. output");

  if (!row?.outputKey) throw new Error("ready render has no outputKey");
  const output = await storage.get(row.outputKey);
  const meta = await sharp(output).metadata();
  check(
    `the output is ${img.displayWidth}x${img.displayHeight}`,
    meta.width === img.displayWidth && meta.height === img.displayHeight,
    `got ${meta.width}x${meta.height}`,
  );

  // The one check that reads pixels here rather than trusting the executor's own
  // report: inside the mask the picture must differ from the photo. It is the same
  // claim `changedInside` makes, measured on the JPEG that actually shipped, after
  // storage and re-encode — the two places the executor cannot see.
  const photo = await storage.get(img.displayKey!);
  const a = await sharp(photo).removeAlpha().raw().toBuffer();
  const b = await sharp(output).removeAlpha().raw().toBuffer();
  let inside = 0;
  let differing = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (!mask.data[i]) continue;
    inside++;
    const o = i * 3;
    // A threshold, not equality: JPEG is lossy, so a handful of levels of drift is
    // the codec rather than the render.
    if (
      Math.abs(a[o] - b[o]) > 6 ||
      Math.abs(a[o + 1] - b[o + 1]) > 6 ||
      Math.abs(a[o + 2] - b[o + 2]) > 6
    ) {
      differing++;
    }
  }
  const frac = inside ? differing / inside : 0;
  check(
    `the shipped JPEG differs from the photo inside the mask (${(frac * 100).toFixed(1)}%)`,
    frac > 0.5,
    "byte-identical output is the no-op failure, and it passes every geometry check",
  );

  const outPath = storage.absolutePath(row.outputKey);
  console.log(`\n  render ${renderId} -> ${outPath}`);
  console.log(`  "${m.headline}"`);
  for (const line of m.lines as string[]) console.log(`    · ${line}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`\nFAILED: ${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
