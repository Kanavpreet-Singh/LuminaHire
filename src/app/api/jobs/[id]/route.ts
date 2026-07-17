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

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: jobId } = await params;
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

        const existingJob = await prisma.jobPosting.findUnique({
            where: { id: jobId },
        });

        if (!existingJob) {
            return new NextResponse("Job posting not found", { status: 404 });
        }

        if (existingJob.recruiterId !== user.id) {
            return new NextResponse("Forbidden: You do not own this job posting", { status: 403 });
        }

        const { title, description, requirements, status } = await req.json();

        if (!title || !description) {
            return new NextResponse("Title and description are required.", { status: 400 });
        }

        // Check if we need to regenerate the embedding
        const hasContentChanged = 
            title !== existingJob.title || 
            description !== existingJob.description || 
            (requirements || "") !== (existingJob.requirements || "");

        let embeddingString = null;
        if (hasContentChanged) {
            // Send JD to python api to get embedding
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
            embeddingString = `[${normalizedEmbedding.join(",")}]`;
        }

        // Update database record
        const updatedJob = await prisma.jobPosting.update({
            where: { id: jobId },
            data: {
                title,
                description,
                requirements: requirements || null,
                status: status || existingJob.status,
            },
        });

        // Update the embedding if it was regenerated
        if (embeddingString) {
            await prisma.$executeRaw`
                UPDATE job_postings 
                SET "embedding" = ${embeddingString}::vector 
                WHERE "id" = ${jobId}
            `;
        }

        return NextResponse.json({ success: true, job: updatedJob });
    } catch (error: any) {
        console.error("Failed to update job:", error);
        return new NextResponse(error?.message || "Internal server error", { status: 500 });
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: jobId } = await params;
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

        const existingJob = await prisma.jobPosting.findUnique({
            where: { id: jobId },
        });

        if (!existingJob) {
            return new NextResponse("Job posting not found", { status: 404 });
        }

        if (existingJob.recruiterId !== user.id) {
            return new NextResponse("Forbidden: You do not own this job posting", { status: 403 });
        }

        // Delete job posting
        await prisma.jobPosting.delete({
            where: { id: jobId },
        });

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("Failed to delete job:", error);
        return new NextResponse(error?.message || "Internal server error", { status: 500 });
    }
}
