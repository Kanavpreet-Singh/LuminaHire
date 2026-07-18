import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { PYTHON_API_URL } from "@/lib/vetting";

/**
 * HITL "ask the researcher to dig deeper" follow-up. Sends the recruiter's
 * free-text instruction to the Python tool-calling research agent, which
 * decides which tool(s) to call, and appends the new findings to the
 * session's research_results (status stays AWAITING_RESEARCH_INPUT).
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
        const { instruction } = await req.json().catch(() => ({}));
        if (!instruction || typeof instruction !== "string" || !instruction.trim()) {
            return new NextResponse("Missing instruction", { status: 400 });
        }

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
        if (vettingSession.status !== "AWAITING_RESEARCH_INPUT") {
            return new NextResponse(
                `Session is not awaiting research input (status: ${vettingSession.status})`,
                { status: 409 }
            );
        }

        const { candidate, job } = vettingSession.application;
        const existingResults = Array.isArray(vettingSession.researchResults)
            ? (vettingSession.researchResults as any[])
            : [];

        const pythonResponse = await fetch(`${PYTHON_API_URL}/vet/research/followup`, {
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
                research_results: existingResults,
                instruction: instruction.trim(),
            }),
        });

        if (!pythonResponse.ok) {
            const errText = await pythonResponse.text();
            throw new Error(errText || "Guided research request failed");
        }

        const pythonData = await pythonResponse.json();
        const newResults = Array.isArray(pythonData.new_results) ? pythonData.new_results : [];
        const toolCalls = Array.isArray(pythonData.tool_calls) ? pythonData.tool_calls : [];
        const followupLogs = Array.isArray(pythonData.logs) ? pythonData.logs : [];

        const existingLogs = Array.isArray(vettingSession.logs) ? (vettingSession.logs as string[]) : [];

        const updated = await prisma.vettingSession.update({
            where: { id: sessionId },
            data: {
                researchResults: [...existingResults, ...newResults],
                logs: [...existingLogs, ...followupLogs],
            },
            include: { application: { include: { candidate: true, job: true } } },
        });

        return NextResponse.json({ vettingSession: updated, toolCalls });
    } catch (error: any) {
        console.error("Error running guided research follow-up:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
