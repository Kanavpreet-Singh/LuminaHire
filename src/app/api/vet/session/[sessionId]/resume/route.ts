import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { PYTHON_API_URL } from "@/lib/vetting";

/**
 * Resume an interrupted run from its last persisted stage. Uses the plan and any
 * checkpointed research results already in the DB so completed stages are not
 * re-run. Recovers FAILED sessions (e.g. after a Python restart) without losing
 * prior work.
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

        const plan = (vettingSession.researchPlan as any) || null;
        const research = Array.isArray(vettingSession.researchResults)
            ? (vettingSession.researchResults as any[])
            : [];
        const iterations = research.reduce(
            (max, r) => Math.max(max, Number(r?.iteration) || 0),
            0
        );

        // Resume phase reflects what work already exists.
        const resumePhase = research.length > 0 ? "EVALUATING" : "RESEARCHING";
        await prisma.vettingSession.update({
            where: { id: sessionId },
            data: { status: resumePhase },
        });

        const dispatch = await fetch(`${PYTHON_API_URL}/vet/resume-async`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: sessionId,
                job: {
                    title: vettingSession.application.job.title,
                    description: vettingSession.application.job.description,
                    requirements: vettingSession.application.job.requirements,
                    recruiter_instructions: vettingSession.recruiterInstructions,
                },
                candidate: {
                    name: vettingSession.application.candidate.name,
                    email: vettingSession.application.candidate.email,
                    resume_text: vettingSession.application.candidate.resumeText,
                    linkedin_url: vettingSession.application.candidate.linkedinUrl,
                    github_url: vettingSession.application.candidate.githubUrl,
                },
                planner_output: plan,
                research_results: research,
                research_iterations: iterations,
                hitl: vettingSession.pipelineMode === "HITL",
                resume_at_evaluator: research.length > 0,
            }),
        });

        if (dispatch.status === 409) {
            const running = await prisma.vettingSession.findUnique({
                where: { id: sessionId },
                include: { application: { include: { candidate: true, job: true } } },
            });
            return NextResponse.json({ vettingSession: running });
        }
        if (!dispatch.ok) {
            await prisma.vettingSession.update({
                where: { id: sessionId },
                data: { status: "FAILED" },
            });
            const errText = await dispatch.text();
            throw new Error(errText || "Failed to resume vetting run");
        }

        const started = await prisma.vettingSession.findUnique({
            where: { id: sessionId },
            include: { application: { include: { candidate: true, job: true } } },
        });
        return NextResponse.json({ vettingSession: started });
    } catch (error: any) {
        console.error("Error resuming vetting session:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
