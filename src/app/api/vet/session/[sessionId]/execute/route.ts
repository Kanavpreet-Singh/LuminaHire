import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { PYTHON_API_URL } from "@/lib/vetting";

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
            include: {
                application: {
                    include: { candidate: true, job: true }
                }
            }
        });

        if (!vettingSession) {
            return new NextResponse("Vetting session not found", { status: 404 });
        }

        // Verify ownership
        if (vettingSession.application.job.recruiterId !== session.user.id) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        // Move to RESEARCHING; the background pipeline + poll-through take over.
        // The pipeline now pauses at AWAITING_RESEARCH_INPUT for human review
        // instead of running straight through to COMPLETED.
        await prisma.vettingSession.update({
            where: { id: sessionId },
            data: { status: "RESEARCHING" }
        });

        // Kick off the background pipeline (returns 202 immediately).
        const pythonResponse = await fetch(`${PYTHON_API_URL}/vet/execute-async`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: sessionId,
                job: {
                    title: vettingSession.application.job.title,
                    description: vettingSession.application.job.description,
                    requirements: vettingSession.application.job.requirements
                },
                candidate: {
                    name: vettingSession.application.candidate.name,
                    email: vettingSession.application.candidate.email,
                    resume_text: vettingSession.application.candidate.resumeText,
                    linkedin_url: vettingSession.application.candidate.linkedinUrl,
                    github_url: vettingSession.application.candidate.githubUrl
                },
                planner_output: vettingSession.researchPlan || {}
            })
        });

        // 409 = a run is already in flight for this session; that's fine, just report running.
        if (pythonResponse.status === 409) {
            const running = await prisma.vettingSession.findUnique({
                where: { id: sessionId },
                include: {
                    application: {
                        include: { candidate: true, job: true }
                    }
                }
            });
            return NextResponse.json({ vettingSession: running });
        }

        if (!pythonResponse.ok) {
            await prisma.vettingSession.update({
                where: { id: sessionId },
                data: { status: "FAILED" }
            });
            const errText = await pythonResponse.text();
            throw new Error(errText || "Failed to start vetting execution");
        }

        // Return the RESEARCHING session; the frontend polls the GET route to advance it.
        const started = await prisma.vettingSession.findUnique({
            where: { id: sessionId },
            include: {
                application: {
                    include: { candidate: true, job: true }
                }
            }
        });
        return NextResponse.json({ vettingSession: started });
    } catch (error: any) {
        console.error("Error running execute vetting:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
