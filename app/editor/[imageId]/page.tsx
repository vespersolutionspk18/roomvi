/**
 * /editor/[imageId] — the editor.
 *
 * A server component that verifies the image exists before mounting the client
 * shell, so a bad id is a 404 page rather than a client-side fetch failure
 * rendered inside a working chrome.
 */
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Editor } from "@/components/editor/Editor";
import { db } from "@/lib/db";
import { images } from "@/lib/db/schema";

export default async function EditorPage(props: PageProps<"/editor/[imageId]">) {
  const { imageId } = await props.params;

  const image = await db.query.images.findFirst({ where: eq(images.id, imageId) });
  if (!image) notFound();

  return (
    <>
      <Editor imageId={image.id} />
    </>
  );
}
