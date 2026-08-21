/**
 * roomvi schema.
 *
 * Two invariants are encoded here deliberately:
 *
 *  1. `renders.base_image_id` always points at the ORIGINAL photo, and the edit
 *     is described by the `render_ops` rows. The row-level anchor never moves,
 *     which is what keeps history queries and cascade deletes simple.
 *
 *     Within that frame, a render's INPUT pixels may be a previous render's
 *     output: conversational editing builds on the selected version, with the
 *     chain carried by the job payload (`baseRenderId`) rather than by the rows,
 *     so every version still hangs off the same original and nothing chains
 *     silently — each link was an explicit, paid request.
 *
 *  2. Nothing stores a fal.ai URL as a source of truth. fal output URLs expire
 *     (~7 days), so the worker copies every output to local storage and we keep
 *     only the storage key. `images.fal_url` is a short-lived upload cache with
 *     an explicit expiry, never a reference we depend on.
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

const id = () =>
  varchar("id", { length: 21 })
    .primaryKey()
    .$defaultFn(() => nanoid());

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ enums */

/** Architectural surfaces get Precision mode; objects fall back to generative. */
export const surfaceKindEnum = pgEnum("surface_kind", [
  "floor",
  "wall",
  "ceiling",
  "countertop",
  "backsplash",
  "upper_cabinets",
  "lower_cabinets",
  "island",
  "window",
  "door",
  "rug",
  "furniture",
  "appliance",
  "custom",
]);

export const surfaceSourceEnum = pgEnum("surface_source", ["fal", "brush", "derived"]);

export const materialCategoryEnum = pgEnum("material_category", [
  "flooring",
  "tile",
  "stone",
  "wood",
  "rug",
  "countertop",
  "wallpaper",
  "paint",
  "cabinetry",
]);

/** Tile layout pattern, applied in world-mm space before the modulo. */
export const bondEnum = pgEnum("bond", ["stack", "running", "herringbone", "basketweave"]);

export const renderStatusEnum = pgEnum("render_status", [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
]);

/**
 * `precision` = local CV, real bitmap at true mm scale, costs nothing.
 * `generative` = fal edit composited back through the mask.
 */
export const executorEnum = pgEnum("executor", ["precision", "generative"]);

export const opKindEnum = pgEnum("op_kind", ["material", "prompt"]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
  "dead",
]);

export const jobKindEnum = pgEnum("job_kind", ["analyze", "render", "mipmap"]);

/* ------------------------------------------------------------------ tables */

export const users = pgTable("users", {
  id: id(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: varchar("name", { length: 120 }),
  credits: integer("credits").notNull().default(50),
  createdAt: createdAt(),
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    userId: varchar("user_id", { length: 21 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_user_idx").on(t.userId)],
);

export const images = pgTable(
  "images",
  {
    id: id(),
    projectId: varchar("project_id", { length: 21 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    /** Display-sized copy actually sent to fal and the editor canvas. */
    displayKey: text("display_key"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /**
     * Dimensions of the display copy. Masks, quads and brush strokes are all in
     * DISPLAY pixel space, so the client needs these to map coordinates — using
     * the original dimensions would offset every mask by the downscale factor.
     */
    displayWidth: integer("display_width"),
    displayHeight: integer("display_height"),
    /** Deduplicates uploads and keys the mask cache. */
    sha256: varchar("sha256", { length: 64 }).notNull(),
    mimeType: varchar("mime_type", { length: 64 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    exif: jsonb("exif").$type<Record<string, unknown>>(),
    /**
     * Quality gate result:
     * { blurVariance, clippedLowPct, clippedHighPct, verdict: 'ok'|'warn'|'reject',
     *   warnings: string[] }
     */
    quality: jsonb("quality").$type<ImageQuality>(),
    /** Cached fal upload URL. Expires — never depend on it. */
    falUrl: text("fal_url"),
    falUrlExpiresAt: timestamp("fal_url_expires_at", { withTimezone: true }),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("images_project_idx").on(t.projectId),
    index("images_sha_idx").on(t.sha256),
  ],
);

export const surfaces = pgTable(
  "surfaces",
  {
    id: id(),
    imageId: varchar("image_id", { length: 21 })
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    kind: surfaceKindEnum("kind").notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    /** 1-bit PNG on disk. Masks are large, streamed to the browser, and read
     *  by sharp directly — bytea would be the wrong home. */
    maskKey: text("mask_key").notNull(),
    /** Normalized [x0,y0,x1,y1]. */
    bbox: jsonb("bbox").$type<[number, number, number, number]>(),
    confidence: real("confidence"),
    source: surfaceSourceEnum("source").notNull().default("fal"),
    /** Single-photo area is ±15-25%, so store a range and never a point value. */
    areaM2Low: real("area_m2_low"),
    areaM2High: real("area_m2_high"),
    /**
     * Precision-mode plane fit. Null until the user places the quad.
     * The homography maps image px -> world mm, which is what makes
     * "600x900 tile renders as 600x900" true rather than aspirational.
     */
    plane: jsonb("plane").$type<SurfacePlane>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("surfaces_image_idx").on(t.imageId)],
);

export const suppliers = pgTable("suppliers", {
  id: id(),
  name: varchar("name", { length: 200 }).notNull().unique(),
  website: text("website"),
  createdAt: createdAt(),
});

export const materials = pgTable(
  "materials",
  {
    id: id(),
    sku: varchar("sku", { length: 80 }).notNull().unique(),
    supplierId: varchar("supplier_id", { length: 21 }).references(() => suppliers.id, {
      onDelete: "set null",
    }),
    category: materialCategoryEnum("category").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    /** Seamless tileable bitmap. Required for Precision mode. */
    textureKey: text("texture_key"),
    heroKey: text("hero_key"),
    /** Highest built mip level; null until the mipmap job runs. */
    mipLevels: smallint("mip_levels"),
    /* --- the columns that make true-scale rendering possible --- */
    tileWMm: integer("tile_w_mm"),
    tileHMm: integer("tile_h_mm"),
    groutMm: real("grout_mm").default(3),
    bond: bondEnum("bond").notNull().default("stack"),
    finish: varchar("finish", { length: 80 }),
    /** Measured CIELAB, for the post-render colour retarget. */
    colorLab: jsonb("color_lab").$type<[number, number, number]>(),
    leadTimeDays: integer("lead_time_days"),
    /** True only when texture + real tile dimensions are both present. */
    precisionReady: boolean("precision_ready").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("materials_category_idx").on(t.category)],
);

export const renders = pgTable(
  "renders",
  {
    id: id(),
    projectId: varchar("project_id", { length: 21 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** ALWAYS the original photo. See invariant 1 at the top of this file. */
    baseImageId: varchar("base_image_id", { length: 21 })
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    status: renderStatusEnum("status").notNull().default("queued"),
    executor: executorEnum("executor").notNull(),
    outputKey: text("output_key"),
    width: integer("width"),
    height: integer("height"),
    model: varchar("model", { length: 120 }),
    /**
     * `bigint`, not `integer`. fal returns seeds across the full uint32 range and
     * 2599281090 overflowed a signed 4-byte column — which threw on the SUCCESS
     * update, after the render was paid for and written to disk, so the queue
     * retried and paid twice more. Stored as a JS number: uint32 is far inside
     * `Number.MAX_SAFE_INTEGER`, so `mode: "number"` is exact here.
     */
    seed: bigint("seed", { mode: "number" }),
    /** fal billable units, for reconciliation against their billing API. */
    costUnits: real("cost_units"),
    falRequestId: varchar("fal_request_id", { length: 120 }),
    /**
     * Structure guard: how much the output drifted OUTSIDE the intended mask.
     * Precision renders must be ~0 (bit-identical); generative renders get a
     * pHash/SSIM score and are retried above threshold.
     */
    driftScore: real("drift_score"),
    /**
     * Precision mode's measurement check — the numbers behind the "laid to scale"
     * claim the overlay makes out loud.
     *
     * Persisted rather than recomputed on read because it is EVIDENCE: it describes
     * what the render that is on disk actually did, and re-deriving it later from the
     * plane would answer a different question (what a render would do now, with
     * whatever the quad has since been dragged to). A trust feature that silently
     * re-measures is not a trust feature.
     */
    measurement: jsonb("measurement").$type<RenderMeasurement>(),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("renders_project_idx").on(t.projectId),
    index("renders_base_image_idx").on(t.baseImageId),
  ],
);

/** The edit graph. Ops, not flattened outputs — this is the anti-drift store. */
export const renderOps = pgTable(
  "render_ops",
  {
    id: id(),
    renderId: varchar("render_id", { length: 21 })
      .notNull()
      .references(() => renders.id, { onDelete: "cascade" }),
    seq: smallint("seq").notNull(),
    kind: opKindEnum("kind").notNull(),
    surfaceId: varchar("surface_id", { length: 21 }).references(() => surfaces.id, {
      onDelete: "set null",
    }),
    materialId: varchar("material_id", { length: 21 }).references(() => materials.id, {
      onDelete: "set null",
    }),
    prompt: text("prompt"),
    /** Executor-specific knobs: strength, bond override, theta, gamma, ... */
    params: jsonb("params").$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("render_ops_seq_idx").on(t.renderId, t.seq)],
);

/**
 * Postgres-as-queue. Claimed with FOR UPDATE SKIP LOCKED; a lease that expires
 * lets a crashed worker's job be re-run instead of lost.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    kind: jobKindEnum("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    priority: smallint("priority").notNull().default(0),
    attempts: smallint("attempts").notNull().default(0),
    maxAttempts: smallint("max_attempts").notNull().default(3),
    /** Backoff target: not eligible for claim until now() >= run_after. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 80 }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Prevents a double-click from queueing (and charging) twice. */
    idempotencyKey: varchar("idempotency_key", { length: 200 }).unique(),
    lastError: text("last_error"),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The claim query's covering index: status + eligibility + ordering.
    index("jobs_claim_idx").on(t.status, t.runAfter, t.priority),
    index("jobs_lease_idx").on(t.status, t.leaseExpiresAt),
  ],
);

/**
 * Credits are debited at SUBMIT and refunded on failure — not at completion,
 * or a user with one credit could fire forty concurrent renders.
 */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: id(),
    userId: varchar("user_id", { length: 21 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: varchar("reason", { length: 80 }).notNull(),
    renderId: varchar("render_id", { length: 21 }).references(() => renders.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [index("credit_ledger_user_idx").on(t.userId)],
);

export const shareLinks = pgTable(
  "share_links",
  {
    id: id(),
    token: varchar("token", { length: 32 }).notNull().unique(),
    renderId: varchar("render_id", { length: 21 })
      .notNull()
      .references(() => renders.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("share_links_render_idx").on(t.renderId)],
);

export const favorites = pgTable(
  "favorites",
  {
    id: id(),
    userId: varchar("user_id", { length: 21 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    materialId: varchar("material_id", { length: 21 })
      .notNull()
      .references(() => materials.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("favorites_unique_idx").on(t.userId, t.materialId)],
);

/* ------------------------------------------------------------------- types */

/**
 * What a Precision render measured about itself.
 *
 * Every field is checkable against a tape measure in the real room, which is the
 * point: this is what the editor's measurement overlay reads, and it is the
 * difference between "600x600 matte" as a claim and as a statement of fact.
 */
export type RenderMeasurement = {
  /** Worst corner round-trip through H and back, px. Sub-0.01 is a closed solve. */
  residualPx: number;
  /** Joint courses counted in the render, and what the arithmetic requires. */
  tilesAcross: number;
  tilesDown: number;
  expectedAcross: number;
  expectedDown: number;
  /** Fraction of the surface painted; below 1 means furniture was cut out. */
  painted: number;
  /** Pixels outside the mask left bit-identical. False is a bug, not a warning. */
  outsideUntouched: boolean;
  /** Fraction of the composited region that actually changed. See the note in
   *  lib/precision/execute.ts: without this, `outsideUntouched` passes vacuously. */
  changedInside: number;
  tile: { widthMm: number; heightMm: number; groutMm: number; bond: string; thetaDeg: number };
  /** The user-facing verdict, precomputed so the overlay cannot disagree with it. */
  headline: string;
  verified: boolean;
  lines: string[];
};

export type ImageQuality = {
  blurVariance: number;
  clippedLowPct: number;
  clippedHighPct: number;
  verdict: "ok" | "warn" | "reject";
  warnings: string[];
};

export type SurfacePlane = {
  /** 4 image-space points (px), user-placed or auto-seeded, clockwise from TL. */
  quad: [[number, number], [number, number], [number, number], [number, number]];
  /** Real-world size in mm of the rectangle the quad covers. */
  refWidthMm: number;
  refHeightMm: number;
  /** Row-major 3x3 homography, image px -> world mm. */
  H: number[];
  /** Tile course rotation in radians, snapped to the dominant wall direction. */
  theta: number;
  /** RANSAC inlier ratio or user confirmation; below ~0.85 suggests a non-planar surface. */
  fitQuality?: number;
};

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Render = typeof renders.$inferSelect;
export type Surface = typeof surfaces.$inferSelect;
export type Material = typeof materials.$inferSelect;
export type Image = typeof images.$inferSelect;
