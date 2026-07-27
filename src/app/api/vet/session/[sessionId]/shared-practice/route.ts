import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { toSharedPayload } from "@/lib/interview";

/**
 * The recruiter end of an opt-in share: a practice session the candidate chose
 * to attach to this application.
 *
 * EVERYTHING GOES THROUGH toSharedPayload(), which is an ALLOWLIST. Delivery
 * scores, presence scores, the raw metrics, the face timeline, and the
 * recording itself are structurally unable to reach this response — not
 * filtered out here, but never selected in the first place. A metric added next
 * quarter is invisible to recruiters by default, which is the correct direction
 * for this to fail.
 *
 * A revoked share reads as no share at all.
 */
export async function GET(
    _req: Request,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { sessionId } = await params;

        const vettingSession = await prisma.vettingSession.findUnique({
            where: { id: sessionId },
            select: { applicationId: true, application: { select: { job: { select: { recruiterId: true } } } } },
        });
        if (!vettingSession) return new NextResponse("Session not found", { status: 404 });
        if (vettingSession.application.job.recruiterId !== session.user.id) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        const share = await prisma.mockInterviewShare.findFirst({
            where: { applicationId: vettingSession.applicationId, revokedAt: null },
            include: {
                mockInterview: {
                    include: {
                        answers: {
                            where: { isFinal: true },
                            include: { question: true },
                            orderBy: { createdAt: "asc" },
                        },
                    },
                },
            },
        });

        if (!share) return NextResponse.json({ shared: null });

        return NextResponse.json({
            shared: toSharedPayload(share.mockInterview),
            sharedAt: share.sharedAt,
            // Stated plainly so a recruiter doesn't mistake a partial view for
            // the whole picture, or read the absence of delivery scores as the
            // candidate having done badly on them.
            note:
                "The candidate chose to share this. It covers what they said and how well it answered the " +
                "question. Scores for delivery and presentation are theirs alone and were not shared.",
        });
    } catch (error: any) {
        console.error("Error reading shared practice:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
