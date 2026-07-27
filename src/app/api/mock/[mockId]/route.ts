import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { pollThroughMediaAnalyses } from "@/lib/interview";

/** Read or delete one mock interview attempt. Candidate-owned throughout. */

async function loadOwned(mockId: string, userId: string) {
    const candidate = await prisma.candidate.findUnique({
        where: { userId },
        select: { id: true },
    });
    if (!candidate) return { error: new NextResponse("No candidate profile", { status: 404 }) };

    const mock = await prisma.mockInterview.findUnique({
        where: { id: mockId },
        include: {
            job: { select: { id: true, title: true } },
            practiceSet: {
                include: {
                    // Shared questions plus this candidate's own PERSONAL one.
                    // Unscoped, this would hand every other applicant's
                    // résumé-derived question to whoever opened the page.
                    questions: {
                        where: { OR: [{ candidateId: null }, { candidateId: candidate.id }] },
                        orderBy: { order: "asc" },
                    },
                },
            },
            answers: { include: { question: true }, orderBy: { createdAt: "asc" } },
            share: true,
        },
    });
    if (!mock) return { error: new NextResponse("Mock interview not found", { status: 404 }) };
    if (mock.candidateId !== candidate.id) {
        return { error: new NextResponse("Forbidden", { status: 403 }) };
    }
    return { mock };
}

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
        let { mock, error } = await loadOwned(mockId, session.user.id!);
        if (error) return error;

        // Advance any in-flight media analyses on read. There is no queue and no
        // callback channel in this deployment, so a page load is what moves the
        // state machine forward — same poll-through pattern as vetting sessions.
        if (mock!.answers.some((a) => a.status === "ANALYZING")) {
            const changed = await pollThroughMediaAnalyses(mockId, mock!.job.title);
            if (changed) {
                const reloaded = await loadOwned(mockId, session.user.id!);
                if (reloaded.mock) mock = reloaded.mock;
            }
        }

        // Their own history on this job, so the results view can show a trend.
        // This is the ONLY comparison the product makes: a candidate against
        // their own past attempts. There is no cohort percentile and no
        // leaderboard, because a percentile on these metrics is a percentile on
        // accent, home acoustics, and webcam quality.
        const history = await prisma.mockInterview.findMany({
            where: {
                candidateId: mock!.candidateId,
                jobId: mock!.jobId,
                status: "COMPLETED",
                id: { not: mock!.id },
            },
            orderBy: { completedAt: "desc" },
            take: 5,
            select: { id: true, overallScore: true, dimensionScores: true, completedAt: true },
        });

        // Their own applications, for the share dialog's target list. Sharing is
        // only ever onto an application the candidate themselves holds.
        const applications = await prisma.application.findMany({
            where: { candidateId: mock!.candidateId },
            select: {
                id: true,
                job: { select: { title: true, recruiter: { select: { companyName: true } } } },
            },
            orderBy: { createdAt: "desc" },
        });

        return NextResponse.json({
            mockInterview: mock,
            history,
            applications: applications.map((a) => ({
                id: a.id,
                jobTitle: a.job.title,
                companyName: a.job.recruiter.companyName || "—",
            })),
        });
    } catch (error: any) {
        console.error("Error reading mock interview:", error);
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
        const { mock, error } = await loadOwned(mockId, session.user.id!);
        if (error) return error;

        // Media blobs are deleted by the retention sweep via mediaPublicId; the
        // rows cascade from here. Phase 3 wires the blob deletion in — until
        // then no attempt has media to orphan.
        await prisma.mockInterview.delete({ where: { id: mock!.id } });
        return NextResponse.json({ deleted: true });
    } catch (error: any) {
        console.error("Error deleting mock interview:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
