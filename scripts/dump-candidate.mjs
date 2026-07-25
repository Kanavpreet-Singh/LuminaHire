/**
 * Dump one candidate as the JSON payload shape the Python vetting API expects.
 * Used to drive end-to-end tests against real data rather than fixtures.
 *
 *   node scripts/dump-candidate.mjs <email> > payload.json
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";

const email = process.argv[2];
if (!email) {
    console.error("Usage: node scripts/dump-candidate.mjs <email>");
    process.exit(1);
}

const prisma = new PrismaClient();
const c = await prisma.candidate.findUnique({ where: { email } });
if (!c) {
    console.error(`No candidate with email ${email}`);
    process.exit(1);
}

console.log(
    JSON.stringify(
        {
            name: c.name,
            email: c.email,
            resume_text: c.resumeText,
            linkedin_url: c.linkedinUrl,
            github_url: c.githubUrl,
        },
        null,
        2
    )
);

await prisma.$disconnect();
