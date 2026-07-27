import {
  generateUploadButton,
  generateUploadDropzone,
  generateReactHelpers,
} from "@uploadthing/react";

import type { OurFileRouter } from "../app/api/uploadthing/core";

export const UploadButton = generateUploadButton<OurFileRouter>();
export const UploadDropzone = generateUploadDropzone<OurFileRouter>();

// Programmatic upload, used by the practice recorder: a take comes out of
// MediaRecorder as an in-memory Blob, so there is no file input to hang a
// button off. `useUploadThing` also exposes upload progress, which matters when
// a candidate is waiting on a 40MB video before they can see their score.
export const { useUploadThing } = generateReactHelpers<OurFileRouter>();
