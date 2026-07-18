import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { candidateId, jobId } = await req.json();

        if (!candidateId || !jobId) {
            return new NextResponse("Missing candidateId or jobId", { status: 400 });
        }

        // Verify the job exists and belongs to the recruiter
        const job = await prisma.jobPosting.findFirst({
            where: {
                id: jobId,
                recruiterId: session.user.id
            }
        });

        if (!job) {
            return new NextResponse("Job posting not found or not owned by you", { status: 404 });
        }

        // Verify the candidate exists
        const candidate = await prisma.candidate.findUnique({
            where: { id: candidateId }
        });

        if (!candidate) {
            return new NextResponse("Candidate not found", { status: 404 });
        }

        // Check if an Application exists or create it
        let application = await prisma.application.findUnique({
            where: {
                candidateId_jobId: {
                    candidateId,
                    jobId
                }
            }
        });

        if (!application) {
            application = await prisma.application.create({
                data: {
                    candidateId,
                    jobId,
                    status: "AI_PROCESSING"
                }
            });
        }

        // Check if a VettingSession already exists
        let vettingSession = await prisma.vettingSession.findUnique({
            where: { applicationId: application.id }
        });

        if (vettingSession) {
            if (vettingSession.status !== "FAILED") {
                const hydrated = await prisma.vettingSession.findUnique({
                    where: { id: vettingSession.id },
                    include: {
                        application: {
                            include: {
                                candidate: true,
                                job: true
                            }
                        }
                    }
                });
                return NextResponse.json({ vettingSession: hydrated });
            }
            // If it failed, delete and recreate
            await prisma.vettingSession.delete({
                where: { id: vettingSession.id }
            });
        }

        // Call the python microservice to run Agent 1: Planner
        const pythonResponse = await fetch("http://127.0.0.1:8000/vet/initiate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                job: {
                    title: job.title,
                    description: job.description,
                    requirements: job.requirements
                },
                candidate: {
                    name: candidate.name,
                    email: candidate.email,
                    resume_text: candidate.resumeText,
                    linkedin_url: candidate.linkedinUrl,
                    github_url: candidate.githubUrl
                }
            })
        });

        if (!pythonResponse.ok) {
            const errText = await pythonResponse.text();
            throw new Error(errText || "Python microservice returned an error");
        }

        const pythonData = await pythonResponse.json();

        // Save session state to PostgreSQL via Prisma
        vettingSession = await prisma.vettingSession.create({
            data: {
                applicationId: application.id,
                status: "PLANNING",
                researchPlan: pythonData.planner_output || {},
                logs: pythonData.logs || []
            }
        });

        const hydrated = await prisma.vettingSession.findUnique({
            where: { id: vettingSession.id },
            include: {
                application: {
                    include: {
                        candidate: true,
                        job: true
                    }
                }
            }
        });

        return NextResponse.json({ vettingSession: hydrated });
    } catch (error: any) {
        console.error("Error in initiate vetting:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
