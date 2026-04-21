# Smart Findings

A web application that extracts and synthesizes chronic findings from musculoskeletal radiology reports into persistent longitudinal entities using Claude LLMs.

Built by [Michael Hood, MD](https://github.com/hoodcm), emergency radiologist at Massachusetts General Hospital / Mass General Brigham and primary member of the [Open Imaging Data Model (OIDM) Collaborative](https://github.com/open-imaging-data-model). Related OIDM work includes the [Imaging Problem List](https://github.com/hoodcm/JAMIA-imaging-problem-list/tree/add-exemplar-patient-jamia).

> This application is a research demonstration and is not approved for use with protected health information (PHI) or any data subject to HIPAA, HITECH, or equivalent privacy regulations. Use only synthetic, de-identified, or publicly available data. The authors assume no responsibility for unauthorized use of patient data.

## The Problem

Chronic findings in MSK radiology reports — hardware, degenerative changes, old fractures — are scattered across report sections and repeated inconsistently across longitudinal studies. Radiologists manually re-dictate these findings for every new exam, which is time-consuming and error-prone.

## The Solution

Smart Findings treats chronic findings as **persistent longitudinal entities** rather than isolated report artifacts. A "right total hip arthroplasty" mentioned across three reports is one entity with three temporal instances — not three separate findings. The system extracts, classifies, deduplicates, and normalizes these entities into structured output ready for clinical carry-forward.

## Three-Stage Pipeline

The application runs three LLM calls against the input reports:

1. **Extract** (streamed prose): Reads reports and produces a clean, anatomy-grouped carry-forward summary. Streams via SSE for immediate rendering (~6s to first content). Handles chronicity gating, negative assertions, anatomy normalization, phraseology standardization, supersession logic, and multi-report entity resolution.

2. **Tag** (structured JSON): Re-reads reports sentence by sentence and tags each chronic finding with a taxonomy identifier. Runs in parallel with Extract. Produces one JSON object per finding with taxonomy ID, assertion (positive/negative), severity, anatomy, date, and verbatim source text. No deduplication — that's the next stage's job.

3. **Synthesize** (structured JSON): Takes tagged findings and resolves them into longitudinal entities. Groups by taxonomy ID + anatomy, merges degenerative sub-findings, applies supersession rules (arthroplasty supersedes native joint, revision supersedes prior complications), and produces normalized clinical text with temporal instance histories.

## Three Output Views

- **Report View**: Anatomy-grouped prose, superseded findings excluded — ready to paste into a dictation
- **Structured View**: Interactive entity cards with category badges, assertion indicators, expandable instance histories, and a negative findings toggle
- **JSON View**: Raw structured output

## Features

- SSE streaming for immediate Report View rendering
- Taxonomy-based classification (bring your own MSK findings taxonomy)
- Pertinent negatives as first-class entities with visibility toggle
- Supersession logic: arthroplasty supersedes native joint findings, revision supersedes prior complications
- Hardware negative roll-up: individual hardware negatives consolidate to "No hardware abnormality"
- Severity normalization to a 5-tier scale (mild → severe), only when explicitly stated
- Phraseology standardization: stability language, hedging removal, remote timing, degenerative formatting
- Multiple Claude models: Opus 4.6, Sonnet 4.6, Haiku 4.5
- Prompt caching via Anthropic `cache_control` for cost savings
- JSONL transaction logging
- Accessible UI with ARIA semantics, keyboard navigation, and screen reader support
- Responsive two-column desktop / single-column mobile layout

## Prerequisites

- Python 3.13+
- [Anthropic API key](https://console.anthropic.com/)
- An MSK findings taxonomy CSV (see [Taxonomy Setup](#taxonomy-setup))

## Setup

```bash
git clone https://github.com/hoodcm/msk-xr-smart-findings-demo.git
cd smart-findings
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Configure your API key:

```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### Taxonomy Setup

The application expects a findings taxonomy CSV at `data/findings_taxonomy.csv`. This file is not included in the repository — you need to provide your own.

The CSV must have these columns: `id`, `name`, `category`, `parent_id`, `synonyms`, `finding_type`.

- `id`: Unique identifier (e.g., `MID1010`)
- `name`: Finding name (e.g., `total_joint_arthroplasty`)
- `category`: One of `extrinsic`, `osseous`, `articular`, `alignment`, `soft_tissue`, `technique`
- `parent_id`: ID of the parent entry (for hierarchy), or empty for root entries
- `synonyms`: Comma-separated alternate names
- `finding_type`: Finding classification

Place your taxonomy file at `data/findings_taxonomy.csv` (or symlink it):

```bash
ln -s /path/to/your/taxonomy.csv data/findings_taxonomy.csv
```

## Usage

Start the server:

```bash
uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

Navigate to [http://localhost:8000](http://localhost:8000).

1. Paste one or more MSK radiology reports into the input area
2. Select a model from the dropdown
3. Click **Process Reports** (or press Cmd+Enter)

The Report View streams immediately. Structured and JSON views populate in the background.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/process/stream` | POST | SSE streaming: streams prose extract, then sends tagged and synthesized findings as events |
| `/api/process` | POST | Non-streaming: returns synthesized findings directly |
| `/api/taxonomy` | GET | Returns the findings taxonomy as nested tree JSON |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.13, FastAPI, Uvicorn |
| Frontend | Single-page HTML, Tailwind CSS (CDN), Lucide icons |
| LLM | Anthropic Claude API |
| Data | JSONL transaction logs |

## License

MIT
