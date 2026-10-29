"""Zoom cloud recordings, read through a Server-to-Server OAuth app in the person's own Zoom
account. Credentials come from ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET /
ZOOM_USER, or from zoom.json beside this file (saved from the page, never sent back to it)."""
from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from common import ROOT, BuildError, Job

CONFIG_FILE = ROOT / "zoom.json"
OAUTH_URL = os.environ.get("ZOOM_OAUTH_URL", "https://zoom.us/oauth/token")
API_BASE = os.environ.get("ZOOM_API_BASE", "https://api.zoom.us/v2")
FIELDS = ("account_id", "client_id", "client_secret", "user")
SCOPE = "cloud_recording:read:list_user_recordings:admin"
LOOKBACK_DAYS = 90

_lock = threading.Lock()
_token: dict = {"value": None, "expires": 0.0, "key": None}
_listed: dict[str, dict] = {}  # recording uuid -> its files, from the last listing


class ZoomError(BuildError):
    pass


def load_config() -> dict | None:
    env = {
        "account_id": os.environ.get("ZOOM_ACCOUNT_ID"),
        "client_id": os.environ.get("ZOOM_CLIENT_ID"),
        "client_secret": os.environ.get("ZOOM_CLIENT_SECRET"),
        "user": os.environ.get("ZOOM_USER"),
    }
    if all(env.values()):
        return env
    try:
        saved = json.loads(CONFIG_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(saved, dict) and all(saved.get(k) for k in FIELDS):
        return {k: str(saved[k]).strip() for k in FIELDS}
    return None


def status() -> dict:
    cfg = load_config()
    return {"configured": cfg is not None, "user": cfg["user"] if cfg else None, "scope": SCOPE}


def save_config(values: dict) -> dict:
    cfg = {k: str(values.get(k) or "").strip() for k in FIELDS}
    missing = [k for k in FIELDS if not cfg[k]]
    if missing:
        raise ZoomError("Please fill in all four fields.")
    access_token(cfg, fresh=True)  # check the credentials before keeping them
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), "utf-8")
    return status()


def forget() -> dict:
    CONFIG_FILE.unlink(missing_ok=True)
    with _lock:
        _token.update(value=None, expires=0.0, key=None)
        _listed.clear()
    return status()


def access_token(cfg: dict, fresh: bool = False) -> str:
    key = (cfg["account_id"], cfg["client_id"], cfg["client_secret"])
    with _lock:
        if not fresh and _token["key"] == key and _token["expires"] > time.time() + 60:
            return _token["value"]
    basic = base64.b64encode(f"{cfg['client_id']}:{cfg['client_secret']}".encode()).decode()
    query = urllib.parse.urlencode({"grant_type": "account_credentials", "account_id": cfg["account_id"]})
    body = _request(f"{OAUTH_URL}?{query}", data=b"", headers={"Authorization": f"Basic {basic}"})
    if not body.get("access_token"):
        raise ZoomError("Zoom didn't return an access token.")
    with _lock:
        _token.update(value=body["access_token"], expires=time.time() + int(body.get("expires_in", 3600)), key=key)
    return body["access_token"]


def recordings(cfg: dict) -> list[dict]:
    """Cloud recordings from the last few months, newest first."""
    auth = {"Authorization": f"Bearer {access_token(cfg)}"}
    user = urllib.parse.quote(cfg["user"], safe="")
    found: dict[str, dict] = {}
    end = date.today()
    remaining = LOOKBACK_DAYS
    while remaining > 0:
        start = end - timedelta(days=min(30, remaining) - 1)  # Zoom allows a month per request
        page = ""
        while True:
            query = {"from": start.isoformat(), "to": end.isoformat(), "page_size": 100}
            if page:
                query["next_page_token"] = page
            body = _request(f"{API_BASE}/users/{user}/recordings?{urllib.parse.urlencode(query)}", headers=auth)
            for meeting in body.get("meetings") or []:
                if meeting.get("uuid"):
                    found[meeting["uuid"]] = meeting
            page = body.get("next_page_token") or ""
            if not page:
                break
        remaining -= 30
        end = start - timedelta(days=1)

    with _lock:
        _listed.clear()
        _listed.update(found)
    summaries = [_summary(m) for m in found.values()]
    return sorted((s for s in summaries if s["has_transcript"] or s["has_audio"]),
                  key=lambda s: s["start"] or "", reverse=True)


def recording(cfg: dict, uuid: str) -> dict:
    with _lock:
        meeting = _listed.get(uuid)
    if meeting is None:
        recordings(cfg)
        with _lock:
            meeting = _listed.get(uuid)
    if meeting is None:
        raise ZoomError("That Zoom recording is no longer listed. It may have been deleted or moved to the trash.")
    return meeting


def _summary(meeting: dict) -> dict:
    found = files(meeting)
    return {
        "uuid": meeting["uuid"],
        "topic": meeting.get("topic") or "Zoom meeting",
        "start": meeting.get("start_time"),
        "duration": meeting.get("duration"),
        "has_transcript": "transcript" in found,
        "has_audio": "audio" in found,
    }


def files(meeting: dict) -> dict:
    """The recording files worth having: the transcript and the lightest audio."""
    done = [f for f in meeting.get("recording_files") or []
            if f.get("download_url") and f.get("status", "completed") == "completed"]
    pick = {}
    for f in done:
        kind = str(f.get("file_type", "")).upper()
        if kind == "TRANSCRIPT" and "transcript" not in pick:
            pick["transcript"] = f
        elif kind == "M4A":
            pick["audio"] = f
        elif kind == "MP4" and "audio" not in pick:
            pick["audio"] = f
    return pick


def download(cfg: dict, file: dict, dest: Path, job: Job, label: str) -> Path:
    """Fetch one recording file (bearer token first, the documented query-string form as a fallback)."""
    if dest.exists():
        return dest
    url = file["download_url"]
    token = access_token(cfg)
    attempts = [
        (url, {"Authorization": f"Bearer {token}"}),
        (f"{url}{'&' if '?' in url else '?'}access_token={urllib.parse.quote(token)}", {}),
    ]
    opener = urllib.request.build_opener(_KeepAuthOnSameHost())
    partial = dest.with_suffix(dest.suffix + ".part")
    last_error = None
    for target, headers in attempts:
        try:
            with opener.open(urllib.request.Request(target, headers=headers), timeout=60) as resp, open(partial, "wb") as out:
                total = int(resp.headers.get("Content-Length") or file.get("file_size") or 0)
                got = 0
                while chunk := resp.read(1 << 20):
                    out.write(chunk)
                    got += len(chunk)
                    if total:
                        job.update(step=f"Downloading the {label} from Zoom · {min(100, got * 100 // total)}%")
            partial.replace(dest)
            return dest
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in (401, 403):
                break
        except urllib.error.URLError as exc:
            raise ZoomError(f"Couldn't download from Zoom ({exc.reason}).") from exc
    partial.unlink(missing_ok=True)
    raise ZoomError(f"Zoom refused the {label} download ({getattr(last_error, 'code', '?')}). "
                    f"Check that your Zoom app has the {SCOPE} scope and is activated.")


class _KeepAuthOnSameHost(urllib.request.HTTPRedirectHandler):
    """Zoom redirects downloads to signed storage links; don't carry the token to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
            new.remove_header("Authorization")
        return new


def _request(url: str, *, data: bytes | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8", "replace"))
            message = detail.get("reason") or detail.get("message") or detail.get("error") or ""
        except ValueError:
            message = ""
        raise ZoomError(_explain(exc.code, str(message))) from exc
    except urllib.error.URLError as exc:
        raise ZoomError(f"Couldn't reach Zoom ({exc.reason}).") from exc


def _explain(code: int, message: str) -> str:
    lowered = message.lower()
    if code in (400, 401) and ("client" in lowered or "credential" in lowered or "account" in lowered or code == 401):
        return "Zoom didn't accept those credentials. Check the Account ID, Client ID and Client secret of your Server-to-Server OAuth app, and that the app is activated."
    if code == 403 or "scope" in lowered:
        return f"Your Zoom app is missing a permission. Add the scope {SCOPE} to it, then activate it again."
    if code == 404:
        return "Zoom couldn't find that user. Use the email address of the Zoom account that owns the recordings."
    if code == 429:
        return "Zoom is rate-limiting requests right now. Try again in a minute."
    return f"Zoom said: {message or 'an error'} (HTTP {code})."
