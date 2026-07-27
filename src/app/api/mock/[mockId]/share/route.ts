import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { toSharedPayload } from "@/lib/interview";

/**
 * Opt-in sharing of a completed mock interview onto one of the candidate's own
 * applications, and revocation of same.
 *
 * SCOPE IS CONTENT_ONLY, ENFORCED TWICE: once by the enum on the row, and once
 * by toSharedPayload(), which is an allowlist over content scores and the
 * answer text. Delivery and presence scores, the raw metrics, the face
 * timeline, and every delivery/presence coaching item never cross this
 * boundary — they correlate with accent, speech disabilities, and equipment
 * quality, which makes them coaching signal and not hiring signal.
 *
 * The recording itself is never shared here either. That would be a separate,
 * explicit toggle.
 */

async function loadOwnedCompleted(mockId: string, userId: string) {
    const candidate = await prisma.candidate.findUnique({
        where: { userId },
        select: { id: true },
    });
    if (!candidate) return { error: new NextResponse("No candidate profile", { status: 404 }) };

    const mock = await prisma.mockInterview.findUnique({
        where: { id: mockId },
        include: { share: true },
    });
    if (!mock) return { error: new NextResponse("Mock interview not found", { status: 404 }) };
    if (mock.candidateId !== candidate.id) {
        return { error: new NextResponse("Forbidden", { status: 403 }) };
    }
    return { mock, candidateId: candidate.id };
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ mockId: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "CANDIDATE") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { mockId } = await params;
        const body = await req.json().catch(() => ({}));
        const applicationId = typeof body.applicationId === "string" ? body.applicationId : "";
        if (!applicationId) return new NextResponse("Missing applicationId", { status: 400 });

        const { mock, candidateId, error } = await loadOwnedCompleted(mockId, session.user.id!);
        if (error) return error;

        if (mock!.status !== "COMPLETED") {
            return new NextResponse("Finish the session before sharing it.", { status: 409 });
        }

        // The application must be the candidate's own. Without this a candidate
        // could attach their results to a stranger's application.
        const application = await prisma.application.findUnique({
            where: { id: applicationId },
            select: { id: true, candidateId: true },
        });
        if (!application || application.candidateId !== candidateId) {
            return new NextResponse("Application not found", { status: 404 });
        }

        const share = await prisma.mockInterviewShare.upsert({
            where: { mockInterviewId: mockId },
            create: { mockInterviewId: mockId, applicationId, scope: "CONTENT_ONLY" },
            // Re-sharing a previously revoked attempt clears revokedAt and
            // re-points it, rather than failing on the unique constraint.
            update: { applicationId, revokedAt: null, sharedAt: new Date() },
        });

        return NextResponse.json({ share, sharedFields: SHARED_FIELDS_NOTICE });
    } catch (error: any) {
        console.error("Error sharing mock interview:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ mockId: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "CANDIDATE") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { mockId } = await params;
        const { mock, error } = await loadOwnedCompleted(mockId, session.user.id!);
        if (error) return error;
        if (!mock!.share) return NextResponse.json({ revoked: true });

        await prisma.mockInterviewShare.update({
            where: { mockInterviewId: mockId },
            data: { revokedAt: new Date() },
        });
        return NextResponse.json({ revoked: true });
    } catch (error: any) {
        console.error("Error revoking mock interview share:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

/**
 * Preview exactly what a recruiter would see. Shown in the share dialog BEFORE
 * the candidate confirms — consent to share is not meaningful if you can't see
 * what you're sharing.
 */
export async function GET(
    _req: Request,
    { params }: { params: Promise<{ mockId: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "CANDIDATE") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { mockId } = await params;
        const candidate = await prisma.candidate.findUnique({
            where: { userId: session.user.id! },
            select: { id: true },
        });
        if (!candidate) return new NextResponse("No candidate profile", { status: 404 });

        const mock = await prisma.mockInterview.findUnique({
            where: { id: mockId },
            include: {
                answers: {
                    where: { isFinal: true },
                    include: { question: true },
                    orderBy: { createdAt: "asc" },
                },
                share: true,
            },
        });
        if (!mock) return new NextResponse("Mock interview not found", { status: 404 });
        if (mock.candidateId !== candidate.id) return new NextResponse("Forbidden", { status: 403 });

        return NextResponse.json({
            preview: toSharedPayload(mock),
            share: mock.share,
            notice: SHARED_FIELDS_NOTICE,
        });
    } catch (error: any) {
        console.error("Error previewing share payload:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

const SHARED_FIELDS_NOTICE = {
    shared: [
        "Your content and language scores",
        "What you said, per question",
        "The content feedback on each answer",
    ],
    notShared: [
        "Your delivery and presence scores",
        "Every speaking measurement — pace, pauses, volume, camera",
        "Your recordings",
    ],
};
