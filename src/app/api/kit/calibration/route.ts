import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

/**
 * Loop closure: what interviewers actually found, against what the verification
 * pipeline ruled.
 *
 * This is the compounding part of the design. Every rating a recruiter writes
 * into an Interview Kit produces a (claim, automated verdict, human outcome)
 * triple, and those triples are the ONLY data that can answer the question the
 * whole product rests on: are the rulings right?
 *
 * Two things it can tell you that nothing else can:
 *
 *   PRECISION ON `CONTRADICTED`. A false CONTRADICTED is the most damaging
 *   output this system can produce — a candidate publicly accused of inflating
 *   a figure they actually hit. If contradicted claims consistently score well
 *   in person, the extractor or the numeric guard is wrong, not the candidate.
 *
 *   WHETHER `UNVERIFIABLE` IS FAIR. The product's central bet is that
 *   unverifiable claims are usually just private work, and so must never cost a
 *   candidate points. If they interview roughly as well as verified claims,
 *   that bet is holding. If they interview far worse, the neutral treatment is
 *   too generous and deserves revisiting.
 *
 * Recruiter-scoped: a recruiter sees calibration over their own interviews only.
 */
export async function GET() {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const rated = await prisma.interviewKitQuestion.findMany({
            where: {
                interviewerRating: { not: null },
                kit: { vettingSession: { application: { job: { recruiterId: session.user.id } } } },
            },
            select: {
                interviewerRating: true,
                claimStatus: true,
                kind: true,
                targetsClaimId: true,
                interviewerNotes: true,
                kit: {
                    select: {
                        vettingSessionId: true,
                        vettingSession: {
                            select: { application: { select: { candidate: { select: { name: true } } } } },
                        },
                    },
                },
            },
            orderBy: { askedAt: "desc" },
            take: 500,
        });

        const buckets: Record<string, { ratings: number[]; label: string }> = {
            CONTRADICTED: { ratings: [], label: "Claims the evidence contradicted" },
            UNVERIFIABLE: { ratings: [], label: "Claims no public source could settle" },
            UNCHECKED: { ratings: [], label: "Claims a source existed for but wasn't read" },
            VERIFIED: { ratings: [], label: "Claims already verified (depth questions only)" },
            NONE: { ratings: [], label: "Questions not tied to a claim" },
        };

        for (const q of rated) {
            const key = q.claimStatus && buckets[q.claimStatus] ? q.claimStatus : "NONE";
            buckets[key].ratings.push(q.interviewerRating!);
        }

        const byStatus = Object.entries(buckets)
            .filter(([, b]) => b.ratings.length > 0)
            .map(([status, b]) => ({
                status,
                label: b.label,
                count: b.ratings.length,
                meanRating: round2(b.ratings.reduce((a, c) => a + c, 0) / b.ratings.length),
                // Share rated 4-5. The headline number: how often the interview
                // went well for claims in this bucket.
                strongShare: round2(b.ratings.filter((r) => r >= 4).length / b.ratings.length),
                weakShare: round2(b.ratings.filter((r) => r <= 2).length / b.ratings.length),
            }))
            .sort((a, b) => b.count - a.count);

        // The individually reviewable cases: a contradiction the candidate
        // answered well is either a stale figure or a bad ruling, and either way
        // a human should look at it.
        const contradictionsAnsweredWell = rated
            .filter((q) => q.claimStatus === "CONTRADICTED" && (q.interviewerRating ?? 0) >= 4)
            .slice(0, 20)
            .map((q) => ({
                sessionId: q.kit.vettingSessionId,
                candidate: q.kit.vettingSession.application.candidate.name,
                claimId: q.targetsClaimId,
                rating: q.interviewerRating,
                notes: q.interviewerNotes,
            }));

        const contradicted = buckets.CONTRADICTED.ratings;
        return NextResponse.json({
            totalRated: rated.length,
            byStatus,
            contradictionsAnsweredWell,
            // Stated rather than inferred by the reader: below this, the numbers
            // above are anecdotes, and presenting them as a rate would invite a
            // decision they can't support.
            sampleSufficient: rated.length >= 30,
            falseContradictionRate:
                contradicted.length >= 5
                    ? round2(contradicted.filter((r) => r >= 4).length / contradicted.length)
                    : null,
        });
    } catch (error: any) {
        console.error("Error building kit calibration:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
