# LuminaHire

**Résumé verification for technical hiring.** LuminaHire reads a candidate's résumé, extracts every checkable claim, and tests those claims against the profiles the candidate linked on that same résumé. It tells a recruiter three things: what held up, what conflicts with the candidate's own public profiles, and what nobody can verify online — turning that last category into targeted interview questions.

It is deliberately **not** an internet research tool. That distinction is the whole design, and the section below explains why.

---

## Why not just search the web for the candidate?

Most "AI candidate research" tools search the open web for a person's name and summarize what comes back. We built that first, then removed it, because it fails in two ways that no amount of prompt engineering fixes.

**1. It finds the wrong person.** Searching `"Priya Sharma" backend engineer` returns pages about many different Priya Sharmas. An LLM cannot tell them apart — there is no signal in the results that distinguishes the candidate from a stranger with the same name. A recruiter shown someone else's GitHub, publications, or conference talks has been *actively misled*, which is strictly worse than being shown nothing. They now have false confidence instead of a known gap.

**2. There is usually nothing to find.** Ordinary engineers are not public figures. Companies do not publish per-employee breakdowns of who built what. So a question like *"what did they actually own at Acme?"* has no public answer at all. Searching for it burns API calls, and — worse — invites the model to pad thin results into something that reads like evidence.

Real recruiters don't do this either. They read the résumé and click the links on it. That's the workflow LuminaHire automates, plus the part humans can't do at scale: systematically checking whether each claim on the résumé actually matches what those links show.

### The rule that follows from this

> **Every source LuminaHire reads was supplied by the candidate**, either as a profile link on their résumé or as a specific artifact their résumé names (a paper title, a package name). Nothing is discovered by searching for the candidate's name.

Anything that can't be reached from a candidate-supplied source is reported as `UNVERIFIABLE` and routed to the interview — never guessed at, and never held against the candidate.

There is exactly one deliberate exception: a recruiter can type a free-text follow-up request ("check if they've written about Kafka"), which may run an open-web search. The two conditions that make search dangerous don't hold there — a human asked for that specific lookup, and a human reads the raw result. Those findings are always labelled **unconfirmed attribution** so they can never be mistaken for verified fact.

---

## What you get

For every claim on the résumé, a ruling:

| Status | Meaning | Effect on score |
|---|---|---|
| **VERIFIED** | A candidate-supplied source directly supports it. | Positive — this is what you can bank on. |
| **CONTRADICTED** | Their own linked profile conflicts with it (résumé says 800 problems solved, profile shows 200). | Negative, and surfaced as a red flag. The highest-value finding the system produces. |
| **UNVERIFIABLE** | No public source could settle it. Normal for private company work, NDA'd systems, team contributions. | **None.** Explicitly neutral. |
| **UNCHECKED** | A relevant source existed but couldn't be read (blocked scraper, site down). | **None.** You get the link to check manually. |

### Why UNVERIFIABLE never costs a candidate points

Most good engineers do their best work inside private company repositories. If the system penalized claims it couldn't verify, it would systematically punish candidates for having had normal jobs, and reward those who happen to work in public. That is a scoring bug disguised as rigor. `UNVERIFIABLE` describes the *public visibility of the work*, not the candidate's honesty or ability — so the pipeline scores those claims exactly as a recruiter would when reading a résumé with no links at all, and converts each one into an interview question instead.

That conversion is the point. "We couldn't verify this" becomes *"ask them to walk through the caching layer they claim they built"* — a question only someone who did the work can answer well.

### Identity cross-checking

Even a candidate-supplied link can point at the wrong person — résumés get copy-pasted from templates and links get typo'd. So whenever a profile publishes a real name (GitHub, LeetCode, GeeksforGeeks, Codeforces), it's matched against the résumé name before any of its data is trusted. A mismatch is flagged loudly and that source's data is excluded from the evaluation rather than silently absorbed.

The matcher is lenient about the shape of a name and strict only about shared content — word order, dropped middle names, missing accents, and first-name-only profiles all still match; two names with nothing in common do not.

---

## The pipeline

Four agents, as a LangGraph state machine:

```
START ─(plan exists?)─→ Claims Extractor ──→ END   (human review checkpoint)
                              │
                              ▼
                          Verifier ──→ Claims Judge ──→ Report Writer ──→ END
                              ▲              │
                              └──────────────┘
                          (bounded re-check loop)
```

1. **Claims Extractor** — reads the résumé and JD, enumerates checkable claims, and tags each with which candidate-supplied source could settle it (or `NONE`). Prefers quantified, falsifiable claims, since that's where résumé inflation shows up.
2. **Verifier** — fetches every linked profile deterministically (no LLM discretion about whether a link exists — that's ground truth), cross-checks identity on each, then makes only two judgment calls: which claimed technology to test against the candidate's own repos, and which named publication to verify. **Open-web search is not in its tool roster.**
3. **Claims Judge** — rules every claim against the cited evidence and scores fit. Any claim the model fails to rule on is backfilled as `UNVERIFIABLE`, so a model omission can never read as a negative signal.
4. **Report Writer** — writes the recruiter-facing memo, red flags, and one targeted interview question per unverified claim.

Human-in-the-loop checkpoints pause after planning and after evaluation, so a recruiter can edit the plan or request more checks before the report is written. Batch runs ("Hiring Committee") skip both and finish with a pairwise tournament that re-ranks the shortlist head-to-head, since independently-produced absolute scores aren't calibrated against each other.

## Verified sources

GitHub (REST API), LeetCode, GeeksforGeeks, Codeforces, HackerRank, CodeChef, Stack Overflow, npm, Dev.to, Medium, personal portfolio sites, and — by exact title only — Semantic Scholar and arXiv.

Every one of these tools degrades gracefully: a blocked scraper or a down API returns `UNCHECKED` with the link intact, never a crash and never a silent gap. Some sites (notably LeetCode, behind Cloudflare) block automated reads intermittently; the pipeline reports that honestly rather than pretending the profile was empty.

## A résumé is required

Candidate profiles cannot be saved, matched, or vetted without an uploaded, text-extractable résumé. It isn't optional metadata — it's the input the entire pipeline runs on. Without it there are no claims to extract and no links to check, so the system would emit an empty report that *looks like a weak candidate* rather than a missing input. Enforced in the API and the UI (`src/lib/resume-required.ts`).

---

## Getting started

```bash
# 1. Install
npm install
pip install -r python/requirements.txt

# 2. Configure — see the table below
cp .env.example .env

# 3. Database
npx prisma generate
npx prisma migrate deploy

# 4. Run both services
python python/main.py     # FastAPI agent service, :8000
npm run dev               # Next.js app,          :3000
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL with the `pgvector` extension (semantic matching). |
| `OPENAI_API_KEY` | LLM calls for the four agents. |
| `GEMINI_API_KEY` | Résumé text extraction and embeddings. |
| `GITHUB_TOKEN` | Optional, strongly recommended — raises the GitHub API limit from 60/hr to 5,000/hr. |
| `UPLOADTHING_TOKEN` | Résumé file uploads. |
| `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | NextAuth session + Google sign-in. |
| `LANGFUSE_*` | Optional tracing and per-session cost tracking. |
| `MOCK_AI_RESPONSES` | `1` runs the whole pipeline with deterministic fake data — no API keys, no spend. |

### Maintenance scripts

```bash
node scripts/list-candidates.mjs              # read-only DB inspection
node scripts/cleanup-seed-candidates.mjs      # dry run; add --yes to execute
```

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind · Prisma + PostgreSQL/pgvector · NextAuth · FastAPI · LangGraph · Langfuse
