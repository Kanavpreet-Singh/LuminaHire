import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
    getOrCreatePublishedPracticeSet,
    ensurePersonalQuestionRow,
    orderQuestionsForCandidate,
} from "@/lib/interview";

/**
 * A job's practice questions, for a candidate to rehearse against.
 *
 * RESOLVED BY jobId AND NOTHING ELSE. There is no application lookup and no
 * vetting-session lookup in this file, deliberately: a candidate requesting a
 * practice set must reveal nothing about whether they are being vetted, and
 * must not receive questions shaped by verdicts on their own resume. See
 * docs/interview-practice-design.md, "The invariant that shapes everything".
 */
export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user) return new NextResponse("Unauthorized", { status: 401 });

        const { id: jobId } = await params;

        const job = await prisma.jobPosting.findUnique({
            where: { id: jobId },
            select: { id: true, title: true, status: true },
        });
        if (!job) return new NextResponse("Job not found", { status: 404 });

        // Recruiters can preview a set without having a candidate profile.
        const candidate =
            (session.user as any).role === "CANDIDATE"
                ? await prisma.candidate.findUnique({ where: { userId: session.user.id! } })
                : null;

        let set = await getOrCreatePublishedPracticeSet(jobId, candidate?.id);

        if (candidate) {
            // Materialize their own PERSONAL question so it is answerable, not
            // just previewable, then re-read so it is included below.
            const personal = await ensurePersonalQuestionRow(set.id, candidate);
            if (personal && !set.questions.some((q) => q.id === personal.id)) {
                set = await getOrCreatePublishedPracticeSet(jobId, candidate.id);
            }
        }

        let questions: any[] = set.questions;
        if (candidate) {
            // Retrieval, not generation: reorders existing questions using the
            // candidate's own resume so the competencies their background covers
            // least come first, since that's where practice pays.
            questions = orderQuestionsForCandidate(set.questions, {
                resumeText: candidate.resumeText,
                skills: candidate.skills,
            });
        }

        return NextResponse.json({
            job: { id: job.id, title: job.title, status: job.status },
            set: {
                id: set.id,
                version: set.version,
                publishedAt: set.publishedAt,
                questions,
            },
        });
    } catch (error: any) {
        console.error("Error loading practice set:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

/**
 * Regenerate a job's practice set as a new version. Recruiter-only.
 *
 * Publishing a new version never mutates the old one: existing MockAnswer rows
 * keep pointing at the question they were actually asked, so a historical
 * attempt never becomes unreadable.
 */
export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { id: jobId } = await params;
        const job = await prisma.jobPosting.findUnique({ where: { id: jobId } });
        if (!job) return new NextResponse("Job not found", { status: 404 });
        if (job.recruiterId !== session.user.id) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        await prisma.practiceSet.updateMany({
            where: { jobId, status: "PUBLISHED" },
            data: { status: "ARCHIVED" },
        });

        const set = await getOrCreatePublishedPracticeSet(jobId);
        return NextResponse.json({ set });
    } catch (error: any) {
        console.error("Error regenerating practice set:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
