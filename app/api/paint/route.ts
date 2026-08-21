/**
 * POST /api/paint — store a hand-painted region mask.
 *
 * The client rasterizes its strokes to a PNG (white = where the change may
 * land) at the DISPLAY dimensions and uploads the blob; this route validates it
 * against the photo, stores it, and hands back the key that a render op can
 * reference. No DB row: a paint mask is an input, not an asset — it lives
 * exactly as long as the renders that used it.
 */
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { db } from "@/lib/db";
import { images, projects } from "@/lib/db/schema";
import { resolveUser } from "@/lib/session";
import * as storage from "@/lib/storage";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const user = await resolveUser();

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const imageId = form?.get("imageId");
  if (!(file instanceof File) || typeof imageId !== "string") {
    return Response.json(
      { error: { code: "invalid", message: "A mask image and imageId are required." } },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: { code: "too_large", message: "Mask is too large." } },
      { status: 413 },
    );
  }

  // Scoped to the owner via image -> project -> user, so a known imageId cannot
  // be used by another account to park bytes in storage.
  const image = await db.query.images.findFirst({ where: eq(images.id, imageId) });
  if (!image) {
    return Response.json(
      { error: { code: "not_found", message: "No such image." } },
      { status: 404 },
    );
  }
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, image.projectId),
  });
  if (!project || project.userId !== user.id) {
    return Response.json(
      { error: { code: "forbidden", message: "That photo is not yours." } },
      { status: 403 },
    );
  }

  if (!image.displayWidth || !image.displayHeight) {
    return Response.json(
      { error: { code: "not_ready", message: "That photo has no display copy yet." } },
      { status: 409 },
    );
  }

  // A mask that does not line up with the display copy would composite garbage;
  // the dimension check is the whole validation that matters.
  let meta;
  try {
    meta = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
  } catch {
    return Response.json(
      { error: { code: "undecodable", message: "That mask is not a readable PNG." } },
      { status: 415 },
    );
  }
  if (meta.width !== image.displayWidth || meta.height !== image.displayHeight) {
    return Response.json(
      {
        error: {
          code: "size_mismatch",
          message: `The mask must be ${image.displayWidth}x${image.displayHeight}.`,
        },
      },
      { status: 409 },
    );
  }

  const key = `masks/paint-${nanoid()}.png`;
  await storage.put(key, Buffer.from(await file.arrayBuffer()));

  return Response.json({ key }, { status: 201 });
}
