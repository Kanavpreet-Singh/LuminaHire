from __future__ import annotations

"""
LuminaHire — Tracing & Cost Tracking (Langfuse)
================================================
Every vetting-pipeline invocation (initial run, HITL resume, research
follow-up, Q&A, ...) is wrapped in a Langfuse trace and tagged with the DB
VettingSession id as Langfuse's `session_id`, so ALL of a session's traces
across its lifetime (plan -> research -> evaluate -> report, plus any
follow-ups) group together under one session view in the Langfuse dashboard.
Every LangGraph node (agents.py) and every tool call (tools/catalog.py
dispatch()) is instrumented as a nested span via @observe(); every LLM call
(llm_client.py) is instrumented as a generation with model/token/cost data.

Fully optional: if LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY aren't set, every
decorator/helper below becomes a no-op so mock-mode and local dev without a
Langfuse account work completely unmodified.

Separately from Langfuse itself, this module ALSO accumulates a lightweight,
local per-run token/cost total via a contextvar (reset_usage/record_usage/
get_usage). This powers the recruiter-facing "Cost & Usage" card without any
live round-trip to Langfuse's API: main.py's background pipeline runner resets
it before a run and reads it back after, then persists the total onto the
VettingSession row (see registry.py's `usage` field and src/lib/vetting.ts).
"""

import os
from contextvars import ContextVar
from typing import Any, Dict, Optional

from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

LANGFUSE_ENABLED = bool(os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY"))

if LANGFUSE_ENABLED:
    from langfuse.decorators import observe, langfuse_context
else:
    # No-op fallbacks with the same call signatures as the real Langfuse SDK,
    # so every call site (agents.py, tools/catalog.py, llm_client.py, main.py)
    # works identically whether or not Langfuse is configured.
    def observe(*d_args, **d_kwargs):
        def _decorator(fn):
            return fn
        # Support both bare @observe and @observe(name=..., as_type=...).
        if d_args and callable(d_args[0]) and not d_kwargs:
            return d_args[0]
        return _decorator

    class _NoopLangfuseContext:
        def update_current_trace(self, *args, **kwargs):
            pass

        def update_current_observation(self, *args, **kwargs):
            pass

    langfuse_context = _NoopLangfuseContext()  # type: ignore[assignment]


# Per-1M-token USD pricing for models this app actually calls through
# llm_client.py. Extend as new models/providers are added; an unrecognized
# model name costs $0 rather than raising, so tracing/cost-estimation can
# never break the pipeline itself.
_PRICING_PER_1M_TOKENS: Dict[str, Dict[str, float]] = {
    "openai/gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "llama-3.3-70b-versatile": {"input": 0.59, "output": 0.79},
    "gemini-2.5-flash": {"input": 0.30, "output": 2.50},
    "gemini-embedding-2": {"input": 0.15, "output": 0.0},
    "gemini-embedding-001": {"input": 0.15, "output": 0.0},
}


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    price = _PRICING_PER_1M_TOKENS.get(model)
    if not price:
        return 0.0
    return (prompt_tokens / 1_000_000) * price["input"] + (completion_tokens / 1_000_000) * price["output"]


def start_session_trace(session_id: str, name: str, metadata: Optional[dict] = None) -> None:
    """
    Tag the current @observe'd trace (the caller must already be inside one --
    see main.py's _run_pipeline/_run_report_stage/research_followup/vet_qa)
    with the vetting session's real DB id as Langfuse's `session_id`. This is
    what makes every phase of a session (which may span several separate
    pipeline invocations across HITL pauses/resumes) show up grouped under one
    session in the Langfuse dashboard.
    """
    if not LANGFUSE_ENABLED:
        return
    langfuse_context.update_current_trace(session_id=session_id, name=name, metadata=metadata or {})


def report_generation_usage(model: str, prompt_tokens: int, completion_tokens: int, cost_usd: float) -> None:
    """
    Manually attach token/cost data to the CURRENT generation observation.
    Needed because this app calls OpenAI-compatible endpoints through custom
    base_urls with provider-prefixed model names (e.g. "openai/gpt-4o-mini"
    via the AICredits proxy) that Langfuse's own auto-pricing can't recognize
    -- so cost is computed here (see estimate_cost_usd) and pushed in
    explicitly rather than relying on Langfuse's auto-detection.
    """
    if not LANGFUSE_ENABLED:
        return
    langfuse_context.update_current_observation(
        model=model,
        usage_details={"input": prompt_tokens, "output": completion_tokens, "total": prompt_tokens + completion_tokens},
        cost_details={"input": round(cost_usd, 6), "total": round(cost_usd, 6)},
    )


# ── Local per-run usage accumulator (independent of Langfuse) ──────────────

_usage_ctx: ContextVar[Optional[Dict[str, Any]]] = ContextVar("lumina_usage_ctx", default=None)


def reset_usage() -> None:
    """Start a fresh accumulator for the current run. Call once at the top of
    each top-level pipeline invocation (main.py's _run_pipeline/_run_report_stage/
    research_followup/vet_qa) -- BackgroundTasks run each call in a single
    dedicated thread, so a contextvar set here stays correctly scoped to just
    that run even though multiple runs execute concurrently in the threadpool."""
    _usage_ctx.set({"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0, "calls": []})


def record_usage(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Add one LLM call's token usage to the current run's accumulator (a no-op
    if reset_usage() was never called, e.g. a code path outside any tracked
    pipeline run). Returns the estimated cost of just this call."""
    cost = estimate_cost_usd(model, prompt_tokens, completion_tokens)
    acc = _usage_ctx.get()
    if acc is not None:
        acc["prompt_tokens"] += prompt_tokens
        acc["completion_tokens"] += completion_tokens
        acc["cost_usd"] += cost
        acc["calls"].append({
            "model": model,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "cost_usd": round(cost, 6),
        })
    return cost


def get_usage() -> Optional[Dict[str, Any]]:
    """The current run's accumulated usage, or None if reset_usage() was never
    called for this run. Read this once after the run completes and persist it
    (see registry.py's `usage` field)."""
    acc = _usage_ctx.get()
    if acc is None:
        return None
    return {**acc, "cost_usd": round(acc["cost_usd"], 6)}
