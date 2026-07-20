import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { PYTHON_API_URL, mergeUsage } from "@/lib/vetting";

/**
 * Recruiter Q&A over the full accumulated pipeline context (job, candidate,
 * research plan, research evidence, evaluation, final report). Only available
 * once a session is COMPLETED. Appends each Q&A pair to qaHistory.
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
        const { question } = await req.json().catch(() => ({}));
        if (!question || typeof question !== "string" || !question.trim()) {
            return new NextResponse("Missing question", { status: 400 });
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
        if (vettingSession.status !== "COMPLETED") {
            return new NextResponse(
                `Session is not completed yet (status: ${vettingSession.status})`,
                { status: 409 }
            );
        }

        const { candidate, job } = vettingSession.application;

        const pythonResponse = await fetch(`${PYTHON_API_URL}/vet/qa`, {
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
                research_results: vettingSession.researchResults || [],
                evaluation: vettingSession.evaluation || null,
                final_report: vettingSession.finalReport || {},
                question: question.trim(),
            }),
        });

        if (!pythonResponse.ok) {
            const errText = await pythonResponse.text();
            throw new Error(errText || "Q&A request failed");
        }

        const pythonData = await pythonResponse.json();
        const existingHistory = Array.isArray(vettingSession.qaHistory)
            ? (vettingSession.qaHistory as any[])
            : [];
        const newEntry = {
            question: question.trim(),
            answer: pythonData.answer || "",
            citations: Array.isArray(pythonData.citations) ? pythonData.citations : [],
            askedAt: new Date().toISOString(),
        };

        const updated = await prisma.vettingSession.update({
            where: { id: sessionId },
            data: {
                qaHistory: [...existingHistory, newEntry],
                usage: mergeUsage((vettingSession as any).usage, pythonData.usage) as any,
            },
            include: { application: { include: { candidate: true, job: true } } },
        });

        return NextResponse.json({ vettingSession: updated });
    } catch (error: any) {
        console.error("Error answering Q&A question:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
