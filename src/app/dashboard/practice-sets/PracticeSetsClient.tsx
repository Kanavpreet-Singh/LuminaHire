"use client";

import { useEffect, useState } from "react";
import {
    Page,
    PageHeader,
    Card,
    Badge,
    Button,
    Field,
    Select,
    EmptyState,
    ErrorNote,
    Loading,
} from "@/components/ui";

/**
 * Practice-set review for recruiters.
 *
 * Sets write themselves the first time a candidate opens a job, so this page is
 * for review and regeneration rather than setup — a recruiter who never visits
 * still has working practice questions on every role.
 *
 * Regenerating publishes a NEW version instead of editing the old one, so
 * answers already recorded keep pointing at the question that was actually asked.
 */

interface Job {
    id: string;
    title: string;
    status: string;
}

interface Question {
    id: string;
    order: number;
    prompt: string;
    category: string;
    competency: string;
    targetSeconds: number;
    rubric: { must_cover?: string[]; common_mistakes?: string[] } | null;
}

const CATEGORY_LABEL: Record<string, string> = {
    ROLE_MOTIVATION: "Warmup",
    PROJECT_WALKTHROUGH: "Project",
    BEHAVIORAL: "Behavioral",
    TECHNICAL_CONCEPT: "Technical",
    SYSTEM_DESIGN: "System design",
    PERSONAL: "Candidate's résumé",
};

export default function PracticeSetsClient({ jobs }: { jobs: Job[] }) {
    // Jobs come from the server component, scoped to this recruiter. The public
    // /api/jobs list returns every OPEN job regardless of owner, so using it here
    // would offer roles this recruiter can't regenerate.
    const [selected, setSelected] = useState<string>(jobs[0]?.id ?? "");
    const [set, setSet] = useState<{ version: number; questions: Question[] } | null>(null);
    const [loading, setLoading] = useState(jobs.length > 0);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!selected) return;
        setSet(null);
        setError(null);
        setLoading(true);
        fetch(`/api/jobs/${selected}/practice-set`)
            .then(async (r) => {
                if (!r.ok) throw new Error(await r.text());
                return r.json();
            })
            .then((d) => setSet(d.set))
            .catch((e) => setError(e.message || "Couldn't load the practice set"))
            .finally(() => setLoading(false));
    }, [selected]);

    async function regenerate() {
        if (
            !confirm(
                "Publish a new version of these questions? Candidates will practise against the new set; " +
                    "answers already recorded keep their original questions."
            )
        )
            return;
        setWorking(true);
        setError(null);
        try {
            const res = await fetch(`/api/jobs/${selected}/practice-set`, { method: "POST" });
            if (!res.ok) throw new Error(await res.text());
            setSet((await res.json()).set);
        } catch (e: any) {
            setError(e.message || "Couldn't regenerate the set");
        } finally {
            setWorking(false);
        }
    }

    return (
        <Page>
            <PageHeader
                backHref="/dashboard"
                backLabel="Dashboard"
                eyebrow="Candidate-facing"
                title="Practice questions"
                description="What candidates rehearse against for each of your roles. Written from the job posting alone — these are not your interview kit, and they reveal nothing about any individual candidate's vetting."
                actions={
                    set && (
                        <Button tone="secondary" onClick={regenerate} disabled={working}>
                            {working ? "Writing…" : "Publish new version"}
                        </Button>
                    )
                }
            />

            {jobs.length === 0 ? (
                <EmptyState
                    title="No roles yet"
                    description="Post a role and its practice questions are written the first time a candidate opens it."
                />
            ) : (
                <div className="space-y-6">
                    <div className="flex flex-wrap items-end gap-4">
                        <div className="min-w-64 flex-1">
                            <Field label="Role" htmlFor="job">
                                <Select
                                    id="job"
                                    value={selected}
                                    onChange={(e) => setSelected(e.target.value)}
                                >
                                    {jobs.map((j) => (
                                        <option key={j.id} value={j.id}>
                                            {j.title}
                                        </option>
                                    ))}
                                </Select>
                            </Field>
                        </div>
                        {set && (
                            <p className="pb-3 text-xs tabular-nums text-content-tertiary">
                                Version {set.version} · {set.questions.length} questions
                            </p>
                        )}
                    </div>

                    {error && <ErrorNote>{error}</ErrorNote>}
                    {loading && <Loading label="Loading questions…" />}

                    {set?.questions.map((q, i) => (
                        <Card key={q.id} as="article">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <span className="text-xs font-bold tabular-nums text-content-tertiary">
                                    {String(i + 1).padStart(2, "0")}
                                </span>
                                <Badge tone={q.category === "PERSONAL" ? "accent" : "neutral"}>
                                    {CATEGORY_LABEL[q.category] || q.category}
                                </Badge>
                                <span className="ml-auto text-[11px] tabular-nums text-content-tertiary">
                                    ~{q.targetSeconds}s
                                </span>
                            </div>
                            <p className="text-sm leading-relaxed text-content-primary">{q.prompt}</p>
                            {q.competency && (
                                <p className="mt-2 text-xs text-content-tertiary">Tests: {q.competency}</p>
                            )}
                            {q.rubric?.must_cover && q.rubric.must_cover.length > 0 && (
                                <div className="mt-4 border-t border-border-default pt-4">
                                    <h4 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                                        A complete answer covers
                                    </h4>
                                    <ul className="space-y-1">
                                        {q.rubric.must_cover.map((m, k) => (
                                            <li key={k} className="text-xs text-content-secondary">
                                                {m}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </Card>
                    ))}
                </div>
            )}
        </Page>
    );
}
