import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://localhost:8000";
const TARGET_EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || "1536");

function normalizeEmbeddingDimensions(values: unknown): number[] {
    if (!Array.isArray(values)) {
        throw new Error("Python API returned an invalid embedding payload.");
    }

    const numericValues = values.map((value) => Number(value));
    if (numericValues.some((value) => Number.isNaN(value))) {
        throw new Error("Python API returned non-numeric embedding values.");
    }

    if (numericValues.length === TARGET_EMBEDDING_DIMENSIONS) {
        return numericValues;
    }

    if (numericValues.length > TARGET_EMBEDDING_DIMENSIONS) {
        return numericValues.slice(0, TARGET_EMBEDDING_DIMENSIONS);
    }

    return [
        ...numericValues,
        ...new Array(TARGET_EMBEDDING_DIMENSIONS - numericValues.length).fill(0),
    ];
}

function calibrateScore(rawScore: number | null): number | null {
    if (rawScore === null) return null;
    const minThreshold = 0.68;
    const maxThreshold = 0.80;
    
    if (rawScore <= minThreshold) return 0;
    if (rawScore >= maxThreshold) return 100;
    
    const calibrated = ((rawScore - minThreshold) / (maxThreshold - minThreshold)) * 100;
    return Math.round(calibrated);
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.email) {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
        });

        if (!user || user.role !== "RECRUITER") {
            return new NextResponse("Unauthorized or not a recruiter", { status: 401 });
        }

        // A recruiter must have a company name to post a job
        if (!user.companyName) {
            return new NextResponse("You must provide your company name first.", { status: 400 });
        }

        const { title, description, requirements } = await req.json();

        if (!title || !description) {
            return new NextResponse("Title and description are required.", { status: 400 });
        }

        // 1. Send JD to python api to get embedding
        const pythonRes = await fetch(`${PYTHON_API_URL}/process-job`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, description, requirements }),
        });

        if (!pythonRes.ok) {
            const errJson = await pythonRes.json().catch(() => null);
            throw new Error(errJson?.detail || "Failed to process job embedding.");
        }

        const { embedding } = await pythonRes.json();
        const normalizedEmbedding = normalizeEmbeddingDimensions(embedding);
        const embeddingString = `[${normalizedEmbedding.join(",")}]`;

        // 2. Save job posting safely using Prisma (handles CUID and enums automatically)
        const newJob = await prisma.jobPosting.create({
            data: {
                title,
                description,
                requirements: requirements || null,
                status: "OPEN",
                recruiterId: user.id,
            }
        });

        // 3. Update the vector embedding via raw SQL
        await prisma.$executeRaw`
            UPDATE job_postings 
            SET "embedding" = ${embeddingString}::vector 
            WHERE "id" = ${newJob.id}
        `;

        return NextResponse.json({ success: true, job: newJob });
    } catch (error: any) {
        console.error("Failed to create job:", error);
        return new NextResponse(error?.message || "Internal server error", { status: 500 });
    }
}

export async function GET(req: Request) {
    try {
        const session = await auth();
        const { searchParams } = new URL(req.url);
        const query = searchParams.get("query") || "";

        let candidate = null;
        if (session?.user?.email) {
            const user = await prisma.user.findUnique({
                where: { email: session.user.email },
                include: { candidate: true }
            });
            if (user?.role === "CANDIDATE" && user.candidate) {
                candidate = user.candidate;
            }
        }

        if (candidate) {
            // Use raw SQL to calculate cosine similarity with pgvector <=> operator
            const jobs = await prisma.$queryRaw<any[]>`
                SELECT 
                    j.id, 
                    j.title, 
                    j.description, 
                    j.requirements, 
                    j.status,
                    j."createdAt",
                    u.name as "recruiterName",
                    u."companyName" as "companyName",
                    CASE 
                        WHEN j.embedding IS NOT NULL AND c.embedding IS NOT NULL 
                        THEN (1 - (j.embedding <=> c.embedding)) 
                        ELSE NULL 
                    END as "matchScore"
                FROM job_postings j
                LEFT JOIN users u ON j."recruiterId" = u.id
                LEFT JOIN candidates c ON c.id = ${candidate.id}
                WHERE j.status = 'OPEN' 
                  AND (
                    j.title ILIKE ${`%${query}%`}
                    OR j.description ILIKE ${`%${query}%`}
                    OR u."companyName" ILIKE ${`%${query}%`}
                  )
                ORDER BY 
                    CASE WHEN j.embedding IS NOT NULL AND c.embedding IS NOT NULL THEN (1 - (j.embedding <=> c.embedding)) END DESC,
                    j."createdAt" DESC
            `;

            const formattedJobs = jobs.map(job => ({
                ...job,
                matchScore: calibrateScore(job.matchScore !== null ? Number(job.matchScore) : null)
            }));

            return NextResponse.json(formattedJobs);
        } else {
            // Not logged in or not a candidate, return jobs without similarity scores
            const jobs = await prisma.jobPosting.findMany({
                where: {
                    status: "OPEN",
                    OR: [
                        { title: { contains: query, mode: "insensitive" } },
                        { description: { contains: query, mode: "insensitive" } },
                        { recruiter: { companyName: { contains: query, mode: "insensitive" } } },
                    ]
                },
                include: {
                    recruiter: {
                        select: {
                            name: true,
                            companyName: true,
                        }
                    }
                },
                orderBy: { createdAt: "desc" }
            });

            const formattedJobs = jobs.map(job => ({
                id: job.id,
                title: job.title,
                description: job.description,
                requirements: job.requirements,
                status: job.status,
                createdAt: job.createdAt,
                recruiterName: job.recruiter?.name,
                companyName: job.recruiter?.companyName,
                matchScore: null
            }));

            return NextResponse.json(formattedJobs);
        }
    } catch (error: any) {
        console.error("Failed to fetch jobs:", error);
        return new NextResponse(error?.message || "Internal server error", { status: 500 });
    }
}
