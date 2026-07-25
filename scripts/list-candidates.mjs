/**
 * Inspection helper: prints every candidate in the database with the fields
 * that matter for vetting (does a resume exist, which profile links were
 * captured, how many applications hang off them).
 *
 * Read-only. Run with:  node scripts/list-candidates.mjs
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";

const prisma = new PrismaClient();

const candidates = await prisma.candidate.findMany({
  select: {
    id: true,
    name: true,
    email: true,
    resumeUrl: true,
    resumeText: true,
    linkedinUrl: true,
    githubUrl: true,
    userId: true,
    createdAt: true,
    _count: { select: { applications: true } },
  },
  orderBy: { createdAt: "asc" },
});

console.log(`TOTAL CANDIDATES: ${candidates.length}\n`);
for (const c of candidates) {
  console.log(
    `- ${c.name} <${c.email}>\n` +
      `    id=${c.id} userId=${c.userId ?? "(none)"}\n` +
      `    resumeUrl=${c.resumeUrl ? "YES" : "NO"}  resumeText=${c.resumeText ? c.resumeText.length + " chars" : "NONE"}\n` +
      `    github=${c.githubUrl ?? "-"}  linkedin=${c.linkedinUrl ?? "-"}\n` +
      `    applications=${c._count.applications}  created=${c.createdAt.toISOString()}`
  );
}

const [users, apps, sessions, batches] = await Promise.all([
  prisma.user.count(),
  prisma.application.count(),
  prisma.vettingSession.count(),
  prisma.vettingBatch.count(),
]);
console.log(
  `\nUsers: ${users}, Applications: ${apps}, VettingSessions: ${sessions}, VettingBatches: ${batches}`
);

await prisma.$disconnect();
