/**
 * POST /api/references — store a user-supplied reference image.
 *
 * References are the "make it look like this" inputs for the AI editor: a photo
 * of a cupboard the user likes, a material sample, a colour plate. They are NOT
 * room photos and deliberately get no `images` row — no analyze, no project
 * attribution, no editor listing. Just bytes in storage and a key the render
 * route can validate against.
 *
 * The bytes are normalised through sharp (cap dimension, re-encode JPEG) so a
 * 40MB phone photo does not travel to fal as-is: fal charges nothing for input
 * size, but upload time is worker lease time.
 */
import { nanoid } from "nanoid";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { resolveUser } from "@/lib/session";
import * as storage from "@/lib/storage";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_EDGE = 2048;

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { error: { code: "no_file", message: "Attach a reference image." } },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: { code: "too_large", message: "References are limited to 32MB." } },
      { status: 413 },
    );
  }
  if (file.type && !ALLOWED.has(file.type)) {
    return Response.json(
      { error: { code: "bad_type", message: "Use a JPEG, PNG, WebP or HEIC image." } },
      { status: 415 },
    );
  }

  const raw = Buffer.from(await file.arrayBuffer());

  // A reference that sharp cannot decode will not be decodable by fal either —
  // reject here rather than dead-lettering a paid render later.
  let normalized: Buffer;
  try {
    normalized = await sharp(raw)
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return Response.json(
      { error: { code: "undecodable", message: "That file is not a readable image." } },
      { status: 415 },
    );
  }

  // Ownership: the reference must be attributed to one of the caller's projects,
  // so the endpoint cannot be used as an anonymous storage bucket. The key is
  // the only thing renders consume; no images row is created.
  const projectId = form?.get("projectId");
  if (typeof projectId !== "string") {
    return Response.json(
      { error: { code: "no_project", message: "A project id is required." } },
      { status: 400 },
    );
  }
  const user = await resolveUser();
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.userId, user.id)),
  });
  if (!project) {
    return Response.json(
      { error: { code: "not_found", message: "No such project." } },
      { status: 404 },
    );
  }

  const key = `refs/${nanoid()}.jpg`;
  await storage.put(key, normalized);

  return Response.json(
    {
      reference: {
        key,
        url: `/api/files/${key}`,
        width: Math.min(MAX_EDGE, (await sharp(normalized).metadata()).width ?? MAX_EDGE),
      },
    },
    { status: 201 },
  );
}
