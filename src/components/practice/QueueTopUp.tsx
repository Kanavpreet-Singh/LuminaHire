"use client";

import { useState } from "react";
import { Button, ErrorNote, cx } from "@/components/ui";

/**
 * End of the queue: choose a category and get more questions.
 *
 * There is no fixed number of questions in a practice session. Someone drilling
 * behavioural answers before a Monday interview should be able to keep going
 * without starting a new session, and someone who only wants system design
 * shouldn't have to sit through warmups to reach it.
 *
 * The categories are phrased as what the candidate wants to work on, not as the
 * enum they map to — "Talk through a project" is a thing you'd say;
 * PROJECT_WALKTHROUGH is a database value.
 */

const CATEGORIES = [
    { value: "BEHAVIORAL", label: "Behavioural", hint: "Times you handled something", emoji: "🤝" },
    { value: "TECHNICAL_CONCEPT", label: "Technical", hint: "Explain how something works", emoji: "⚙️" },
    { value: "PROJECT_WALKTHROUGH", label: "Projects", hint: "Talk through what you built", emoji: "🛠" },
    { value: "SYSTEM_DESIGN", label: "System design", hint: "Design something out loud", emoji: "🧩" },
    { value: "ROLE_MOTIVATION", label: "Motivation", hint: "Why this, why now", emoji: "🧭" },
] as const;

export default function QueueTopUp({
    mockId,
    answered,
    onAdded,
}: {
    mockId: string;
    answered: number;
    onAdded: () => Promise<void> | void;
}) {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function add(category: string) {
        setBusy(category);
        setError(null);
        try {
            const res = await fetch(`/api/mock/${mockId}/questions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ category, count: 3 }),
            });
            if (!res.ok) throw new Error(await res.text());
            await onAdded();
        } catch (e: any) {
            setError(e.message || "Couldn't add more questions");
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="q-enter rounded-3xl border border-border-default bg-surface-card p-8 text-center shadow-md">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-content-tertiary">
                Queue empty
            </p>
            <h2 className="mt-2 text-2xl font-black text-content-primary">
                {answered === 0
                    ? "Nothing left to answer"
                    : `That's ${answered} answered`}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-content-secondary">
                Keep going as long as you like — pick what you want to work on and we&apos;ll write three
                more.
            </p>

            {error && (
                <div className="mx-auto mt-5 max-w-md text-left">
                    <ErrorNote>{error}</ErrorNote>
                </div>
            )}

            <div className="mt-6 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {CATEGORIES.map((cat, i) => (
                    <button
                        key={cat.value}
                        onClick={() => add(cat.value)}
                        disabled={!!busy}
                        style={{ animationDelay: `${60 + i * 45}ms` }}
                        className={cx(
                            "q-enter group rounded-2xl border p-4 text-left transition-all",
                            "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400",
                            busy === cat.value
                                ? "border-primary-400/50 bg-primary-500/10"
                                : "border-border-default bg-surface-secondary hover:-translate-y-0.5 hover:border-primary-400/40",
                            busy ? "cursor-wait opacity-60" : "cursor-pointer"
                        )}
                    >
                        <span className="text-lg" aria-hidden="true">{cat.emoji}</span>
                        <span className="mt-1.5 block text-sm font-bold text-content-primary">
                            {busy === cat.value ? "Writing…" : cat.label}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-content-tertiary">
                            {cat.hint}
                        </span>
                    </button>
                ))}
            </div>

            {answered > 0 && (
                <p className="mt-6 text-xs text-content-tertiary">
                    Or finish below to see how the whole session went.
                </p>
            )}
        </div>
    );
}

export { CATEGORIES as TOPUP_CATEGORIES };
