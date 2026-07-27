import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { PYTHON_API_URL, mergeUsage } from "@/lib/vetting";

/**
 * The Interview Kit: a runnable interview built from a COMPLETED vetting
 * session's claim verdicts. Recruiter-only, and scoped to session ownership —
 * this is the artifact the candidate must never see (see
 * docs/interview-practice-design.md, "The invariant that shapes everything").
 *
 * POST generates or regenerates; GET reads. Generation is idempotent by
 * replacement: a regeneration deletes the previous kit's questions, which also
 * discards any interviewer notes on them, so the UI warns before regenerating a
 * kit that has been used.
 */

async function loadOwnedSession(sessionId: string, userId: string) {
    const vettingSession = await prisma.vettingSession.findUnique({
        where: { id: sessionId },
        include: { application: { include: { candidate: true, job: true } } },
    });
    if (!vettingSession) return { error: new NextResponse("Vetting session not found", { status: 404 }) };
    if (vettingSession.application.job.recruiterId !== userId) {
        return { error: new NextResponse("Forbidden", { status: 403 }) };
    }
    return { vettingSession };
}

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
        const { vettingSession, error } = await loadOwnedSession(sessionId, session.user.id!);
        if (error) return error;

        const kit = await prisma.interviewKit.findUnique({
            where: { vettingSessionId: vettingSession!.id },
            include: { questions: { orderBy: { order: "asc" } } },
        });

        return NextResponse.json({ kit });
    } catch (error: any) {
        console.error("Error reading interview kit:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

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
        const body = await req.json().catch(() => ({}));
        const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
        const durationMinutes = Number(body.durationMinutes) || 45;

        const { vettingSession, error } = await loadOwnedSession(sessionId, session.user.id!);
        if (error) return error;

        // The kit is built from claim verdicts, which only exist once the
        // evaluation has settled and the report has been written.
        if (vettingSession!.status !== "COMPLETED") {
            return new NextResponse(
                `Session is not completed yet (status: ${vettingSession!.status})`,
                { status: 409 }
            );
        }

        const { candidate, job } = vettingSession!.application;

        const response = await fetch(`${PYTHON_API_URL}/interview/kit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: sessionId,
                job: { title: job.title, description: job.description, requirements: job.requirements },
                candidate: {
                    name: candidate.name,
                    email: candidate.email,
                    resume_text: candidate.resumeText,
                    linkedin_url: candidate.linkedinUrl,
                    github_url: candidate.githubUrl,
                },
                planner_output: vettingSession!.researchPlan || {},
                evaluation: vettingSession!.evaluation || null,
                final_report: vettingSession!.finalReport || {},
                instructions,
                duration_minutes: durationMinutes,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(errText || "Interview kit generation failed");
        }

        const data = await response.json();
        const questions = Array.isArray(data.questions) ? data.questions : [];

        if (questions.length === 0) {
            return new NextResponse(
                data.agent_error || "The kit generator returned no questions. Try again.",
                { status: 502 }
            );
        }

        // Replace wholesale rather than merge. A regenerated kit is a different
        // interview — reconciling old interviewer notes onto new questions would
        // silently attach a rating to a question that was never asked.
        const kit = await prisma.$transaction(async (tx) => {
            await tx.interviewKit.deleteMany({ where: { vettingSessionId: sessionId } });
            return tx.interviewKit.create({
                data: {
                    vettingSessionId: sessionId,
                    status: "READY",
                    instructions: instructions || null,
                    agenda: data.agenda ?? undefined,
                    referenceChecks: data.reference_checks ?? undefined,
                    usage: data.usage ?? undefined,
                    errorMessage: data.agent_error ?? null,
                    questions: {
                        create: questions.map((q: any, i: number) => ({
                            order: i,
                            question: String(q.question || ""),
                            kind: KIT_KINDS.has(q.kind) ? q.kind : "CLAIM_PROBE",
                            targetsClaimId: q.targets_claim_id || null,
                            claimStatus: q.claim_status || null,
                            why: String(q.why || ""),
                            followUps: Array.isArray(q.follow_ups) ? q.follow_ups.map(String) : [],
                            rubric: q.rubric ?? undefined,
                            difficulty: KIT_DIFFICULTIES.has(q.difficulty) ? q.difficulty : "CORE",
                            timeBoxMinutes: Number(q.time_box_minutes) || null,
                        })),
                    },
                },
                include: { questions: { orderBy: { order: "asc" } } },
            });
        });

        // Kit generation is a real LLM call on this session's behalf, so it
        // belongs in the session's running cost total alongside the pipeline
        // stages and Q&A.
        await prisma.vettingSession.update({
            where: { id: sessionId },
            data: { usage: mergeUsage((vettingSession as any).usage, data.usage) as any },
        });

        return NextResponse.json({ kit, openingNote: data.opening_note ?? "" });
    } catch (error: any) {
        console.error("Error generating interview kit:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

// Guard the enum boundary: an unrecognized kind/difficulty from the model must
// degrade to a sane default rather than throw a Prisma enum error and discard
// an otherwise complete kit.
const KIT_KINDS = new Set(["CONTRADICTION", "CLAIM_PROBE", "JD_GAP", "DEPTH", "BEHAVIORAL"]);
const KIT_DIFFICULTIES = new Set(["WARMUP", "CORE", "STRETCH"]);
