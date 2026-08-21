/**
 * Prompt construction and intent classification for the generative executor.
 *
 * Two jobs, both of which decide where money goes:
 *
 *  1. THE PRESERVE LIST. A whole-image edit model will happily improve the photo
 *     while it works — shift the camera, straighten a wall, add a window that
 *     "balances" the composition. Enumerating architecture as a POSITIVE list is
 *     what holds it still; a negative list ("don't move the camera") reads as a
 *     suggestion to most of these models. This skeleton is fal's own community
 *     template shape, not invention.
 *
 *  2. ROUTING. A material swap and a structural edit are different endpoints with
 *     different prices and different failure modes, and the user types both into
 *     the same box. "make the floor oak" is a masked swap: the mask exists, the
 *     layout is untouched, and the result can be composited back through the mask
 *     so nothing outside it can drift. "remove the cupboards and put a BBQ grill
 *     there" is not — the change extends past any mask (the wall behind, the
 *     shadow on the floor), so masking it would produce a cupboard-shaped hole.
 *     Getting this backwards is not a slightly worse render; it is a visibly
 *     broken one.
 */

/** Surfaces whose identity the model must not renegotiate while it works. */
const PRESERVE = [
  "camera position and focal length",
  "room layout and proportions",
  "wall, floor and ceiling planes",
  "window positions and the direction of daylight",
  "fixture, socket and switch locations",
].join(", ");

const CONSTRAINTS = [
  "do not reframe, crop or zoom",
  "no warped or bent geometry",
  "no new windows, doors or walls",
  "no added text, labels or watermark",
].join(", ");

export type MaterialDescriptor = {
  name: string;
  category: string;
  finish: string | null;
  tileWMm: number | null;
  tileHMm: number | null;
};

/**
 * The masked-swap prompt.
 *
 * Names the material in trade terms because that is the vocabulary these models
 * were trained on — "600 × 900 matte porcelain" carries scale and sheen
 * information that "grey tile" does not. Where real tile dimensions exist they go
 * in; where they do not, nothing is invented, since a fabricated format is a
 * claim the render cannot honour.
 */
export function materialPrompt(surfaceLabel: string, material: MaterialDescriptor): string {
  const format =
    material.tileWMm && material.tileHMm
      ? `${material.tileWMm} × ${material.tileHMm} mm format`
      : null;
  const spec = [material.finish, material.category, format].filter(Boolean).join(", ");

  return [
    `Change: replace the ${surfaceLabel.toLowerCase()} with ${material.name}` +
      (spec ? ` (${spec})` : "") +
      `. Keep the existing shading, reflections, contact shadows and perspective` +
      ` foreshortening of that surface — only the material changes.`,
    `Preserve: ${PRESERVE}`,
    `Constraints: ${CONSTRAINTS}, do not alter anything outside the masked region`,
  ].join("\n");
}

/** The free-form prompt. The user's words lead; the guard rails follow. */
export function freeFormPrompt(userPrompt: string): string {
  return [
    `Change: ${userPrompt.trim().replace(/\s+/g, " ")}`,
    `Preserve: ${PRESERVE}`,
    `Constraints: ${CONSTRAINTS}`,
  ].join("\n");
}

/**
 * The edit prompt for the reference-driven whole-image editor.
 *
 * One instruction block rather than a system/prompt split: the Pro endpoint
 * weighs a single prompt most reliably, and the rails must survive even where a
 * system role is not honoured. When the user selected a target, it is named
 * explicitly — "the upper cabinets" carries more information than any amount of
 * pronoun resolution — and everything NOT named is claimed for preservation,
 * which is what stops a cupboard recolour from becoming a kitchen restyle.
 */
export function editPrompt(userPrompt: string, targetLabel?: string | null): string {
  const target = targetLabel ? `Target: ${targetLabel}. ` : "";
  return [
    `${target}Change: ${userPrompt.trim().replace(/\s+/g, " ")}`,
    `Apply the change only to what is named. Everything else stays exactly as photographed.`,
    `Preserve: ${PRESERVE}`,
    `Constraints: ${CONSTRAINTS}`,
  ].join("\n");
}

/**
 * System prompt for the free-form endpoint.
 *
 * Separate from the instruction because `nano-banana-2` weights it differently:
 * the system prompt sets standing behaviour, the prompt describes one edit. Role
 * framing ("architectural visualiser") measurably reduces the model's urge to
 * restyle the whole room, which is the dominant failure on free-form edits.
 */
export const FREE_FORM_SYSTEM = [
  "You are an architectural visualiser producing a photorealistic remodel of a real",
  "room photograph. The photograph is evidence: its geometry, camera and lighting",
  "are fixed facts. Apply exactly the requested change and nothing else. Match the",
  "existing white balance, exposure and shadow direction so the edit is",
  "indistinguishable from the original capture.",
].join(" ");

/* ------------------------------------------------------------------ intent */

export type Intent =
  | { mode: "material"; surfaceHint: string | null }
  | { mode: "surface_prompt"; surfaceHint: string }
  | { mode: "structural" };

/**
 * Words that mean the change cannot be confined to a mask.
 *
 * Removing a cupboard reveals wall that was never visible, and deletes the shadow
 * it cast on the floor. Both lie OUTSIDE the cupboard mask, so a masked composite
 * would paste the original cupboard's pixels back over the edit at the boundary.
 */
const STRUCTURAL = [
  "remove", "delete", "demolish", "knock", "take out", "get rid",
  "add", "install", "put in", "place a", "build", "extend",
  "move", "relocate", "swap out", "replace the", "open up", "widen",
  "declutter", "clear", "empty",
];

/** Words that mean a surface is being re-finished, which a mask CAN confine. */
const FINISH = [
  "paint", "repaint", "colour", "color", "tile", "retile", "wallpaper",
  "finish", "material", "texture", "stain", "make the", "change the",
];

/**
 * Map free text onto a surface kind.
 *
 * Deliberately generous with synonyms: a user says "worktop", the schema says
 * `countertop`, and failing to connect them sends a perfectly maskable edit down
 * the expensive whole-image path.
 */
const SYNONYMS: Record<string, string[]> = {
  floor: ["floor", "flooring", "ground", "tiles underfoot"],
  wall: ["wall", "walls", "wallpaper"],
  ceiling: ["ceiling", "roof"],
  countertop: ["countertop", "counter", "worktop", "work top", "bench", "benchtop", "surface top"],
  backsplash: ["backsplash", "back splash", "splashback", "splash back"],
  upper_cabinets: ["upper cabinet", "upper cupboard", "wall unit", "overhead"],
  lower_cabinets: ["lower cabinet", "lower cupboard", "base unit", "under counter"],
  island: ["island", "peninsula"],
  window: ["window", "windows", "glazing"],
  door: ["door", "doors"],
};

/** The generic words. Only usable when exactly one cabinet zone exists. */
const CABINET_WORDS = ["cabinet", "cabinets", "cupboard", "cupboards", "unit", "units", "joinery"];

export function findSurfaceHint(prompt: string, availableKinds: string[]): string | null {
  const p = prompt.toLowerCase();

  // Longest phrase first, so "upper cupboard" is not consumed by "cupboard".
  const scored: Array<{ kind: string; len: number }> = [];
  for (const kind of availableKinds) {
    for (const word of SYNONYMS[kind] ?? []) {
      if (p.includes(word)) scored.push({ kind, len: word.length });
    }
  }
  if (scored.length > 0) {
    scored.sort((a, b) => b.len - a.len);
    return scored[0].kind;
  }

  // "the cupboards" is only unambiguous when one cabinet run was detected. With
  // both upper and lower present, guessing picks the wrong half of the kitchen.
  if (CABINET_WORDS.some((w) => p.includes(w))) {
    const cabinets = availableKinds.filter((k) => k.endsWith("_cabinets"));
    if (cabinets.length === 1) return cabinets[0];
  }
  return null;
}

/**
 * Decide how a free-form prompt should be rendered.
 *
 * The bias is toward `structural` when both signals fire: "replace the cabinets
 * with open shelving" names a surface AND removes it, and a masked swap of that
 * returns cabinet-shaped shelves. An unnecessary whole-image edit costs more and
 * looks fine; a wrongly masked structural edit looks broken.
 */
export function classifyPrompt(prompt: string, availableKinds: string[]): Intent {
  const p = prompt.toLowerCase();
  const hint = findSurfaceHint(p, availableKinds);
  const structural = STRUCTURAL.some((w) => p.includes(w));
  const finish = FINISH.some((w) => p.includes(w));

  if (hint && finish && !structural) return { mode: "surface_prompt", surfaceHint: hint };
  if (structural) return { mode: "structural" };
  if (hint) return { mode: "surface_prompt", surfaceHint: hint };
  return { mode: "structural" };
}
