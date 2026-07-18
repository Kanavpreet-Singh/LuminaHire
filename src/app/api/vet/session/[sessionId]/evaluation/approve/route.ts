import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { PYTHON_API_URL } from "@/lib/vetting";

/**
 * Approve the reviewed evaluation and generate the final report. Ends
 * COMPLETED via the existing syncCompletedResults path (no changes needed
 * there) since /vet/evaluation/approve-async writes through the same
 * registry.set_results call as every other completion path.
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

        const { candidate, job } = vettingSession.application;
        const research = Array.isArray(vettingSession.researchResults)
            ? (vettingSession.researchResults as any[])
            : [];
        const iterations = research.reduce((max, r) => Math.max(max, Number(r?.iteration) || 0), 0);

        await prisma.vettingSession.update({ where: { id: sessionId }, data: { status: "EVALUATING" } });

        const pythonResponse = await fetch(`${PYTHON_API_URL}/vet/evaluation/approve-async`, {
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
                planner_output: vettingSession.researchPlan || {},
                research_results: research,
                research_iterations: iterations,
                evaluation: vettingSession.evaluation || {},
            }),
        });

        if (pythonResponse.status === 409) {
            const running = await prisma.vettingSession.findUnique({
                where: { id: sessionId },
                include: { application: { include: { candidate: true, job: true } } },
            });
            return NextResponse.json({ vettingSession: running });
        }
        if (!pythonResponse.ok) {
            await prisma.vettingSession.update({ where: { id: sessionId }, data: { status: "FAILED" } });
            const errText = await pythonResponse.text();
            throw new Error(errText || "Failed to start report generation");
        }

        const started = await prisma.vettingSession.findUnique({
            where: { id: sessionId },
            include: { application: { include: { candidate: true, job: true } } },
        });
        return NextResponse.json({ vettingSession: started });
    } catch (error: any) {
        console.error("Error approving evaluation:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
