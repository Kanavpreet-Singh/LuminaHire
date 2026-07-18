import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { pollThroughPython } from "@/lib/vetting";

export async function GET(
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

        // If a background run is in flight, advance its state from the Python service.
        const refreshed = await pollThroughPython(vettingSession as any);

        return NextResponse.json({ vettingSession: refreshed });
    } catch (error: any) {
        console.error("Error retrieving vetting session:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { sessionId } = await params;
        const { researchPlan } = await req.json();

        if (!researchPlan) {
            return new NextResponse("Missing researchPlan body parameter", { status: 400 });
        }

        const vettingSession = await prisma.vettingSession.findUnique({
            where: { id: sessionId },
            include: {
                application: {
                    include: {
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

        // Update the research plan
        const updatedSession = await prisma.vettingSession.update({
            where: { id: sessionId },
            data: {
                researchPlan
            }
        });

        return NextResponse.json({ vettingSession: updatedSession });
    } catch (error: any) {
        console.error("Error updating vetting session plan:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
