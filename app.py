import asyncio
import os
import json
import time
import csv
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional, List

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from starlette.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import anthropic

# Load environment variables
load_dotenv()

# Validate API keys on startup
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

if not ANTHROPIC_API_KEY:
    raise ValueError("ANTHROPIC_API_KEY not found in environment variables. Please check your .env file.")

# Initialize API client (async for non-blocking LLM calls)
anthropic_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

# Type definitions
ModelType = Literal[
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001"
]

# Pydantic models for Call 1: Extract + Tag
class TaggedFinding(BaseModel):
    source_text: str
    taxonomy_id: str
    taxonomy_name: str
    category: str
    anatomy: str
    assertion: str
    severity: Optional[str] = None
    date: Optional[str] = None
    stability: Optional[str] = None

class TaggedExtractionOutput(BaseModel):
    findings: List[TaggedFinding]

# Pydantic models for Call 2: Synthesize
class FindingInstance(BaseModel):
    date: Optional[str] = None
    source_text: str
    assertion: str

class SynthesizedFinding(BaseModel):
    name: str
    taxonomy_id: str
    taxonomy_name: str
    category: str
    anatomy: str
    assertion: str
    extracted_text: str
    severity: Optional[str] = None
    stability: Optional[str] = None
    superseded: bool = False
    superseded_by: Optional[str] = None
    instances: List[FindingInstance]

class SynthesizedOutput(BaseModel):
    findings: List[SynthesizedFinding]

# API request/response models
class ProcessRequest(BaseModel):
    text: str
    model: ModelType
    session_id: str

class ProcessResponse(BaseModel):
    findings: List[SynthesizedFinding]
    latency_ms: int

# Model configuration mapping
MODEL_CONFIGS = {
    "claude-opus-4-6": {
        "model_id": "claude-opus-4-6",
        "max_tokens": 8192
    },
    "claude-sonnet-4-6": {
        "model_id": "claude-sonnet-4-6",
        "max_tokens": 8192
    },
    "claude-haiku-4-5-20251001": {
        "model_id": "claude-haiku-4-5-20251001",
        "max_tokens": 8192
    }
}

# Global taxonomy reference
taxonomy_reference = ""
taxonomy_rows: list[dict] = []

TAXONOMY_PATH = Path(__file__).parent / "data" / "findings_taxonomy.csv"

def load_taxonomy():
    """Load taxonomy CSV and format as compact reference for prompts"""
    global taxonomy_reference, taxonomy_rows

    if not TAXONOMY_PATH.exists():
        raise FileNotFoundError(f"Taxonomy file not found: {TAXONOMY_PATH}")

    lines = []
    taxonomy_rows = []
    with open(TAXONOMY_PATH, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            taxonomy_rows.append(dict(row))
            # Format: MID1010 | total_joint_arthroplasty | hardware | TJA, Total joint replacement
            line = f"{row['id']} | {row['name']} | {row['category']} | {row['synonyms']}"
            lines.append(line)

    taxonomy_reference = "\n".join(lines)

def load_prompt(prompt_type: Literal["tag", "synthesize", "extract"]) -> str:
    """Load prompt from prompts directory"""
    prompt_path = Path(__file__).parent / "prompts" / f"{prompt_type}.txt"
    if not prompt_path.exists():
        raise FileNotFoundError(f"Prompt file not found: {prompt_path}")
    return prompt_path.read_text(encoding="utf-8")

async def call_llm_structured(
    model_key: ModelType,
    system_prompt: str,
    user_message: str,
    response_format: type
) -> tuple:
    """
    Call Anthropic API with structured output using messages.parse().
    Returns (parsed_output, latency_ms)
    """
    start_time = time.time()

    config = MODEL_CONFIGS[model_key]
    model_id = config["model_id"]
    max_tokens = config["max_tokens"]

    try:
        response = await anthropic_client.messages.parse(
            model=model_id,
            max_tokens=max_tokens,
            system=[
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"}
                }
            ],
            messages=[{"role": "user", "content": user_message}],
            output_format=response_format
        )

        parsed_output = response.parsed_output

        latency_ms = int((time.time() - start_time) * 1000)
        return parsed_output, latency_ms

    except anthropic.APIError as e:
        raise HTTPException(status_code=500, detail=f"Anthropic API error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM API error: {str(e)}")

def log_transaction(
    session_id: str,
    operation: Literal["tag", "synthesize", "extract"],
    model: str,
    input_text: str,
    output_text: str,
    latency_ms: int
):
    """Log transaction to JSONL file"""
    data_dir = Path(__file__).parent / "data"
    data_dir.mkdir(exist_ok=True, parents=True)

    log_path = data_dir / "extractions.jsonl"

    entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "session_id": session_id,
        "operation": operation,
        "model": model,
        "input_text": input_text,
        "output_text": output_text,
        "latency_ms": latency_ms
    }

    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")

# Create FastAPI application
app = FastAPI(
    title="Smart Findings Extractor",
    description="Extract and synthesize chronic findings from musculoskeletal radiology reports",
    version="2.0.0"
)

# Load taxonomy on startup
@app.on_event("startup")
async def startup_event():
    load_taxonomy()

# CORS middleware for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
app.mount("/static", StaticFiles(directory="static", html=True), name="static")

@app.get("/")
async def root():
    """Redirect to static index.html"""
    return RedirectResponse(url="/static/index.html")

@app.get("/api/taxonomy")
async def get_taxonomy():
    """Return taxonomy as a nested tree for visualization."""
    nodes = {}
    roots = []

    for row in taxonomy_rows:
        node = {
            "id": row["id"],
            "name": row["name"],
            "category": row["category"],
            "finding_type": row.get("finding_type", ""),
            "synonyms": row.get("synonyms", ""),
            "children": [],
        }
        nodes[row["id"]] = node

    for row in taxonomy_rows:
        parent_id = row.get("parent_id", "")
        node = nodes[row["id"]]
        if parent_id and parent_id in nodes:
            nodes[parent_id]["children"].append(node)
        else:
            roots.append(node)

    return {"tree": roots, "total": len(taxonomy_rows)}

@app.post("/api/process", response_model=ProcessResponse)
async def process_report(request: ProcessRequest):
    """
    Single endpoint that runs both Call 1 (Extract + Tag) and Call 2 (Synthesize).
    """

    # Load prompts
    tag_prompt = load_prompt("tag")
    synthesize_prompt = load_prompt("synthesize")

    # Inject taxonomy reference into both prompts
    tag_prompt = tag_prompt.replace("{TAXONOMY_REFERENCE}", taxonomy_reference)
    synthesize_prompt = synthesize_prompt.replace("{TAXONOMY_REFERENCE}", taxonomy_reference)

    # Call 1: Extract + Tag
    tagged_output, latency1 = await call_llm_structured(
        model_key=request.model,
        system_prompt=tag_prompt,
        user_message=request.text,
        response_format=TaggedExtractionOutput
    )

    # Log Call 1
    log_transaction(
        session_id=request.session_id,
        operation="tag",
        model=request.model,
        input_text=request.text,
        output_text=tagged_output.model_dump_json(),
        latency_ms=latency1
    )

    # Call 2: Synthesize (takes Call 1 output as input)
    synthesized_output, latency2 = await call_llm_structured(
        model_key=request.model,
        system_prompt=synthesize_prompt,
        user_message=tagged_output.model_dump_json(),
        response_format=SynthesizedOutput
    )

    # Log Call 2
    log_transaction(
        session_id=request.session_id,
        operation="synthesize",
        model=request.model,
        input_text=tagged_output.model_dump_json(),
        output_text=synthesized_output.model_dump_json(),
        latency_ms=latency2
    )

    return ProcessResponse(
        findings=synthesized_output.findings,
        latency_ms=latency1 + latency2
    )

@app.post("/api/process/stream")
async def process_report_stream(request: ProcessRequest):
    """
    Streaming endpoint: Call 1 streams prose via SSE, Call 2 runs in background.
    """

    async def event_generator():
        try:
            # Load and prepare prompts up front
            extract_prompt = load_prompt("extract")
            tag_prompt = load_prompt("tag")
            synthesize_prompt = load_prompt("synthesize")
            tag_prompt = tag_prompt.replace("{TAXONOMY_REFERENCE}", taxonomy_reference)
            synthesize_prompt = synthesize_prompt.replace(
                "{TAXONOMY_REFERENCE}", taxonomy_reference
            )
            config = MODEL_CONFIGS[request.model]

            # --- Start tag call in parallel with extract stream ---
            # Both take the original report text as input, so no dependency
            tag_task = asyncio.create_task(
                call_llm_structured(
                    model_key=request.model,
                    system_prompt=tag_prompt,
                    user_message=request.text,
                    response_format=TaggedExtractionOutput,
                )
            )

            # --- Extract (streamed prose) ---
            start_time = time.time()
            full_text = ""

            async with anthropic_client.messages.stream(
                model=config["model_id"],
                max_tokens=config["max_tokens"],
                temperature=0,
                system=[
                    {
                        "type": "text",
                        "text": extract_prompt,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=[{"role": "user", "content": request.text}],
            ) as stream:
                async for text in stream.text_stream:
                    full_text += text
                    yield f"event: text\ndata: {json.dumps({'text': text})}\n\n"

            extract_latency = int((time.time() - start_time) * 1000)
            yield f"event: done\ndata: {json.dumps({'latency_ms': extract_latency})}\n\n"

            log_transaction(
                session_id=request.session_id,
                operation="extract",
                model=request.model,
                input_text=request.text,
                output_text=full_text,
                latency_ms=extract_latency,
            )

            # --- Wait for tag (already running), send draft, then synthesize ---
            tagged_output, latency1 = await tag_task

            log_transaction(
                session_id=request.session_id,
                operation="tag",
                model=request.model,
                input_text=request.text,
                output_text=tagged_output.model_dump_json(),
                latency_ms=latency1,
            )

            # Send tagged findings as draft structured view
            yield f"event: tagged\ndata: {json.dumps({'findings': [f.model_dump() for f in tagged_output.findings], 'latency_ms': extract_latency + latency1})}\n\n"

            synthesized_output, latency2 = await call_llm_structured(
                model_key=request.model,
                system_prompt=synthesize_prompt,
                user_message=tagged_output.model_dump_json(),
                response_format=SynthesizedOutput,
            )

            log_transaction(
                session_id=request.session_id,
                operation="synthesize",
                model=request.model,
                input_text=tagged_output.model_dump_json(),
                output_text=synthesized_output.model_dump_json(),
                latency_ms=latency2,
            )

            total_latency = extract_latency + latency1 + latency2
            yield f"event: structured\ndata: {json.dumps({'findings': [f.model_dump() for f in synthesized_output.findings], 'latency_ms': total_latency})}\n\n"

        except Exception as e:
            print(f"Stream error: {e}")
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
