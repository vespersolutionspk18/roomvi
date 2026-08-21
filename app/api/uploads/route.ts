/**
 * POST /api/uploads — accept a room photo.
 *
 * Multipart FormData is read via the Web `Request.formData()` that Next 16 route
 * handlers expose. This buffers the file in memory, which is why MAX_UPLOAD_BYTES
 * is enforced from Content-Length BEFORE the body is read — otherwise a 2GB POST
 * is buffered first and rejected second.
 *
 * A `reject` verdict from the quality gate still stores the image. The user gets
 * the warnings and can decide; refusing to store it means they lose the upload
 * and re-send the same bytes. What `reject` gates is the *render* button, not the
 * upload.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { images, projects } from "@/lib/db/schema";
import {
  ACCEPTED_MIME,
  MAX_UPLOAD_BYTES,
  UploadError,
  assessQuality,
  prepareUpload,
} from "@/lib/image";
import * as storage from "@/lib/storage";

export async function POST(request: Request) {
  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES) {
      throw new UploadError(
        "too_large",
        `Photo is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`,
        413,
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    const projectId = form.get("projectId");

    if (!(file instanceof File)) {
      throw new UploadError("no_file", "No file was uploaded.");
    }
    if (typeof projectId !== "string" || !projectId) {
      throw new UploadError("no_project", "Missing projectId.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new UploadError("too_large", "Photo is too large.", 413);
    }
    if (!ACCEPTED_MIME.has(file.type)) {
      throw new UploadError(
        "bad_type",
        `Unsupported format ${file.type || "(unknown)"}. Use JPEG, PNG, WebP or HEIC.`,
        415,
      );
    }

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) {
      throw new UploadError("no_project", "Project not found.", 404);
    }

    const raw = Buffer.from(await file.arrayBuffer());
    const sha256 = createHash("sha256").update(raw).digest("hex");

    // Dedupe within the project: the same photo re-uploaded returns the existing
    // row rather than a second copy on disk with a second set of masks.
    const existing = await db.query.images.findFirst({
      where: and(eq(images.projectId, projectId), eq(images.sha256, sha256)),
    });
    if (existing) {
      return Response.json({ image: publicImage(existing), deduped: true });
    }

    const prepared = await prepareUpload(raw);
    const quality = await assessQuality({ image: prepared.display });

    // Insert first to get the id the storage keys are built from, then write the
    // files. A crash between the two leaves a row pointing at missing files,
    // which the analyze job reports cleanly; the reverse (orphan files with no
    // row) would be invisible garbage.
    const [row] = await db
      .insert(images)
      .values({
        projectId,
        // Placeholder keys, rewritten below once the id exists.
        storageKey: "",
        width: prepared.width,
        height: prepared.height,
        displayWidth: prepared.displayWidth,
        displayHeight: prepared.displayHeight,
        sha256,
        mimeType: prepared.originalMime,
        byteSize: prepared.original.byteLength,
        exif: prepared.exif,
        quality,
      })
      .returning();

    const storageKey = storage.keys.imageOriginal(row.id, prepared.originalExt);
    const displayKey = storage.keys.imageDisplay(row.id);

    await storage.put(storageKey, prepared.original);
    await storage.put(displayKey, prepared.display);

    const [updated] = await db
      .update(images)
      .set({ storageKey, displayKey })
      .where(eq(images.id, row.id))
      .returning();

    return Response.json({ image: publicImage(updated), deduped: false }, { status: 201 });
  } catch (err) {
    if (err instanceof UploadError) {
      return Response.json({ error: { code: err.code, message: err.message } }, {
        status: err.status,
      });
    }
    console.error("[uploads] unexpected", err);
    return Response.json(
      { error: { code: "internal", message: "Upload failed." } },
      { status: 500 },
    );
  }
}

/** Never leak storage keys to the client — hand out the served URL instead. */
function publicImage(row: typeof images.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    width: row.width,
    height: row.height,
    displayWidth: row.displayWidth,
    displayHeight: row.displayHeight,
    quality: row.quality,
    url: row.displayKey ? `/api/files/${row.displayKey}` : null,
    originalUrl: row.storageKey ? `/api/files/${row.storageKey}` : null,
    createdAt: row.createdAt,
  };
}
