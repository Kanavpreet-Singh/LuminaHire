"""
LuminaHire — Unified structured-LLM client with automatic failover.

Provider order (when LLM_PROVIDER is unset/"gemini"):
  1. AICredits (OpenAI-compatible third-party proxy, OPENAI_API_KEY) — tried
     first whenever a key is configured.
  2. Google Gemini (gemini-2.5-flash) with native response_schema.
  3. Groq (llama-3.3-70b-versatile) in JSON mode, used when Gemini returns a
     quota (429 / RESOURCE_EXHAUSTED) or overload (503 / UNAVAILABLE) error.
All three paths return a dict validated against the same Pydantic schema, so
callers get an identical shape regardless of which provider served the request.

NOTE: Google-Search grounding (tools.grounded_search) is Gemini-only — neither
Groq nor the AICredits proxy has an equivalent web-search tool — so during a
Gemini outage web research degrades gracefully while the reasoning agents
(planner/evaluator/report writer) keep working on whichever provider is live.
"""

import os
import json
import time
from typing import Any, Type

import requests
from dotenv import load_dotenv
from pydantic import BaseModel
from google import genai
from google.genai import types

# Load .env here too so provider keys are available regardless of import order.
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

GEMINI_MODEL = "gemini-2.5-flash"
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

# AICredits -- third-party OpenAI-compatible proxy (https://aicredits.in),
# tried first whenever OPENAI_API_KEY is configured. Model names are
# provider-prefixed in their catalog (e.g. "openai/gpt-4o-mini").
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://aicredits.in/v1")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "openai/gpt-4o-mini")

# Local-testing provider toggle: unset/"gemini" (default) keeps the existing
# Gemini->Groq real-mode path untouched. "ollama" routes every structured
# call (planner/evaluator/report/QA) AND the ReAct researcher's tool-calling
# through a local Ollama model instead -- opt-in, dev-only (slow: ~30s cold,
# a few seconds warm), never a production fallback tier.
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini").lower()
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "ministral-3:3b")
OLLAMA_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT", "300"))

_gemini_client = None
_groq_client = None
_openai_client = None


def _get_gemini():
    global _gemini_client
    if _gemini_client is None:
        if not os.getenv("GEMINI_API_KEY"):
            raise ValueError("GEMINI_API_KEY is not set.")
        _gemini_client = genai.Client()
    return _gemini_client


def _get_groq():
    global _groq_client
    if _groq_client is None:
        key = os.getenv("GROQ_API_KEY")
        if not key:
            return None
        from groq import Groq
        _groq_client = Groq(api_key=key)
    return _groq_client


def _get_openai():
    global _openai_client
    if _openai_client is None:
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            return None
        from openai import OpenAI
        _openai_client = OpenAI(base_url=OPENAI_BASE_URL, api_key=key)
    return _openai_client


def _is_quota_or_overload(exc: Exception) -> bool:
    msg = str(exc)
    return any(k in msg for k in ("429", "RESOURCE_EXHAUSTED", "quota", "503", "UNAVAILABLE", "overloaded"))


def _gemini_structured(prompt: str, schema: Type[BaseModel], temperature: float) -> dict:
    resp = _get_gemini().models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            temperature=temperature,
        ),
    )
    return json.loads(resp.text)


def _groq_structured(prompt: str, schema: Type[BaseModel], temperature: float) -> dict:
    client = _get_groq()
    if client is None:
        raise RuntimeError("Gemini unavailable and GROQ_API_KEY not set for fallback.")

    schema_json = json.dumps(schema.model_json_schema())
    system = (
        "You are a precise data-extraction engine. Respond with a single JSON object "
        "that strictly conforms to this JSON Schema. Output JSON only, no prose.\n\n"
        f"JSON Schema:\n{schema_json}"
    )
    resp = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
        temperature=temperature,
    )
    raw = resp.choices[0].message.content or "{}"
    data = json.loads(raw)
    # Validate/coerce to the schema so callers get a guaranteed shape.
    return schema.model_validate(data).model_dump()


def _openai_structured(prompt: str, schema: Type[BaseModel], temperature: float) -> dict:
    """
    Structured generation via AICredits, an OpenAI-compatible third-party
    proxy (https://aicredits.in) -- tried first whenever OPENAI_API_KEY is
    set, ahead of Gemini/Groq. Uses JSON mode (response_format=json_object)
    with the schema embedded in the system prompt, same pattern as the Groq
    path above, since the proxy's documented support is json_object mode
    rather than a schema-constrained response_format.
    """
    client = _get_openai()
    if client is None:
        raise RuntimeError("OPENAI_API_KEY not set.")

    schema_json = json.dumps(schema.model_json_schema())
    system = (
        "You are a precise data-extraction engine. Respond with a single JSON object "
        "that strictly conforms to this JSON Schema. Output JSON only, no prose.\n\n"
        f"JSON Schema:\n{schema_json}"
    )
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
        temperature=temperature,
    )
    raw = resp.choices[0].message.content or "{}"
    data = json.loads(raw)
    return schema.model_validate(data).model_dump()


def _ollama_structured(prompt: str, schema: Type[BaseModel], temperature: float) -> dict:
    """
    Schema-constrained generation via local Ollama (LLM_PROVIDER=ollama). Uses
    Ollama's `format` parameter with the Pydantic model's JSON Schema for
    structured output, same contract as the Gemini/Groq paths above: raises
    on failure (no local Ollama-specific fallback -- callers already handle
    provider errors the same way regardless of which provider raised).
    """
    resp = requests.post(
        f"{OLLAMA_BASE_URL}/api/chat",
        json={
            "model": OLLAMA_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "format": schema.model_json_schema(),
            "stream": False,
            "options": {"temperature": temperature},
        },
        timeout=OLLAMA_TIMEOUT,
    )
    resp.raise_for_status()
    content = (resp.json().get("message") or {}).get("content", "{}")
    data = json.loads(content)
    return schema.model_validate(data).model_dump()


def structured_generate(prompt: str, schema: Type[BaseModel], temperature: float = 0.2,
                        retries: int = 2) -> dict:
    """
    AICredits-only for now, per explicit request: Gemini/Groq/Ollama are
    disabled below (commented out, not deleted -- uncomment to restore the
    AICredits -> Gemini -> Groq failover chain / the Ollama local-testing
    toggle). `retries` is currently unused (kept in the signature so callers
    don't need to change) since there's no retry/failover loop while only
    one provider is active.
    """
    return _openai_structured(prompt, schema, temperature)

    # -- Disabled: local Ollama toggle --
    # if LLM_PROVIDER == "ollama":
    #     return _ollama_structured(prompt, schema, temperature)
    #
    # -- Disabled: AICredits-first, then Gemini -> Groq failover --
    # if _get_openai() is not None:
    #     try:
    #         return _openai_structured(prompt, schema, temperature)
    #     except Exception as e:
    #         print(f"[LLM] AICredits unavailable ({str(e)[:80]}); falling back to Gemini.")
    #
    # delay = 2.0
    # last_exc: Any = None
    # for attempt in range(retries):
    #     try:
    #         return _gemini_structured(prompt, schema, temperature)
    #     except Exception as e:
    #         last_exc = e
    #         if _is_quota_or_overload(e):
    #             groq = _get_groq()
    #             if groq is not None:
    #                 print(f"[LLM] Gemini unavailable ({str(e)[:80]}); failing over to Groq {GROQ_MODEL}.")
    #                 return _groq_structured(prompt, schema, temperature)
    #             # No Groq configured — one backoff retry then give up.
    #             if attempt < retries - 1:
    #                 time.sleep(delay)
    #                 delay *= 2
    #                 continue
    #         raise
    # raise last_exc


# ── Smoke test ────────────────────────────────────────────────
if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

    class Demo(BaseModel):
        sentiment: str
        score: int

    print("Gemini path:", structured_generate("Classify sentiment of 'I love this'.", Demo, 0.0))
    # Force the Groq path directly to confirm it works:
    print("Groq path:  ", _groq_structured("Classify sentiment of 'I hate this'.", Demo, 0.0))
