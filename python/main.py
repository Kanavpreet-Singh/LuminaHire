"""
LuminaHire — Resume Processing Microservice
=============================================
FastAPI service that handles:
  1. PDF text extraction using LangChain's PyPDFLoader
  2. Vector embedding generation using Google Gemini (text-embedding-004)

Run with:  uvicorn main:app --reload --port 8000
"""

import os
import sys
import tempfile
import traceback
import requests
import base64
from typing import List
from dotenv import load_dotenv

# Windows consoles default to a legacy codepage (cp1252) that can't encode the
# emoji used in live agent step logs -- reconfigure to UTF-8 so a step message
# like "[Step] GitHub: fetching..." never crashes a print() call mid-pipeline.
# No-op on platforms where stdout is already UTF-8.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import registry
import tools
import tracing

from langchain_community.document_loaders import PyPDFLoader
from google import genai
from google.genai.errors import APIError

# Load environment variables from the root .env file
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY is not set in the .env file!")

EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-2")
EMBEDDING_OUTPUT_DIMENSIONALITY = int(os.getenv("EMBEDDING_DIMENSIONS", "1536"))

# Initialize genai client
genai_client = genai.Client()

# ── FastAPI App ──────────────────────────────────────────────
app = FastAPI(
    title="LuminaHire Resume Processor",
    description="Microservice for PDF parsing & Gemini vector embeddings",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


from fastapi.responses import JSONResponse
from fastapi import Request

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
    )


# ── Request / Response Models ────────────────────────────────
class ProcessResumeRequest(BaseModel):
    resume_url: str

class ProcessJobRequest(BaseModel):
    title: str
    description: str
    requirements: str | None = None


class ProcessResumeResponse(BaseModel):
    resume_text: str
    embedding: list[float]
    num_pages: int
    embedding_dimensions: int
    ocr_used: bool


class ProcessJobResponse(BaseModel):
    embedding: list[float]
    embedding_dimensions: int

# ── Gemini Embeddings ────────────────────────────────────────
_HTTP_EMBEDDING_MODEL_CANDIDATES = [
    EMBEDDING_MODEL,
    "gemini-embedding-2",
    "gemini-embedding-001",
]


def _is_quota_or_billing_error(message: str) -> bool:
    text = message.lower()
    keywords = [
        "quota",
        "resource_exhausted",
        "billing",
        "insufficient",
        "credit",
        "rate limit",
        "429",
    ]
    return any(keyword in text for keyword in keywords)


def _embed_query_with_sdk(model_name: str, text: str) -> List[float]:
    try:
        result = genai_client.models.embed_content(
            model=model_name,
            contents=text,
            config={"output_dimensionality": EMBEDDING_OUTPUT_DIMENSIONALITY}
        )
        if not result.embeddings or not result.embeddings[0].values:
            raise RuntimeError(f"Empty embedding values returned by model '{model_name}'")
        return [float(v) for v in result.embeddings[0].values]
    except APIError as e:
        if e.code == 429 or _is_quota_or_billing_error(str(e.message)):
            raise HTTPException(
                status_code=429,
                detail=(
                    "Gemini API quota or billing limit reached. "
                    "Please check your GEMINI_API_KEY project credits/billing and try again."
                ),
            )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API embedding request failed: {e.message}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API embedding request failed: {str(e)}",
        )

def _chunk_text(text: str, chunk_size: int = 10000, overlap: int = 500) -> List[str]:
    if len(text) <= chunk_size:
        return [text]

    chunks: List[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + chunk_size)
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = max(0, end - overlap)
    return chunks


def _mean_pool(vectors: List[List[float]]) -> List[float]:
    if not vectors:
        raise ValueError("No vectors to pool")
    if len(vectors) == 1:
        return vectors[0]

    dims = len(vectors[0])
    pooled = [0.0] * dims

    for vec in vectors:
        if len(vec) != dims:
            raise ValueError("Embedding vectors have inconsistent dimensions")
        for i, value in enumerate(vec):
            pooled[i] += float(value)

    count = float(len(vectors))
    return [value / count for value in pooled]


def _extract_text_from_pdf_with_loader(pdf_path: str) -> tuple[str, int]:
    loader = PyPDFLoader(pdf_path)
    pages = loader.load()
    full_text = "\n\n".join([page.page_content for page in pages]).strip()
    return full_text, len(pages)


def _extract_pdf_hyperlinks(pdf_path: str) -> List[str]:
    """
    Pull real hyperlink targets (PDF link annotations) out of the resume PDF.
    Resumes very often show link text like "GitHub" or "Portfolio" with the
    actual URL only present as a clickable hyperlink, not as visible text --
    plain text extraction (PyPDFLoader / OCR) misses those entirely. Never
    raises; returns [] on any failure so resume processing still succeeds.
    """
    urls: List[str] = []
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        for page in reader.pages:
            annots = page.get("/Annots")
            if not annots:
                continue
            for annot_ref in annots:
                try:
                    annot = annot_ref.get_object()
                    if annot.get("/Subtype") != "/Link":
                        continue
                    action = annot.get("/A")
                    if not action:
                        continue
                    uri = action.get("/URI")
                    if uri and str(uri) not in urls:
                        urls.append(str(uri))
                except Exception:
                    continue
    except Exception as e:
        print(f"[PDF hyperlink extraction] skipped: {e}")
    return urls


def _extract_text_with_gemini_ocr(pdf_path: str) -> str:
    with open(pdf_path, "rb") as f:
        pdf_bytes = f.read()

    try:
        result = genai_client.models.generate_content(
            model="gemini-1.5-flash",
            contents=[
                "Extract all readable text from this resume PDF. "
                "Preserve section boundaries with line breaks. "
                "Return only plain text and do not add commentary.",
                {"mime_type": "application/pdf", "data": pdf_bytes}
            ]
        )
        return result.text or ""
    except APIError as e:
        if e.code == 429 or _is_quota_or_billing_error(str(e.message)):
            raise HTTPException(
                status_code=429,
                detail=(
                    "Gemini API quota or billing limit reached. "
                    "Please check your GEMINI_API_KEY project credits/billing and try again."
                ),
            )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API OCR request failed: {e.message}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API OCR request failed: {str(e)}",
        )


def _embed_text(text: str) -> List[float]:
    chunks = _chunk_text(text)
    last_error: Exception | None = None

    for model_name in _HTTP_EMBEDDING_MODEL_CANDIDATES:
        try:
            vectors = [_embed_query_with_sdk(model_name, chunk) for chunk in chunks]
            return _mean_pool(vectors)
        except HTTPException as exc:
            # Continue trying the next model for non-quota failures (e.g. model not found).
            if exc.status_code == 429:
                raise
            last_error = exc
        except Exception as exc:
            last_error = exc

    if last_error is not None:
        raise last_error
    raise RuntimeError("No embedding model candidates available")


# ── Main Endpoint ────────────────────────────────────────────
@app.post("/process-resume", response_model=ProcessResumeResponse)
async def process_resume(req: ProcessResumeRequest):
    """
    Downloads a PDF from the given URL, extracts text, falls back to OCR for
    scanned/image-only PDFs, and generates a Gemini embedding vector.
    """
    tmp_path = None
    ocr_used = False
    try:
        # 1. Download the PDF to a temp file
        print(f"[1/3] Downloading PDF from: {req.resume_url[:80]}...")
        try:
            response = requests.get(req.resume_url, timeout=30)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=400, detail=f"Failed to download PDF: {str(e)}")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(response.content)
            tmp_path = tmp.name

        # 2. Extract text using LangChain PyPDFLoader
        print(f"[2/3] Extracting text with LangChain PyPDFLoader...")
        full_text, page_count = _extract_text_from_pdf_with_loader(tmp_path)

        if not full_text:
            print("PyPDFLoader returned empty content. Running Gemini OCR fallback...")
            ocr_used = True
            full_text = _extract_text_with_gemini_ocr(tmp_path)

        if not full_text:
            raise HTTPException(
                status_code=422,
                detail="Could not extract text from PDF (direct parsing and OCR both failed).",
            )

        # Append real PDF hyperlink targets (link annotations), which are
        # invisible to plain text extraction -- resumes often show "GitHub" as
        # the link text with the actual URL only reachable as a hyperlink.
        # This lets the vetting pipeline's resume URL scan pick them up later.
        hyperlinks = _extract_pdf_hyperlinks(tmp_path)
        if hyperlinks:
            print(f"Found {len(hyperlinks)} PDF hyperlink(s): {hyperlinks[:5]}")
            full_text += "\n\n[Hyperlinks found in resume PDF]\n" + "\n".join(hyperlinks)

        # 3. Generate Gemini embedding
        print(f"[3/3] Generating Gemini embedding ({len(full_text)} chars)...")
        embedding_vector = _embed_text(full_text)

        print(
            f"Done! Extracted {page_count} pages, {len(full_text)} chars, "
            f"{len(embedding_vector)}-dim vector. OCR used: {ocr_used}"
        )

        return ProcessResumeResponse(
            resume_text=full_text,
            embedding=embedding_vector,
            num_pages=page_count,
            embedding_dimensions=len(embedding_vector),
            ocr_used=ocr_used,
        )

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        print(f"Error processing resume: {e}")
        raise HTTPException(status_code=500, detail=f"Resume processing failed: {str(e)}")
    finally:
        # Clean up temp file
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

@app.post("/process-job", response_model=ProcessJobResponse)
async def process_job(req: ProcessJobRequest):
    """
    Generates a Gemini embedding vector for a job posting.
    """
    try:
        # Combine text for context
        full_text = f"Title: {req.title}\n\nDescription:\n{req.description}"
        if req.requirements:
            full_text += f"\n\nRequirements:\n{req.requirements}"
            
        print(f"Generating embedding for job posting ({len(full_text)} chars)...")
        embedding_vector = _embed_text(full_text)
        
        return ProcessJobResponse(
            embedding=embedding_vector,
            embedding_dimensions=len(embedding_vector)
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        print(f"Error processing job: {e}")
        raise HTTPException(status_code=500, detail=f"Job processing failed: {str(e)}")

# ── Vetting Agent Endpoints ────────────────────────────────────

class JobInput(BaseModel):
    title: str
    description: str
    requirements: str | None = None
    # Batch "Hiring Committee" priority instructions (free text). Absent/None
    # for single-candidate runs -- every agent prompt renders its instruction
    # block empty when this is falsy, so the existing flow is unchanged.
    recruiter_instructions: str | None = None

class CandidateInput(BaseModel):
    name: str
    email: str
    resume_text: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None

class VetInitiateRequest(BaseModel):
    job: JobInput
    candidate: CandidateInput

class VetExecuteRequest(BaseModel):
    job: JobInput
    candidate: CandidateInput
    planner_output: dict

class VetExecuteAsyncRequest(VetExecuteRequest):
    session_id: str

class VetRunFullAsyncRequest(VetInitiateRequest):
    session_id: str

class VetResumeAsyncRequest(BaseModel):
    session_id: str
    job: JobInput
    candidate: CandidateInput
    planner_output: dict | None = None
    research_results: list | None = None
    research_iterations: int | None = 0
    hitl: bool = False
    resume_at_evaluator: bool = False


class VetResearchFollowupRequest(BaseModel):
    session_id: str
    job: JobInput
    candidate: CandidateInput
    planner_output: dict
    research_results: list
    instruction: str


class VetResearchApproveAsyncRequest(BaseModel):
    session_id: str
    job: JobInput
    candidate: CandidateInput
    planner_output: dict
    research_results: list
    research_iterations: int = 0


class VetEvaluationApproveAsyncRequest(BaseModel):
    session_id: str
    job: JobInput
    candidate: CandidateInput
    planner_output: dict
    research_results: list
    research_iterations: int = 0
    evaluation: dict


class VetQARequest(BaseModel):
    session_id: str
    job: JobInput
    candidate: CandidateInput
    planner_output: dict | None = None
    research_results: list | None = None
    evaluation: dict | None = None
    final_report: dict
    question: str


def _job_dict(job: JobInput) -> dict:
    return {
        "title": job.title,
        "description": job.description,
        "requirements": job.requirements,
        "recruiter_instructions": job.recruiter_instructions,
    }

def _candidate_dict(c: CandidateInput) -> dict:
    """
    Build the candidate dict used by every vetting endpoint. The website
    profile fields (linkedin_url/github_url) always win when present; if
    either is missing, fall back to a deterministic scan of the resume text
    (including any real PDF hyperlinks appended during resume processing --
    see _extract_pdf_hyperlinks) so a candidate who only pasted/linked their
    GitHub/LinkedIn on their resume still gets researched instead of showing
    "not found". Every other platform (leetcode/gfg/codeforces/hackerrank/
    codechef/medium/devto/stackoverflow/npm/scholar/portfolio) has no
    dedicated website field at all, so those always come from this resume scan.
    """
    linkedin_url = c.linkedin_url
    github_url = c.github_url
    extra_urls: dict = {k: None for k in tools.PROFILE_URL_KEYS if k not in ("linkedin_url", "github_url")}
    if c.resume_text:
        extracted = tools.extract_profile_urls_from_resume(c.resume_text)
        linkedin_url = linkedin_url or extracted.get("linkedin_url")
        github_url = github_url or extracted.get("github_url")
        extra_urls = {k: v for k, v in extracted.items() if k not in ("linkedin_url", "github_url")}

    return {
        "name": c.name, "email": c.email, "resume_text": c.resume_text,
        "linkedin_url": linkedin_url, "github_url": github_url,
        **extra_urls,
    }


@app.post("/vet/initiate")
async def initiate_vetting(req: VetInitiateRequest):
    """
    Runs Stage 1 (Planner Agent) to outline which areas to check.
    Kept synchronous for backward compatibility with the HITL flow.
    """
    import agents

    state = agents.new_state(_job_dict(req.job), _candidate_dict(req.candidate))
    try:
        result = agents.app_graph.invoke(state)
        return {
            "planner_output": result.get("planner_output"),
            "logs": result.get("logs", []),
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Vetting initiation failed: {str(e)}")


@app.post("/vet/execute")
async def execute_vetting(req: VetExecuteRequest):
    """
    Runs Stage 2 (Researcher -> Evaluator -> Report Writer) synchronously using
    the approved research plan. Kept for backward compatibility.
    """
    import agents

    state = agents.new_state(
        _job_dict(req.job), _candidate_dict(req.candidate), planner_output=req.planner_output
    )
    try:
        result = agents.app_graph.invoke(state)
        return {
            "research_results": result.get("research_results"),
            "final_report": result.get("final_report"),
            "logs": result.get("logs", []),
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Vetting execution failed: {str(e)}")


# ── Background pipeline runner + async endpoints ────────────────

@tracing.observe(name="vetting_pipeline_run")
def _run_pipeline(session_id: str, job: dict, candidate: dict, planner_output,
                  research_results=None, research_iterations: int = 0, hitl: bool = False,
                  skip_to_evaluator: bool = False):
    """
    Plain `def` so FastAPI runs it in the threadpool (sync LLM calls must NOT
    block the event loop). Streams the graph and mirrors phase transitions into
    the in-memory registry.

    Resume semantics (skips already-completed stages):
      - planner_output is None    -> plan first (run-full)
      - skip_to_evaluator=True    -> jump straight to evaluation (resume/approve)
      - otherwise                 -> start from research

    skip_to_evaluator is an EXPLICIT caller decision, not inferred from
    research_results content -- an approved-but-empty research pass (e.g. the
    planner's queries all came back empty in real mode) is still a valid
    "move on to evaluation" case, and an empty list is falsy in Python, so
    inferring intent from research_results truthiness would silently send an
    explicitly-approved empty pass back through the researcher instead.

    hitl=True pauses the graph after the first research pass and after
    evaluation settles (see agents.route_after_researcher/route_after_evaluation),
    landing on AWAITING_RESEARCH_INPUT / AWAITING_EVALUATION_APPROVAL instead of
    running straight through to COMPLETED. hitl=False (run-full-async, non-HITL
    resume) is unaffected and always runs to COMPLETED or FAILED.
    """
    import agents

    tracing.start_session_trace(session_id, name="vetting_pipeline_run", metadata={"hitl": hitl, "skip_to_evaluator": skip_to_evaluator})
    tracing.reset_usage()

    with registry.PIPELINE_SEMAPHORE:
        try:
            base_logs: List[str] = []

            # Pass 1: planning (only when no plan exists yet). Graph pauses at planner->END.
            if planner_output is None and not research_results:
                registry.set_phase(session_id, "PLANNING")
                stage1 = agents.app_graph.invoke(agents.new_state(job, candidate, session_id=session_id))
                planner_output = stage1.get("planner_output")
                base_logs = stage1.get("logs", []) or []
                registry.set_planner_output(session_id, planner_output)
                registry.set_progress(session_id, logs=base_logs)

            # Pass 2: research/evaluate/report (or resume mid-way).
            registry.set_phase(session_id, "EVALUATING" if skip_to_evaluator else "RESEARCHING")
            if skip_to_evaluator:
                registry.set_progress(session_id, research_results=research_results or [],
                                      research_iterations=research_iterations)
            state2 = agents.new_state(
                job, candidate, planner_output=planner_output,
                research_results=research_results, research_iterations=research_iterations,
                hitl=hitl, skip_to_evaluator=skip_to_evaluator, session_id=session_id,
            )
            state2["logs"] = list(base_logs)

            final = None
            for step in agents.app_graph.stream(state2, stream_mode="values"):
                final = step
                if step.get("final_report") is None and step.get("evaluation") is not None:
                    registry.set_phase(session_id, "EVALUATING")
                registry.set_progress(
                    session_id,
                    research_results=step.get("research_results"),
                    research_iterations=step.get("research_iterations"),
                    logs=step.get("logs"),
                )

            if final is None:
                raise RuntimeError("Pipeline produced no output.")

            if final.get("final_report") is not None:
                registry.set_results(
                    session_id,
                    final_report=final.get("final_report"),
                    research_results=final.get("research_results", []),
                    logs=final.get("logs", []),
                    research_iterations=final.get("research_iterations", 0),
                    planner_output=planner_output,
                    evaluation=final.get("evaluation"),
                    usage=tracing.get_usage(),
                )
            elif final.get("evaluation") is not None:
                registry.set_awaiting_evaluation(
                    session_id,
                    evaluation=final.get("evaluation"),
                    research_results=final.get("research_results", []),
                    research_iterations=final.get("research_iterations", 0),
                    logs=final.get("logs", []),
                    usage=tracing.get_usage(),
                )
            else:
                registry.set_awaiting_research(
                    session_id,
                    research_results=final.get("research_results", []),
                    research_iterations=final.get("research_iterations", 0),
                    logs=final.get("logs", []),
                    usage=tracing.get_usage(),
                )
        except Exception as e:
            traceback.print_exc()
            registry.set_failed(session_id, str(e), usage=tracing.get_usage())


@tracing.observe(name="report_stage_run")
def _run_report_stage(session_id: str, job: dict, candidate: dict, planner_output,
                      research_results: list, research_iterations: int, evaluation: dict):
    """
    Runs ONLY the Report Writer on an already-approved evaluation, bypassing the
    graph entirely (report_writer_node has no branching, so there's nothing for
    LangGraph routing to add here). Used by /vet/evaluation/approve-async.
    """
    import agents

    tracing.start_session_trace(session_id, name="report_stage_run")
    tracing.reset_usage()

    with registry.PIPELINE_SEMAPHORE:
        try:
            state = agents.new_state(
                job, candidate, planner_output=planner_output,
                research_results=research_results, research_iterations=research_iterations,
                evaluation=evaluation, session_id=session_id,
            )
            result = agents.report_writer_node(state)
            registry.set_results(
                session_id,
                final_report=result.get("final_report"),
                research_results=research_results,
                logs=result.get("logs", []),
                research_iterations=research_iterations,
                planner_output=planner_output,
                evaluation=evaluation,
                usage=tracing.get_usage(),
            )
        except Exception as e:
            traceback.print_exc()
            registry.set_failed(session_id, str(e), usage=tracing.get_usage())


@app.post("/vet/execute-async", status_code=202)
async def execute_vetting_async(req: VetExecuteAsyncRequest, background_tasks: BackgroundTasks):
    """Kick off Stage 2 (research only) in the background for an already-approved
    plan. Pauses at AWAITING_RESEARCH_INPUT for human review."""
    if not registry.create(req.session_id, initial_phase="RESEARCHING"):
        raise HTTPException(status_code=409, detail="A run for this session is already in progress.")
    background_tasks.add_task(
        _run_pipeline, req.session_id, _job_dict(req.job), _candidate_dict(req.candidate),
        req.planner_output, None, 0, True, False,
    )
    return {"session_id": req.session_id, "status": "started"}


@app.post("/vet/run-full-async", status_code=202)
async def run_full_async(req: VetRunFullAsyncRequest, background_tasks: BackgroundTasks):
    """Kick off the entire pipeline (plan -> research -> evaluate -> report) with no HITL."""
    if not registry.create(req.session_id, initial_phase="PLANNING"):
        raise HTTPException(status_code=409, detail="A run for this session is already in progress.")
    background_tasks.add_task(
        _run_pipeline, req.session_id, _job_dict(req.job), _candidate_dict(req.candidate), None
    )
    return {"session_id": req.session_id, "status": "started"}


@app.post("/vet/resume-async", status_code=202)
async def resume_async(req: VetResumeAsyncRequest, background_tasks: BackgroundTasks):
    """
    Resume an interrupted run from its last persisted stage. resume_at_evaluator
    (computed by the Next.js resume route from whether any research results were
    actually persisted) decides whether the graph resumes at evaluation
    (skipping re-research) or at research; otherwise it plans first. hitl mirrors
    the session's pipeline mode so a crash-recovered HITL session still pauses
    for review instead of silently running to completion.
    """
    if not registry.create(req.session_id, initial_phase="RESEARCHING"):
        raise HTTPException(status_code=409, detail="A run for this session is already in progress.")
    background_tasks.add_task(
        _run_pipeline, req.session_id, _job_dict(req.job), _candidate_dict(req.candidate),
        req.planner_output, req.research_results, req.research_iterations or 0, req.hitl,
        req.resume_at_evaluator,
    )
    return {"session_id": req.session_id, "status": "started"}


@app.post("/vet/research/followup")
@tracing.observe(name="research_followup")
async def research_followup(req: VetResearchFollowupRequest):
    """
    Synchronous HITL follow-up: an LLM decides which tool(s) (web_search_tool,
    github_profile_tool, github_topic_search_tool) to call based on the
    recruiter's free-text instruction, executes them, and returns new findings
    for the caller to append to the session's research_results. Bounded to a
    handful of tool calls, so this stays synchronous like the legacy endpoints.
    """
    import research_agent

    tracing.start_session_trace(req.session_id, name="research_followup")
    tracing.reset_usage()
    try:
        result = research_agent.run_guided_research(
            _job_dict(req.job), _candidate_dict(req.candidate),
            req.planner_output, req.research_results, req.instruction,
        )
        result["usage"] = tracing.get_usage()
        return result
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Guided research failed: {str(e)}")


@app.post("/vet/research/approve-async", status_code=202)
async def research_approve_async(req: VetResearchApproveAsyncRequest, background_tasks: BackgroundTasks):
    """Approve the reviewed research and kick off evaluation. Pauses at
    AWAITING_EVALUATION_APPROVAL for human review."""
    if not registry.create(req.session_id, initial_phase="EVALUATING"):
        raise HTTPException(status_code=409, detail="A run for this session is already in progress.")
    background_tasks.add_task(
        _run_pipeline, req.session_id, _job_dict(req.job), _candidate_dict(req.candidate),
        req.planner_output, req.research_results, req.research_iterations or 0, True, True,
    )
    return {"session_id": req.session_id, "status": "started"}


@app.post("/vet/evaluation/approve-async", status_code=202)
async def evaluation_approve_async(req: VetEvaluationApproveAsyncRequest, background_tasks: BackgroundTasks):
    """Approve the reviewed evaluation and generate the final report. Ends COMPLETED."""
    if not registry.create(req.session_id, initial_phase="EVALUATING"):
        raise HTTPException(status_code=409, detail="A run for this session is already in progress.")
    background_tasks.add_task(
        _run_report_stage, req.session_id, _job_dict(req.job), _candidate_dict(req.candidate),
        req.planner_output, req.research_results, req.research_iterations or 0, req.evaluation,
    )
    return {"session_id": req.session_id, "status": "started"}


@app.post("/vet/qa")
@tracing.observe(name="vet_qa")
async def vet_qa(req: VetQARequest):
    """Answer a recruiter's free-text question using the full accumulated pipeline context."""
    import agents

    tracing.start_session_trace(req.session_id, name="vet_qa")
    tracing.reset_usage()
    try:
        answer = agents.answer_qa_question(
            _job_dict(req.job), _candidate_dict(req.candidate),
            req.planner_output, req.research_results, req.evaluation, req.final_report, req.question,
        )
        answer["usage"] = tracing.get_usage()
        return answer
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Q&A failed: {str(e)}")


@app.get("/vet/status/{session_id}")
async def vet_status(session_id: str):
    """Poll a background run's phase and (once available) results."""
    entry = registry.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="No active or recent task for this session id.")
    return {
        "phase": entry["phase"],
        "planner_output": entry["planner_output"],
        "research_results": entry["research_results"],
        "evaluation": entry.get("evaluation"),
        "final_report": entry["final_report"],
        "logs": entry["logs"],
        "research_iterations": entry["research_iterations"],
        "error": entry["error"],
        "usage": entry.get("usage"),
    }

# ── Health Check ─────────────────────────────────────────────
@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "LuminaHire Resume Processor"}
