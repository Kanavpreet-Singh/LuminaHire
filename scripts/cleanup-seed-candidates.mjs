/**
 * One-off cleanup: remove the seeded demo candidates, keeping only the real
 * accounts listed in KEEP_EMAILS.
 *
 * Deletes, in dependency order (Prisma cascades handle the middle two):
 *   candidate -> applications -> vetting sessions, then the candidate's own
 *   User login row (which does NOT cascade from Candidate, so it is removed
 *   explicitly or it would be left orphaned).
 *
 * Recruiter users are never touched: only User rows that belong to a deleted
 * candidate AND have role CANDIDATE are removed.
 *
 * Dry run (default, changes nothing):  node scripts/cleanup-seed-candidates.mjs
 * Execute:                             node scripts/cleanup-seed-candidates.mjs --yes
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--yes");

// Real accounts to preserve. Everything else is seeded demo data.
const KEEP_EMAILS = ["kanavpreetsingh2005@gmail.com", "kps142005@gmail.com"];

const doomed = await prisma.candidate.findMany({
  where: { email: { notIn: KEEP_EMAILS } },
  select: {
    id: true,
    name: true,
    email: true,
    userId: true,
    _count: { select: { applications: true } },
  },
});

const kept = await prisma.candidate.findMany({
  where: { email: { in: KEEP_EMAILS } },
  select: { name: true, email: true, _count: { select: { applications: true } } },
});

console.log(`MODE: ${EXECUTE ? "EXECUTE (destructive)" : "DRY RUN (no changes)"}\n`);
console.log(`KEEPING ${kept.length} candidate(s):`);
for (const c of kept) console.log(`  + ${c.name} <${c.email}> (${c._count.applications} applications)`);

console.log(`\nDELETING ${doomed.length} candidate(s):`);
for (const c of doomed) console.log(`  - ${c.name} <${c.email}> (${c._count.applications} applications)`);

const doomedUserIds = doomed.map((c) => c.userId).filter(Boolean);
const doomedUsers = await prisma.user.findMany({
  where: { id: { in: doomedUserIds }, role: "CANDIDATE" },
  select: { id: true, email: true, role: true },
});
console.log(`\nDELETING ${doomedUsers.length} orphaned CANDIDATE user account(s).`);

const recruiters = await prisma.user.count({ where: { role: "RECRUITER" } });
console.log(`PRESERVING ${recruiters} recruiter account(s) — never touched by this script.`);

if (!EXECUTE) {
  console.log("\nDry run complete. Re-run with --yes to apply.");
  await prisma.$disconnect();
  process.exit(0);
}

// Applications and vetting sessions cascade from Candidate; batch membership
// is SetNull, so surviving batches detach cleanly rather than erroring.
const delCandidates = await prisma.candidate.deleteMany({
  where: { email: { notIn: KEEP_EMAILS } },
});
const delUsers = await prisma.user.deleteMany({
  where: { id: { in: doomedUserIds }, role: "CANDIDATE" },
});

// Batches whose member sessions are all gone are demo leftovers with nothing
// left to show; drop those so the recruiter UI isn't listing empty runs.
const emptyBatches = await prisma.vettingBatch.findMany({
  where: { sessions: { none: {} } },
  select: { id: true },
});
const delBatches = await prisma.vettingBatch.deleteMany({
  where: { id: { in: emptyBatches.map((b) => b.id) } },
});

console.log(
  `\nDeleted: ${delCandidates.count} candidates, ${delUsers.count} users, ${delBatches.count} empty batches.`
);

const [candidates, users, apps, sessions, batches] = await Promise.all([
  prisma.candidate.count(),
  prisma.user.count(),
  prisma.application.count(),
  prisma.vettingSession.count(),
  prisma.vettingBatch.count(),
]);
console.log(
  `Remaining -> candidates: ${candidates}, users: ${users}, applications: ${apps}, sessions: ${sessions}, batches: ${batches}`
);

await prisma.$disconnect();
