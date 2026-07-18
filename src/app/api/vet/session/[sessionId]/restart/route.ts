import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
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

        // Fetch session details from Postgres
        const vettingSession = await prisma.vettingSession.findUnique({
            where: { id: sessionId },
            include: {
                application: {
                    include: {
                        candidate: true,
                        job: true
                    }
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

        // Trigger Python microservice to execute planner
        const pythonResponse = await fetch(`${PYTHON_API_URL}/vet/initiate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
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
                }
            })
        });

        if (!pythonResponse.ok) {
            const errText = await pythonResponse.text();
            throw new Error(errText || "Python planner execution failed");
        }

        const pythonData = await pythonResponse.json();

        // Save new findings to DB and reset status
        const updatedSession = await prisma.vettingSession.update({
            where: { id: sessionId },
            data: {
                status: "PLANNING",
                researchPlan: pythonData.planner_output || {},
                researchResults: [],
                evaluation: Prisma.JsonNull,
                finalReport: {},
                qaHistory: Prisma.JsonNull,
                logs: pythonData.logs || []
            },
            include: {
                application: {
                    include: {
                        candidate: true,
                        job: true
                    }
                }
            }
        });

        return NextResponse.json({ vettingSession: updatedSession });
    } catch (error: any) {
        console.error("Error restarting vetting:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
