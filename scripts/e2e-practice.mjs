/**
 * End-to-end regression for Interview Kits & Candidate Practice.
 *
 * Drives the REAL Next.js routes with REAL auth cookies against the real
 * database and the Python service. Nothing is stubbed except the LLM, which
 * runs in mock mode so the suite is free, deterministic, and needs no API key.
 *
 * PREREQUISITES — both services running, Python in mock mode:
 *   Terminal 1:  cd python; $env:MOCK_AI_RESPONSES="1"; python -m uvicorn main:app --port 8000
 *   Terminal 2:  $env:MOCK_AI_RESPONSES="1"; npx next dev --port 3111
 *   Terminal 3:  node scripts/e2e-practice.mjs
 *
 * Point it elsewhere with E2E_BASE_URL (default http://127.0.0.1:3111).
 *
 * TEST DATA. Creates two throwaway candidates on @example.test and seeds a
 * completed vetting session so the kit and share paths have something to work
 * against. Deletes all of it on the way out unless you pass --keep. It never
 * touches accounts that don't end in @example.test.
 *
 * WHAT THE IMPORTANT CHECKS ARE. Most of these are ordinary happy-path
 * assertions, but four exist because breaking them would be a privacy or
 * fairness failure rather than a bug:
 *   - the raw per-frame face track is never persisted
 *   - a shared session carries no delivery/presence/metric/media field
 *   - one candidate cannot see another's résumé-derived question
 *   - a VERIFIED claim is never re-asked as a plain probe
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:3111";
const KEEP = process.argv.includes("--keep");

const CAND = { email: "e2e-candidate@example.test", password: "TestPass123!" };
const CAND2 = { email: "e2e-other@example.test", password: "TestPass123!" };
const REC = { email: "john.doe@luminahire.com", password: "JohnDoe@2026" };

const prisma = new PrismaClient();
let pass = 0;
const failures = [];

function check(name, ok, detail = "") {
    if (ok) {
        pass++;
        console.log(`  ok    ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name} ${detail}`);
    }
}
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(creds, name) {
    await fetch(`${BASE}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email: creds.email, password: creds.password, role: "CANDIDATE" }),
    });
}

/** Log in through the real NextAuth credentials flow and return a fetch bound to the cookie jar. */
async function login(creds) {
    const jar = new Map();
    const put = (res) => {
        for (const [k, v] of res.headers) {
            if (k.toLowerCase() !== "set-cookie") continue;
            for (const c of v.split(/,(?=[^;]+=)/)) {
                const [pair] = c.split(";");
                const i = pair.indexOf("=");
                jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
            }
        }
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

    let res = await fetch(`${BASE}/api/auth/csrf`);
    put(res);
    const { csrfToken } = await res.json();
    res = await fetch(`${BASE}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookie() },
        body: new URLSearchParams({ csrfToken, ...creds, redirect: "false", callbackUrl: BASE }),
        redirect: "manual",
    });
    put(res);
    return (path, init = {}) =>
        fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers || {}), cookie: cookie() } });
}

const json = (fn, path, init) => fn(path, init).then((r) => r.json());

async function waitAnalyzed(c, mockId, tries = 20) {
    for (let i = 0; i < tries; i++) {
        await sleep(1000);
        const d = await json(c, `/api/mock/${mockId}`);
        if (!d.mockInterview.answers.some((a) => a.status === "ANALYZING")) return d;
    }
    return json(c, `/api/mock/${mockId}`);
}

/** A face track with a deliberate 5-second look-away, so the metric has a known answer. */
function faceTrack() {
    return Array.from({ length: 200 }, (_, i) => {
        const t = i / 15;
        const away = t >= 4 && t <= 9;
        return {
            t: +t.toFixed(2), present: true, yaw: away ? 65 : 4, pitch: 2, roll: 0,
            bbox: [0.4, 0.28, 0.2, 0.26],
            bs: { smile: i % 20 ? 0.2 : 0.03, browDown: 0.02, blink: i % 40 === 0 ? 0.9 : 0.05 },
        };
    });
}

/**
 * Setup the HTTP API can't do: a résumé (normally a parsed PDF upload) and a
 * completed vetting session (normally a full pipeline run). Everything the
 * suite asserts on still goes through the real routes.
 */
async function seed() {
    const resume =
        "Machine learning engineer. Built a distributed training pipeline in PyTorch across 64 GPUs, " +
        "owning the gradient synchronization layer. Led incident response for a model-serving outage. " +
        "No production system design or scope negotiation experience.";

    for (const email of [CAND.email, CAND2.email]) {
        const u = await prisma.user.findUnique({ where: { email } });
        if (u) {
            await prisma.candidate.update({
                where: { userId: u.id },
                data: { resumeText: resume, skills: ["Python", "PyTorch", "distributed training"] },
            });
        }
    }

    const rec = await prisma.user.findUnique({ where: { email: REC.email } });
    if (!rec) throw new Error("Demo recruiter missing — POST /api/demo-recruiter first.");
    const job = await prisma.jobPosting.findFirst({ where: { recruiterId: rec.id, status: "OPEN" } });
    if (!job) throw new Error("The demo recruiter has no OPEN job. Create one, then re-run.");

    const cand = await prisma.candidate.findUnique({ where: { email: CAND.email } });
    const app = await prisma.application.upsert({
        where: { candidateId_jobId: { candidateId: cand.id, jobId: job.id } },
        create: { candidateId: cand.id, jobId: job.id },
        update: {},
    });

    // One of each ruling, so the kit's sourcing rules are actually exercised.
    const finalReport = {
        overall_fit_percentage: 65,
        claim_verdicts: [
            { id: "C1", claim: "Solved 1000+ LeetCode problems", status: "CONTRADICTED", claimed_value: 1000, observed_value: 214 },
            { id: "C2", claim: "Built the distributed training pipeline", status: "UNVERIFIABLE" },
            { id: "C3", claim: "Maintains an npm package", status: "VERIFIED" },
            { id: "C4", claim: "Contributed to an OSS scheduler", status: "UNCHECKED" },
        ],
        gaps_or_concerns: ["No production Kafka experience shown"],
    };
    const payload = {
        status: "COMPLETED", finalReport, evaluation: finalReport,
        researchPlan: { company_vetting: ["What was their scope on the pipeline?"] },
    };
    const sess = await prisma.vettingSession.upsert({
        where: { applicationId: app.id },
        create: { applicationId: app.id, ...payload },
        update: payload,
    });

    return { jobId: job.id, applicationId: app.id, sessionId: sess.id };
}

async function cleanup() {
    for (const email of [CAND.email, CAND2.email]) {
        const u = await prisma.user.findUnique({ where: { email } });
        // Cascades through candidate -> applications -> sessions -> kits, mocks,
        // shares, and the candidate-scoped personal question.
        if (u) await prisma.user.delete({ where: { id: u.id } });
    }
}

async function main() {
    console.log(`LuminaHire practice/kit regression against ${BASE}\n`);

    await register(CAND, "E2E Tester");
    await register(CAND2, "E2E Other");
    await fetch(`${BASE}/api/demo-recruiter`, { method: "POST" });
    const seeded = await seed();

    const c = await login(CAND);
    const c2 = await login(CAND2);
    const r = await login(REC);

    section("auth");
    check("candidate signs in", (await json(c, "/api/auth/session"))?.user?.role === "CANDIDATE");
    check("recruiter signs in", (await json(r, "/api/auth/session"))?.user?.role === "RECRUITER");

    const jobs = await json(c, "/api/jobs?query=");
    const job = jobs.find((j) => j.id === seeded.jobId);
    check("seeded job is visible", !!job);

    section("practice sets — the leak boundary");
    const set = await json(c, `/api/jobs/${job.id}/practice-set`);
    check("set generates on first read", set.set.questions.length > 0);
    check("payload has no vetting-session linkage", !JSON.stringify(set).includes("vettingSession"));
    check("second read is cached", (await json(c, `/api/jobs/${job.id}/practice-set`)).set.id === set.set.id);

    const personal = set.set.questions.find((q) => q.category === "PERSONAL");
    check("résumé question is answerable", !!personal);
    const other = await json(c2, `/api/jobs/${job.id}/practice-set`);
    check("another candidate cannot see it", !other.set.questions.some((q) => q.id === personal?.id));

    section("typed answers");
    const m = (await json(c, "/api/mock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, mode: "TEXT" }),
    })).mockInterview;
    check("session starts", m.mode === "TEXT");
    check("session includes the résumé question", m.practiceSet.questions.some((q) => q.category === "PERSONAL"));

    const a0 = (await json(c, `/api/mock/${m.id}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: m.practiceSet.questions[0].id, answerText: "I led the migration. ".repeat(30) }),
    })).answer;
    check("typed answer scores inline", a0.status === "ANALYZED" && typeof a0.score === "number");
    check("typing has no delivery score", !("delivery" in (a0.analysis.scores || {})));
    check("a foreign question is rejected",
        (await c(`/api/mock/${m.id}/answer`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionId: "bogus", answerText: "x" }),
        })).status === 400);
    check("another candidate cannot read the session", (await c2(`/api/mock/${m.id}`)).status === 403);

    section("recorded answers");
    const vm = (await json(c, "/api/mock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, mode: "VIDEO" }),
    })).mockInterview;
    const vq = vm.practiceSet.questions[0];
    const disp = await json(c, `/api/mock/${vm.id}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            questionId: vq.id, mediaUrl: "https://example.test/take.webm",
            mimeType: "video/webm", durationSeconds: 133, faceTrack: faceTrack(),
        }),
    });
    check("analysis dispatches in the background", disp.analyzing === true && disp.answer.status === "ANALYZING");

    const va = (await waitAnalyzed(c, vm.id)).mockInterview.answers[0];
    check("polling persists the result", va.status === "ANALYZED", `(${va.status})`);
    check("presence is scored", typeof va.analysis?.scores?.presence === "number");
    check("delivery is scored", typeof va.analysis?.scores?.delivery === "number");
    check("speech timeline stored for the ribbon", (va.metrics?.speech_timeline || []).length > 0);
    check("face timeline downsampled to 1 Hz", (va.faceTimeline || []).length > 0);
    check("PRIVACY: raw face track is not persisted",
        !JSON.stringify(va.metrics || {}).includes("browDown"));
    check("look-away measured from the real track", (va.metrics?.longest_look_away_s ?? 0) >= 4,
        `(got ${va.metrics?.longest_look_away_s})`);

    section("expression reading (valence–arousal)");
    check("affect estimated from the face track", va.metrics?.affect_available === true);
    check("valence and arousal are in range",
        Math.abs(va.metrics?.valence_mean ?? 9) <= 1 && Math.abs(va.metrics?.arousal_mean ?? 9) <= 1,
        `(v=${va.metrics?.valence_mean} a=${va.metrics?.arousal_mean})`);
    check("expression timeline stored for the ribbon", (va.metrics?.affect_timeline || []).length > 0);
    check("backend is reported", typeof va.metrics?.affect_backend === "string");

    // Affect is DESCRIPTION, not assessment. It has no band in scoring.py, so
    // it must be incapable of moving the candidate's number.
    check("FAIRNESS: affect is not a scored dimension",
        !Object.keys(va.analysis?.scores || {}).some((k) => /affect|valence|arousal|emotion/i.test(k)),
        `(${Object.keys(va.analysis?.scores || {}).join(",")})`);
    check("FAIRNESS: affect is not in any band detail",
        !JSON.stringify(va.analysis?.band_detail || {}).match(/valence|arousal|affect/i));

    const summary = va.analysis?.coaching?.delivery_summary;
    check("delivery paragraph is written", typeof summary?.paragraph === "string" && summary.paragraph.length > 40);
    check("improvements are capped at two", (summary?.improvements || []).length <= 2);
    // No emotion word may reach the candidate — we describe what the face did.
    check("NO emotion labels in the paragraph",
        !/\b(happy|sad|angry|fearful|disgust(ed)?|surprised|nervous|anxious)\b/i.test(summary?.paragraph || ""),
        `("${(summary?.paragraph || "").slice(0, 80)}")`);

    await json(c, `/api/mock/${vm.id}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: vq.id, mediaUrl: "https://example.test/take2.webm", durationSeconds: 120 }),
    });
    const takes = (await waitAnalyzed(c, vm.id)).mockInterview.answers.filter((a) => a.questionId === vq.id);
    check("only the latest take counts", takes.filter((t) => t.isFinal).length === 1);
    check("retake is attempt 2", takes.find((t) => t.isFinal).attemptNo === 2);

    section("unbounded queue — top-up by category");
    const before = (await json(c, `/api/mock/${m.id}`)).mockInterview.practiceSet.questions;
    const topUp = await json(c, `/api/mock/${m.id}/questions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "SYSTEM_DESIGN", count: 3 }),
    });
    check("top-up returns new questions", (topUp.questions || []).length > 0,
        `(${JSON.stringify(topUp).slice(0, 90)})`);
    check("all top-ups are the requested category",
        (topUp.questions || []).every((q) => q.category === "SYSTEM_DESIGN"));

    const after = (await json(c, `/api/mock/${m.id}`)).mockInterview.practiceSet.questions;
    check("queue grew", after.length > before.length, `(${before.length} -> ${after.length})`);
    check("top-ups sort after the original set",
        after.slice(before.length).every((q) => q.order > 100));

    const prompts = after.map((q) => q.prompt.trim().toLowerCase());
    check("no duplicate questions in the queue", new Set(prompts).size === prompts.length);

    // Candidate-scoped, exactly like the résumé question: one candidate topping
    // up must not rewrite what every other applicant practises against.
    const otherQueue = (await json(c2, `/api/jobs/${job.id}/practice-set`)).set.questions;
    check("SCOPING: top-ups are invisible to another candidate",
        !otherQueue.some((q) => topUp.questions.some((t) => t.id === q.id)));

    check("an unknown category falls back rather than 500ing",
        (await c(`/api/mock/${m.id}/questions`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: "NONSENSE", count: 1 }),
        })).status < 500);
    check("another candidate cannot top up this session",
        (await c2(`/api/mock/${m.id}/questions`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: "BEHAVIORAL" }),
        })).status === 403);

    section("accessibility mode");
    const am = (await json(c, "/api/mock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, mode: "VIDEO", accessibilityMode: true }),
    })).mockInterview;
    await json(c, `/api/mock/${am.id}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            questionId: am.practiceSet.questions[0].id,
            mediaUrl: "https://example.test/take3.webm", durationSeconds: 100, faceTrack: faceTrack(),
        }),
    });
    const aa = (await waitAnalyzed(c, am.id)).mockInterview.answers[0];
    check("FAIRNESS: opting out drops delivery and presence",
        !("delivery" in (aa.analysis?.scores || {})) && !("presence" in (aa.analysis?.scores || {})));
    check("opting out still scores content in full", typeof aa.analysis?.scores?.content === "number");

    section("finish and retention");
    const fin = (await json(c, `/api/mock/${vm.id}/finalize`, { method: "POST" })).mockInterview;
    check("session finalizes", fin.status === "COMPLETED" && typeof fin.overallScore === "number");
    const pinned = await json(c, `/api/mock/${vm.id}/pin`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }),
    });
    check("pinning clears the retention clock", pinned.pinned === true && pinned.recordings > 0);
    check("pinned recordings have no expiry",
        (await json(c, `/api/mock/${vm.id}`)).mockInterview.answers
            .filter((a) => a.mediaUrl).every((a) => a.expiresAt === null));

    section("sharing — the content-only boundary");
    const preview = await json(c, `/api/mock/${vm.id}/share`);
    const blob = JSON.stringify(preview.preview);
    for (const banned of [
        "delivery", "presence", "articulation", "faceTimeline", "metrics", "mediaUrl", "stall",
        // Expression reading is candidate-private. FER carries documented racial
        // bias, so this must be structurally unable to reach a hiring decision.
        "valence", "arousal", "affect", "blendshape",
    ]) {
        check(`PRIVACY: preview excludes "${banned}"`, !blob.includes(banned));
    }
    check("preview keeps the content score", preview.preview.scores.content !== undefined);

    check("share can be granted", !!(await json(c, `/api/mock/${vm.id}/share`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId: seeded.applicationId }),
    })).share);

    const seen = await json(r, `/api/vet/session/${seeded.sessionId}/shared-practice`);
    check("recruiter sees the shared session", !!seen.shared);
    const seenBlob = JSON.stringify(seen.shared || {});
    check("PRIVACY: recruiter payload leaks nothing",
        !/delivery|presence|mediaUrl|valence|arousal|affect/i.test(seenBlob));
    check("candidates cannot read the recruiter view",
        (await c2(`/api/vet/session/${seeded.sessionId}/shared-practice`)).status === 401);
    check("share can be revoked", (await c(`/api/mock/${vm.id}/share`, { method: "DELETE" })).status === 200);
    check("revoking hides it from the recruiter",
        (await json(r, `/api/vet/session/${seeded.sessionId}/shared-practice`)).shared === null);

    section("interview kit");
    const kit = (await json(r, `/api/vet/session/${seeded.sessionId}/kit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: "30-minute screen", durationMinutes: 30 }),
    })).kit;
    check("kit generates", kit?.questions.length > 0);
    check("the contradiction is covered", kit.questions.some((q) => q.claimStatus === "CONTRADICTED"));
    check("CORRECTNESS: a verified claim is never re-asked",
        !kit.questions.some((q) => q.claimStatus === "VERIFIED" && q.kind !== "DEPTH"));
    check("core questions carry follow-up ladders",
        kit.questions.filter((q) => q.difficulty === "CORE").every((q) => q.followUps.length > 0));

    const kq = kit.questions.find((q) => q.claimStatus === "CONTRADICTED") || kit.questions[0];
    const rated = await json(r, `/api/kit/question/${kq.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asked: true, interviewerRating: 4, interviewerNotes: "Explained a stale figure." }),
    });
    check("interview notes save", rated.question.interviewerRating === 4 && !!rated.question.askedAt);
    check("out-of-range ratings are rejected",
        (await r(`/api/kit/question/${kq.id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interviewerRating: 9 }),
        })).status === 400);
    check("candidates cannot read the kit",
        (await c(`/api/vet/session/${seeded.sessionId}/kit`)).status === 401);
    check("ratings reach calibration (the feedback loop)",
        (await json(r, "/api/kit/calibration")).totalRated > 0);
    check("candidates cannot read calibration", (await c("/api/kit/calibration")).status === 401);
    check("candidates cannot regenerate a practice set",
        (await c(`/api/jobs/${job.id}/practice-set`, { method: "POST" })).status === 401);

    section("pages render");
    const pages = [
        ["anon", (p) => fetch(`${BASE}${p}`), "/"],
        ["anon", (p) => fetch(`${BASE}${p}`), "/login"],
        ["anon", (p) => fetch(`${BASE}${p}`), "/register"],
        ["candidate", c, "/jobs"],
        ["candidate", c, "/profile"],
        ["candidate", c, "/practice"],
        ["candidate", c, `/practice/${job.id}`],
        ["candidate", c, `/practice/session/${vm.id}`],
        ["recruiter", r, "/dashboard"],
        ["recruiter", r, "/dashboard/jobs/new"],
        ["recruiter", r, "/dashboard/practice-sets"],
        ["recruiter", r, "/vetting"],
        ["recruiter", r, "/vetting/calibration"],
        ["recruiter", r, `/vetting/${seeded.sessionId}`],
    ];
    for (const [who, fn, path] of pages) {
        const res = await fn(path);
        const html = await res.text();
        const broken = /Application error|__NEXT_ERROR|Internal Server Error/.test(html);
        check(`${who} ${path}`, res.status === 200 && !broken, `(${res.status}${broken ? " render error" : ""})`);
    }

    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.log("failed:", failures.join(" | "));
    return failures.length === 0;
}

let ok = false;
try {
    ok = await main();
} catch (error) {
    console.error("\nHARNESS ERROR:", error.message);
} finally {
    if (KEEP) console.log("\n--keep: test accounts left in place.");
    else await cleanup();
    await prisma.$disconnect();
}
process.exit(ok ? 0 : 1);
