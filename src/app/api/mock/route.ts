import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getOrCreatePublishedPracticeSet, ensurePersonalQuestionRow } from "@/lib/interview";

/**
 * Start a mock interview attempt, and list the candidate's past attempts.
 *
 * Attempts are candidate-owned throughout. Nothing here is visible to a
 * recruiter unless the candidate later opts in via /api/mock/[mockId]/share,
 * and even then only content scores travel (see toSharedPayload).
 */

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "CANDIDATE") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const candidate = await prisma.candidate.findUnique({
            where: { userId: session.user.id! },
            select: { id: true },
        });
        if (!candidate) return NextResponse.json({ interviews: [] });

        const interviews = await prisma.mockInterview.findMany({
            where: { candidateId: candidate.id },
            orderBy: { startedAt: "desc" },
            take: 50,
            include: {
                job: { select: { id: true, title: true } },
                _count: { select: { answers: true } },
            },
            omit: { coaching: true },   // the list doesn't render it; don't ship it
        });

        return NextResponse.json({ interviews });
    } catch (error: any) {
        console.error("Error listing mock interviews:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "CANDIDATE") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const jobId = typeof body.jobId === "string" ? body.jobId : "";
        if (!jobId) return new NextResponse("Missing jobId", { status: 400 });

        const mode = MODES.has(body.mode) ? body.mode : "TEXT";
        const accessibilityMode = body.accessibilityMode === true;

        const candidate = await prisma.candidate.findUnique({
            where: { userId: session.user.id! },
        });
        if (!candidate) {
            return new NextResponse(
                "Complete your candidate profile before starting a practice session.",
                { status: 409 }
            );
        }

        const job = await prisma.jobPosting.findUnique({ where: { id: jobId }, select: { id: true } });
        if (!job) return new NextResponse("Job not found", { status: 404 });

        const set = await getOrCreatePublishedPracticeSet(jobId, candidate.id);
        // Their own résumé question, answerable alongside the job's questions.
        await ensurePersonalQuestionRow(set.id, candidate);

        const created = await prisma.mockInterview.create({
            data: {
                candidateId: candidate.id,
                jobId,
                practiceSetId: set.id,
                mode,
                accessibilityMode,
                status: "IN_PROGRESS",
            },
        });

        const mock = await prisma.mockInterview.findUnique({
            where: { id: created.id },
            include: {
                job: { select: { id: true, title: true } },
                practiceSet: {
                    include: {
                        // Shared questions plus this candidate's own. Never
                        // another candidate's résumé-derived question.
                        questions: {
                            where: { OR: [{ candidateId: null }, { candidateId: candidate.id }] },
                            orderBy: { order: "asc" },
                        },
                    },
                },
            },
        });

        return NextResponse.json({ mockInterview: mock });
    } catch (error: any) {
        console.error("Error starting mock interview:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

const MODES = new Set(["VIDEO", "AUDIO", "TEXT"]);
