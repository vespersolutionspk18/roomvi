/**
 * Storage abstraction.
 *
 * Everything the app writes (uploads, masks, renders, material textures) goes
 * through here. The local-disk implementation keeps files OUTSIDE `public/` so
 * they stay access-controlled and are served via app/api/files/[...key]/route.ts.
 *
 * Swapping to S3/R2 later means reimplementing this one module — no call sites
 * change. Keys are POSIX-style paths ("images/abc123/original.jpg") regardless
 * of platform; only `absolutePath` touches the OS separator.
 */
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? "./storage");

/** Reject keys that would escape the storage root. */
function assertSafeKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
  const resolved = path.resolve(ROOT, key);
  const rel = path.relative(ROOT, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Storage key escapes root: ${JSON.stringify(key)}`);
  }
}

/** Absolute on-disk path for a key. Use only where a real path is required. */
export function absolutePath(key: string): string {
  assertSafeKey(key);
  return path.resolve(ROOT, key);
}

export async function put(key: string, data: Buffer | Uint8Array): Promise<string> {
  const abs = absolutePath(key);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return key;
}

export async function get(key: string): Promise<Buffer> {
  return readFile(absolutePath(key));
}

export async function exists(key: string): Promise<boolean> {
  try {
    await stat(absolutePath(key));
    return true;
  } catch {
    return false;
  }
}

export async function size(key: string): Promise<number> {
  return (await stat(absolutePath(key))).size;
}

/** Stream a file for HTTP responses, avoiding a full read into memory. */
export function stream(key: string, range?: { start: number; end: number }): ReadStream {
  return createReadStream(absolutePath(key), range);
}

export async function remove(key: string): Promise<void> {
  try {
    await unlink(absolutePath(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/* ---- key builders: the single source of truth for storage layout ---- */

export const keys = {
  imageOriginal: (imageId: string, ext: string) => `images/${imageId}/original.${ext}`,
  imageDisplay: (imageId: string) => `images/${imageId}/display.jpg`,
  surfaceMask: (surfaceId: string) => `masks/${surfaceId}.png`,
  renderOutput: (renderId: string) => `renders/${renderId}.jpg`,
  materialTexture: (sku: string) => `materials/${sku}/tile.png`,
  /** Mip level 0 is the base texture; level N is base >> N. */
  materialMip: (sku: string, level: number) => `materials/${sku}/mip-${level}.png`,
  materialHero: (sku: string) => `materials/${sku}/hero.jpg`,
} as const;
