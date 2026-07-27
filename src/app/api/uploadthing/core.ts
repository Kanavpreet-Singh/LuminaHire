import { createUploadthing, type FileRouter } from "uploadthing/next";
import { UploadThingError } from "uploadthing/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

const f = createUploadthing();

// FileRouter for your app, can contain multiple FileRoutes
export const ourFileRouter = {
  // Define as many FileRoutes as you like, each with a unique routeSlug
  resumeUploader: f({ pdf: { maxFileSize: "4MB", maxFileCount: 1 } })
    // Set permissions and file types for this FileRoute
    .middleware(async ({ req }) => {
      // This code runs on your server before upload
      // Here you could verify the user is logged in, but for candidate signup it's public
      return { };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // This code RUNS ON YOUR SERVER after upload
      console.log("File upload complete!");
      console.log("File URL:", file.url);
      
      // Whatever is returned here is sent to the clientside `onClientUploadComplete` callback
      return { url: file.url };
    }),

  /**
   * Practice-interview recordings.
   *
   * UNLIKE resumeUploader ABOVE, THIS MIDDLEWARE AUTHENTICATES. The resume
   * route is deliberately public because a resume is attached during candidate
   * signup, before a session exists. Inheriting that pattern here would put an
   * unauthenticated media-upload endpoint on a public host — an open bucket
   * with a URL. A recording is also personal in a way a submitted resume is
   * not, so it is tied to a candidate at upload time.
   */
  mockVideoUploader: f({
    video: { maxFileSize: "128MB", maxFileCount: 1 },
    audio: { maxFileSize: "32MB", maxFileCount: 1 },
  })
    .middleware(async () => {
      const session = await auth();
      if (!session?.user || (session.user as any).role !== "CANDIDATE") {
        throw new UploadThingError("Sign in as a candidate to upload a recording.");
      }
      const candidate = await prisma.candidate.findUnique({
        where: { userId: session.user.id! },
        select: { id: true },
      });
      if (!candidate) {
        throw new UploadThingError("Complete your candidate profile first.");
      }
      return { candidateId: candidate.id };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // The row is created by POST /api/mock/[mockId]/answer, which also
      // dispatches analysis. Returning the key lets that route store
      // mediaPublicId for the retention sweep to delete against later.
      return { url: file.url, key: file.key, candidateId: metadata.candidateId };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
