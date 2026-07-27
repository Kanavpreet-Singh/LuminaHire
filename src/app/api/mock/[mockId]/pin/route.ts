import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

/**
 * Keep a session's recordings past the retention window, or let them expire.
 *
 * Recordings default to a 30-day life so a practice tool doesn't quietly become
 * a permanent archive of people's faces. Pinning is the candidate's own
 * override — `expiresAt: null` means the sweep leaves it alone.
 */
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
        const { pinned } = await req.json().catch(() => ({ pinned: true }));

        const candidate = await prisma.candidate.findUnique({
            where: { userId: session.user.id! },
            select: { id: true },
        });
        if (!candidate) return new NextResponse("No candidate profile", { status: 404 });

        const mock = await prisma.mockInterview.findUnique({
            where: { id: mockId },
            select: { candidateId: true },
        });
        if (!mock) return new NextResponse("Session not found", { status: 404 });
        if (mock.candidateId !== candidate.id) return new NextResponse("Forbidden", { status: 403 });

        const updated = await prisma.mockAnswer.updateMany({
            where: { mockInterviewId: mockId, mediaUrl: { not: null } },
            data: {
                expiresAt: pinned
                    ? null
                    : new Date(Date.now() + RETENTION_DAYS * 86_400_000),
            },
        });

        return NextResponse.json({ pinned: !!pinned, recordings: updated.count });
    } catch (error: any) {
        console.error("Error pinning mock interview:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

const RETENTION_DAYS = Number(process.env.MOCK_MEDIA_RETENTION_DAYS || 30);
