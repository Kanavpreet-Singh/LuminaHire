"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared UI primitives.
 *
 * These exist because the app had six pages that each invented their own card,
 * button, badge, and empty state. The result read as six products: a "Card" was
 * `rounded-3xl` here and `rounded-2xl` there, buttons were `bg-brand-500` in one
 * place and a gradient in another, and every page wrote its own "nothing here
 * yet" message in a different voice.
 *
 * The visual language is unchanged — same violet, same surfaces, same Inter and
 * Saira Stencil. What changes is that there is now one definition of each thing,
 * so a fix or a contrast improvement lands everywhere at once.
 *
 * Two rules encoded here rather than left to each caller:
 *   1. NUMBERS ARE TABULAR. Scores, counts, timestamps, and durations use
 *      tabular-nums so digits do not jitter as values update and columns of
 *      figures actually line up.
 *   2. EMPTY STATES ARE INVITATIONS. Every one takes an action, because a blank
 *      screen that only says "no data" wastes the one moment the person is
 *      looking for what to do next.
 */

function cx(...parts: (string | false | null | undefined)[]) {
    return parts.filter(Boolean).join(" ");
}

/* ── Page scaffolding ────────────────────────────────────────── */

export function Page({
    children,
    width = "wide",
    className,
}: {
    children: ReactNode;
    width?: "narrow" | "wide" | "full";
    className?: string;
}) {
    const max = width === "narrow" ? "max-w-3xl" : width === "wide" ? "max-w-5xl" : "max-w-7xl";
    return (
        <div className="flex-1 bg-surface-primary text-content-primary">
            <div className={cx("mx-auto px-6 py-10 sm:py-12", max, className)}>{children}</div>
        </div>
    );
}

export function PageHeader({
    eyebrow,
    title,
    description,
    actions,
    backHref,
    backLabel = "Back",
}: {
    eyebrow?: string;
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    backHref?: string;
    backLabel?: string;
}) {
    return (
        <header className="mb-8">
            {backHref && (
                <Link
                    href={backHref}
                    className="mb-3 inline-block text-[11px] font-bold uppercase tracking-[0.14em] text-content-tertiary no-underline transition-colors hover:text-content-primary"
                >
                    ← {backLabel}
                </Link>
            )}
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                    {eyebrow && (
                        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-content-tertiary">
                            {eyebrow}
                        </p>
                    )}
                    <h1 className="text-3xl font-black tracking-tight text-content-primary sm:text-4xl">
                        {title}
                    </h1>
                    {description && (
                        <div className="mt-2 max-w-2xl text-sm leading-relaxed text-content-secondary">
                            {description}
                        </div>
                    )}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
        </header>
    );
}

export function Section({
    title,
    description,
    actions,
    children,
    className,
}: {
    title?: string;
    description?: string;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <section className={cx("space-y-4", className)}>
            {(title || actions) && (
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        {title && (
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                                {title}
                            </h2>
                        )}
                        {description && (
                            <p className="mt-1 text-xs text-content-tertiary">{description}</p>
                        )}
                    </div>
                    {actions && <div className="flex items-center gap-2">{actions}</div>}
                </div>
            )}
            {children}
        </section>
    );
}

/* ── Surfaces ────────────────────────────────────────────────── */

export function Card({
    children,
    className,
    tone = "default",
    as: Tag = "div",
}: {
    children: ReactNode;
    className?: string;
    tone?: "default" | "quiet" | "accent" | "warning" | "danger";
    as?: any;
}) {
    const tones = {
        default: "border-border-default bg-surface-card",
        quiet: "border-border-default bg-surface-secondary/60",
        accent: "border-primary-400/30 bg-primary-500/5",
        warning: "border-amber-500/30 bg-amber-500/10",
        danger: "border-rose-500/30 bg-rose-500/10",
    }[tone];
    return (
        <Tag className={cx("rounded-3xl border p-6 shadow-md backdrop-blur-xl", tones, className)}>
            {children}
        </Tag>
    );
}

/* ── Controls ────────────────────────────────────────────────── */

const BUTTON_TONES = {
    primary:
        "bg-[image:var(--gradient-primary)] text-white shadow-glow hover:-translate-y-px disabled:hover:translate-y-0",
    secondary:
        "border border-border-default bg-surface-card text-content-primary hover:border-border-hover",
    ghost: "text-content-secondary hover:text-content-primary hover:bg-surface-secondary",
    danger: "border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20",
};

export function Button({
    children,
    tone = "primary",
    size = "md",
    className,
    ...props
}: {
    children: ReactNode;
    tone?: keyof typeof BUTTON_TONES;
    size?: "sm" | "md";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            {...props}
            className={cx(
                "inline-flex items-center justify-center rounded-xl font-bold transition-all",
                "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400",
                "disabled:cursor-not-allowed disabled:opacity-40",
                size === "sm" ? "px-4 py-1.5 text-xs" : "px-6 py-2.5 text-sm",
                BUTTON_TONES[tone],
                className
            )}
        >
            {children}
        </button>
    );
}

export function LinkButton({
    children,
    href,
    tone = "secondary",
    size = "md",
    className,
}: {
    children: ReactNode;
    href: string;
    tone?: keyof typeof BUTTON_TONES;
    size?: "sm" | "md";
    className?: string;
}) {
    return (
        <Link
            href={href}
            className={cx(
                "inline-flex items-center justify-center rounded-xl font-bold no-underline transition-all",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400",
                size === "sm" ? "px-4 py-1.5 text-xs" : "px-6 py-2.5 text-sm",
                BUTTON_TONES[tone],
                className
            )}
        >
            {children}
        </Link>
    );
}

export function Badge({
    children,
    className,
    tone = "neutral",
}: {
    children: ReactNode;
    className?: string;
    tone?: "neutral" | "accent" | "success" | "warning" | "danger";
}) {
    const tones = {
        neutral: "border-border-default bg-surface-secondary text-content-tertiary",
        accent: "border-primary-400/30 bg-primary-500/10 text-primary-300",
        success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        warning: "border-amber-500/30 bg-amber-500/10 text-amber-400",
        danger: "border-rose-500/30 bg-rose-500/10 text-rose-400",
    }[tone];
    return (
        <span
            className={cx(
                "inline-flex items-center rounded-lg border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]",
                tones,
                className
            )}
        >
            {children}
        </span>
    );
}

/* ── Data display ────────────────────────────────────────────── */

/**
 * A single number with its label. `hint` carries the arithmetic behind it where
 * one exists, because a score a person can't interrogate is a score they can't
 * trust.
 */
export function Stat({
    value,
    label,
    hint,
    suffix,
    tone,
}: {
    value: ReactNode;
    label: string;
    hint?: string;
    suffix?: string;
    tone?: "up" | "down";
}) {
    return (
        <div>
            <div className="flex items-baseline gap-1">
                <span
                    className={cx(
                        "text-2xl font-black tabular-nums",
                        tone === "up"
                            ? "text-emerald-400"
                            : tone === "down"
                              ? "text-amber-400"
                              : "text-content-primary"
                    )}
                >
                    {value}
                </span>
                {suffix && <span className="text-xs text-content-tertiary">{suffix}</span>}
            </div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-content-tertiary">
                {label}
            </div>
            {hint && <div className="mt-0.5 text-[10px] tabular-nums text-content-tertiary">{hint}</div>}
        </div>
    );
}

export function Meter({ value, max = 100, tone }: { value: number; max?: number; tone?: string }) {
    const pct = Math.max(0, Math.min(100, (value / max) * 100));
    return (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
            <div
                className={cx("h-full rounded-full", tone || "bg-[image:var(--gradient-primary)]")}
                style={{ width: `${pct}%` }}
            />
        </div>
    );
}

/* ── States ──────────────────────────────────────────────────── */

/** Empty states are invitations. Every one takes an action. */
export function EmptyState({
    title,
    description,
    action,
}: {
    title: string;
    description?: string;
    action?: ReactNode;
}) {
    return (
        <Card className="py-12 text-center">
            <p className="text-sm font-bold text-content-primary">{title}</p>
            {description && (
                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-content-secondary">
                    {description}
                </p>
            )}
            {action && <div className="mt-5 flex justify-center">{action}</div>}
        </Card>
    );
}

/**
 * Errors say what happened and what to do. They do not apologize and they are
 * never vague — "something went wrong" tells the reader nothing they can act on.
 */
export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
    return (
        <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-400"
        >
            <span className="min-w-0 flex-1">{children}</span>
            {onRetry && (
                <Button tone="secondary" size="sm" onClick={onRetry}>
                    Try again
                </Button>
            )}
        </div>
    );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
    return (
        <div className="flex items-center justify-center gap-3 py-16 text-sm text-content-tertiary">
            <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border-hover border-t-primary-400"
                aria-hidden="true"
            />
            {label}
        </div>
    );
}

/* ── Forms ───────────────────────────────────────────────────── */

const FIELD_CLASS =
    "w-full rounded-xl border border-border-default bg-surface-secondary px-4 py-2.5 text-sm text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-2 focus:ring-primary-500/40";

export function Field({
    label,
    hint,
    children,
    htmlFor,
}: {
    label: string;
    hint?: string;
    children: ReactNode;
    htmlFor?: string;
}) {
    return (
        <div>
            <label
                htmlFor={htmlFor}
                className="mb-2 block text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary"
            >
                {label}
            </label>
            {children}
            {hint && <p className="mt-1.5 text-xs text-content-tertiary">{hint}</p>}
        </div>
    );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return <input {...props} className={cx(FIELD_CLASS, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return <textarea {...props} className={cx(FIELD_CLASS, "resize-y", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
    return <select {...props} className={cx(FIELD_CLASS, "cursor-pointer", props.className)} />;
}

export { cx };
