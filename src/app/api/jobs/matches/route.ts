import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getJobMatches } from "@/lib/matches";

export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const jobId = searchParams.get("jobId");

        if (!jobId) {
            return new NextResponse("Missing jobId parameter", { status: 400 });
        }

        // Verify job belongs to this recruiter
        const job = await prisma.jobPosting.findUnique({
            where: { id: jobId },
            select: { recruiterId: true, title: true }
        });

        if (!job) {
            return new NextResponse("Job posting not found", { status: 404 });
        }

        if (job.recruiterId !== session.user.id) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        // Rank candidates by pgvector cosine similarity (shared with the committee).
        const formattedMatches = await getJobMatches(jobId);

        return NextResponse.json({
            jobTitle: job.title,
            matches: formattedMatches
        });
    } catch (error: any) {
        console.error("Error retrieving candidate matches:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
