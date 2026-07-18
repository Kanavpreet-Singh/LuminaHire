import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

/**
 * Send an evaluation back for more research. No Python call needed:
 * research_results are already persisted, so this just flips status back to
 * AWAITING_RESEARCH_INPUT so the recruiter can use the follow-up prompt box
 * again before re-approving into evaluation.
 */
export async function POST(
    req: Request,
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
            include: { application: { include: { candidate: true, job: true } } },
        });

        if (!vettingSession) {
            return new NextResponse("Vetting session not found", { status: 404 });
        }
        if (vettingSession.application.job.recruiterId !== session.user.id) {
            return new NextResponse("Forbidden", { status: 403 });
        }
        if (vettingSession.status !== "AWAITING_EVALUATION_APPROVAL") {
            return new NextResponse(
                `Session is not awaiting evaluation approval (status: ${vettingSession.status})`,
                { status: 409 }
            );
        }

        const updated = await prisma.vettingSession.update({
            where: { id: sessionId },
            data: {
                status: "AWAITING_RESEARCH_INPUT",
                evaluation: Prisma.JsonNull,
            },
            include: { application: { include: { candidate: true, job: true } } },
        });

        return NextResponse.json({ vettingSession: updated });
    } catch (error: any) {
        console.error("Error requesting more research:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
