import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

/**
 * Live note capture during an interview: mark a question asked, rate the
 * answer 1-5, and write notes.
 *
 * This is the highest-value byproduct in the whole design. Each write produces
 * a (claim, automated verdict, human outcome) triple, and those are the only
 * data that can ever answer "is the verification actually right?" — precision
 * on CONTRADICTED rulings, and whether UNVERIFIABLE claims tend to hold up in
 * person. python/eval/rank_eval.py is the natural home for that analysis.
 */
export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ questionId: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { questionId } = await params;
        const body = await req.json().catch(() => ({}));

        const existing = await prisma.interviewKitQuestion.findUnique({
            where: { id: questionId },
            include: {
                kit: {
                    include: {
                        vettingSession: { include: { application: { include: { job: true } } } },
                    },
                },
            },
        });
        if (!existing) return new NextResponse("Question not found", { status: 404 });
        if (existing.kit.vettingSession.application.job.recruiterId !== session.user.id) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        const data: Record<string, unknown> = {};

        if (body.interviewerRating !== undefined) {
            if (body.interviewerRating === null) {
                data.interviewerRating = null;
            } else {
                const rating = Number(body.interviewerRating);
                if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
                    return new NextResponse("interviewerRating must be an integer 1-5, or null", { status: 400 });
                }
                data.interviewerRating = rating;
            }
        }

        if (body.interviewerNotes !== undefined) {
            data.interviewerNotes =
                typeof body.interviewerNotes === "string" ? body.interviewerNotes : null;
        }

        if (body.asked !== undefined) {
            // Idempotent: re-marking an already-asked question keeps the
            // original timestamp, so a double-click during a live interview
            // doesn't rewrite when it happened.
            data.askedAt = body.asked ? (existing.askedAt ?? new Date()) : null;
        }

        if (Object.keys(data).length === 0) {
            return new NextResponse("Nothing to update", { status: 400 });
        }

        const question = await prisma.interviewKitQuestion.update({
            where: { id: questionId },
            data,
        });

        return NextResponse.json({ question });
    } catch (error: any) {
        console.error("Error updating kit question:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
