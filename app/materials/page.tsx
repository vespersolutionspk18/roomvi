/**
 * Materials — the public library. Server page reads the catalogue once; the
 * browser component owns the filtering.
 */
import { eq } from "drizzle-orm";
import { AppHeader } from "@/components/site/AppHeader";
import { MaterialBrowser, type CatalogueItem } from "@/components/site/MaterialBrowser";
import { db } from "@/lib/db";
import { materials, suppliers } from "@/lib/db/schema";
import { resolveUser } from "@/lib/session";

export default async function MaterialsPage() {
  const user = await resolveUser();

  const rows = await db
    .select({
      id: materials.id,
      name: materials.name,
      category: materials.category,
      finish: materials.finish,
      tileWMm: materials.tileWMm,
      tileHMm: materials.tileHMm,
      leadTimeDays: materials.leadTimeDays,
      heroKey: materials.heroKey,
      precisionReady: materials.precisionReady,
      supplier: suppliers.name,
    })
    .from(materials)
    .leftJoin(suppliers, eq(materials.supplierId, suppliers.id))
    .where(eq(materials.active, true))
    .orderBy(materials.name);

  const items: CatalogueItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    finish: r.finish,
    tileWMm: r.tileWMm,
    tileHMm: r.tileHMm,
    leadTimeDays: r.leadTimeDays,
    heroKey: r.heroKey,
    precisionReady: r.precisionReady,
    supplier: r.supplier,
  }));

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader credits={user.credits} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 pb-16 pt-10">
        <div className="mb-8 max-w-2xl">
          <h1 className="font-display text-[30px] font-[560] leading-[1.1] tracking-[-.015em] text-ink">
            The material library
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            Every entry carries its real trade dimensions and a seamless bitmap, so what
            you see in the editor is what the supplier delivers. The dot marks materials
            that render at true scale for free.
          </p>
        </div>

        <MaterialBrowser items={items} />
      </main>
    </div>
  );
}
