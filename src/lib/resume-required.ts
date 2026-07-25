/**
 * Resume-required policy
 * ======================
 * A resume is not optional metadata in LuminaHire — it is the input the entire
 * verification pipeline runs on. Every downstream stage depends on it:
 *
 *   - the Claims Extractor reads the resume to enumerate what the candidate
 *     claims (no resume text => no claims => nothing to verify);
 *   - the Verifier only ever visits links found in the resume, so with no
 *     resume there is nothing to check and every claim degrades to
 *     UNVERIFIABLE;
 *   - semantic job matching ranks on the resume's vector embedding, which is
 *     produced from the extracted text.
 *
 * A candidate row with no resume therefore cannot produce a meaningful vetting
 * result — it produces an empty report that looks like a failed candidate
 * rather than a missing input. This module centralizes that rule so the API
 * and UI enforce exactly the same thing.
 */

/** Minimum extracted characters for a resume to be usable. Below this, text extraction effectively failed (scanned image, empty PDF). */
export const MIN_RESUME_TEXT_LENGTH = 100;

export type ResumeBearingCandidate = {
    resumeUrl?: string | null;
    resumeText?: string | null;
};

export type ResumeCheck = {
    ok: boolean;
    reason?: string;
};

/** True when the candidate has an uploaded resume file on record. */
export function hasResumeFile(candidate: ResumeBearingCandidate | null | undefined): boolean {
    return Boolean(candidate?.resumeUrl && candidate.resumeUrl.trim());
}

/** True when the resume was successfully parsed into usable text. */
export function hasUsableResumeText(candidate: ResumeBearingCandidate | null | undefined): boolean {
    const text = candidate?.resumeText;
    return Boolean(text && text.trim().length >= MIN_RESUME_TEXT_LENGTH);
}

/**
 * Whether this candidate can be put through the vetting pipeline.
 *
 * Deliberately distinguishes "no file" from "file present but unreadable":
 * the second case is a scanned or image-only PDF, and telling the user that
 * specifically is the difference between a fixable problem and a mystery.
 */
export function canBeVetted(candidate: ResumeBearingCandidate | null | undefined): ResumeCheck {
    if (!candidate) {
        return { ok: false, reason: "No candidate profile exists." };
    }
    if (!hasResumeFile(candidate)) {
        return {
            ok: false,
            reason:
                "This candidate has no resume on file. LuminaHire verifies a resume against the candidate's own linked profiles, so a resume is required before vetting can run.",
        };
    }
    if (!hasUsableResumeText(candidate)) {
        return {
            ok: false,
            reason:
                "A resume file is uploaded but no readable text could be extracted from it (it may be a scanned image rather than a text PDF). Re-upload a text-based PDF so the resume's claims and links can be read.",
        };
    }
    return { ok: true };
}

/**
 * Whether a candidate profile save is allowed to proceed.
 *
 * `incomingResumeUrl` is what this request is setting: a string to upload or
 * replace, null to remove, undefined to leave unchanged.
 */
export function canSaveProfile(
    existing: ResumeBearingCandidate | null | undefined,
    incomingResumeUrl: string | null | undefined
): ResumeCheck {
    // Explicit removal: refused, because it would leave a profile that cannot
    // be vetted. Replacing a resume (a non-empty string) is always fine.
    if (incomingResumeUrl === null) {
        return {
            ok: false,
            reason:
                "A resume is required on every candidate profile, so it cannot be removed. Upload a replacement instead — that will delete the old file automatically.",
        };
    }
    if (incomingResumeUrl === undefined && !hasResumeFile(existing)) {
        return {
            ok: false,
            reason: "Upload your resume to save your profile. LuminaHire needs it to verify your experience against your linked profiles.",
        };
    }
    return { ok: true };
}
