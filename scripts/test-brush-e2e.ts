/**
 * End-to-end brush correction against the running app and a real mask.
 *
 * The unit suite proves `applyStrokes` is correct in isolation. This proves the
 * part it cannot: that the mask on disk, the route's rasterization, and the
 * client's normalized coordinates all agree — which is the actual claim ("what you
 * paint is what gets stored"), and the one that fails silently if the display
 * dimensions and the mask dimensions ever diverge.
 *
 * The check that matters is the LAST one: re-decode the saved PNG and confirm the
 * pixels the strokes targeted are on. Anything less tests the HTTP status code.
 *
 * Free. No fal calls — brushing is local compute by design.
 */
import { desc, eq, isNotNull } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { images, surfaces } from "../lib/db/schema";
import { applyStrokes, type Stroke } from "../lib/editor/brush";
import { analyzeMask, decodeMask } from "../lib/mask";
import * as storage from "../lib/storage";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const img = await db.query.images.findFirst({
    where: isNotNull(images.analyzedAt),
    orderBy: [desc(images.analyzedAt)],
  });
  if (!img?.displayWidth || !img.displayHeight) throw new Error("no analyzed image to brush");

  const zones = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, img.id) });
  if (zones.length === 0) throw new Error(`image ${img.id} has no surfaces`);

  // Prefer a zone fal produced: correcting an already-corrected mask would test the
  // second save, not the first, and the first is the one with more moving parts
  // (source flip, confidence clear, key rotation).
  const target = zones.find((z) => z.source === "fal") ?? zones[0];
  console.log(`\nbrush e2e — image ${img.id} (${img.displayWidth}x${img.displayHeight}), zone ${target.kind} '${target.label}'\n`);

  const before = await decodeMask(await storage.get(target.maskKey));
  const beforeStats = analyzeMask(before);
  const beforeKey = target.maskKey;
  console.log(`  before: ${beforeKey} — coverage ${(beforeStats.coverage * 100).toFixed(2)}%`);

  // A stroke in a spot that is currently OFF, so the add is measurable. Search for
  // one rather than assuming: a large zone may already cover the centre.
  let spot: { x: number; y: number } | null = null;
  for (const cand of [
    { x: 0.5, y: 0.5 }, { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.3 },
    { x: 0.15, y: 0.8 }, { x: 0.85, y: 0.75 }, { x: 0.5, y: 0.15 },
  ]) {
    const i = Math.floor(cand.y * before.height) * before.width + Math.floor(cand.x * before.width);
    if (!before.data[i]) { spot = cand; break; }
  }
  if (!spot) throw new Error("no off-mask spot found — zone covers everything tested");
  console.log(`  painting an add stroke at (${spot.x}, ${spot.y})`);

  const strokes: Stroke[] = [
    { mode: "add", radius: 0.04, points: [spot, { x: spot.x + 0.06, y: spot.y + 0.04 }] },
  ];

  // What the CLIENT would show, computed locally. The whole point is that the
  // server must produce exactly this.
  const expected = new Uint8Array(before.data);
  const expectedChanged = applyStrokes(expected, before.width, before.height, strokes);

  const res = await fetch(`${BASE}/api/images/${img.id}/surfaces/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strokes }),
  });
  const body = await res.json();
  check(`PATCH returns 200 (got ${res.status})`, res.ok, JSON.stringify(body).slice(0, 200));
  if (!res.ok) return;

  check(
    `server's changed count matches the client's exactly (${body.changed} vs ${expectedChanged})`,
    body.changed === expectedChanged,
  );
  check("source flipped to 'brush'", body.source === "brush", String(body.source));
  check("confidence cleared", body.confidence === null);
  check("a NEW mask key was written (immutable cache)", body.maskUrl !== `/api/files/${beforeKey}`);

  const newKey = String(body.maskUrl).replace("/api/files/", "");
  const after = await decodeMask(await storage.get(newKey));

  // THE claim. Byte-identical to what the browser drew.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) if (expected[i] !== after.data[i]) diff++;
  check(
    "the stored mask is bit-identical to the client's local preview",
    diff === 0,
    `${diff} px differ`,
  );

  const i = Math.floor(spot.y * after.height) * after.width + Math.floor(spot.x * after.width);
  check("the painted spot is on in the stored mask", after.data[i] === 255);

  const afterStats = analyzeMask(after);
  check(
    `coverage grew (${(beforeStats.coverage * 100).toFixed(2)}% -> ${(afterStats.coverage * 100).toFixed(2)}%)`,
    afterStats.coverage > beforeStats.coverage,
  );

  const row = await db.query.surfaces.findFirst({ where: eq(surfaces.id, target.id) });
  check("the row points at the new key", row?.maskKey === newKey, String(row?.maskKey));
  check("the old mask file was cleaned up", !(await storage.exists(beforeKey)));

  // A second, empty-effect save must be refused as a no-op rather than burning a
  // new key — the guard that keeps the browser's immutable cache meaningful.
  const again = await fetch(`${BASE}/api/images/${img.id}/surfaces/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strokes }),
  });
  const againBody = await again.json();
  check("re-applying the same strokes reports unchanged", againBody.unchanged === true, JSON.stringify(againBody).slice(0, 120));

  // And a malformed payload must be a 400, not a 500.
  const badRes = await fetch(`${BASE}/api/images/${img.id}/surfaces/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strokes: [{ mode: "wat", radius: 5, points: [] }] }),
  });
  check(`a malformed stroke list is a 400 (got ${badRes.status})`, badRes.status === 400);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => { console.error(`\n${err instanceof Error ? err.stack : err}\n`); process.exitCode = 1; })
  .finally(() => pool.end());
