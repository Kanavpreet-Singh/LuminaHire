import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { callPython } from "@/lib/interview";

/**
 * Top up the practice queue with more questions in a chosen category.
 *
 * THE ROWS ARE CANDIDATE-SCOPED. They carry `candidateId`, exactly like the
 * PERSONAL question, so one candidate asking for four more system-design
 * questions doesn't silently rewrite what every other applicant for that role
 * practises against. The shared, job-derived set stays exactly as published.
 *
 * Generation itself still sees only the job posting — see python/practice.py.
 */

const CATEGORIES = new Set([
    "BEHAVIORAL",
    "TECHNICAL_CONCEPT",
    "PROJECT_WALKTHROUGH",
    "SYSTEM_DESIGN",
    "ROLE_MOTIVATION",
]);

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
        const category = CATEGORIES.has(body.category) ? body.category : "BEHAVIORAL";
        const count = Math.max(1, Math.min(5, Number(body.count) || 3));

        const candidate = await prisma.candidate.findUnique({
            where: { userId: session.user.id! },
            select: { id: true },
        });
        if (!candidate) return new NextResponse("No candidate profile", { status: 404 });

        const mock = await prisma.mockInterview.findUnique({
            where: { id: mockId },
            include: { job: true },
        });
        if (!mock) return new NextResponse("Session not found", { status: 404 });
        if (mock.candidateId !== candidate.id) return new NextResponse("Forbidden", { status: 403 });

        // Everything this candidate can already see in this set, so the top-up
        // doesn't hand them a question they've already been asked.
        const existing = await prisma.practiceQuestion.findMany({
            where: {
                setId: mock.practiceSetId,
                OR: [{ candidateId: null }, { candidateId: candidate.id }],
            },
            select: { prompt: true, order: true },
            orderBy: { order: "desc" },
        });

        const generated = await callPython("/practice/more-questions", {
            job_id: mock.jobId,
            job: {
                title: mock.job.title,
                description: mock.job.description,
                requirements: mock.job.requirements,
            },
            category,
            count,
            avoid: existing.map((q) => q.prompt),
        });

        const questions = Array.isArray(generated.questions) ? generated.questions : [];
        if (questions.length === 0) {
            return new NextResponse(
                generated.agent_error ||
                    "Couldn't write more questions in that category right now. Try another category.",
                { status: 502 }
            );
        }

        // Append after everything they already have. The PERSONAL question sits
        // at order 100, so start past it to keep the queue in a sane order.
        const nextOrder = Math.max(100, existing[0]?.order ?? 0) + 1;
        const seen = new Set(existing.map((q) => q.prompt.trim().toLowerCase()));

        const created = await prisma.$transaction(
            questions
                .filter((q: any) => {
                    const p = String(q.prompt || "").trim().toLowerCase();
                    if (!p || seen.has(p)) return false;
                    seen.add(p);
                    return true;
                })
                .map((q: any, i: number) =>
                    prisma.practiceQuestion.create({
                        data: {
                            setId: mock.practiceSetId,
                            candidateId: candidate.id,
                            order: nextOrder + i,
                            prompt: String(q.prompt),
                            category,
                            competency: String(q.competency || "").slice(0, 120),
                            targetSeconds: Math.max(30, Math.min(300, Number(q.target_seconds) || 120)),
                            rubric: q.rubric ?? undefined,
                            followUpHints: Array.isArray(q.follow_up_hints)
                                ? q.follow_up_hints.map(String)
                                : [],
                        },
                    })
                )
        );

        if (created.length === 0) {
            return new NextResponse(
                "Those all came back as questions you've already had. Try a different category.",
                { status: 409 }
            );
        }

        return NextResponse.json({ questions: created });
    } catch (error: any) {
        console.error("Error generating more questions:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
