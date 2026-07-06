#!/usr/bin/env python3
"""Rivr builder app broker — host-side reconciler for builder app lifecycles.

The builder LLM session writes typed lifecycle requests into
`/opt/rivr-person-workspace/.rivr-apps/queue/<appId>.json` (via the owner-gated
`/api/builder/apps` routes). This broker — a systemd path-unit oneshot — is the
ONLY thing that touches Docker. It re-validates every request and manifest
independently; nothing the session wrote is trusted.

Safety model (mirrors the proven camalot static-site deployer):
  * strict allowlisted manifest, denylisted app ids (platform stack untouchable)
  * builds run in a resource-capped BuildKit container (docker-container
    driver), never under dockerd's unbounded cgroup, with a wall-clock timeout
  * child containers: cap_drop ALL, no-new-privileges, non-root, read-only
    rootfs (static) / tmpfs-bounded (node), hard mem/cpu/pids/log limits,
    proxy network only (+ db network when a database is declared)
  * health-gate before old release teardown; previous release retained
  * two-phase delete (archive first, confirm token), DB dumped before drop
  * retention: releases, images, build logs, and trash are all bounded
  * disk high-watermark refuses new work before the host is endangered

Install (as root on the camalot host):
  cp rivr-app-broker.py /usr/local/libexec/rivr-app-broker.py && chmod 755 …
  cp rivr-app-broker.{service,path} /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now rivr-app-broker.path
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants — the host-side half of the shared contract
# (`src/lib/builder/app-manifest.ts` / `app-lifecycle.ts` in rivr-person).
# ---------------------------------------------------------------------------

WORKSPACE_ROOT = Path("/opt/rivr-person-workspace")
APPS_WORKSPACES = WORKSPACE_ROOT / "apps"
BROKER_ROOT = WORKSPACE_ROOT / ".rivr-apps"
QUEUE_DIR = BROKER_ROOT / "queue"
STATUS_DIR = BROKER_ROOT / "status"
DOMAINS_DIR = BROKER_ROOT / "domains"

APPS_ROOT = Path("/opt/rivr-apps")
TRASH_ROOT = APPS_ROOT / ".trash"
LOCK_PATH = Path("/run/lock/rivr-app-broker.lock")

BASE_DOMAIN = "camalot.me"
PROXY_NETWORK = "pmdl_proxy-external"
DB_NETWORK = "pmdl_db-internal"
TRAEFIK_ENTRYPOINT = "websecure"
TRAEFIK_CERTRESOLVER = "letsencrypt"
POSTGRES_CONTAINER = "pmdl_postgres"
POSTGRES_SECRET_FILE = Path("/opt/pm-core/secrets/postgres_password")

CONTAINER_PREFIX = "pmdl_app_"
IMAGE_PREFIX = "rivr-app-"
BUILDER_NAME = "rivr-apps-builder"
BUILDER_MEMORY = "2g"
BUILDER_CPUS = "1"

REQUEST_VERSION = 1
MANIFEST_VERSION = 1
MANIFEST_FILE = "rivr-app.json"
RUNTIMES = {"static", "node-22"}
DATABASES = {"none", "postgres"}
RESOURCE_CLASSES = {
    "tiny": {"memory": "128m", "cpus": "0.25", "pids": 64},
    "small": {"memory": "256m", "cpus": "0.5", "pids": 128},
    "medium": {"memory": "512m", "cpus": "1.0", "pids": 256},
}
ACTIONS = {"deploy", "stop", "start", "rollback", "archive", "delete"}
PHASES_TERMINAL_OK = {"running", "stopped", "archived", "deleted"}

APP_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,30}[a-z0-9]$")
SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
HEALTH_PATH_RE = re.compile(r"^/[A-Za-z0-9/._-]{0,127}$")
DOMAIN_RE = re.compile(
    r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$"
)
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I
)

APP_ID_DENYLIST = {
    "camalot", "rivr", "rivr-person", "pm-core", "postgres", "redis", "minio",
    "synapse", "traefik", "dashboard", "whisperx", "livekit", "camtron",
    "parachute", "socket-proxy", "mautrix", "api", "www", "mail", "smtp",
    "admin", "current", "queue", "status", "releases", "secrets",
}

PORT_MIN, PORT_MAX = 3000, 8999
MAX_REQUEST_BYTES = 64 * 1024
MAX_SECRET_NAMES = 16
MAX_CUSTOM_DOMAINS = 8

# Static release rules (same discipline as the camalot site deployer).
STATIC_MAX_FILES = 500
STATIC_MAX_FILE_BYTES = 10 * 1024 * 1024
STATIC_MAX_RELEASE_BYTES = 50 * 1024 * 1024
STATIC_ALLOWED_SUFFIXES = {
    ".html", ".htm", ".css", ".js", ".json", ".svg", ".xml", ".txt",
    ".md", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
    ".woff", ".woff2", ".ttf", ".otf", ".wav", ".mp3", ".mp4", ".webm",
}
STATIC_ALLOWED_NAMES = {"CNAME", "robots.txt"}

# Node build-context rules.
NODE_MAX_FILES = 2000
NODE_MAX_FILE_BYTES = 10 * 1024 * 1024
NODE_MAX_CONTEXT_BYTES = 100 * 1024 * 1024
BUILD_TIMEOUT_SECONDS = 900
HEALTH_TIMEOUT_SECONDS = 60
HEALTH_POLL_SECONDS = 3

SKIP_PARTS = {".git", ".rivr-deploy", "node_modules", ".next", "dist", ".cache"}

KEEP_RELEASES = 5
KEEP_IMAGES = 2
TRASH_RETENTION_DAYS = 14
BUILD_LOG_MAX_BYTES = 1024 * 1024
STATUS_DETAIL_MAX_CHARS = 4000
MIN_FREE_DISK_BYTES = 10 * 1024**3

DOCKER = "/usr/bin/docker"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(args: list[str], timeout: int = 120, input_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, capture_output=True, text=True, timeout=timeout, input=input_text,
    )


def docker(args: list[str], timeout: int = 120, input_text: str | None = None) -> subprocess.CompletedProcess:
    return run([DOCKER, *args], timeout=timeout, input_text=input_text)


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o644)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


class BrokerError(RuntimeError):
    """A validation or execution failure attributable to one request."""


# ---------------------------------------------------------------------------
# Status reporting
# ---------------------------------------------------------------------------

def write_status(app_id: str, phase: str, request: dict | None = None, **extra) -> None:
    payload = {
        "version": 1,
        "appId": app_id,
        "phase": phase,
        "updatedAt": utcnow(),
    }
    if request is not None:
        payload["requestId"] = request.get("requestId")
        payload["action"] = request.get("action")
    releases_dir = APPS_ROOT / app_id / "releases"
    if releases_dir.is_dir():
        payload["releases"] = sorted(
            (p.name for p in releases_dir.iterdir() if p.is_dir()), reverse=True
        )[:KEEP_RELEASES]
    for key, value in extra.items():
        if value is not None:
            payload[key] = value
    atomic_json(STATUS_DIR / f"{app_id}.json", payload)


# ---------------------------------------------------------------------------
# Validation — nothing from the session is trusted
# ---------------------------------------------------------------------------

def validate_app_id(app_id: str) -> str:
    if not isinstance(app_id, str) or not APP_ID_RE.fullmatch(app_id):
        raise BrokerError("Invalid app id")
    if app_id in APP_ID_DENYLIST or app_id.startswith("mautrix"):
        raise BrokerError(f'App id "{app_id}" is reserved by the platform')
    return app_id


def load_manifest(app_id: str) -> dict:
    """Load and strictly validate the manifest FROM THE WORKSPACE."""
    manifest_path = APPS_WORKSPACES / app_id / MANIFEST_FILE
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise BrokerError(f"{MANIFEST_FILE} missing from workspace")
    if manifest_path.stat().st_size > MAX_REQUEST_BYTES:
        raise BrokerError(f"{MANIFEST_FILE} is unreasonably large")
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BrokerError(f"{MANIFEST_FILE} unreadable: {error}") from error
    if not isinstance(raw, dict):
        raise BrokerError(f"{MANIFEST_FILE} must be a JSON object")

    allowed_keys = {
        "version", "appId", "name", "runtime", "internalPort",
        "resourceClass", "database", "secretNames", "healthPath",
    }
    unknown = set(raw) - allowed_keys
    if unknown:
        raise BrokerError(f"Unknown manifest keys: {sorted(unknown)}")
    if raw.get("version") != MANIFEST_VERSION:
        raise BrokerError(f"Manifest version must be {MANIFEST_VERSION}")
    if raw.get("appId") != app_id:
        raise BrokerError("Manifest appId does not match workspace")

    runtime = raw.get("runtime")
    if runtime not in RUNTIMES:
        raise BrokerError(f"runtime must be one of {sorted(RUNTIMES)}")

    resource_class = raw.get("resourceClass", "tiny")
    if resource_class not in RESOURCE_CLASSES:
        raise BrokerError(f"resourceClass must be one of {sorted(RESOURCE_CLASSES)}")

    database = raw.get("database", "none")
    if database not in DATABASES:
        raise BrokerError(f"database must be one of {sorted(DATABASES)}")
    if runtime == "static" and database != "none":
        raise BrokerError("static apps cannot declare a database")

    port = raw.get("internalPort")
    if runtime == "node-22":
        if not isinstance(port, int) or not (PORT_MIN <= port <= PORT_MAX):
            raise BrokerError(f"internalPort must be an integer in [{PORT_MIN}, {PORT_MAX}]")
    elif port is not None:
        raise BrokerError("internalPort is not allowed for static apps")

    secret_names = raw.get("secretNames", [])
    if not isinstance(secret_names, list) or len(secret_names) > MAX_SECRET_NAMES:
        raise BrokerError(f"secretNames must be a list of at most {MAX_SECRET_NAMES} names")
    for name in secret_names:
        if not isinstance(name, str) or not SECRET_NAME_RE.fullmatch(name):
            raise BrokerError(f"Invalid secret name: {name!r}")

    health_path = raw.get("healthPath", "/")
    if not isinstance(health_path, str) or not HEALTH_PATH_RE.fullmatch(health_path):
        raise BrokerError("Invalid healthPath")

    return {
        "appId": app_id,
        "runtime": runtime,
        "internalPort": port,
        "resourceClass": resource_class,
        "database": database,
        "secretNames": list(dict.fromkeys(secret_names)),
        "healthPath": health_path,
    }


def load_verified_domains(app_id: str) -> list[str]:
    """Custom domains bound by the app-side after DNS verification.

    Re-verified here: a domain is only routed when it currently resolves to
    one of this host's public addresses, so a stale or forged entry cannot
    capture traffic.
    """
    domains_path = DOMAINS_DIR / f"{app_id}.json"
    if not domains_path.is_file():
        return []
    try:
        raw = json.loads(domains_path.read_text(encoding="utf-8"))
        candidates = raw.get("domains", [])
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(candidates, list):
        return []

    host_addresses = host_public_addresses()
    verified: list[str] = []
    for domain in candidates[:MAX_CUSTOM_DOMAINS]:
        if not isinstance(domain, str) or not DOMAIN_RE.fullmatch(domain):
            continue
        if domain == BASE_DOMAIN or domain.endswith(f".{BASE_DOMAIN}"):
            continue  # base-domain traffic is owned by the platform site lane
        try:
            resolved = {info[4][0] for info in socket.getaddrinfo(domain, None)}
        except OSError:
            continue
        if resolved & host_addresses:
            verified.append(domain)
    return verified


def host_public_addresses() -> set[str]:
    addresses: set[str] = set()
    try:
        addresses.update(info[4][0] for info in socket.getaddrinfo(BASE_DOMAIN, None))
    except OSError:
        pass
    return addresses


# ---------------------------------------------------------------------------
# Docker plumbing
# ---------------------------------------------------------------------------

def container_name(app_id: str, release: str) -> str:
    return f"{CONTAINER_PREFIX}{app_id}_{release.split('-')[0]}"


def list_app_containers(app_id: str) -> list[str]:
    result = docker([
        "ps", "-a", "--filter", f"name=^{CONTAINER_PREFIX}{app_id}_",
        "--format", "{{.Names}}",
    ])
    return [line for line in result.stdout.splitlines() if line.strip()]


def remove_containers(names: list[str]) -> None:
    for name in names:
        docker(["rm", "-f", name], timeout=60)


def traefik_labels(app_id: str, release: str, port: int, domains: list[str]) -> list[str]:
    router = f"rivrapp-{app_id}-{release.split('-')[0]}"
    hosts = [f"{app_id}.{BASE_DOMAIN}", *domains]
    rule = " || ".join(f"Host(`{host}`)" for host in hosts)
    return [
        "--label", "traefik.enable=true",
        "--label", f"traefik.http.routers.{router}.rule={rule}",
        "--label", f"traefik.http.routers.{router}.entrypoints={TRAEFIK_ENTRYPOINT}",
        "--label", f"traefik.http.routers.{router}.tls.certresolver={TRAEFIK_CERTRESOLVER}",
        "--label", f"traefik.http.services.{router}.loadbalancer.server.port={port}",
        "--label", "rivr.app.managed=true",
        "--label", f"rivr.app.id={app_id}",
        "--label", f"rivr.app.release={release}",
    ]


def hardening_flags(resource_class: str) -> list[str]:
    limits = RESOURCE_CLASSES[resource_class]
    return [
        "--restart", "unless-stopped",
        "--security-opt", "no-new-privileges:true",
        "--cap-drop", "ALL",
        "--memory", limits["memory"],
        "--cpus", limits["cpus"],
        "--pids-limit", str(limits["pids"]),
        "--log-driver", "json-file",
        "--log-opt", "max-size=1m",
        "--log-opt", "max-file=2",
        "--network", PROXY_NETWORK,
    ]


def ensure_bounded_builder() -> None:
    """A BuildKit builder in its OWN capped container.

    `docker build` via dockerd runs BuildKit inside dockerd's cgroup, which is
    unbounded — that is exactly what made this host unresponsive on
    2026-07-06. The docker-container driver gives BuildKit a container of its
    own, which we cap like any other workload.
    """
    exists = docker(["buildx", "inspect", BUILDER_NAME])
    if exists.returncode != 0:
        created = docker([
            "buildx", "create", "--name", BUILDER_NAME,
            "--driver", "docker-container",
        ])
        if created.returncode != 0:
            raise BrokerError(f"Failed to create bounded builder: {created.stderr[-500:]}")
        docker(["buildx", "inspect", BUILDER_NAME, "--bootstrap"], timeout=180)
    builder_container = f"buildx_buildkit_{BUILDER_NAME}0"
    docker([
        "update", "--memory", BUILDER_MEMORY, "--memory-swap", BUILDER_MEMORY,
        "--cpus", BUILDER_CPUS, builder_container,
    ])


def free_disk_bytes() -> int:
    stats = os.statvfs("/")
    return stats.f_bavail * stats.f_frsize


# ---------------------------------------------------------------------------
# Static runtime
# ---------------------------------------------------------------------------

NGINX_APP_CONF = """server {
    listen 80;
    server_name _;
    root /srv/app/current;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
"""


def collect_static_files(workspace: Path) -> tuple[list[tuple[Path, Path]], str]:
    selected: list[tuple[Path, Path]] = []
    total = 0
    digest = hashlib.sha256()
    for source in sorted(workspace.rglob("*")):
        relative = source.relative_to(workspace)
        if any(part in SKIP_PARTS or part.startswith(".") for part in relative.parts):
            continue
        if source.is_symlink():
            raise BrokerError(f"Symlinks are not allowed: {relative}")
        if not source.is_file():
            continue
        if source.name == MANIFEST_FILE:
            continue
        if source.name not in STATIC_ALLOWED_NAMES and source.suffix.lower() not in STATIC_ALLOWED_SUFFIXES:
            continue
        size = source.stat().st_size
        if size > STATIC_MAX_FILE_BYTES:
            raise BrokerError(f"File exceeds {STATIC_MAX_FILE_BYTES} bytes: {relative}")
        total += size
        if total > STATIC_MAX_RELEASE_BYTES:
            raise BrokerError(f"Release exceeds {STATIC_MAX_RELEASE_BYTES} bytes")
        selected.append((source, relative))
        if len(selected) > STATIC_MAX_FILES:
            raise BrokerError(f"Release exceeds {STATIC_MAX_FILES} files")
        digest.update(str(relative).encode())
        digest.update(b"\0")
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    if not any(relative == Path("index.html") for _, relative in selected):
        raise BrokerError("index.html is required for a static app")
    return selected, digest.hexdigest()


def deploy_static(app_id: str, manifest: dict, request: dict) -> None:
    workspace = APPS_WORKSPACES / app_id
    files, digest = collect_static_files(workspace)
    release = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{digest[:12]}"
    app_root = APPS_ROOT / app_id
    releases_dir = app_root / "releases"
    release_dir = releases_dir / release
    releases_dir.mkdir(parents=True, exist_ok=True)

    if not release_dir.exists():
        staging = releases_dir / f".{release}.staging"
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True, mode=0o755)
        for source, relative in files:
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            os.chmod(destination, 0o644)
        staging.rename(release_dir)

    conf_path = app_root / "nginx.conf"
    conf_path.write_text(NGINX_APP_CONF, encoding="utf-8")

    current = app_root / "current"
    next_link = app_root / ".current.next"
    next_link.unlink(missing_ok=True)
    next_link.symlink_to(release_dir.relative_to(app_root))
    os.replace(next_link, current)

    domains = load_verified_domains(app_id)
    old_containers = list_app_containers(app_id)
    name = container_name(app_id, release)
    if name not in old_containers:
        run_result = docker([
            "run", "-d", "--name", name,
            *hardening_flags(manifest["resourceClass"]),
            # nginx master must chown its temp dirs and setuid to the worker
            # user — the same three caps the proven camalot-site lane grants.
            "--cap-add", "CHOWN", "--cap-add", "SETGID", "--cap-add", "SETUID",
            "--read-only",
            "--tmpfs", "/var/cache/nginx:size=16m,mode=0755",
            "--tmpfs", "/var/run:size=1m,mode=0755",
            "--tmpfs", "/tmp:size=8m,mode=1777",
            "-v", f"{app_root}:/srv/app:ro",
            "-v", f"{conf_path}:/etc/nginx/conf.d/default.conf:ro",
            *traefik_labels(app_id, release, 80, domains),
            "nginx:alpine",
        ], timeout=180)
        if run_result.returncode != 0:
            raise BrokerError(f"Failed to start static container: {run_result.stderr[-500:]}")
        remove_containers([c for c in old_containers if c != name])

    prune_releases(app_id)
    write_status(
        app_id, "running", request,
        release=release,
        url=f"https://{app_id}.{BASE_DOMAIN}/",
        customDomains=domains or None,
    )


# ---------------------------------------------------------------------------
# node-22 runtime
# ---------------------------------------------------------------------------

NODE_DOCKERFILE = """# Platform-owned build recipe — never taken from the workspace.
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \\
    elif [ -f package.json ]; then npm install --omit=dev; fi \\
    && npm cache clean --force
RUN if node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; \\
    then npm run build; fi
USER node
ENV NODE_ENV=production
CMD ["/bin/sh", "-c", "if [ -n \\"$DATABASE_URL_FILE\\" ] && [ -f \\"$DATABASE_URL_FILE\\" ]; then export DATABASE_URL=$(cat \\"$DATABASE_URL_FILE\\"); fi; exec npm start"]
"""


def build_node_context(app_id: str, workspace: Path, context_dir: Path) -> str:
    digest = hashlib.sha256()
    total = 0
    count = 0
    for source in sorted(workspace.rglob("*")):
        relative = source.relative_to(workspace)
        if any(part in SKIP_PARTS for part in relative.parts):
            continue
        if any(part.startswith(".") for part in relative.parts):
            continue
        if source.is_symlink():
            raise BrokerError(f"Symlinks are not allowed: {relative}")
        if not source.is_file():
            continue
        size = source.stat().st_size
        if size > NODE_MAX_FILE_BYTES:
            raise BrokerError(f"File exceeds {NODE_MAX_FILE_BYTES} bytes: {relative}")
        total += size
        count += 1
        if total > NODE_MAX_CONTEXT_BYTES:
            raise BrokerError(f"Build context exceeds {NODE_MAX_CONTEXT_BYTES} bytes")
        if count > NODE_MAX_FILES:
            raise BrokerError(f"Build context exceeds {NODE_MAX_FILES} files")
        destination = context_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        digest.update(str(relative).encode())
        digest.update(b"\0")
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    if count == 0:
        raise BrokerError("Workspace has no buildable files")
    (context_dir / "Dockerfile").write_text(NODE_DOCKERFILE, encoding="utf-8")
    return digest.hexdigest()


def provision_postgres(app_id: str) -> Path:
    """Idempotently create a least-privilege role + database for one app.

    The credential is written to a root-owned file mounted into the child at
    /run/secrets; it never enters the request, status, manifest, or transcript.
    """
    secrets_dir = APPS_ROOT / app_id / "secrets"
    secrets_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    secret_path = secrets_dir / "database_url"
    db_name = f"rivr_app_{app_id.replace('-', '_')}"
    role_name = db_name

    if secret_path.is_file():
        return secret_path

    password = hashlib.sha256(os.urandom(32)).hexdigest()[:32]
    sql = (
        f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{role_name}') "
        f"THEN CREATE ROLE {role_name} LOGIN PASSWORD '{password}'; END IF; END $$;"
    )
    create_role = docker([
        "exec", "-i", POSTGRES_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1",
    ], input_text=sql, timeout=60)
    if create_role.returncode != 0:
        raise BrokerError(f"Failed to create app db role: {create_role.stderr[-500:]}")

    db_exists = docker([
        "exec", POSTGRES_CONTAINER, "psql", "-U", "postgres", "-tAc",
        f"SELECT 1 FROM pg_database WHERE datname = '{db_name}'",
    ], timeout=60)
    if "1" not in db_exists.stdout:
        create_db = docker([
            "exec", POSTGRES_CONTAINER, "createdb", "-U", "postgres", "-O", role_name, db_name,
        ], timeout=60)
        if create_db.returncode != 0:
            raise BrokerError(f"Failed to create app database: {create_db.stderr[-500:]}")

    url = f"postgresql://{role_name}:{password}@{POSTGRES_CONTAINER}:5432/{db_name}"
    fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(url)
    return secret_path


def health_gate(name: str, port: int, health_path: str) -> None:
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    last_error = "no probe ran"
    probe = (
        f"fetch('http://127.0.0.1:{port}{health_path}')"
        ".then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
    )
    while time.monotonic() < deadline:
        state = docker(["inspect", "--format", "{{.State.Status}}", name])
        if state.returncode != 0 or state.stdout.strip() != "running":
            last_error = f"container state: {state.stdout.strip() or state.stderr[-200:]}"
        else:
            check = docker(["exec", name, "node", "-e", probe], timeout=30)
            if check.returncode == 0:
                return
            last_error = f"health probe failed: {check.stderr[-200:] or 'non-2xx response'}"
        time.sleep(HEALTH_POLL_SECONDS)
    raise BrokerError(f"Health gate failed after {HEALTH_TIMEOUT_SECONDS}s ({last_error})")


def deploy_node(app_id: str, manifest: dict, request: dict) -> None:
    if free_disk_bytes() < MIN_FREE_DISK_BYTES:
        raise BrokerError("Disk high-watermark reached; refusing new builds")
    ensure_bounded_builder()

    workspace = APPS_WORKSPACES / app_id
    app_root = APPS_ROOT / app_id
    app_root.mkdir(parents=True, exist_ok=True)
    write_status(app_id, "building", request)

    with tempfile.TemporaryDirectory(prefix=f"rivr-app-{app_id}-", dir="/var/tmp") as tmp:
        context_dir = Path(tmp) / "context"
        context_dir.mkdir()
        digest = build_node_context(app_id, workspace, context_dir)
        release = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{digest[:12]}"
        image = f"{IMAGE_PREFIX}{app_id}:{release}"

        build = docker([
            "buildx", "build", "--builder", BUILDER_NAME, "--load",
            "-t", image, str(context_dir),
        ], timeout=BUILD_TIMEOUT_SECONDS)
        log_path = app_root / "build.log"
        log_text = (build.stdout + "\n" + build.stderr)[-BUILD_LOG_MAX_BYTES:]
        log_path.write_text(log_text, encoding="utf-8")
        if build.returncode != 0:
            raise BrokerError(f"Build failed: …{log_text[-STATUS_DETAIL_MAX_CHARS:]}")

    port = manifest["internalPort"]
    env_flags: list[str] = ["-e", f"PORT={port}"]
    volume_flags: list[str] = []
    network_extra: list[str] = []
    if manifest["database"] == "postgres":
        secret_path = provision_postgres(app_id)
        volume_flags += ["-v", f"{secret_path}:/run/secrets/database_url:ro"]
        env_flags += ["-e", "DATABASE_URL_FILE=/run/secrets/database_url"]
        network_extra = [DB_NETWORK]

    domains = load_verified_domains(app_id)
    old_containers = list_app_containers(app_id)
    name = container_name(app_id, release)
    if name in old_containers:
        docker(["rm", "-f", name], timeout=60)
        old_containers.remove(name)

    write_status(app_id, "deploying", request, release=release)
    run_result = docker([
        "run", "-d", "--name", name,
        *hardening_flags(manifest["resourceClass"]),
        "--tmpfs", "/tmp:size=64m,mode=1777",
        *env_flags,
        *volume_flags,
        *traefik_labels(app_id, release, port, domains),
        image,
    ], timeout=180)
    if run_result.returncode != 0:
        raise BrokerError(f"Failed to start app container: {run_result.stderr[-500:]}")
    for network in network_extra:
        docker(["network", "connect", network, name])

    try:
        health_gate(name, port, manifest["healthPath"])
    except BrokerError:
        docker(["logs", "--tail", "50", name])
        docker(["rm", "-f", name], timeout=60)
        raise

    remove_containers(old_containers)
    (app_root / "releases").mkdir(parents=True, exist_ok=True)
    marker = app_root / "releases" / release
    if not marker.exists():
        marker.mkdir(mode=0o755)
        (marker / "image.txt").write_text(f"{image}\n", encoding="utf-8")
    current = app_root / "current"
    next_link = app_root / ".current.next"
    next_link.unlink(missing_ok=True)
    next_link.symlink_to(marker.relative_to(app_root))
    os.replace(next_link, current)

    prune_releases(app_id)
    prune_images(app_id)
    write_status(
        app_id, "running", request,
        release=release,
        url=f"https://{app_id}.{BASE_DOMAIN}/",
        customDomains=domains or None,
    )


# ---------------------------------------------------------------------------
# Non-deploy lifecycle actions
# ---------------------------------------------------------------------------

def resolve_runtime(app_id: str) -> str:
    """Runtime of the LIVE app (from its release marker), not the workspace."""
    current = APPS_ROOT / app_id / "current"
    if current.exists() and (current / "image.txt").is_file():
        return "node-22"
    return "static"


def action_stop(app_id: str, request: dict) -> None:
    containers = list_app_containers(app_id)
    for name in containers:
        docker(["stop", name], timeout=90)
    write_status(app_id, "stopped", request)


def action_start(app_id: str, request: dict) -> None:
    """(Re)start the current release; refreshes routes via a fresh deploy of
    the CURRENT artifacts when the container set is gone."""
    containers = list_app_containers(app_id)
    if containers:
        for name in containers:
            docker(["start", name], timeout=90)
        write_status(app_id, "running", request)
        return
    manifest = load_manifest(app_id)
    if manifest["runtime"] == "static":
        deploy_static(app_id, manifest, request)
    else:
        redeploy_release(app_id, manifest, request, release_of_current(app_id))


def release_of_current(app_id: str) -> str:
    current = APPS_ROOT / app_id / "current"
    if not current.exists():
        raise BrokerError("No current release to start; deploy first")
    return current.resolve().name


def redeploy_release(app_id: str, manifest: dict, request: dict, release: str) -> None:
    """Run an EXISTING image release (start/rollback) without rebuilding."""
    marker = APPS_ROOT / app_id / "releases" / release
    image_file = marker / "image.txt"
    if not image_file.is_file():
        raise BrokerError(f"Release {release} has no image record")
    image = image_file.read_text(encoding="utf-8").strip()
    port = manifest["internalPort"]

    env_flags = ["-e", f"PORT={port}"]
    volume_flags: list[str] = []
    network_extra: list[str] = []
    if manifest["database"] == "postgres":
        secret_path = provision_postgres(app_id)
        volume_flags += ["-v", f"{secret_path}:/run/secrets/database_url:ro"]
        env_flags += ["-e", "DATABASE_URL_FILE=/run/secrets/database_url"]
        network_extra = [DB_NETWORK]

    domains = load_verified_domains(app_id)
    old_containers = list_app_containers(app_id)
    name = container_name(app_id, release)
    if name in old_containers:
        docker(["rm", "-f", name], timeout=60)
        old_containers.remove(name)
    run_result = docker([
        "run", "-d", "--name", name,
        *hardening_flags(manifest["resourceClass"]),
        "--tmpfs", "/tmp:size=64m,mode=1777",
        *env_flags,
        *volume_flags,
        *traefik_labels(app_id, release, port, domains),
        image,
    ], timeout=180)
    if run_result.returncode != 0:
        raise BrokerError(f"Failed to start release: {run_result.stderr[-500:]}")
    for network in network_extra:
        docker(["network", "connect", network, name])
    health_gate(name, port, manifest["healthPath"])
    remove_containers(old_containers)

    app_root = APPS_ROOT / app_id
    next_link = app_root / ".current.next"
    next_link.unlink(missing_ok=True)
    next_link.symlink_to(Path("releases") / release)
    os.replace(next_link, app_root / "current")
    write_status(app_id, "running", request, release=release,
                 url=f"https://{app_id}.{BASE_DOMAIN}/")


def action_rollback(app_id: str, request: dict) -> None:
    app_root = APPS_ROOT / app_id
    releases_dir = app_root / "releases"
    if not releases_dir.is_dir():
        raise BrokerError("No releases to roll back to")
    releases = sorted((p.name for p in releases_dir.iterdir() if p.is_dir()), reverse=True)
    current = release_of_current(app_id)
    candidates = [r for r in releases if r < current]
    if not candidates:
        raise BrokerError("No earlier release available")
    target = candidates[0]

    if resolve_runtime(app_id) == "static":
        next_link = app_root / ".current.next"
        next_link.unlink(missing_ok=True)
        next_link.symlink_to(Path("releases") / target)
        os.replace(next_link, app_root / "current")
        write_status(app_id, "running", request, release=target,
                     url=f"https://{app_id}.{BASE_DOMAIN}/")
        return
    manifest = load_manifest(app_id)
    redeploy_release(app_id, manifest, request, target)


def action_archive(app_id: str, request: dict) -> None:
    remove_containers(list_app_containers(app_id))
    write_status(app_id, "archived", request)


def action_delete(app_id: str, request: dict, prior_phase: str | None) -> None:
    if prior_phase != "archived":
        raise BrokerError("Delete requires the app to be archived first")
    if request.get("confirmToken") != app_id:
        raise BrokerError("Delete requires confirmToken equal to the appId")

    remove_containers(list_app_containers(app_id))

    db_name = f"rivr_app_{app_id.replace('-', '_')}"
    trash_dir = TRASH_ROOT / f"{app_id}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    trash_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    db_exists = docker([
        "exec", POSTGRES_CONTAINER, "psql", "-U", "postgres", "-tAc",
        f"SELECT 1 FROM pg_database WHERE datname = '{db_name}'",
    ], timeout=60)
    if "1" in db_exists.stdout:
        dump = docker([
            "exec", POSTGRES_CONTAINER, "pg_dump", "-U", "postgres", "-Fc", db_name,
        ], timeout=600)
        (trash_dir / f"{db_name}.dump").write_bytes(dump.stdout.encode("utf-8", "surrogateescape"))
        docker(["exec", POSTGRES_CONTAINER, "dropdb", "-U", "postgres", db_name], timeout=120)
        docker([
            "exec", POSTGRES_CONTAINER, "psql", "-U", "postgres", "-c",
            f"DROP ROLE IF EXISTS {db_name}",
        ], timeout=60)

    app_root = APPS_ROOT / app_id
    if app_root.is_dir():
        shutil.move(str(app_root), str(trash_dir / "artifacts"))

    images = docker([
        "images", f"{IMAGE_PREFIX}{app_id}", "--format", "{{.Repository}}:{{.Tag}}",
    ]).stdout.splitlines()
    for image in images:
        if image.strip():
            docker(["rmi", "-f", image.strip()], timeout=120)

    (DOMAINS_DIR / f"{app_id}.json").unlink(missing_ok=True)
    write_status(app_id, "deleted", request)


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

def prune_releases(app_id: str) -> None:
    app_root = APPS_ROOT / app_id
    releases_dir = app_root / "releases"
    if not releases_dir.is_dir():
        return
    current = (app_root / "current").resolve() if (app_root / "current").exists() else None
    releases = sorted((p for p in releases_dir.iterdir() if p.is_dir()),
                      key=lambda p: p.name, reverse=True)
    kept = 0
    for release in releases:
        if current and release.resolve() == current:
            continue
        kept += 1
        if kept >= KEEP_RELEASES:
            shutil.rmtree(release)


def prune_images(app_id: str) -> None:
    images = docker([
        "images", f"{IMAGE_PREFIX}{app_id}", "--format", "{{.Tag}}",
    ]).stdout.splitlines()
    tags = sorted((t.strip() for t in images if t.strip()), reverse=True)
    for tag in tags[KEEP_IMAGES:]:
        docker(["rmi", "-f", f"{IMAGE_PREFIX}{app_id}:{tag}"], timeout=120)


def prune_trash() -> None:
    if not TRASH_ROOT.is_dir():
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=TRASH_RETENTION_DAYS)
    for entry in TRASH_ROOT.iterdir():
        try:
            if datetime.fromtimestamp(entry.stat().st_mtime, timezone.utc) < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


# ---------------------------------------------------------------------------
# Request processing
# ---------------------------------------------------------------------------

def load_request(path: Path) -> dict:
    if path.is_symlink() or path.stat().st_size > MAX_REQUEST_BYTES:
        raise BrokerError("Invalid request file")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != REQUEST_VERSION:
        raise BrokerError("Unsupported request version")
    request_id = data.get("requestId")
    if not isinstance(request_id, str) or not UUID_RE.fullmatch(request_id):
        raise BrokerError("Invalid request id")
    if data.get("action") not in ACTIONS:
        raise BrokerError("Unknown action")
    return data


def process_request(path: Path) -> None:
    app_id = validate_app_id(path.stem)
    request: dict | None = None
    try:
        request = load_request(path)
        if request.get("appId") != app_id:
            raise BrokerError("Request appId does not match queue entry")
        action = request["action"]
        # Capture the phase from BEFORE this request: two-phase guards
        # (archive → delete) must see the app's prior state, not the
        # "validating" stamp written below.
        prior_phase: str | None = None
        status_path = STATUS_DIR / f"{app_id}.json"
        if status_path.is_file():
            try:
                prior_phase = json.loads(status_path.read_text(encoding="utf-8")).get("phase")
            except (OSError, json.JSONDecodeError):
                prior_phase = None
        write_status(app_id, "validating", request)

        if action == "deploy":
            manifest = load_manifest(app_id)
            if manifest["runtime"] == "static":
                deploy_static(app_id, manifest, request)
            else:
                deploy_node(app_id, manifest, request)
        elif action == "stop":
            action_stop(app_id, request)
        elif action == "start":
            action_start(app_id, request)
        elif action == "rollback":
            action_rollback(app_id, request)
        elif action == "archive":
            action_archive(app_id, request)
        elif action == "delete":
            action_delete(app_id, request, prior_phase)
    except BrokerError as error:
        write_status(app_id, "failed", request, error=str(error)[:STATUS_DETAIL_MAX_CHARS])
    except Exception as error:  # noqa: BLE001 — one bad request must not stop the queue
        write_status(app_id, "failed", request, error=f"Internal broker error: {error}")
    finally:
        path.unlink(missing_ok=True)


def main() -> int:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        QUEUE_DIR.mkdir(parents=True, exist_ok=True)
        STATUS_DIR.mkdir(parents=True, exist_ok=True)
        pending = sorted(
            (p for p in QUEUE_DIR.iterdir()
             if p.is_file() and p.suffix == ".json" and not p.name.startswith(".")),
            key=lambda p: p.stat().st_mtime,
        )
        for path in pending:
            process_request(path)
        prune_trash()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"rivr-app-broker failed: {error}", file=sys.stderr)
        raise SystemExit(1)
