import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { deleteUploadThingFileByUrl } from "@/lib/uploadthing";

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

export async function GET() {
    const session = await auth();
    if (!session?.user?.email) {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        include: { candidate: true },
    });

    if (!user) {
        return new NextResponse("User not found", { status: 404 });
    }

    // If the user signed in with Google (or is a candidate without a profile yet), create one lazily.
    if (!user.candidate && user.role === "CANDIDATE") {
        const newCandidate = await prisma.candidate.create({
            data: {
                userId: user.id,
                name: user.name || "",
                email: user.email,
            },
        });
        return NextResponse.json({ candidate: newCandidate, role: user.role });
    }

    return NextResponse.json({ candidate: user.candidate, role: user.role });
}

export async function POST(req: Request) {
    const session = await auth();
    if (!session?.user?.email) {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    const { resumeUrl, phone } = await req.json();

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        include: { candidate: true },
    });

    if (!user || user.role !== "CANDIDATE") {
        return new NextResponse("Unauthorized or not a candidate", { status: 401 });
    }

    // 1. Save or Update the standard fields
    const updatedCandidate = await prisma.candidate.upsert({
        where: { userId: user.id },
        create: {
            userId: user.id,
            name: user.name || "",
            email: user.email,
            phone: phone || null,
            resumeUrl: resumeUrl || null,
        },
        update: {
            phone: phone !== undefined ? phone : undefined,
            resumeUrl: resumeUrl !== undefined ? resumeUrl : undefined,
        },
    });

    const existingResumeUrl = user.candidate?.resumeUrl;
    const resumeChanged = resumeUrl !== undefined && resumeUrl !== existingResumeUrl;

    // 2. If the resumeUrl has changed, process via the Python microservice
    let embeddingStatus: "success" | "failed" | "skipped" = "skipped";
    let embeddingError: string | null = null;

    if (resumeChanged) {
        if (resumeUrl) {
            try {
                console.log("📄 Sending resume to Python microservice for processing...");

                // Call the Python FastAPI service
                const pythonRes = await fetch(`${PYTHON_API_URL}/process-resume`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ resume_url: resumeUrl }),
                });

                if (!pythonRes.ok) {
                    const contentType = pythonRes.headers.get("content-type") || "";
                    let pythonError = "Resume processing service failed.";

                    if (contentType.includes("application/json")) {
                        const errJson = await pythonRes.json().catch(() => null);
                        pythonError = errJson?.detail || JSON.stringify(errJson) || pythonError;
                    } else {
                        pythonError = await pythonRes.text();
                    }

                    const isQuotaError =
                        pythonRes.status === 429 ||
                        /quota|credit|billing|resource_exhausted|rate limit/i.test(pythonError);

                    if (isQuotaError) {
                        throw new Error(
                            "Gemini API quota/billing limit reached. Please recharge or enable billing for GEMINI_API_KEY."
                        );
                    }

                    throw new Error(`Python API returned ${pythonRes.status}: ${pythonError}`);
                }

                const { resume_text, embedding } = await pythonRes.json();
                const normalizedEmbedding = normalizeEmbeddingDimensions(embedding);

                // Save the extracted text and vector embedding to PostgreSQL
                const embeddingString = `[${normalizedEmbedding.join(",")}]`;

                console.log("💾 Saving vector to PostgreSQL...");
                await prisma.$executeRaw`
                    UPDATE candidates 
                    SET "embedding" = ${embeddingString}::vector, "resumeText" = ${resume_text} 
                    WHERE "userId" = ${user.id}
                `;

                console.log("✅ Vector embedding successfully stored!");
                embeddingStatus = "success";
            } catch (error: any) {
                console.error("❌ Failed to process resume:", error);
                embeddingStatus = "failed";
                embeddingError = error?.message || "Unknown error during resume processing";
            }

            if (existingResumeUrl && existingResumeUrl !== resumeUrl) {
                void deleteUploadThingFileByUrl(existingResumeUrl).catch((cleanupError) => {
                    console.error("⚠️ Failed to delete old UploadThing resume:", cleanupError);
                });
            }
        } else if (resumeUrl === null) {
            // User deleted their resume, clear the vector and text
            console.log("🗑️ Clearing vector and resume text...");
            await prisma.$executeRaw`
                UPDATE candidates 
                SET "embedding" = NULL, "resumeText" = NULL 
                WHERE "userId" = ${user.id}
            `;

            if (existingResumeUrl) {
                void deleteUploadThingFileByUrl(existingResumeUrl).catch((cleanupError) => {
                    console.error("⚠️ Failed to delete removed UploadThing resume:", cleanupError);
                });
            }

            embeddingStatus = "success";
        }
    }

    return NextResponse.json({
        success: true,
        candidate: updatedCandidate,
        embedding: { status: embeddingStatus, error: embeddingError },
    });
}

