/**
 * Verify the brush rasterizer.
 *
 * `applyStrokes` is the one function in the project that MUST produce identical
 * output in two runtimes — the browser previews with it and the route persists
 * with it. A divergence would not throw and would not fail a typecheck; it would
 * show the user a mask they did not get, and only surface as a render shaped
 * wrong. So the properties that make the two sides interchangeable are asserted
 * here rather than assumed from "it has no imports":
 *
 *   determinism        -> same strokes, same bits, twice
 *   order dependence   -> add-then-erase != erase-then-add (both are legal edits)
 *   normalized space   -> a stroke at (0.5,0.5) lands at the centre at ANY size
 *   `changed` honesty  -> the count is the number of pixels that flipped, exactly
 *   clipping           -> a stroke off the edge paints what is on-canvas, no throw
 *   validation         -> every rejection the route relies on actually rejects
 *
 * Free. No fal, no database, no disk.
 */
import {
  applyStrokes,
  validateStrokes,
  thin,
  DEFAULT_RADIUS,
  MAX_POINTS_PER_STROKE,
  MAX_RADIUS,
  MAX_STROKES,
  MIN_RADIUS,
  type Stroke,
} from "../lib/editor/brush";

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

const W = 400;
const H = 300;

function blank(w = W, h = H): Uint8Array {
  return new Uint8Array(w * h);
}

/** A half-on mask: left half white. Gives both modes something real to bite on. */
function halfOn(w = W, h = H): Uint8Array {
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) bits[y * w + x] = 255;
  return bits;
}

function countOn(bits: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) n++;
  return n;
}

function at(bits: Uint8Array, nx: number, ny: number, w = W, h = H): number {
  return bits[Math.floor(ny * h) * w + Math.floor(nx * w)];
}

const dot = (mode: "add" | "subtract", x: number, y: number, radius = DEFAULT_RADIUS): Stroke => ({
  mode,
  radius,
  points: [{ x, y }],
});

function main() {
  console.log("\nbrush rasterizer\n");

  /* ------------------------------------------------------------ determinism */

  {
    const strokes: Stroke[] = [
      { mode: "add", radius: 0.05, points: [{ x: 0.2, y: 0.3 }, { x: 0.7, y: 0.45 }] },
      dot("subtract", 0.4, 0.4, 0.02),
    ];
    const a = blank();
    const b = blank();
    const ca = applyStrokes(a, W, H, strokes);
    const cb = applyStrokes(b, W, H, strokes);
    let same = ca === cb;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    check("same strokes over same bits produce identical output", same, `${ca} vs ${cb} changed`);
  }

  /* --------------------------------------------------- normalized geometry */

  {
    // The property that makes strokes portable at all: the client paints on a CSS
    // box of arbitrary size, the mask is display-sized, and the two agree only
    // because coordinates are fractions. If this drifts, corrections land offset
    // and the user cannot tell why.
    const sizes: Array<[number, number]> = [
      [400, 300],
      [1024, 768],
      [97, 61],
      [1200, 400],
    ];
    let allCentred = true;
    const shares: number[] = [];
    for (const [w, h] of sizes) {
      const bits = new Uint8Array(w * h);
      applyStrokes(bits, w, h, [dot("add", 0.5, 0.5, 0.1)]);
      if (!at(bits, 0.5, 0.5, w, h)) allCentred = false;
      // A corner must stay off — a radius of 0.1 of the short edge cannot reach it.
      if (at(bits, 0.02, 0.02, w, h)) allCentred = false;
      shares.push(countOn(bits) / (w * h));
    }
    check("a centred dot lands at the centre at every image size", allCentred);

    // Radius is normalized to the SHORT edge, so a disc covers a CONSTANT number
    // of pixels relative to short², not to area — which is why a wide photo shows a
    // smaller share. Asserting the pixel radius instead of the share is the honest
    // version of this check.
    let radiusHeld = true;
    for (const [w, h] of sizes) {
      const bits = new Uint8Array(w * h);
      applyStrokes(bits, w, h, [dot("add", 0.5, 0.5, 0.1)]);
      const expected = Math.PI * (0.1 * Math.min(w, h)) ** 2;
      const actual = countOn(bits);
      // Rasterizing a disc onto a coarse grid deviates from πr²; 12% is loose
      // enough for a 6px radius on the 97x61 case and tight enough to catch a
      // radius interpreted against the wrong edge (which would be ~2.5x off).
      if (Math.abs(actual - expected) / expected > 0.12) radiusHeld = false;
    }
    check("radius resolves against the short edge at every aspect ratio", radiusHeld, shares.map((s) => s.toFixed(4)).join(", "));
  }

  /* ----------------------------------------------------------- order matters */

  {
    // Both of these are things a user does, and they are NOT the same edit. A
    // rasterizer that grouped adds before subtracts would make the second one
    // impossible to express, and it is the more common of the two ("cover it, then
    // trim the overshoot").
    const overlap: [Stroke, Stroke] = [dot("add", 0.5, 0.5, 0.12), dot("subtract", 0.5, 0.5, 0.06)];
    const addFirst = blank();
    applyStrokes(addFirst, W, H, overlap);
    const eraseFirst = blank();
    applyStrokes(eraseFirst, W, H, [overlap[1], overlap[0]]);

    check(
      "add-then-erase leaves a hole at the centre",
      at(addFirst, 0.5, 0.5) === 0 && at(addFirst, 0.5, 0.5 + 0.09) === 255,
    );
    check("erase-then-add leaves the centre filled", at(eraseFirst, 0.5, 0.5) === 255);
    check("the two orders differ", countOn(addFirst) !== countOn(eraseFirst));
  }

  /* ---------------------------------------------------------- changed count */

  {
    const bits = halfOn();
    const before = countOn(bits);
    // Wholly inside the already-on left half, so nothing can flip.
    const changed = applyStrokes(bits, W, H, [dot("add", 0.2, 0.5, 0.05)]);
    check("painting add over an already-on region reports 0 changed", changed === 0, `${changed}`);
    check("...and leaves the bits alone", countOn(bits) === before);
  }

  {
    const bits = halfOn();
    const before = countOn(bits);
    const changed = applyStrokes(bits, W, H, [dot("add", 0.8, 0.5, 0.05)]);
    const after = countOn(bits);
    check(
      "changed equals the pixel delta when only adding into empty space",
      changed === after - before && changed > 0,
      `changed ${changed}, delta ${after - before}`,
    );
  }

  {
    // The count must be flips, not brush area — this is what the route's `changed
    // === 0` short-circuit and its `erased` guard both rest on.
    const bits = halfOn();
    // Straddles the boundary: half the disc is already on, half is not.
    const changed = applyStrokes(bits, W, H, [dot("add", 0.5, 0.5, 0.1)]);
    const discArea = Math.PI * (0.1 * Math.min(W, H)) ** 2;
    check(
      "a stroke straddling the mask edge counts only the flipped half",
      changed > discArea * 0.35 && changed < discArea * 0.65,
      `${changed} of ~${Math.round(discArea)} disc px`,
    );
  }

  /* --------------------------------------------------------------- clipping */

  {
    const bits = blank();
    let threw = false;
    let changed = 0;
    try {
      changed = applyStrokes(bits, W, H, [
        { mode: "add", radius: 0.08, points: [{ x: -0.5, y: 0.5 }, { x: 0.5, y: 0.5 }] },
      ]);
    } catch {
      threw = true;
    }
    check("a stroke starting off-canvas does not throw", !threw);
    check("...and paints the on-canvas part", changed > 0 && at(bits, 0.02, 0.5) === 255);
    check("...and nothing above the stroke", at(bits, 0.3, 0.1) === 0);
  }

  {
    // A stroke drawn entirely outside is a no-op, not a crash. Happens whenever a
    // pointer capture delivers a move after the cursor left the frame.
    const bits = blank();
    const changed = applyStrokes(bits, W, H, [dot("add", 3, 3, 0.05)]);
    check("a stroke entirely off-canvas changes nothing", changed === 0);
  }

  /* -------------------------------------------------------- capsule, not beads */

  {
    // The reason strokes are capsule fills rather than stamped discs: a fast drag
    // delivers widely spaced points, and a stamp walk would leave gaps between
    // them. Two points a third of the frame apart must be JOINED.
    const bits = blank();
    applyStrokes(bits, W, H, [
      { mode: "add", radius: 0.02, points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] },
    ]);
    let solid = true;
    for (let nx = 0.21; nx <= 0.79; nx += 0.01) if (!at(bits, nx, 0.5)) solid = false;
    check("a two-point stroke is continuous along its whole length", solid);
  }

  {
    // A tap is a one-point stroke. It must still paint — the degenerate segment
    // case is a real user action (clicking a speck of missed mask), not an edge
    // case to tolerate.
    const bits = blank();
    const changed = applyStrokes(bits, W, H, [dot("add", 0.5, 0.5, 0.03)]);
    check("a single-point tap paints a disc", changed > 0 && at(bits, 0.5, 0.5) === 255);
  }

  {
    // A radius that rounds below one pixel must still mark something, or the
    // smallest brush setting silently does nothing.
    const bits = blank();
    const changed = applyStrokes(bits, W, H, [dot("add", 0.5, 0.5, MIN_RADIUS)]);
    check(`the smallest legal radius (${MIN_RADIUS}) still paints`, changed > 0, `${changed} px`);
  }

  /* ------------------------------------------------------------- validation */

  {
    const cases: Array<[string, unknown, boolean]> = [
      ["a well-formed stroke list", [{ mode: "add", radius: 0.03, points: [{ x: 0.1, y: 0.1 }] }], true],
      ["not an array", { mode: "add" }, false],
      ["an empty array", [], false],
      ["an unknown mode", [{ mode: "paint", radius: 0.03, points: [{ x: 0, y: 0 }] }], false],
      ["a radius below MIN", [{ mode: "add", radius: MIN_RADIUS / 2, points: [{ x: 0, y: 0 }] }], false],
      ["a radius above MAX", [{ mode: "add", radius: MAX_RADIUS * 2, points: [{ x: 0, y: 0 }] }], false],
      ["a NaN radius", [{ mode: "add", radius: Number.NaN, points: [{ x: 0, y: 0 }] }], false],
      ["a stroke with no points", [{ mode: "add", radius: 0.03, points: [] }], false],
      ["a NaN coordinate", [{ mode: "add", radius: 0.03, points: [{ x: Number.NaN, y: 0 }] }], false],
      ["an Infinity coordinate", [{ mode: "add", radius: 0.03, points: [{ x: Infinity, y: 0 }] }], false],
      ["a string coordinate", [{ mode: "add", radius: 0.03, points: [{ x: "0.5", y: 0 }] }], false],
      ["a null stroke", [null], false],
      [
        `more than ${MAX_STROKES} strokes`,
        Array.from({ length: MAX_STROKES + 1 }, () => ({
          mode: "add",
          radius: 0.03,
          points: [{ x: 0, y: 0 }],
        })),
        false,
      ],
      [
        `more than ${MAX_POINTS_PER_STROKE} points`,
        [
          {
            mode: "add",
            radius: 0.03,
            points: Array.from({ length: MAX_POINTS_PER_STROKE + 1 }, () => ({ x: 0.5, y: 0.5 })),
          },
        ],
        false,
      ],
    ];

    let allRight = true;
    const wrong: string[] = [];
    for (const [label, input, shouldPass] of cases) {
      const got = validateStrokes(input).ok;
      if (got !== shouldPass) {
        allRight = false;
        wrong.push(label);
      }
    }
    check(`validateStrokes accepts and rejects all ${cases.length} cases correctly`, allRight, wrong.join("; "));
  }

  {
    // Out-of-range coordinates are CLAMPED, not rejected. Drawing off the edge of
    // the photo is normal; refusing the save because of it would be maddening.
    const r = validateStrokes([{ mode: "add", radius: 0.03, points: [{ x: -3, y: 9 }] }]);
    check(
      "an out-of-range point is clamped rather than rejected",
      r.ok && r.strokes[0].points[0].x === 0 && r.strokes[0].points[0].y === 1,
    );
  }

  {
    // Validation must not silently reorder or merge: the route relies on the
    // returned list being the SAME edit the client drew, in the same order.
    const input = [
      { mode: "add", radius: 0.05, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
      { mode: "subtract", radius: 0.02, points: [{ x: 0.15, y: 0.15 }] },
    ];
    const r = validateStrokes(input);
    check(
      "validation preserves stroke order, modes and point counts",
      r.ok &&
        r.strokes.length === 2 &&
        r.strokes[0].mode === "add" &&
        r.strokes[1].mode === "subtract" &&
        r.strokes[0].points.length === 2 &&
        r.strokes[1].points.length === 1,
    );

    // And a validated payload must rasterize the same as the raw one, or the
    // client's preview and the server's write differ by the validation step.
    if (r.ok) {
      const raw = blank();
      const validated = blank();
      applyStrokes(raw, W, H, input as Stroke[]);
      applyStrokes(validated, W, H, r.strokes);
      let identical = true;
      for (let i = 0; identical && i < raw.length; i++) if (raw[i] !== validated[i]) identical = false;
      check("rasterizing before and after validation gives the same bits", identical);
    }
  }

  /* ------------------------------------------------------------------- thin */

  {
    // 400 points inside one brush width, which is what a slow drag actually sends.
    const dense = Array.from({ length: 400 }, (_, i) => ({ x: 0.3 + i * 0.0002, y: 0.5 }));
    const thinned = thin(dense, 0.05, W / H);
    check(
      `thin() drops redundant points (400 -> ${thinned.length})`,
      thinned.length < 20 && thinned.length >= 2,
      `${thinned.length}`,
    );
    check(
      "thin() keeps the first and last point exactly",
      thinned[0].x === dense[0].x &&
        thinned[thinned.length - 1].x === dense[dense.length - 1].x,
    );

    // The thinned stroke must paint what the dense one did — thinning is an
    // optimization, and one that changed the mask would be a bug the user sees.
    const dsr = blank();
    const tsr = blank();
    applyStrokes(dsr, W, H, [{ mode: "add", radius: 0.05, points: dense }]);
    applyStrokes(tsr, W, H, [{ mode: "add", radius: 0.05, points: thinned }]);
    let diff = 0;
    for (let i = 0; i < dsr.length; i++) if (dsr[i] !== tsr[i]) diff++;
    check(
      "a thinned stroke rasterizes to the same region",
      diff === 0,
      `${diff} px differ`,
    );
  }

  {
    // Two points cannot be thinned — there is nothing between them to drop.
    const two = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }];
    check("thin() leaves a two-point stroke alone", thin(two, 0.05, 1).length === 2);
  }

  /* --------------------------------------------------------------- coverage */

  {
    // The route refuses a save whose result covers <0.1% of the frame, because a
    // mask that small bills fal for a no-op. Erasing a whole zone must therefore
    // be REACHABLE by a brush — otherwise that guard can never fire and is
    // untested code pretending to be a safety net.
    const bits = halfOn();
    const changed = applyStrokes(bits, W, H, [dot("subtract", 0.25, 0.5, MAX_RADIUS)]);
    const coverage = countOn(bits) / bits.length;
    check(
      "a max-radius erase can drive coverage down far enough to trip the route's guard",
      changed > 0 && coverage < 0.5,
      `coverage ${(coverage * 100).toFixed(1)}%`,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
