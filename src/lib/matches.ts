import prisma from "@/lib/prisma";

/**
 * Calibrate a raw pgvector cosine similarity (0..1) into a 0-100 match score.
 * Below minThreshold -> 0, above maxThreshold -> 100, linear in between.
 */
export function calibrateScore(rawScore: number | null): number | null {
    if (rawScore === null) return null;
    const minThreshold = 0.68;
    const maxThreshold = 0.8;

    if (rawScore <= minThreshold) return 0;
    if (rawScore >= maxThreshold) return 100;

    const calibrated = ((rawScore - minThreshold) / (maxThreshold - minThreshold)) * 100;
    return Math.round(calibrated);
}

export interface JobMatch {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    skills: string[];
    resumeUrl: string | null;
    resumeText: string | null;
    linkedinUrl: string | null;
    githubUrl: string | null;
    applicationId: string | null;
    sessionId: string | null;
    sessionStatus: string | null;
    matchScore: number | null;
}

/**
 * Rank all candidates against a job by pgvector cosine similarity, calibrated to
 * 0-100. Shared by the recruiter "AI Matches" modal and the batch Hiring
 * Committee. Only candidates and jobs with embeddings participate.
 */
export async function getJobMatches(jobId: string): Promise<JobMatch[]> {
    const matches = await prisma.$queryRaw<any[]>`
        SELECT
            c.id,
            c.name,
            c.email,
            c.phone,
            c.skills,
            c."resumeUrl",
            c."resumeText",
            c."linkedinUrl",
            c."githubUrl",
            app.id as "applicationId",
            vs.id as "sessionId",
            vs.status as "sessionStatus",
            CASE
                WHEN j.embedding IS NOT NULL AND c.embedding IS NOT NULL
                THEN (1 - (j.embedding <=> c.embedding))
                ELSE NULL
            END as "matchScore"
        FROM candidates c
        LEFT JOIN applications app ON app."candidateId" = c.id AND app."jobId" = ${jobId}
        LEFT JOIN vetting_sessions vs ON vs."applicationId" = app.id
        CROSS JOIN job_postings j
        WHERE j.id = ${jobId}
          AND c.embedding IS NOT NULL
          AND j.embedding IS NOT NULL
        ORDER BY "matchScore" DESC
    `;

    return matches.map((match) => ({
        id: match.id,
        name: match.name,
        email: match.email,
        phone: match.phone,
        skills: match.skills || [],
        resumeUrl: match.resumeUrl,
        resumeText: match.resumeText,
        linkedinUrl: match.linkedinUrl || null,
        githubUrl: match.githubUrl || null,
        applicationId: match.applicationId || null,
        sessionId: match.sessionId || null,
        sessionStatus: match.sessionStatus || null,
        matchScore: calibrateScore(match.matchScore !== null ? Number(match.matchScore) : null),
    }));
}
