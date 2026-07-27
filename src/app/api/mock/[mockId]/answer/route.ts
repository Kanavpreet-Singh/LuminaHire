import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { judgeAndPersistAnswer, dispatchMediaAnalysis } from "@/lib/interview";

/**
 * Submit one answer to a practice question, then score it.
 *
 * RETAKES ARE FIRST-CLASS. Re-answering the same question creates attempt N+1
 * and demotes the previous attempt's isFinal flag; only the final attempt is
 * scored and counted. Rehearsal is the product — a tool that punishes a second
 * take is not a practice tool. It also keeps retakes cheap: nothing is judged
 * until the candidate commits.
 *
 * PERSISTENCE PRECEDES ANALYSIS, ALWAYS. The answer row is written before the
 * judge is called, and a judging failure leaves it FAILED with its content
 * intact rather than losing it. In VIDEO mode this is what stops a background
 * job from destroying a take the candidate can't easily record again.
 */
export async function POST(
    req: Request,
    { params }: { params: Promise<{ mockId: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "CANDIDATE") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { mockId } = await params;
        const body = await req.json().catch(() => ({}));
        const questionId = typeof body.questionId === "string" ? body.questionId : "";
        const answerText = typeof body.answerText === "string" ? body.answerText.trim() : "";
        const mediaUrl = typeof body.mediaUrl === "string" ? body.mediaUrl : "";
        const mediaKey = typeof body.mediaKey === "string" ? body.mediaKey : null;
        const mimeType = typeof body.mimeType === "string" ? body.mimeType : null;
        const durationSeconds = Number.isFinite(Number(body.durationSeconds))
            ? Number(body.durationSeconds)
            : null;
        const faceTrack = Array.isArray(body.faceTrack) ? body.faceTrack : null;

        if (!questionId) return new NextResponse("Missing questionId", { status: 400 });
        if (!answerText && !mediaUrl) {
            return new NextResponse("Provide either answerText or mediaUrl", { status: 400 });
        }
        // Bounded before it reaches Python. ~15 Hz x 180 s is roughly 2,700
        // rows; anything far past that is a client bug or a deliberate flood.
        if (faceTrack && faceTrack.length > 6000) {
            return new NextResponse("Face track too large", { status: 413 });
        }

        const candidate = await prisma.candidate.findUnique({
            where: { userId: session.user.id! },
            select: { id: true },
        });
        if (!candidate) return new NextResponse("No candidate profile", { status: 404 });

        const mock = await prisma.mockInterview.findUnique({
            where: { id: mockId },
            include: { job: { select: { title: true } }, practiceSet: { select: { id: true } } },
        });
        if (!mock) return new NextResponse("Mock interview not found", { status: 404 });
        if (mock.candidateId !== candidate.id) return new NextResponse("Forbidden", { status: 403 });

        // The question must belong to the set this attempt was started against,
        // or an answer would be scored against a rubric from a different job.
        const question = await prisma.practiceQuestion.findUnique({ where: { id: questionId } });
        if (!question || question.setId !== mock.practiceSetId) {
            return new NextResponse("Question does not belong to this practice set", { status: 400 });
        }

        const previous = await prisma.mockAnswer.findMany({
            where: { mockInterviewId: mockId, questionId },
            orderBy: { attemptNo: "desc" },
            take: 1,
        });
        const attemptNo = (previous[0]?.attemptNo ?? 0) + 1;

        const answer = await prisma.$transaction(async (tx) => {
            await tx.mockAnswer.updateMany({
                where: { mockInterviewId: mockId, questionId },
                data: { isFinal: false },
            });
            return tx.mockAnswer.create({
                data: {
                    mockInterviewId: mockId,
                    questionId,
                    attemptNo,
                    isFinal: true,
                    answerText: answerText || null,
                    mediaUrl: mediaUrl || null,
                    mediaPublicId: mediaKey,
                    mimeType,
                    durationSeconds,
                    status: "UPLOADED",
                    // Media retention default. Null would mean "keep forever";
                    // the candidate can pin an attempt to clear this.
                    ...(mediaUrl
                        ? { expiresAt: new Date(Date.now() + RETENTION_DAYS * 86_400_000) }
                        : {}),
                },
            });
        });

        // Media answers analyze in the background: ASR is CPU-bound and can take
        // a minute, which no HTTP request should hold open. Text answers are one
        // fast LLM call, so they stay synchronous and return their score inline.
        if (mediaUrl) {
            await dispatchMediaAnalysis(answer.id, {
                mediaUrl,
                question: {
                    prompt: question.prompt,
                    category: question.category,
                    targetSeconds: question.targetSeconds,
                    rubric: question.rubric,
                },
                faceTrack,
                mode: mock.mode,
                accessibilityMode: mock.accessibilityMode,
                jobTitle: mock.job.title,
                durationSeconds,
            });
            const dispatched = await prisma.mockAnswer.findUnique({
                where: { id: answer.id },
                include: { question: true },
            });
            return NextResponse.json({ answer: dispatched, analyzing: true });
        }

        try {
            const judged = await judgeAndPersistAnswer(answer.id, mock.job.title);
            return NextResponse.json({ answer: judged });
        } catch (judgeError: any) {
            // The answer is safely stored; only scoring failed. Return 200 with
            // the row so the UI can show "saved, scoring failed — retry" rather
            // than an error that implies the answer was lost.
            console.error("Answer judging failed:", judgeError);
            const saved = await prisma.mockAnswer.findUnique({
                where: { id: answer.id },
                include: { question: true },
            });
            return NextResponse.json({
                answer: saved,
                warning: "Your answer was saved, but scoring failed. You can retry scoring without re-recording.",
            });
        }
    } catch (error: any) {
        console.error("Error submitting mock answer:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}

// Recordings are candidate-owned and expire by default; a sweep deletes the
// blob by mediaPublicId. The candidate can pin an attempt to keep it.
const RETENTION_DAYS = Number(process.env.MOCK_MEDIA_RETENTION_DAYS || 30);
