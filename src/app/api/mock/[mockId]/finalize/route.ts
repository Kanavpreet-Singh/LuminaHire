import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { callPython, mergeUsage } from "@/lib/interview";
import { aggregateDimensions } from "@/lib/mock-score";

/**
 * Close out a session: aggregate the per-answer scores and run one cross-answer
 * coaching pass for the patterns a single answer can't reveal.
 *
 * This is the second and last LLM call of an entire session — everything else
 * is per-answer.
 */
export async function POST(
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
                job: { select: { title: true } },
                answers: {
                    where: { isFinal: true, status: "ANALYZED" },
                    include: { question: true },
                    orderBy: { createdAt: "asc" },
                },
            },
        });
        if (!mock) return new NextResponse("Mock interview not found", { status: 404 });
        if (mock.candidateId !== candidate.id) return new NextResponse("Forbidden", { status: 403 });
        if (mock.answers.length === 0) {
            return new NextResponse("Answer at least one question before finishing.", { status: 409 });
        }

        // Their previous completed session on this job, for the only comparison
        // this product makes: the candidate against their own history.
        const previous = await prisma.mockInterview.findFirst({
            where: {
                candidateId: candidate.id,
                jobId: mock.jobId,
                status: "COMPLETED",
                id: { not: mock.id },
            },
            orderBy: { completedAt: "desc" },
            select: { overallScore: true },
        });

        const { overall, dimensions } = aggregateDimensions(
            mock.answers.map((a) => ({
                score: a.score,
                scores: ((a.analysis as any)?.scores ?? {}) as Record<string, number>,
            }))
        );

        let coaching: Record<string, unknown> = {};
        let usage: unknown = null;
        try {
            const result = await callPython("/mock/finalize", {
                mock_interview_id: mockId,
                job_title: mock.job.title,
                previous_overall: previous?.overallScore ?? null,
                answers: mock.answers.map((a) => ({
                    question_prompt: a.question.prompt,
                    category: a.question.category,
                    score: a.score,
                    content_feedback: (a.analysis as any)?.coaching?.content_feedback ?? {},
                })),
            });
            usage = result.usage ?? null;
            delete result.usage;
            coaching = result;
        } catch (error: any) {
            // Per-answer coaching is already persisted and is the bulk of the
            // value. Losing the cross-answer summary must not fail the session
            // or discard scores the candidate already earned.
            console.error("Session coaching failed (non-fatal):", error);
            coaching = { narrative: "", patterns: [], top_fixes: [], agent_error: String(error?.message || error) };
        }

        const updated = await prisma.mockInterview.update({
            where: { id: mockId },
            data: {
                status: "COMPLETED",
                completedAt: new Date(),
                overallScore: overall,
                dimensionScores: dimensions,
                coaching: coaching as any,
                usage: mergeUsage(mock.usage, usage) as any,
            },
            include: {
                job: { select: { id: true, title: true } },
                answers: { include: { question: true }, orderBy: { createdAt: "asc" } },
            },
        });

        return NextResponse.json({ mockInterview: updated });
    } catch (error: any) {
        console.error("Error finalizing mock interview:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
