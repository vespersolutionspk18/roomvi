/**
 * GET /api/files/<key> — serve a file from storage.
 *
 * Storage lives outside `public/` so that access is mediated here rather than by
 * the static file server. Two things this route must get right:
 *
 *  1. Path traversal. `lib/storage.ts` validates the key, but the segments
 *     arriving from a catch-all route are already URL-decoded by Next, so
 *     `%2e%2e` has become `..` by the time we see it. The key is rebuilt by
 *     joining with "/" and handed to storage, which rejects anything escaping
 *     the root. Never construct a path here.
 *
 *  2. Caching. Every key in `lib/storage.keys` is content-addressed by a nanoid
 *     that never gets a second version — a render output or mask under a given
 *     id is immutable — so `immutable` is honest and turns repeat views of the
 *     editor into zero requests.
 */
import { stat } from "node:fs/promises";
import * as storage from "@/lib/storage";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  json: "application/json",
};

export async function GET(request: Request, ctx: RouteContext<"/api/files/[...key]">) {
  const { key: segments } = await ctx.params;
  const key = segments.join("/");

  let abs: string;
  try {
    abs = storage.absolutePath(key);
  } catch {
    // storage.assertSafeKey rejected it. Say nothing about why.
    return new Response("Not found", { status: 404 });
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  // Weak validator from size + mtime: cheap, and sufficient because these files
  // are write-once. Hashing contents on every request would not buy anything.
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const headers = new Headers({
    "Content-Type": contentType,
    ETag: etag,
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Length": String(info.size),
    // Storage holds user photos; never let a crafted upload be sniffed into a
    // script or rendered as a document in the user's origin.
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  });

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  // Range support so the browser can seek, and so a large original doesn't have
  // to be buffered whole to satisfy a partial request.
  const range = parseRange(request.headers.get("range"), info.size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${info.size}`, ETag: etag },
    });
  }

  headers.set("Accept-Ranges", "bytes");

  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(toWebStream(storage.stream(key, range)), { status: 206, headers });
  }

  return new Response(toWebStream(storage.stream(key)), { status: 200, headers });
}

export const HEAD = GET;

type Range = { start: number; end: number };

/** Single-range `bytes=` only; multipart ranges are not worth supporting here. */
function parseRange(header: string | null, size: number): Range | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";

  const [, rawStart, rawEnd] = m;
  let start: number;
  let end: number;

  if (rawStart === "") {
    if (rawEnd === "") return "invalid";
    // Suffix form: the last N bytes.
    const n = Number(rawEnd);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start > end || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

/** Node ReadStream -> web ReadableStream, aborting the read if the client leaves. */
function toWebStream(nodeStream: NodeJS.ReadableStream & { destroy(): void }) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        controller.enqueue(chunk as Uint8Array);
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

// Reading from disk per-request; nothing here is prerenderable.
export const dynamic = "force-dynamic";
