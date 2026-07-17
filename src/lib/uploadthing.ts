import { UTApi } from "uploadthing/server";

const utapi = new UTApi();

function extractUploadThingFileKey(fileUrl: string): string | null {
    try {
        const url = new URL(fileUrl);

        // Common UploadThing URL shape: https://utfs.io/f/<fileKey>
        const fSegmentMatch = url.pathname.match(/\/f\/([^/?#]+)/);
        if (fSegmentMatch?.[1]) {
            return fSegmentMatch[1];
        }

        // Fallback: treat the last path segment as file key.
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length === 0) {
            return null;
        }

        return segments[segments.length - 1];
    } catch {
        return null;
    }
}

export async function deleteUploadThingFileByUrl(fileUrl: string | null | undefined): Promise<void> {
    if (!fileUrl) {
        return;
    }

    if (!/utfs\.io|uploadthing/i.test(fileUrl)) {
        return;
    }

    const fileKey = extractUploadThingFileKey(fileUrl);
    if (!fileKey) {
        return;
    }

    await utapi.deleteFiles(fileKey);
}
