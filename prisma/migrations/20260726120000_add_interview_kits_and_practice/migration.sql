-- ============================================================================
-- Interview Kits & Candidate Practice.  Design: docs/interview-practice-design.md
--
-- STATUS: DOCUMENTATION, NOT AN APPLIED MIGRATION.
--
-- This database is managed with `prisma db push`, not the migrate engine: it
-- has no `_prisma_migrations` table, so `prisma migrate status` reports every
-- migration in this folder as pending even though all their tables exist.
-- Running `prisma migrate deploy` would therefore start at the init migration,
-- hit "relation \"users\" already exists", and leave a failed-migration record
-- that needs `prisma migrate resolve` to clear.
--
-- These statements were applied via `npx prisma db push`. The file is kept as a
-- readable record of what changed. To move to real migrations later, baseline
-- first: `prisma migrate resolve --applied <name>` for every folder here, and
-- only then use `migrate deploy` going forward.
--
-- Purely additive: only CREATE TYPE / CREATE TABLE / CREATE INDEX /
-- ADD FOREIGN KEY, plus two nullable columns on "candidates".
-- ============================================================================

-- CreateEnum
CREATE TYPE "KitStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "KitDifficulty" AS ENUM ('WARMUP', 'CORE', 'STRETCH');

-- CreateEnum
CREATE TYPE "KitQuestionKind" AS ENUM ('CONTRADICTION', 'CLAIM_PROBE', 'JD_GAP', 'DEPTH', 'BEHAVIORAL');

-- CreateEnum
CREATE TYPE "PracticeSetStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PracticeProvenance" AS ENUM ('JOB_ONLY');

-- CreateEnum
CREATE TYPE "PracticeCategory" AS ENUM ('ROLE_MOTIVATION', 'PROJECT_WALKTHROUGH', 'BEHAVIORAL', 'TECHNICAL_CONCEPT', 'SYSTEM_DESIGN', 'PERSONAL');

-- CreateEnum
CREATE TYPE "MockStatus" AS ENUM ('CREATED', 'IN_PROGRESS', 'ANALYZING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MockMode" AS ENUM ('VIDEO', 'AUDIO', 'TEXT');

-- CreateEnum
CREATE TYPE "MockAnswerStatus" AS ENUM ('RECORDED', 'UPLOADED', 'ANALYZING', 'ANALYZED', 'FAILED');

-- CreateEnum
CREATE TYPE "ShareScope" AS ENUM ('CONTENT_ONLY');

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "personalQuestion" JSONB,
ADD COLUMN     "personalQuestionHash" TEXT;

-- CreateTable
CREATE TABLE "interview_kits" (
    "id" TEXT NOT NULL,
    "vettingSessionId" TEXT NOT NULL,
    "status" "KitStatus" NOT NULL DEFAULT 'READY',
    "instructions" TEXT,
    "agenda" JSONB,
    "referenceChecks" JSONB,
    "usage" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_kits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_kit_questions" (
    "id" TEXT NOT NULL,
    "kitId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "kind" "KitQuestionKind" NOT NULL DEFAULT 'CLAIM_PROBE',
    "targetsClaimId" TEXT,
    "claimStatus" TEXT,
    "why" TEXT NOT NULL DEFAULT '',
    "followUps" TEXT[],
    "rubric" JSONB,
    "difficulty" "KitDifficulty" NOT NULL DEFAULT 'CORE',
    "timeBoxMinutes" INTEGER,
    "askedAt" TIMESTAMP(3),
    "interviewerRating" INTEGER,
    "interviewerNotes" TEXT,

    CONSTRAINT "interview_kit_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_sets" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PracticeSetStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedFrom" "PracticeProvenance" NOT NULL DEFAULT 'JOB_ONLY',
    "publishedAt" TIMESTAMP(3),
    "usage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "practice_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_questions" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "category" "PracticeCategory" NOT NULL DEFAULT 'BEHAVIORAL',
    "competency" TEXT NOT NULL DEFAULT '',
    "targetSeconds" INTEGER NOT NULL DEFAULT 120,
    "rubric" JSONB,
    "followUpHints" TEXT[],

    CONSTRAINT "practice_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_interviews" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "practiceSetId" TEXT NOT NULL,
    "status" "MockStatus" NOT NULL DEFAULT 'CREATED',
    "mode" "MockMode" NOT NULL DEFAULT 'TEXT',
    "accessibilityMode" BOOLEAN NOT NULL DEFAULT false,
    "overallScore" DOUBLE PRECISION,
    "dimensionScores" JSONB,
    "coaching" JSONB,
    "usage" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "mock_interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_answers" (
    "id" TEXT NOT NULL,
    "mockInterviewId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "isFinal" BOOLEAN NOT NULL DEFAULT true,
    "answerText" TEXT,
    "mediaUrl" TEXT,
    "mediaPublicId" TEXT,
    "mimeType" TEXT,
    "durationSeconds" DOUBLE PRECISION,
    "transcript" JSONB,
    "metrics" JSONB,
    "faceTimeline" JSONB,
    "analysis" JSONB,
    "score" DOUBLE PRECISION,
    "status" "MockAnswerStatus" NOT NULL DEFAULT 'RECORDED',
    "errorMessage" TEXT,
    "analysisAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mock_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_interview_shares" (
    "id" TEXT NOT NULL,
    "mockInterviewId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "scope" "ShareScope" NOT NULL DEFAULT 'CONTENT_ONLY',
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "mock_interview_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "interview_kits_vettingSessionId_key" ON "interview_kits"("vettingSessionId");

-- CreateIndex
CREATE INDEX "interview_kit_questions_kitId_order_idx" ON "interview_kit_questions"("kitId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "practice_sets_jobId_version_key" ON "practice_sets"("jobId", "version");

-- CreateIndex
CREATE INDEX "practice_questions_setId_order_idx" ON "practice_questions"("setId", "order");

-- CreateIndex
CREATE INDEX "mock_interviews_candidateId_jobId_idx" ON "mock_interviews"("candidateId", "jobId");

-- CreateIndex
CREATE INDEX "mock_answers_mockInterviewId_idx" ON "mock_answers"("mockInterviewId");

-- CreateIndex
CREATE UNIQUE INDEX "mock_answers_mockInterviewId_questionId_attemptNo_key" ON "mock_answers"("mockInterviewId", "questionId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "mock_interview_shares_mockInterviewId_key" ON "mock_interview_shares"("mockInterviewId");

-- CreateIndex
CREATE INDEX "mock_interview_shares_applicationId_idx" ON "mock_interview_shares"("applicationId");

-- AddForeignKey
ALTER TABLE "interview_kits" ADD CONSTRAINT "interview_kits_vettingSessionId_fkey" FOREIGN KEY ("vettingSessionId") REFERENCES "vetting_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_kit_questions" ADD CONSTRAINT "interview_kit_questions_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "interview_kits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_sets" ADD CONSTRAINT "practice_sets_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_questions" ADD CONSTRAINT "practice_questions_setId_fkey" FOREIGN KEY ("setId") REFERENCES "practice_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interviews" ADD CONSTRAINT "mock_interviews_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interviews" ADD CONSTRAINT "mock_interviews_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interviews" ADD CONSTRAINT "mock_interviews_practiceSetId_fkey" FOREIGN KEY ("practiceSetId") REFERENCES "practice_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_answers" ADD CONSTRAINT "mock_answers_mockInterviewId_fkey" FOREIGN KEY ("mockInterviewId") REFERENCES "mock_interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_answers" ADD CONSTRAINT "mock_answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "practice_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interview_shares" ADD CONSTRAINT "mock_interview_shares_mockInterviewId_fkey" FOREIGN KEY ("mockInterviewId") REFERENCES "mock_interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interview_shares" ADD CONSTRAINT "mock_interview_shares_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Follow-up, applied in the same way (db push): make the PERSONAL practice
-- question answerable.
--
-- It is generated from ONE candidate's own resume, so it is scoped to that
-- candidate and reads filter on `candidateId IS NULL OR candidateId = :me`.
-- Without the scope, every applicant for a job would be shown the question
-- written from some other applicant's resume.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "practice_questions" ADD COLUMN     "candidateId" TEXT;

-- CreateIndex
CREATE INDEX "practice_questions_setId_candidateId_idx" ON "practice_questions"("setId", "candidateId");

-- AddForeignKey
ALTER TABLE "practice_questions" ADD CONSTRAINT "practice_questions_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
