import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

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

        // Execute raw SQL to calculate cosine similarity using pgvector
        const matches = await prisma.$queryRaw<any[]>`
            SELECT 
                c.id,
                c.name,
                c.email,
                c.phone,
                c.skills,
                c."resumeUrl",
                c."resumeText",
                CASE 
                    WHEN j.embedding IS NOT NULL AND c.embedding IS NOT NULL 
                    THEN (1 - (j.embedding <=> c.embedding)) 
                    ELSE NULL 
                END as "matchScore"
            FROM candidates c
            CROSS JOIN job_postings j
            WHERE j.id = ${jobId}
              AND c.embedding IS NOT NULL
              AND j.embedding IS NOT NULL
            ORDER BY "matchScore" DESC
        `;

        // Format and round match scores to percentage values
        const formattedMatches = matches.map(match => ({
            id: match.id,
            name: match.name,
            email: match.email,
            phone: match.phone,
            skills: match.skills || [],
            resumeUrl: match.resumeUrl,
            resumeText: match.resumeText,
            matchScore: match.matchScore !== null ? Math.round(Number(match.matchScore) * 100) : null
        }));

        return NextResponse.json({
            jobTitle: job.title,
            matches: formattedMatches
        });
    } catch (error: any) {
        console.error("Error retrieving candidate matches:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
