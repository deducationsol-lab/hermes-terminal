"""Stdlib-only, fail-soft client for the hermes-terminal /ingest endpoint.

This module is intentionally dependency-free: it uses only ``urllib.request``
from the standard library so it can be copied into any Python producer with no
install step. It targets the generic hermes-terminal ingest surface documented
in ``api/_lib/validate.ts`` / ``src/client.ts``:

    POST <base_url><ingest_path>
    content-type: application/json
    body: {channel, level, message, meta?, ts?}

``channel`` and ``message`` are required non-empty strings; ``level`` defaults
to ``"info"``; ``meta`` is an optional object. The server stamps ``seq`` + ``ts``
and echoes the stored event.

INGEST PATH (local vs. hosted): the local node server serves ``POST /ingest``,
while the Vercel serverless deployment serves ``POST /api/ingest``. The client
auto-detects which to use from the base URL host (``*.vercel.app`` and other
remote HTTPS hosts -> ``/api/ingest``; ``localhost`` -> ``/ingest``) and also
accepts an explicit override (``ingest_path=`` or ``hosted=``), or a base URL
that already includes the path. See :func:`resolve_ingest_path`.

SIMULATION NOTE: this client ships with the simulation-only multi-agent desk.
It transports ordinary structured log events and has no knowledge of what they
represent. It touches nothing but a local HTTP endpoint.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

# Levels understood by the dashboard color-coding. Any string is accepted by
# the server, but we only ever emit these three from the desk mapping.
LEVEL_INFO = "info"
LEVEL_WARN = "warn"
LEVEL_ERROR = "error"

# The two ingest paths this client knows about:
#   * the LOCAL node server (src/server.ts) serves POST /ingest
#   * the Vercel serverless deployment (api/ingest.ts) serves POST /api/ingest
# The dashboard's SSE path on Vercel is /api/stream, so the API prefix is the
# convention for the hosted deployment.
LOCAL_INGEST_PATH = "/ingest"
HOSTED_INGEST_PATH = "/api/ingest"


def _looks_hosted(base_url: str) -> bool:
    """Heuristic: does ``base_url`` point at a Vercel/hosted deployment?

    Returns ``True`` when the host looks like a Vercel app (``*.vercel.app``) or
    any other remote HTTPS host that is not a loopback/local address. Plain
    ``http://localhost`` / ``127.0.0.1`` / ``[::1]`` (any port) stays local so
    the existing local workflow is unchanged.
    """

    try:
        parsed = urllib.parse.urlparse(base_url)
    except (ValueError, TypeError):  # pragma: no cover - defensive
        return False

    host = (parsed.hostname or "").lower()
    if not host:
        return False

    # Loopback / local development hosts are always local.
    local_hosts = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}
    if host in local_hosts or host.endswith(".localhost"):
        return False

    # Vercel preview/production domains, and the obvious hosted case.
    if host.endswith(".vercel.app"):
        return True

    # Any other non-local host reached over https is treated as a hosted
    # deployment that follows the /api/* serverless convention.
    if parsed.scheme == "https":
        return True

    # Any other remote host (a real domain, not a bare local name) is hosted.
    # A bare single-label hostname with no dot (e.g. a docker service name) is
    # treated as local to avoid surprising existing setups.
    return "." in host


def resolve_ingest_path(
    base_url: str,
    ingest_path: Optional[str] = None,
    hosted: Optional[bool] = None,
) -> str:
    """Resolve the ingest path for a given base URL.

    Resolution order (first match wins):

    1. An explicit ``ingest_path`` override (e.g. ``"/api/ingest"``). Always
       wins so users are never at the mercy of the heuristic. Returned as-is
       (with a leading slash ensured).
    2. An explicit ``hosted`` boolean: ``True`` -> ``/api/ingest``,
       ``False`` -> ``/ingest``.
    3. The path already present on ``base_url`` if it names an ingest endpoint
       (ends with ``/ingest`` or ``/api/ingest``).
    4. Auto-detection via :func:`_looks_hosted`: hosted -> ``/api/ingest``,
       local -> ``/ingest``.
    """

    if ingest_path:
        path = ingest_path.strip()
        if not path.startswith("/"):
            path = "/" + path
        return path.rstrip("/") or "/"

    if hosted is not None:
        return HOSTED_INGEST_PATH if hosted else LOCAL_INGEST_PATH

    # If the base URL already carries an ingest path, honor it.
    try:
        existing = urllib.parse.urlparse(base_url).path.rstrip("/")
    except (ValueError, TypeError):  # pragma: no cover - defensive
        existing = ""
    if existing.endswith("/api/ingest"):
        return HOSTED_INGEST_PATH
    if existing.endswith("/ingest"):
        return LOCAL_INGEST_PATH

    return HOSTED_INGEST_PATH if _looks_hosted(base_url) else LOCAL_INGEST_PATH


def _strip_ingest_suffix(base_url: str) -> str:
    """Remove a trailing ingest path from ``base_url`` so it is a clean origin.

    Lets a user pass a full ingest URL (e.g. ``https://x.vercel.app/api/ingest``)
    as the base URL; the path is detected for routing and then stripped so the
    origin is stored cleanly.
    """

    trimmed = base_url.rstrip("/")
    for suffix in (HOSTED_INGEST_PATH, LOCAL_INGEST_PATH):
        if trimmed.endswith(suffix):
            return trimmed[: -len(suffix)] or trimmed
    return trimmed

# Event "kind" values that represent a soft/negative outcome (-> warn) versus a
# hard failure (-> error). Everything else is normal activity (-> info). These
# are generic, descriptive kinds, not domain/market vocabulary.
_WARN_KINDS = frozenset(
    {
        "loss",
        "losing",
        "halt",
        "halted",
        "reject",
        "rejected",
        "risk_block",
        "risk_halt",
        "stop",
        "cancel",
        "cancelled",
        "skip",
        "skipped",
        "flat_loss",
    }
)

_ERROR_KINDS = frozenset(
    {
        "error",
        "failure",
        "failed",
        "exception",
        "fatal",
        "crash",
    }
)


def level_for_event(event: Dict[str, Any]) -> str:
    """Map a desk event to a dashboard log level.

    Normal activity -> ``info``; losing/halt/reject-type events -> ``warn``;
    hard failures -> ``error``. An explicit ``level`` on the event wins when it
    is one of the recognized levels.
    """

    explicit = event.get("level")
    if isinstance(explicit, str) and explicit in (LEVEL_INFO, LEVEL_WARN, LEVEL_ERROR):
        return explicit

    kind = str(event.get("kind", "")).lower()
    if kind in _ERROR_KINDS:
        return LEVEL_ERROR
    if kind in _WARN_KINDS:
        return LEVEL_WARN
    return LEVEL_INFO


def _human_message(event: Dict[str, Any]) -> str:
    """Build a concise, human-readable message string for an event.

    Prefers an explicit ``message`` field; otherwise synthesizes one from the
    generic ``agent``/``kind``/``symbol``/``reason`` fields.
    """

    explicit = event.get("message")
    if isinstance(explicit, str) and explicit:
        return explicit

    agent = event.get("agent", "agent")
    kind = event.get("kind", "event")
    parts = [f"[{agent}] {kind}"]
    symbol = event.get("symbol")
    if symbol:
        parts.append(f"{symbol}")
    reason = event.get("reason")
    if reason:
        parts.append(f"({reason})")
    text = " ".join(str(p) for p in parts)
    return text or "event"


def event_to_payload(event: Dict[str, Any], channel: str) -> Dict[str, Any]:
    """Map an agent event to an /ingest payload.

    The returned dict matches the ingest contract exactly:

    * ``channel``  -- the configured channel (non-empty string)
    * ``level``    -- ``info`` / ``warn`` / ``error`` (see :func:`level_for_event`)
    * ``message``  -- a non-empty human-readable string
    * ``meta``     -- a dict packing generic keys ``agent``, ``kind``, ``symbol``,
      ``reason`` and the event's ``data`` dict

    Field names are kept generic/descriptive so the generic dashboard can
    auto-discover them with no domain knowledge.
    """

    meta: Dict[str, Any] = {
        "agent": event.get("agent"),
        "kind": event.get("kind"),
        "symbol": event.get("symbol"),
        "reason": event.get("reason"),
        "data": event.get("data", {}),
        # Make the simulation nature discoverable in the dashboard meta/ticker.
        "mode": "simulation",
    }

    payload: Dict[str, Any] = {
        "channel": channel,
        "level": level_for_event(event),
        "message": _human_message(event),
        "meta": meta,
    }

    ts = event.get("ts")
    if isinstance(ts, (int, float)):
        payload["ts"] = int(ts)

    return payload


class HermesClient:
    """A tiny fail-soft producer for the hermes-terminal ingest endpoint.

    All network errors are swallowed: if the server is down or returns an
    error, the call logs locally to stderr and returns ``False`` without
    raising, so the simulation can never be crashed by the dashboard being
    unavailable.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:4000",
        channel: str = "desk",
        timeout: float = 2.0,
        quiet: bool = False,
        ingest_path: Optional[str] = None,
        hosted: Optional[bool] = None,
    ) -> None:
        # Resolve the ingest path BEFORE stripping any path suffix from the base
        # URL, so a full ingest URL passed as the base URL still routes right.
        self.ingest_path = resolve_ingest_path(base_url, ingest_path, hosted)
        self.base_url = _strip_ingest_suffix(base_url)
        self.channel = channel
        self.timeout = timeout
        self.quiet = quiet
        # Count soft failures so callers can report connectivity at the end.
        self.failures = 0
        self.sent = 0

    @property
    def ingest_url(self) -> str:
        return f"{self.base_url}{self.ingest_path}"

    def _warn(self, text: str) -> None:
        if not self.quiet:
            print(f"[hermes-client] {text}", file=sys.stderr)

    def post(self, payload: Dict[str, Any]) -> bool:
        """POST a prepared payload to /ingest. Never raises. Returns success."""

        try:
            body = json.dumps(payload).encode("utf-8")
        except (TypeError, ValueError) as exc:  # pragma: no cover - defensive
            self.failures += 1
            self._warn(f"could not serialize payload: {exc}")
            return False

        request = urllib.request.Request(
            self.ingest_url,
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                # Drain the response so the connection is cleanly reused/closed.
                response.read()
                ok = 200 <= response.status < 300
                if ok:
                    self.sent += 1
                else:
                    self.failures += 1
                    self._warn(f"ingest returned status {response.status}")
                return ok
        except urllib.error.HTTPError as exc:
            self.failures += 1
            self._warn(f"ingest HTTP error {exc.code}")
            return False
        except (urllib.error.URLError, OSError, ValueError) as exc:
            # Connection refused, DNS failure, timeout, etc. Fail soft.
            self.failures += 1
            self._warn(f"ingest unreachable: {exc}")
            return False

    def emit(self, event: Dict[str, Any]) -> bool:
        """Map an agent event to a payload and POST it. Never raises."""

        payload = event_to_payload(event, self.channel)
        return self.post(payload)
