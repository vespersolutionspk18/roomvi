/**
 * GET /api/materials — the catalogue for the editor sidebar.
 *
 * Serves `heroUrl` and `textureUrl` as /api/files paths. The showroom mockup's
 * 15 CSS-gradient swatches (editor.html:593-652) are replaced by these: a CSS
 * gradient cannot be projected onto a floor at true scale, so a swatch the user
 * can pick MUST correspond to a real bitmap on disk.
 *
 * `precisionReady` is surfaced per material because it decides which executor a
 * click gets — bitmap + real mm dimensions means Precision mode can do it for
 * free, anything else falls through to a paid generative render.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { materials } from "@/lib/db/schema";
import type { MaterialSummary } from "@/lib/editor/types";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const categories = url.searchParams.getAll("category").filter(Boolean);
  const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";

  const rows = await db
    .select()
    .from(materials)
    .where(
      categories.length > 0
        ? and(
            eq(materials.active, true),
            inArray(materials.category, categories as typeof materials.category.enumValues),
          )
        : eq(materials.active, true),
    )
    .orderBy(asc(materials.category), asc(materials.name));

  // Filtered in JS rather than SQL: the catalogue is small enough that an ILIKE
  // index is premature, and matching against sku AND name AND finish reads
  // clearly here.
  const filtered = q
    ? rows.filter((m) =>
        [m.name, m.sku, m.finish ?? ""].some((s) => s.toLowerCase().includes(q)),
      )
    : rows;

  const items: MaterialSummary[] = filtered.map((m) => ({
    id: m.id,
    sku: m.sku,
    name: m.name,
    category: m.category,
    finish: m.finish,
    size: m.tileWMm && m.tileHMm ? `${m.tileWMm} × ${m.tileHMm}` : null,
    tileWMm: m.tileWMm,
    tileHMm: m.tileHMm,
    leadTimeDays: m.leadTimeDays,
    heroUrl: m.heroKey ? `/api/files/${m.heroKey}` : null,
    textureUrl: m.textureKey ? `/api/files/${m.textureKey}` : null,
    precisionReady: m.precisionReady,
  }));

  return Response.json({ materials: items, total: items.length });
}
