"""Meeting recordings: from a video (uploaded, or from Zoom) and its slides to a study scene.

1. A timestamped transcript: Zoom's own when it has one, otherwise faster-whisper locally.
2. Slide text from .pptx (read here) and .pdf (read with pypdf), plus any notes files.
3. graphify maps the ideas in the transcript and slides (this needs an LLM backend).
4. One LLM call writes study notes: chapters, key points, terms, decisions, actions.
5. The key points become the moments the constellation replays, each lighting up the
   concepts it is about.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import zoom
from common import (CACHE_DIR, ROOT, BuildError, Job, graphify_command, graphify_python, rmtree, stream,
                    summarize_graph)

HELPER = ROOT / "meeting_helper.py"
UPLOADS = CACHE_DIR / "uploads"
MEETINGS = CACHE_DIR / "meetings"

SCENE_VERSION = 1
MEDIA_EXTS = {".mp4", ".mov", ".m4a", ".mp3", ".wav", ".webm", ".mkv", ".m4v", ".ogg", ".avi"}
DOC_EXTS = {".pdf", ".pptx", ".docx", ".md", ".txt"}
MAX_UPLOAD = 8 * 1024 ** 3
MAX_POINTS = 45
CONCEPTS_FOR_NOTES = 120
POINT_KINDS = {"idea", "example", "decision", "question", "action", "definition"}
EXTRAS_HINT = 'pip install "graphifyy[video,pdf,office]"'

TRANSCRIBE_TIMEOUT = 6 * 3600
EXTRACT_TIMEOUT = 2 * 3600
NOTES_TIMEOUT = 30 * 60


# ---------------------------------------------------------------------------
# Uploads: streamed to disk, named by their content so a re-upload costs nothing.


def save_upload(name: str, length: int, body) -> dict:
    safe = safe_name(name)
    ext = Path(safe).suffix.lower()
    if ext not in MEDIA_EXTS | DOC_EXTS:
        raise ValueError(f"{ext or 'That kind of file'} isn't supported. Recordings: {', '.join(sorted(MEDIA_EXTS))}. "
                         f"Slides and notes: {', '.join(sorted(DOC_EXTS))}.")
    if length <= 0:
        raise ValueError("That file is empty.")
    if length > MAX_UPLOAD:
        raise ValueError("That file is larger than 8 GB.")

    UPLOADS.mkdir(parents=True, exist_ok=True)
    incoming = UPLOADS / f".incoming-{uuid.uuid4().hex}"
    digest = hashlib.sha1()
    remaining = length
    try:
        with open(incoming, "wb") as out:
            while remaining:
                chunk = body.read(min(1 << 20, remaining))
                if not chunk:
                    break
                out.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
        if remaining:
            raise ValueError("The upload was cut short. Please try again.")
        upload_id = digest.hexdigest()[:20]
        folder = UPLOADS / upload_id
        folder.mkdir(exist_ok=True)
        dest = folder / safe
        if not dest.exists():
            incoming.replace(dest)
    finally:
        incoming.unlink(missing_ok=True)
    return {"id": upload_id, "name": safe, "size": length}


def upload_path(upload_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{20}", str(upload_id or "")):
        raise BuildError("That upload isn't known here; please add the file again.")
    folder = UPLOADS / upload_id
    found = sorted(p for p in folder.iterdir() if p.is_file()) if folder.is_dir() else []
    if not found:
        raise BuildError("That upload is gone; please add the file again.")
    return found[0]


def safe_name(name: str) -> str:
    base = re.split(r"[\\/]", str(name or ""))[-1]
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base).strip(" .") or "file"
    stem, ext = os.path.splitext(base)
    return (stem[:100] or "file") + ext[:10].lower()


# ---------------------------------------------------------------------------
# What this machine can do (graphify's extras and LLM backend live in graphify's Python)


_probe: dict = {"at": 0.0, "value": None}


def helper_env() -> dict:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "NO_COLOR": "1"}
    # Through Claude Code, graphify defaults to the largest model; Sonnet is quicker and plenty here.
    env.setdefault("GRAPHIFY_CLAUDE_CLI_MODEL", "sonnet")
    return env


def readiness(refresh: bool = False) -> dict:
    if not refresh and _probe["value"] and time.time() - _probe["at"] < 300:
        return {**_probe["value"], "zoom": zoom.status()}
    py = graphify_python()
    value = {"graphify": graphify_command() is not None, "python": bool(py), "transcribe": False, "pdf": False,
             "docx": False, "backend": None, "backend_source": "", "extras": EXTRAS_HINT}
    if py:
        try:
            result = subprocess.run([py, str(HELPER), "probe"], capture_output=True, timeout=90, cwd=ROOT, env=helper_env())
            value.update(json.loads(result.stdout.decode("utf-8", "replace").strip().splitlines()[-1]))
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
            pass
    _probe.update(at=time.time(), value=value)
    return {**value, "zoom": zoom.status()}


# ---------------------------------------------------------------------------
# The whole pipeline


def build_meeting(job: Job, *, media_id: str | None, zoom_uuid: str | None, doc_ids: list[str], title: str,
                  max_nodes: int) -> dict:
    ready = readiness(refresh=True)
    py = graphify_python()
    if graphify_command() is None or not py:
        raise BuildError("graphify isn't installed. Run `pip install graphifyy`, then start this app again.")
    backend = ready.get("backend")
    if not backend:
        raise BuildError("Meetings need an AI model so graphify can understand the conversation. Install Claude Code "
                         "and sign in once (graphify uses your subscription), or set ANTHROPIC_API_KEY or another key "
                         "graphify supports, then try again.")

    docs = [upload_path(d) for d in doc_ids]
    for doc in docs:
        if doc.suffix.lower() not in DOC_EXTS:
            raise BuildError(f"{doc.name} isn't a slides or notes file.")
    cfg = zoom_meeting = media = None
    if zoom_uuid:
        cfg = zoom.load_config()
        if not cfg:
            raise BuildError("Zoom isn't connected yet.")
        job.update("Finding the recording on Zoom")
        zoom_meeting = zoom.recording(cfg, zoom_uuid)
        media_key = "zoom-" + hashlib.sha1(zoom_uuid.encode()).hexdigest()[:16]
        source_name = zoom_meeting.get("topic") or "Zoom meeting"
        when = zoom_meeting.get("start_time")
    else:
        media = upload_path(media_id or "")
        if media.suffix.lower() not in MEDIA_EXTS:
            raise BuildError(f"{media.name} doesn't look like a recording.")
        media_key, source_name, when = media_id, media.name, None

    docs_key = hashlib.sha1("|".join(sorted(doc_ids)).encode()).hexdigest()[:12] if doc_ids else "talk-only"
    base = MEETINGS / media_key
    work = base / docs_key
    scene_file = work / "scene.json"
    meeting_id = f"{media_key}.{docs_key}"

    cached = _load(scene_file)
    if cached and cached.get("version") == SCENE_VERSION and cached.get("max_nodes") == max_nodes:
        job.update("Found this meeting from last time")
        if title and cached["meeting"].get("title") != title:
            cached["meeting"]["title"] = title
            scene_file.write_text(json.dumps(cached, separators=(",", ":")), "utf-8")
        return cached

    work.mkdir(parents=True, exist_ok=True)
    transcript = get_transcript(job, base, py, media, zoom_meeting, cfg, title)
    paras = paragraphs(transcript["segments"])
    if not paras:
        raise BuildError("No speech was found in that recording.")
    duration = float(transcript.get("duration") or paras[-1]["end"])

    decks, passthrough = read_documents(job, py, docs, work, bool(ready.get("docx")))
    corpus = write_corpus(work / "corpus", title or _pretty(source_name), paras, decks, passthrough)
    graph_file = run_graphify(job, corpus, work / "graphify", backend)
    try:
        graph = json.loads(graph_file.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise BuildError(f"graphify wrote a graph I couldn't read ({exc}).") from exc
    g = summarize_graph(graph, max_nodes, file_of=_file_name, fallback_group=_group_of_file)
    if not g["keep"]:
        raise BuildError("graphify didn't find any ideas to map in this meeting.")

    concepts = g["labels"][:CONCEPTS_FOR_NOTES]
    slide_count = sum(len(d["slides"]) for d in decks)
    raw = write_notes(job, py, work, title, duration, paras, decks, concepts, backend)
    notes = clean_notes(raw, duration, len(concepts), slide_count) if raw else None
    if not notes or not notes["points"]:
        notes = simple_notes(paras, duration)

    job.update("Arranging the stars")
    meta = {
        "id": meeting_id,
        "title": title or notes["title"] or _pretty(source_name),
        "date": when,
        "source": "zoom" if zoom_uuid else "upload",
        "file": source_name,
        "docs": [d.name for d in docs],
    }
    scene = make_meeting_scene(g, paras, transcript, duration, slide_count, notes, meta, max_nodes)
    scene.update(version=SCENE_VERSION, max_nodes=max_nodes)
    scene_file.write_text(json.dumps(scene, separators=(",", ":")), "utf-8")
    return scene


def open_meeting(meeting_id: str) -> dict:
    match = re.fullmatch(r"((?:zoom-)?[0-9a-f]{16,20})\.([0-9a-f]{12}|talk-only)", str(meeting_id or ""))
    scene = _load(MEETINGS / match[1] / match[2] / "scene.json") if match else None
    if not scene:
        raise BuildError("That meeting isn't saved here any more.")
    return scene


# ---------------------------------------------------------------------------
# 1. Transcript


def get_transcript(job: Job, base: Path, py: str, media: Path | None, zoom_meeting: dict | None, cfg: dict | None,
                   title: str) -> dict:
    cached = _load(base / "transcript.json")
    if cached and cached.get("segments"):
        job.update("Using the transcript from last time")
        return cached
    base.mkdir(parents=True, exist_ok=True)

    data = None
    if zoom_meeting is not None:
        found = zoom.files(zoom_meeting)
        if "transcript" in found:
            vtt = zoom.download(cfg, found["transcript"], base / "zoom-transcript.vtt", job, "transcript")
            segments = parse_vtt(vtt.read_text("utf-8", "replace"))
            if segments:
                data = {"source": "zoom", "language": None, "duration": segments[-1]["end"], "segments": segments}
            else:
                job.update(line="Zoom's transcript file wasn't usable, so the audio will be transcribed instead.")
        if data is None:
            if "audio" not in found:
                raise BuildError("This Zoom recording has no audio or transcript to read.")
            audio = found["audio"]
            ext = "." + str(audio.get("file_extension") or "m4a").lower().strip(".")
            media = zoom.download(cfg, audio, base / f"zoom-audio{ext}", job, "recording")

    if data is None:
        data = transcribe(job, py, media, base, title)
    (base / "transcript.json").write_text(json.dumps(data), "utf-8")
    return data


def transcribe(job: Job, py: str, media: Path, base: Path, title: str) -> dict:
    out = base / "whisper.json"
    job.update("Listening to the recording")
    prompt = f"A meeting about {title}. Use proper punctuation." if title else "A meeting. Use proper punctuation."

    def progress(line: str) -> bool:
        if line.startswith("STEP "):
            job.update(step=line[5:])
            return True
        if line.startswith("PROGRESS "):
            try:
                done, total = (float(x) for x in line.split()[1:3])
            except ValueError:
                return False
            job.update(step=f"Listening to the recording · {clock(done)} of {clock(total)}" if total
                       else f"Listening to the recording · {clock(done)}")
            return True
        return False

    code, lines = stream(job, [py, str(HELPER), "transcribe", str(media), str(out), "--prompt", prompt],
                         timeout=TRANSCRIBE_TIMEOUT, cwd=base, env=helper_env(), on_line=progress)
    if code == 3:
        raise BuildError(f"Transcribing needs graphify's video extra. In the environment graphify is installed in, run:  {EXTRAS_HINT}")
    if code != 0 or not out.exists():
        raise BuildError("Couldn't transcribe the recording:\n" + "\n".join(lines[-6:]))
    data = json.loads(out.read_text("utf-8"))
    if not data.get("segments"):
        raise BuildError("No speech was found in that recording.")
    data["source"] = "whisper"
    return data


_CUE = re.compile(r"((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})")


def parse_vtt(text: str) -> list[dict]:
    """WebVTT cues as segments. Zoom writes 'Name: words'; standard voice tags work too."""
    if not text.lstrip("﻿ \n\r\t").startswith("WEBVTT"):
        return []  # eg an HTML error page saved under a .vtt name
    segments = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        for i, line in enumerate(lines):
            cue = _CUE.search(line)
            if not cue:
                continue
            raw = " ".join(lines[i + 1:])
            voice = re.match(r"<v(?:\.[^\s>]*)?\s+([^>]+)>", raw)
            words = re.sub(r"<[^>]+>", "", raw).strip()
            speaker = voice[1].strip() if voice else None
            if not speaker and ": " in words[:60]:
                name, rest = words.split(": ", 1)
                if 0 < len(name) <= 40 and not re.search(r"[.?!,]", name):
                    speaker, words = name.strip(), rest.strip()
            if words:
                segments.append({"start": _seconds(cue[1]), "end": _seconds(cue[2]), "text": words, "speaker": speaker})
            break
    return segments


def paragraphs(segments: list[dict], span: float = 60.0, max_words: int = 110) -> list[dict]:
    """Group transcript segments into short paragraphs: same speaker, about a minute at most."""
    out: list[dict] = []
    for seg in segments:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        last = out[-1] if out else None
        if (last and seg.get("speaker") == last["speaker"] and seg["start"] - last["start"] < span
                and last["words"] < max_words):
            last["text"] += " " + text
            last["words"] += len(text.split())
            last["end"] = seg["end"]
        else:
            out.append({"start": float(seg["start"]), "end": float(seg["end"]), "speaker": seg.get("speaker"),
                        "text": text, "words": len(text.split())})
    return out


# ---------------------------------------------------------------------------
# 2. Slides and notes


def read_documents(job: Job, py: str, docs: list[Path], work: Path, have_docx: bool):
    decks, passthrough = [], []
    for path in docs:
        ext = path.suffix.lower()
        job.update(f"Reading {path.name}")
        if ext == ".pptx":
            decks.append({"name": path.stem, "slides": pptx_slides(path)})
        elif ext == ".pdf":
            decks.append({"name": path.stem, "slides": pdf_slides(job, py, path, work)})
        elif ext == ".docx" and not have_docx:
            raise BuildError(f"Reading .docx files needs graphify's office extra. Run:  {EXTRAS_HINT}")
        else:
            passthrough.append(path)
    return decks, passthrough


def pdf_slides(job: Job, py: str, path: Path, work: Path) -> list[dict]:
    out = work / f"pdf-{hashlib.sha1(str(path).encode()).hexdigest()[:8]}.json"
    code, lines = stream(job, [py, str(HELPER), "pdf", str(path), str(out)], timeout=600, cwd=work, env=helper_env())
    if code == 3:
        raise BuildError(f"Reading PDFs needs graphify's pdf extra. Run:  {EXTRAS_HINT}")
    if code != 0 or not out.exists():
        raise BuildError(f"Couldn't read {path.name}:\n" + "\n".join(lines[-4:]))
    pages = json.loads(out.read_text("utf-8")).get("pages") or []
    slides = []
    for n, text in enumerate(pages, 1):
        lines_ = [line.strip() for line in str(text).splitlines() if line.strip()]
        slides.append({"n": n, "title": (lines_[0] if lines_ else f"Page {n}")[:120],
                       "text": "\n".join(lines_[1:])[:4000], "notes": ""})
    return slides


_NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
_PPTX_MAX_PART = 32 * 1024 * 1024
_SKIP_PLACEHOLDERS = {"sldNum", "dt", "ftr", "hdr", "sldImg"}


def pptx_slides(path: Path) -> list[dict]:
    """Slide titles, text and speaker notes, in presentation order, read straight from the .pptx zip."""
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise BuildError(f"{path.name} isn't a readable PowerPoint file.") from exc
    with archive:
        names = set(archive.namelist())

        def xml(name: str):
            if archive.getinfo(name).file_size > _PPTX_MAX_PART:  # don't inflate zip bombs
                raise BuildError(f"{path.name} has a part too large to read.")
            return ElementTree.fromstring(archive.read(name))

        slides = []
        for n, name in enumerate(_slide_order(names, xml), 1):
            try:
                root = xml(name)
            except ElementTree.ParseError:
                continue
            title, body = "", []
            for shape in root.iter(f"{{{_NS['p']}}}sp"):
                kind = _placeholder(shape)
                if kind in _SKIP_PLACEHOLDERS:
                    continue
                text = _paragraphs(shape)
                if kind in ("title", "ctrTitle") and text and not title:
                    title = " ".join(text)
                else:
                    body.extend(text)
            for frame in root.iter(f"{{{_NS['p']}}}graphicFrame"):  # tables
                body.extend(_paragraphs(frame))
            slides.append({
                "n": n,
                "title": (title or (body[0] if body else f"Slide {n}"))[:120],
                "text": "\n".join(body)[:4000],
                "notes": _notes(names, name, xml)[:3000],
            })
        return slides


def _placeholder(shape) -> str | None:
    ph = shape.find("p:nvSpPr/p:nvPr/p:ph", _NS)
    return None if ph is None else ph.get("type", "body")


def _paragraphs(element) -> list[str]:
    out = []
    for p in element.iter(f"{{{_NS['a']}}}p"):
        text = "".join(t.text or "" for t in p.iter(f"{{{_NS['a']}}}t")).strip()
        if text:
            out.append(text)
    return out


def _slide_order(names: set[str], xml) -> list[str]:
    try:
        pres = xml("ppt/presentation.xml")
        rels = xml("ppt/_rels/presentation.xml.rels")
        targets = {r.get("Id"): r.get("Target") for r in rels.iter(f"{{{_NS['rel']}}}Relationship")}
        order = []
        for sld in pres.iter(f"{{{_NS['p']}}}sldId"):
            target = targets.get(sld.get(f"{{{_NS['r']}}}id"))
            name = _resolve("ppt/presentation.xml", target) if target else None
            if name in names:
                order.append(name)
        if order:
            return order
    except (KeyError, ElementTree.ParseError):
        pass
    found = [n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
    return sorted(found, key=lambda n: int(re.findall(r"\d+", n)[-1]))


def _resolve(base: str, target: str) -> str:
    """A relationship target, relative to the part that declares it."""
    if target.startswith("/"):
        return target.lstrip("/")
    parts = base.split("/")[:-1]
    for piece in target.split("/"):
        if piece == "..":
            if parts:
                parts.pop()
        elif piece and piece != ".":
            parts.append(piece)
    return "/".join(parts)


def _notes(names: set[str], slide: str, xml) -> str:
    folder, file = slide.rsplit("/", 1)
    rels_name = f"{folder}/_rels/{file}.rels"
    if rels_name not in names:
        return ""
    try:
        for rel in xml(rels_name).iter(f"{{{_NS['rel']}}}Relationship"):
            if rel.get("Type", "").endswith("/notesSlide"):
                target = _resolve(slide, rel.get("Target", ""))
                if target in names:
                    lines = []
                    for shape in xml(target).iter(f"{{{_NS['p']}}}sp"):
                        if _placeholder(shape) not in _SKIP_PLACEHOLDERS:
                            lines.extend(_paragraphs(shape))
                    return "\n".join(lines)
    except ElementTree.ParseError:
        pass
    return ""


def write_corpus(folder: Path, title: str, paras: list[dict], decks: list[dict], passthrough: list[Path]) -> Path:
    """The folder graphify reads: the transcript and each deck as Markdown, plus notes files as they are."""
    if folder.exists():
        rmtree(folder)
    folder.mkdir(parents=True)
    lines = [f"# Meeting transcript: {title}", "", "Timestamps are minutes:seconds from the start of the recording.", ""]
    for p in paras:
        who = f"**{p['speaker']}:** " if p.get("speaker") else ""
        lines += [f"[{clock(p['start'])}] {who}{p['text']}", ""]
    (folder / "transcript.md").write_text("\n".join(lines), "utf-8")

    used: set[str] = set()

    def unique(name: str) -> str:
        stem, ext = os.path.splitext(name)
        candidate, k = name, 2
        while candidate in used:
            candidate, k = f"{stem}-{k}{ext}", k + 1
        used.add(candidate)
        return candidate

    for deck in decks:
        out = [f"# Slides: {deck['name']}", ""]
        for s in deck["slides"]:
            out += [f"## Slide {s['n']}: {s['title']}", ""]
            if s["text"]:
                out += [s["text"], ""]
            if s["notes"]:
                out += [f"Speaker notes: {s['notes']}", ""]
        (folder / unique(f"slides-{_slug(deck['name'])}.md")).write_text("\n".join(out), "utf-8")
    for path in passthrough:
        shutil.copyfile(path, folder / unique(f"notes-{_slug(path.stem)}{path.suffix.lower()}"))
    return folder


# ---------------------------------------------------------------------------
# 3. graphify


def run_graphify(job: Job, corpus: Path, out_dir: Path, backend: str) -> Path:
    produced = out_dir / "graphify-out" / "graph.json"
    if produced.exists():
        job.update("Using the map of ideas graphify made last time")
        return produced
    out_dir.mkdir(parents=True, exist_ok=True)
    job.update(f"Mapping the ideas with graphify (using {backend}); this is the slow part")
    code, lines = stream(job, graphify_command() + ["extract", str(corpus), "--out", str(out_dir), "--backend", backend],
                         timeout=EXTRACT_TIMEOUT, cwd=out_dir, env=helper_env())
    if not produced.exists():
        raise BuildError("graphify couldn't map this meeting:\n" + ("\n".join(lines[-8:]) or f"(exit code {code})"))
    return produced


# ---------------------------------------------------------------------------
# 4. Study notes


def write_notes(job: Job, py: str, work: Path, title: str, duration: float, paras: list[dict], decks: list[dict],
                concepts: list[str], backend: str) -> dict | None:
    out = work / "notes.json"
    cached = _load(out)
    if cached:
        return cached
    transcript = "\n".join(f"[{clock(p['start'])}] {p['speaker'] + ': ' if p.get('speaker') else ''}{p['text']}"
                           for p in paras)
    words = transcript.split(" ")
    if len(words) > 60000:
        transcript = " ".join(words[:60000]) + "\n[the rest of the transcript was cut for length]"
    slides = [f"Slide {s['n']} ({d['name']}): {s['title']}. {s['text'][:200]}" for d in decks for s in d["slides"]][:300]
    source = work / "notes-input.json"
    source.write_text(json.dumps({"title": title, "duration": duration, "transcript": transcript, "slides": slides,
                                  "concepts": concepts}), "utf-8")
    job.update("Writing study notes")
    code, lines = stream(job, [py, str(HELPER), "digest", str(source), str(out), "--backend", backend],
                         timeout=NOTES_TIMEOUT, cwd=work, env=helper_env())
    result = _load(out)
    if code != 0 or not result:
        job.update(line="Couldn't write AI study notes, so simpler notes are used instead.")
        return None
    return result


def clean_notes(raw: dict, duration: float, concept_count: int, slide_count: int) -> dict:
    """Keep only well-formed notes, with times inside the meeting and indices that exist."""

    def text(value, limit: int) -> str:
        return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]

    def seconds(value) -> float | None:
        try:
            s = _seconds(value) if isinstance(value, str) and ":" in value else float(value)
        except (TypeError, ValueError):
            return None
        return max(0.0, min(duration, s)) if math.isfinite(s) else None

    def number(value, lo: int, hi: int) -> int | None:
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and lo <= value <= hi else None

    chapters = []
    for c in raw.get("chapters") or []:
        if isinstance(c, dict) and (t := seconds(c.get("start"))) is not None and text(c.get("title"), 80):
            chapters.append({"t": t, "title": text(c["title"], 80), "takeaway": text(c.get("takeaway"), 240)})
    chapters.sort(key=lambda c: c["t"])
    if chapters:
        chapters[0]["t"] = 0.0

    points = []
    for p in raw.get("points") or []:
        if not isinstance(p, dict):
            continue
        t, words = seconds(p.get("t")), text(p.get("text"), 240)
        if t is None or not words:
            continue
        kind = str(p.get("kind") or "idea").lower()
        speaker = text(p.get("speaker"), 40)
        concepts = [number(c, 0, concept_count - 1) for c in p.get("concepts") or []]
        points.append({
            "t": t,
            "text": words,
            "kind": kind if kind in POINT_KINDS else "idea",
            "speaker": speaker if speaker and speaker.lower() not in ("null", "none", "unknown") else None,
            "slide": number(p.get("slide"), 1, slide_count) if slide_count else None,
            "concepts": [c for c in concepts if c is not None][:4],
        })
    points.sort(key=lambda p: p["t"])

    actions = []
    for a in raw.get("actions") or []:
        task = text(a.get("task") if isinstance(a, dict) else a, 240)
        if task:
            owner = text(a.get("owner"), 60) if isinstance(a, dict) else ""
            actions.append({"task": task, "owner": owner if owner and owner.lower() not in ("null", "none") else None})
    return {
        "title": text(raw.get("title"), 90),
        "summary": text(raw.get("summary"), 700),
        "chapters": chapters or [{"t": 0.0, "title": "The meeting", "takeaway": ""}],
        "points": points[:MAX_POINTS],
        "terms": [{"term": text(x.get("term"), 60), "meaning": text(x.get("meaning"), 200)}
                  for x in raw.get("terms") or [] if isinstance(x, dict) and text(x.get("term"), 60)][:12],
        "decisions": [text(x, 240) for x in raw.get("decisions") or [] if text(x, 240)][:15],
        "actions": actions[:15],
        "questions": [text(x, 240) for x in raw.get("questions") or [] if text(x, 240)][:15],
        "ai": True,
    }


def simple_notes(paras: list[dict], duration: float) -> dict:
    """Without AI notes: a line from every minute and a half or so, in equal parts."""
    spacing = max(90.0, duration / MAX_POINTS)
    points, next_at = [], 0.0
    for p in paras:
        if p["start"] >= next_at:
            words = re.split(r"(?<=[.!?])\s+", p["text"])[0].split()
            points.append({"t": p["start"], "text": " ".join(words[:22]) + ("…" if len(words) > 22 else ""),
                           "kind": "idea", "speaker": p.get("speaker"), "slide": None, "concepts": []})
            next_at = p["start"] + spacing
    parts = max(1, min(6, round(duration / 600)))
    return {
        "title": "", "summary": "",
        "chapters": [{"t": duration * i / parts, "title": f"Part {i + 1}", "takeaway": ""} for i in range(parts)],
        "points": points[:MAX_POINTS], "terms": [], "decisions": [], "actions": [], "questions": [], "ai": False,
    }


# ---------------------------------------------------------------------------
# 5. The scene


_STOP = set("""a about above after again against all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each few for from further had has have having he
her here hers him his how if in into is it its itself just let lets me more most my no nor not now of off on once only
or other our ours out over own same she should so some such than that the their theirs them then there these they
this those through to too under until up very was we were what when where which while who whom why will with would
you your yours yes okay yeah um uh like really thing things going get got gonna want need know think right one two
well see say said maybe kind sort lot""".split())


def _tokens(text: str) -> set[str]:
    out = set()
    for word in re.findall(r"[a-z0-9]+", text.lower()):
        if len(word) >= 3 and word not in _STOP:
            out.add(_stem(word))
    return out


def _stem(word: str) -> str:
    for suffix, replacement in (("ings", ""), ("ing", ""), ("ies", "y"), ("es", ""), ("s", ""), ("ed", "")):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)] + replacement
    return word


def build_moments(points: list[dict], chapters: list[dict], paras: list[dict], labels: list[str],
                  degree: list[int], duration: float) -> list[dict]:
    """Each key point lights the concepts the notes tied it to, then those named in what was said around it."""
    label_tokens = [_tokens(label) for label in labels]
    moments = []
    for i, p in enumerate(points):
        start = p["t"]
        following = points[i + 1]["t"] if i + 1 < len(points) else duration
        end = min(max(following, start + 30), start + 180)  # what was said around it, not an hour later
        said = " ".join(q["text"] for q in paras if start - 10 <= q["start"] < end)
        seen = _tokens(said + " " + p["text"])
        picked = list(dict.fromkeys(c for c in p["concepts"] if c < len(labels)))  # concept i is scene node i
        scored = []
        for j, tokens in enumerate(label_tokens):
            if tokens and j not in picked:
                overlap = len(tokens & seen) / len(tokens)
                if overlap >= 0.6:
                    scored.append((overlap, degree[j], j))
        scored.sort(reverse=True)
        chapter = max((k for k, c in enumerate(chapters) if c["t"] <= start + 0.01), default=0)
        moments.append({
            "t": round(start, 1), "text": p["text"], "kind": p["kind"], "speaker": p["speaker"],
            "slide": p["slide"], "chapter": chapter, "n": (picked + [j for _, _, j in scored])[:8],
        })
    return moments


def make_meeting_scene(g: dict, paras: list[dict], transcript: dict, duration: float, slide_count: int,
                       notes: dict, meta: dict, max_nodes: int) -> dict:
    kept_degree = [g["degree"][old] for old in g["keep"]]
    nodes = [
        {"l": g["labels"][i], "f": g["files"][i], "c": g["comm"][i], "d": kept_degree[i], "k": _source_kind(g["files"][i])}
        for i in range(len(g["keep"]))
    ]
    words = sum(p["words"] for p in paras)
    speakers = sorted({p["speaker"] for p in paras if p.get("speaker")})
    chapters = notes["chapters"]
    return {
        "kind": "meeting",
        "nodes": nodes,
        "links": g["links"],
        "communities": g["communities"],
        "moments": build_moments(notes["points"], chapters, paras, g["labels"], kept_degree, duration),
        "chapters": chapters,
        "notes": {k: notes[k] for k in ("summary", "terms", "decisions", "actions", "questions", "ai")},
        "meeting": meta,
        "trimmed": len(g["raw_nodes"]) > max_nodes,
        "stats": {
            "duration": round(duration, 1),
            "words": words,
            "wpm": round(words / max(1.0, duration / 60)),
            "speakers": speakers[:20],
            "slides": slide_count,
            "language": transcript.get("language"),
            "transcript": transcript.get("source"),
            "nodes_total": len(g["raw_nodes"]),
            "links_total": g["pair_count"],
        },
    }


# ---------------------------------------------------------------------------
# Small helpers


def clock(seconds: float) -> str:
    s = int(max(0, seconds))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def _seconds(stamp) -> float:
    parts = str(stamp).strip().replace(",", ".").split(":")
    return sum(float(p) * 60 ** i for i, p in enumerate(reversed(parts)))


def _load(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "file"


def _pretty(name: str) -> str:
    return re.sub(r"[_-]+", " ", Path(str(name)).stem).strip() or "Meeting"


def _file_name(node: dict) -> str:
    return str(node.get("source_file") or "").replace("\\", "/").rsplit("/", 1)[-1]


def _source_kind(file: str) -> str:
    return "talk" if file.startswith("transcript") else "slide" if file.startswith("slides-") else "note"


def _group_of_file(file: str) -> str:
    kind = _source_kind(file)
    return "The conversation" if kind == "talk" else Path(file).stem.replace("slides-", "Slides: ") if kind == "slide" else Path(file).stem
