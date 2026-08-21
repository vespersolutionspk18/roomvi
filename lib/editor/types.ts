/**
 * The editor's API contract, in one place.
 *
 * These mirror what the route handlers actually return. They live outside the
 * route files so a client component can import the type without dragging the
 * server's Drizzle imports into the browser bundle.
 */

/** A detected surface, as `GET /api/images/[id]/surfaces` serves it. */
export type Zone = {
  id: string;
  kind: string;
  label: string;
  source: "fal" | "brush" | "derived";
  confidence: number | null;
  /** A 1-bit PNG under /api/files. Fetched and cached, never inlined. */
  maskUrl: string;
  /** Normalized [x0,y0,x1,y1] over the DISPLAY image. */
  bbox: [number, number, number, number] | null;
  /** Normalized chip anchor — the bbox centre. */
  anchor: { x: number; y: number };
  tint: [number, number, number];
  /**
   * A RANGE. Single-photo area is ±15-25%, so the UI must never render this as
   * a point value next to a price.
   */
  areaM2: { low: number; high: number; approximate: true } | null;
  hasPlane: boolean;
  /**
   * The measured plane. Null until the user places the guides.
   *
   * `quad` is NORMALIZED to the display box and clockwise from top-left — the same
   * convention as `bbox` and brush strokes, so it can go straight back to the PUT
   * route. `H` is the exception: it maps display PX to world mm, so it is not
   * normalizable without folding the display size into the matrix. Scale the quad by
   * `width`/`height` before re-solving, or use `H` as served.
   */
  plane: {
    quad: [[number, number], [number, number], [number, number], [number, number]];
    refWidthMm: number;
    refHeightMm: number;
    /** Row-major 3x3, display PX -> world mm. Derived from `quad`; a cache, not truth. */
    H: number[];
    thetaDeg: number;
  } | null;
  /** Is this kind a flat plane at all? False means Precision is never available here. */
  planar: boolean;
};

export type SurfacesResponse = {
  imageId: string;
  /** The owning project — needed to attribute reference uploads. */
  projectId: string;
  analyzedAt: string | null;
  /** DISPLAY pixel space — masks and brush strokes are in these coordinates. */
  width: number;
  height: number;
  imageUrl: string | null;
  zones: Zone[];
};

export type AnalyzeStatus =
  | { status: "not_started" }
  | { status: "queued" | "running"; jobId: string; attempts: number }
  | { status: "ready"; analyzedAt: string; surfaceCount: number }
  | { status: "failed"; error: string | null; attempts: number };

/**
 * One painted stroke on the stage. Coordinates are NORMALIZED to the display
 * box — the one convention everything the user points at shares. `radius` is a
 * fraction of the SHORT edge, so a stroke reads the same on any window size.
 */
export type PaintStroke = {
  mode: "add" | "erase";
  radius: number;
  points: Array<{ x: number; y: number }>;
};

export type MaterialSummary = {
  id: string;
  sku: string;
  name: string;
  category: string;
  finish: string | null;
  /** Trade dimensions, e.g. "600 × 900". Null for anything not sold as a tile. */
  size: string | null;
  tileWMm: number | null;
  tileHMm: number | null;
  leadTimeDays: number | null;
  /** A real photograph-like swatch, not a CSS gradient. */
  heroUrl: string | null;
  textureUrl: string | null;
  /** True only when a texture AND real mm dimensions exist. Gates Precision. */
  precisionReady: boolean;
};

/**
 * Which material categories make sense on which surface.
 *
 * Selecting the floor should not offer wallpaper. This is a UI filter only —
 * the executor does not enforce it, because an unusual choice ("tile the
 * ceiling") is a legitimate remodel, not an error.
 */
export const CATEGORIES_FOR_KIND: Record<string, string[]> = {
  floor: ["flooring", "tile", "wood", "stone", "rug"],
  wall: ["paint", "wallpaper", "tile", "stone"],
  ceiling: ["paint", "wood"],
  countertop: ["countertop", "stone", "tile"],
  backsplash: ["tile", "stone"],
  upper_cabinets: ["cabinetry", "wood", "paint"],
  lower_cabinets: ["cabinetry", "wood", "paint"],
  island: ["countertop", "stone", "cabinetry"],
  window: [],
  door: ["wood", "paint"],
  custom: [],
};

/** Human labels for the sidebar's category pills. */
export const CATEGORY_LABELS: Record<string, string> = {
  flooring: "Flooring",
  tile: "Tile",
  stone: "Stone",
  wood: "Wood",
  rug: "Rugs",
  countertop: "Countertops",
  wallpaper: "Wallpaper",
  paint: "Paint",
  cabinetry: "Cabinetry",
};

/* ------------------------------------------------------------------- renders */

/** What `POST /api/renders` accepts. One request may carry several ops. */
export type RenderOpInput =
  | { kind: "material"; surfaceId: string; materialId: string; strength?: number }
  | {
      kind: "prompt";
      prompt: string;
      surfaceId?: string | null;
      /** Storage keys of "make it look like this" reference images. */
      referenceKeys?: string[];
      /** Storage key of a hand-painted region mask ("only here"). */
      maskKey?: string;
    };

export type Executor = "generative" | "precision";

export type RenderStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

/**
 * What a Precision render measured about itself, as the poll route serves it.
 *
 * Mirrors `RenderMeasurement` in the schema. Duplicated rather than imported so a
 * client component can read it without pulling Drizzle into the browser bundle —
 * the same reason the rest of this file exists.
 */
export type Measurement = {
  residualPx: number;
  tilesAcross: number;
  tilesDown: number;
  expectedAcross: number;
  expectedDown: number;
  /** Fraction of the surface painted; below 1 means furniture was cut out. */
  painted: number;
  outsideUntouched: boolean;
  changedInside: number;
  tile: { widthMm: number; heightMm: number; groutMm: number; bond: string; thetaDeg: number };
  /**
   * Precomputed server-side so the overlay cannot disagree with the verdict. The UI
   * shows these strings; it does not re-derive the claim from the numbers.
   */
  headline: string;
  verified: boolean;
  lines: string[];
};

/** One poll of `GET /api/renders/[id]`. */
export type RenderState = {
  id: string;
  status: RenderStatus;
  executor: string;
  url: string | null;
  width: number | null;
  height: number | null;
  model: string | null;
  seed: number | null;
  costUnits: number | null;
  driftScore: number | null;
  /**
   * A ready-to-show sentence, or null. Composed server-side against the measured
   * threshold so the client never has to know what a drift score means.
   */
  driftWarning: string | null;
  error: string | null;
  errorCode: string | null;
  /** Populated only by the Precision executor. Null on every generative render. */
  measurement: Measurement | null;
  attempts: number;
  /** Distinguishes a dead queue from a slow model — "dead" means no worker. */
  queueStatus: string | null;
  queueError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  ops: Array<{
    seq: number;
    kind: string;
    surfaceId: string | null;
    materialId: string | null;
    prompt: string | null;
  }>;
};

/** One entry in the version history, as `GET /api/renders?imageId=` serves it. */
export type RenderSummary = {
  id: string;
  status: RenderStatus;
  executor: string;
  url: string | null;
  width: number | null;
  height: number | null;
  model: string | null;
  costUnits: number | null;
  driftScore: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  ops: Array<{
    kind: string;
    surfaceId: string | null;
    materialId: string | null;
    prompt: string | null;
  }>;
};
