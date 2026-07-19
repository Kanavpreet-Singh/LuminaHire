import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { DEMO_RECRUITER } from "@/lib/demo";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://localhost:8000";
const TARGET_EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || "1536");

// Seed job postings created for the demo recruiter on first sign-in.
const DEMO_JOBS: { title: string; description: string; requirements: string }[] = [
    {
        title: "Senior Full-Stack Engineer",
        description:
            "Own end-to-end delivery of features across our Next.js frontend and Node.js services. You'll collaborate with product and design to ship polished, performant experiences, mentor mid-level engineers, and help shape our architecture as we scale.",
        requirements:
            "5+ years building production web apps; strong TypeScript, React/Next.js, and Node.js; solid grasp of relational databases (PostgreSQL) and REST/GraphQL APIs; experience with CI/CD and cloud (AWS/GCP).",
    },
    {
        title: "AI/ML Engineer",
        description:
            "Build and productionize ML features powering our candidate-matching pipeline. Work with embeddings, retrieval, and LLM orchestration to turn messy real-world data into reliable, measurable outcomes.",
        requirements:
            "3+ years in ML/AI; strong Python; hands-on with LLMs, vector databases (pgvector/Pinecone), and prompt engineering; comfortable with model evaluation and MLOps basics.",
    },
    {
        title: "Product Designer (UX/UI)",
        description:
            "Design intuitive, accessible interfaces from research through high-fidelity delivery. You'll partner closely with engineering to maintain a cohesive design system and continuously improve the product experience.",
        requirements:
            "4+ years in product design; strong Figma skills; portfolio demonstrating end-to-end work; solid understanding of accessibility and design systems; comfortable running usability tests.",
    },
    {
        title: "DevOps Engineer",
        description:
            "Keep our infrastructure fast, reliable, and secure. You'll own our deployment pipelines, observability, and cloud infrastructure as code, and champion a culture of automation and reliability.",
        requirements:
            "3+ years in DevOps/SRE; strong Docker and Kubernetes; infrastructure-as-code (Terraform); CI/CD pipelines; monitoring/observability (Prometheus, Grafana); scripting in Bash/Python.",
    },
    {
        title: "Backend Engineer (Python)",
        description:
            "Design and build the APIs and data services behind our agentic hiring platform. You'll focus on correctness, performance, and clean interfaces that other teams can build on with confidence.",
        requirements:
            "4+ years backend development; expert Python (FastAPI/Django); strong PostgreSQL; experience designing scalable REST APIs; familiarity with async processing and message queues.",
    },
    {
        title: "Data Analyst",
        description:
            "Turn product and hiring data into insights that drive decisions. You'll build dashboards, run analyses, and partner with teams across the company to answer their most important questions.",
        requirements:
            "2+ years in analytics; strong SQL; proficiency with a BI tool (Looker/Tableau/Metabase); comfortable with Python or R for analysis; clear communicator of quantitative findings.",
    },
    {
        title: "Technical Product Manager",
        description:
            "Lead the roadmap for our core matching and vetting experience. You'll translate customer needs into a crisp product strategy, and work day-to-day with engineering and design to ship it.",
        requirements:
            "5+ years in product management on technical products; strong grasp of APIs and system design; proven track record shipping B2B SaaS; excellent written and verbal communication.",
    },
];

function normalizeEmbeddingDimensions(values: unknown): number[] | null {
    if (!Array.isArray(values)) return null;
    const numericValues = values.map((value) => Number(value));
    if (numericValues.some((value) => Number.isNaN(value))) return null;
    if (numericValues.length === TARGET_EMBEDDING_DIMENSIONS) return numericValues;
    if (numericValues.length > TARGET_EMBEDDING_DIMENSIONS) {
        return numericValues.slice(0, TARGET_EMBEDDING_DIMENSIONS);
    }
    return [
        ...numericValues,
        ...new Array(TARGET_EMBEDDING_DIMENSIONS - numericValues.length).fill(0),
    ];
}

// Best-effort embedding fetch. The demo must still work if the Python service
// is down, so any failure simply leaves the embedding null (the column is nullable).
async function tryFetchEmbedding(job: {
    title: string;
    description: string;
    requirements: string;
}): Promise<string | null> {
    try {
        const res = await fetch(`${PYTHON_API_URL}/process-job`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(job),
        });
        if (!res.ok) return null;
        const { embedding } = await res.json();
        const normalized = normalizeEmbeddingDimensions(embedding);
        return normalized ? `[${normalized.join(",")}]` : null;
    } catch {
        return null;
    }
}

async function seedDemoJobs(recruiterId: string) {
    const existingCount = await prisma.jobPosting.count({ where: { recruiterId } });
    if (existingCount > 0) return; // already seeded

    for (const job of DEMO_JOBS) {
        const created = await prisma.jobPosting.create({
            data: {
                title: job.title,
                description: job.description,
                requirements: job.requirements,
                status: "OPEN",
                recruiterId,
            },
        });

        const embeddingString = await tryFetchEmbedding(job);
        if (embeddingString) {
            await prisma.$executeRaw`
                UPDATE job_postings
                SET "embedding" = ${embeddingString}::vector
                WHERE "id" = ${created.id}
            `;
        }
    }
}

// Ensures the demo recruiter (John Doe) and their sample job postings exist, so
// the navbar quick-login button always lands on a populated dashboard.
export async function POST() {
    try {
        let recruiter = await prisma.user.findUnique({
            where: { email: DEMO_RECRUITER.email },
        });

        if (!recruiter) {
            const hashedPassword = await bcrypt.hash(DEMO_RECRUITER.password, 12);
            recruiter = await prisma.user.create({
                data: {
                    name: DEMO_RECRUITER.name,
                    email: DEMO_RECRUITER.email,
                    hashedPassword,
                    role: "RECRUITER",
                    companyName: DEMO_RECRUITER.companyName,
                    emailVerified: new Date(),
                },
            });
        } else if (!recruiter.hashedPassword) {
            // Account exists (e.g. created via OAuth) but has no password — set it
            // so credentials sign-in works for the demo button.
            const hashedPassword = await bcrypt.hash(DEMO_RECRUITER.password, 12);
            recruiter = await prisma.user.update({
                where: { id: recruiter.id },
                data: { hashedPassword, role: "RECRUITER" },
            });
        }

        await seedDemoJobs(recruiter.id);

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("Demo recruiter provisioning error:", error);
        return NextResponse.json(
            { error: "Could not prepare the demo account." },
            { status: 500 }
        );
    }
}
