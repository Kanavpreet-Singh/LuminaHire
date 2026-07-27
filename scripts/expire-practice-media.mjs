/**
 * Retention sweep for practice recordings.
 *
 * Practice recordings default to a 30-day life (MockAnswer.expiresAt, set when
 * the answer is created). A practice tool should not quietly become a permanent
 * archive of people's faces, so this deletes the blob and clears the pointer
 * once that window passes. Candidates can pin a session
 * (POST /api/mock/:id/pin) to set expiresAt = null and keep it indefinitely.
 *
 * WHAT IS AND IS NOT DELETED. The media blob goes; the row stays. Scores,
 * transcript, metrics, and coaching are what make a session worth revisiting
 * months later, and none of them are biometric. Only the recording itself is.
 * `mediaUrl` is nulled so the UI stops offering a dead player, and
 * `mediaPublicId` is kept so a failed delete can be retried against a known key.
 *
 * Run from cron, or by hand:
 *   Dry run (default, changes nothing):  node scripts/expire-practice-media.mjs
 *   Execute:                             node scripts/expire-practice-media.mjs --yes
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { UTApi } from "uploadthing/server";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--yes");
const utapi = new UTApi();

const expired = await prisma.mockAnswer.findMany({
    where: {
        expiresAt: { not: null, lte: new Date() },
        mediaUrl: { not: null },
    },
    select: {
        id: true,
        mediaPublicId: true,
        mediaUrl: true,
        expiresAt: true,
        mockInterview: { select: { id: true, candidate: { select: { email: true } } } },
    },
});

console.log(`${expired.length} recording(s) past their retention window.`);
for (const a of expired) {
    console.log(`  ${a.mockInterview.candidate.email}  expired ${a.expiresAt.toISOString().slice(0, 10)}`);
}

if (!EXECUTE) {
    console.log("\nDry run. Re-run with --yes to delete the blobs.");
    await prisma.$disconnect();
    process.exit(0);
}

let deleted = 0;
let failed = 0;

for (const answer of expired) {
    try {
        if (answer.mediaPublicId) {
            await utapi.deleteFiles(answer.mediaPublicId);
        }
        // Clear the pointer whether or not a key was recorded. An answer with a
        // URL we can no longer resolve is worse than one with no URL: it renders
        // a broken player and implies the recording still exists.
        await prisma.mockAnswer.update({
            where: { id: answer.id },
            data: { mediaUrl: null, expiresAt: null },
        });
        deleted++;
    } catch (error) {
        // Leave expiresAt in place so the next sweep retries. A storage outage
        // must not silently mark data as deleted when it still exists.
        failed++;
        console.error(`  failed for answer ${answer.id}: ${error.message}`);
    }
}

console.log(`\nDeleted ${deleted} recording(s).${failed ? ` ${failed} failed and will retry next sweep.` : ""}`);
await prisma.$disconnect();
