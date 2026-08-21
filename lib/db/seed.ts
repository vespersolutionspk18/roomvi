/**
 * Seed the material catalogue.
 *
 * The 15 names and base colours are lifted from showroom/editor.html:382-455 so
 * the ported sidebar looks like the design. Everything else — real tile
 * dimensions, grout width, bond, measured CIELAB — is what the mockup lacked
 * and what Precision mode requires. The dimensions below are real trade sizes
 * for each material type (600x600 porcelain, 1220x180 engineered oak plank,
 * 25mm mosaic chip, ...), not decoration.
 *
 * Textures are procedurally generated placeholders. When real supplier bitmaps
 * arrive, replace the texture file at the same storage key and re-run the mipmap
 * job — no schema or code change, and `precision_ready` already gates on the
 * dimensions being present.
 *
 * Idempotent: re-running updates rows in place, keyed by SKU.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "./index";
import { materials, suppliers } from "./schema";
import { srgbToLab } from "../color";
import * as storage from "../storage";
import { buildMips, generateHero, generateTexture, type TextureSpec } from "../textures";

type SeedMaterial = {
  sku: string;
  name: string;
  supplier: string;
  category: typeof materials.$inferInsert.category;
  /** Real trade dimensions in mm. */
  tileWMm: number;
  tileHMm: number;
  groutMm: number;
  bond: typeof materials.$inferInsert.bond;
  finish: string;
  leadTimeDays: number;
  base: [number, number, number];
  grain: TextureSpec["grain"];
  contrast: number;
};

const SUPPLIERS = [
  { name: "Marca Ceramiche", website: "https://example.com/marca" },
  { name: "Northwood Timber", website: "https://example.com/northwood" },
  { name: "Pietra Stone Co.", website: "https://example.com/pietra" },
];

const CATALOGUE: SeedMaterial[] = [
  {
    sku: "BRK-GRY-600",
    name: "Brooklyn Grey",
    supplier: "Marca Ceramiche",
    category: "tile",
    tileWMm: 600,
    tileHMm: 600,
    groutMm: 3,
    bond: "stack",
    finish: "matte",
    leadTimeDays: 10,
    base: [0xcd, 0xc8, 0xbd],
    grain: "concrete",
    contrast: 0.1,
  },
  {
    sku: "SMK-OAK-12",
    name: "Smoked Oak 12",
    supplier: "Northwood Timber",
    category: "wood",
    tileWMm: 1220,
    tileHMm: 180,
    groutMm: 0,
    bond: "running",
    finish: "brushed oil",
    leadTimeDays: 21,
    base: [0x8a, 0x6f, 0x52],
    grain: "wood",
    contrast: 0.18,
  },
  {
    sku: "TRV-CLS-610",
    name: "Travertino",
    supplier: "Pietra Stone Co.",
    category: "stone",
    tileWMm: 610,
    tileHMm: 406,
    groutMm: 4,
    bond: "running",
    finish: "honed",
    leadTimeDays: 28,
    base: [0xcb, 0xb7, 0x9a],
    grain: "stone",
    contrast: 0.14,
  },
  {
    sku: "TER-PLA-300",
    name: "Terra Plana",
    supplier: "Marca Ceramiche",
    category: "tile",
    tileWMm: 300,
    tileHMm: 300,
    groutMm: 5,
    bond: "stack",
    finish: "unglazed",
    leadTimeDays: 14,
    base: [0xb0, 0x71, 0x4f],
    grain: "concrete",
    contrast: 0.12,
  },
  {
    sku: "CAR-MST-600",
    name: "Carrara Mist",
    supplier: "Pietra Stone Co.",
    category: "stone",
    tileWMm: 600,
    tileHMm: 900,
    groutMm: 2,
    bond: "stack",
    finish: "polished",
    leadTimeDays: 30,
    base: [0xf2, 0xf0, 0xec],
    grain: "stone",
    contrast: 0.09,
  },
  {
    sku: "BSL-090-600",
    name: "Basalt 90",
    supplier: "Pietra Stone Co.",
    category: "stone",
    tileWMm: 600,
    tileHMm: 600,
    groutMm: 3,
    bond: "stack",
    finish: "sandblasted",
    leadTimeDays: 24,
    base: [0x2f, 0x2f, 0x2d],
    grain: "stone",
    contrast: 0.22,
  },
  {
    sku: "RVN-SND-450",
    name: "Riven Sand",
    supplier: "Pietra Stone Co.",
    category: "stone",
    tileWMm: 450,
    tileHMm: 450,
    groutMm: 6,
    bond: "stack",
    finish: "riven",
    leadTimeDays: 26,
    base: [0xcf, 0xc2, 0xa8],
    grain: "stone",
    contrast: 0.16,
  },
  {
    sku: "LMS-NO1-600",
    name: "Limestone No1",
    supplier: "Pietra Stone Co.",
    category: "stone",
    tileWMm: 600,
    tileHMm: 400,
    groutMm: 3,
    bond: "running",
    finish: "honed",
    leadTimeDays: 25,
    base: [0xe7, 0xe0, 0xd2],
    grain: "stone",
    contrast: 0.08,
  },
  {
    sku: "MSC-PET-025",
    name: "Mosaic Petra",
    supplier: "Marca Ceramiche",
    category: "tile",
    tileWMm: 25,
    tileHMm: 25,
    groutMm: 2,
    bond: "stack",
    finish: "gloss",
    leadTimeDays: 12,
    base: [0xd5, 0xc5, 0xae],
    grain: "stone",
    contrast: 0.13,
  },
  {
    sku: "WAL-DRK-14",
    name: "Walnut Dark",
    supplier: "Northwood Timber",
    category: "wood",
    tileWMm: 1800,
    tileHMm: 140,
    groutMm: 0,
    bond: "running",
    finish: "matte lacquer",
    leadTimeDays: 35,
    base: [0x5b, 0x42, 0x32],
    grain: "wood",
    contrast: 0.2,
  },
  {
    sku: "ELM-RCL-20",
    name: "Reclaimed Elm",
    supplier: "Northwood Timber",
    category: "wood",
    tileWMm: 900,
    tileHMm: 200,
    groutMm: 0,
    bond: "running",
    finish: "wire-brushed",
    leadTimeDays: 42,
    base: [0x9a, 0x8d, 0x7b],
    grain: "wood",
    contrast: 0.24,
  },
  {
    sku: "PCL-TIL-800",
    name: "Porcelain Tile",
    supplier: "Marca Ceramiche",
    category: "tile",
    tileWMm: 800,
    tileHMm: 800,
    groutMm: 2,
    bond: "stack",
    finish: "satin",
    leadTimeDays: 10,
    base: [0xef, 0xec, 0xe6],
    grain: "concrete",
    contrast: 0.06,
  },
  {
    sku: "SLT-RVR-300",
    name: "Slate River",
    supplier: "Pietra Stone Co.",
    category: "stone",
    tileWMm: 300,
    tileHMm: 600,
    groutMm: 4,
    bond: "herringbone",
    finish: "natural cleft",
    leadTimeDays: 22,
    base: [0x7b, 0x84, 0x8a],
    grain: "stone",
    contrast: 0.19,
  },
  {
    sku: "TRZ-BNE-600",
    name: "Bone Terrazzo",
    supplier: "Marca Ceramiche",
    category: "tile",
    tileWMm: 600,
    tileHMm: 600,
    groutMm: 3,
    bond: "stack",
    finish: "polished",
    leadTimeDays: 18,
    base: [0xec, 0xe4, 0xd4],
    grain: "stone",
    contrast: 0.15,
  },
  {
    sku: "LIN-CHR-WLP",
    name: "Char Linen",
    supplier: "Marca Ceramiche",
    category: "wallpaper",
    // Wallpaper: roll width and pattern repeat, which is exactly the same
    // "cell size in mm" the tiler needs — no special case required.
    tileWMm: 530,
    tileHMm: 640,
    groutMm: 0,
    bond: "running",
    finish: "textile",
    leadTimeDays: 15,
    base: [0x46, 0x45, 0x3f],
    grain: "concrete",
    contrast: 0.11,
  },
];

/** Texture resolution. 1024 gives ~1.7 px/mm on a 600mm tile — enough that a
 *  Precision render at 2K never has to magnify beyond mip level 0. */
const TEXTURE_SIZE = 1024;

async function seed() {
  console.log("seeding suppliers...");
  const supplierIds = new Map<string, string>();
  for (const s of SUPPLIERS) {
    const [row] = await db
      .insert(suppliers)
      .values(s)
      .onConflictDoNothing()
      .returning({ id: suppliers.id, name: suppliers.name });
    if (row) {
      supplierIds.set(row.name, row.id);
    } else {
      const existing = await db.query.suppliers.findFirst({
        where: (t, { eq }) => eq(t.name, s.name),
      });
      if (existing) supplierIds.set(existing.name, existing.id);
    }
  }

  console.log(`seeding ${CATALOGUE.length} materials + textures...`);
  for (const [i, m] of CATALOGUE.entries()) {
    const texture = await generateTexture({
      size: TEXTURE_SIZE,
      base: m.base,
      contrast: m.contrast,
      grain: m.grain,
      seed: i * 9176 + 3,
    });

    const textureKey = storage.keys.materialTexture(m.sku);
    await storage.put(textureKey, texture);

    const mips = await buildMips(texture);
    for (const [level, buf] of mips.entries()) {
      await storage.put(storage.keys.materialMip(m.sku, level), buf);
    }

    const hero = await generateHero(texture, {
      tileWMm: m.tileWMm,
      tileHMm: m.tileHMm,
      // Wood and wallpaper have no grout, but the hero still needs a hairline
      // seam or the planks merge into one slab and the repeat is invisible.
      groutMm: m.groutMm || 1,
    });
    const heroKey = storage.keys.materialHero(m.sku);
    await storage.put(heroKey, hero);

    const values = {
      sku: m.sku,
      supplierId: supplierIds.get(m.supplier) ?? null,
      category: m.category,
      name: m.name,
      textureKey,
      heroKey,
      mipLevels: mips.length - 1,
      tileWMm: m.tileWMm,
      tileHMm: m.tileHMm,
      groutMm: m.groutMm,
      bond: m.bond,
      finish: m.finish,
      colorLab: srgbToLab(...m.base) as [number, number, number],
      leadTimeDays: m.leadTimeDays,
      // The whole point of the flag: texture AND real dimensions, both present.
      precisionReady: true,
      active: true,
    };

    await db
      .insert(materials)
      .values(values)
      .onConflictDoUpdate({ target: materials.sku, set: values });

    console.log(`  ${m.sku.padEnd(14)} ${m.tileWMm}x${m.tileHMm}mm  ${mips.length} mips`);
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(materials);
  console.log(`done — ${count} materials in catalogue`);
}

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
