"""WhyNot local prototype. Start with python app.py."""

import argparse
from contextlib import closing, contextmanager
import hashlib
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import random
import secrets
import sqlite3
from urllib.parse import urlsplit

from suggestions import BUDGETS, ENERGIES, SCENES, options

ROOT = Path(__file__).resolve().parent
ASSETS = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css"),
          "/app.js": ("app.js", "text/javascript"), "/icon.svg": ("icon.svg", "image/svg+xml"),
          "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
          "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
          "/icon-192.png": ("icon-192.png", "image/png"),
          "/icon-512.png": ("icon-512.png", "image/png")}


class ApiError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


@contextmanager
def transaction(path):
    with closing(sqlite3.connect(path, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        with db:
            db.execute("BEGIN IMMEDIATE")
            yield db


def initialize(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with transaction(path) as db:
        db.execute("CREATE TABLE IF NOT EXISTS sessions (owner TEXT PRIMARY KEY)")
        db.execute("""CREATE TABLE IF NOT EXISTS recommendations (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(owner),
            scene TEXT NOT NULL, energy TEXT NOT NULL, budget INTEGER NOT NULL,
            action TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
            first_step TEXT NOT NULL, detail TEXT NOT NULL, minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND budget),
            created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            preference TEXT CHECK(preference IN ('like','dislike')),
            completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)))""")
        db.execute("CREATE INDEX IF NOT EXISTS by_owner ON recommendations(owner, created DESC)")


def as_card(row):
    return {key: row[key] for key in ("id", "scene", "energy", "budget", "category", "title", "first_step",
                                       "detail", "minutes", "created", "preference", "completed")}


def recommend(db, owner, data):
    if set(data) != {"scene", "energy", "budget"}:
        raise ApiError(400, "INVALID_CONTEXT")
    scene, energy, budget = data["scene"], data["energy"], data["budget"]
    if (type(scene) is not str or scene not in SCENES or type(energy) is not str or
            energy not in ENERGIES or type(budget) is not int or budget not in BUDGETS):
        raise ApiError(400, "INVALID_CONTEXT")
    recent = db.execute("""SELECT action FROM recommendations WHERE owner=? AND scene=?
                           ORDER BY rowid DESC LIMIT 3""", (owner, scene)).fetchall()
    choices = options(scene, energy, budget)
    for row in recent:
        remaining = [item for item in choices if item[0] != row["action"]]
        if remaining:
            choices = remaining
    scores = dict(db.execute("""SELECT category, sum(CASE preference WHEN 'like' THEN 1
        WHEN 'dislike' THEN -1 ELSE 0 END) FROM recommendations
        WHERE owner=? GROUP BY category""", (owner,)))
    weights = [2 ** max(-2, min(2, scores.get(item[5], 0))) for item in choices]
    action, title, first, detail, minutes, category = random.choices(choices, weights)[0]
    identifier = secrets.token_hex(12)
    db.execute("""INSERT INTO recommendations(id,owner,scene,energy,budget,action,category,
        title,first_step,detail,minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
               (identifier, owner, scene, energy, budget, action, category, title, first, detail, minutes))
    return as_card(db.execute("SELECT * FROM recommendations WHERE id=?", (identifier,)).fetchone())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, content, kind="application/json", cookie=None):
        if kind == "application/json":
            content = json.dumps(content, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", kind + "; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie", f"whynot={cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000")
        self.end_headers()
        self.wfile.write(content)

    def owner(self, db):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return None
        token = cookie.get("whynot")
        if token:
            digest = hashlib.sha256(token.value.encode()).hexdigest()
            if db.execute("SELECT 1 FROM sessions WHERE owner=?", (digest,)).fetchone():
                return digest
        return None

    def body(self):
        if self.headers.get_content_type() != "application/json":
            raise ApiError(415, "JSON_REQUIRED")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2048:
                raise ApiError(413 if length > 2048 else 400, "INVALID_BODY")
            data = json.loads(self.rfile.read(length).decode())
        except (ValueError, RecursionError):
            raise ApiError(400, "INVALID_BODY")
        if type(data) is not dict:
            raise ApiError(400, "INVALID_BODY")
        return data

    def route(self):
        path = urlsplit(self.path).path
        if self.command == "GET" and path in ASSETS:
            filename, kind = ASSETS[path]
            cookie = None
            if path == "/":
                with transaction(self.server.db_path) as db:
                    if not self.owner(db):
                        cookie = secrets.token_urlsafe(32)
                        db.execute("INSERT INTO sessions VALUES (?)", (hashlib.sha256(cookie.encode()).hexdigest(),))
            self.reply(200, (ROOT / "web" / filename).read_bytes(), kind, cookie)
            return
        if not path.startswith("/api/"):
            raise ApiError(404, "NOT_FOUND")
        data = self.body() if self.command == "POST" else {}
        with transaction(self.server.db_path) as db:
            owner = self.owner(db)
            if not owner:
                raise ApiError(401, "SESSION_REQUIRED")
            if self.command == "GET" and path == "/api/history":
                rows = db.execute("SELECT * FROM recommendations WHERE owner=? ORDER BY rowid DESC LIMIT 50", (owner,))
                status, payload = 200, {"items": [as_card(row) for row in rows]}
            elif self.command == "POST" and path == "/api/recommendations":
                status, payload = 201, recommend(db, owner, data)
            elif self.command == "POST" and path.startswith("/api/recommendations/") and path.endswith("/feedback"):
                parts = path.split("/")
                if len(parts) != 5:
                    raise ApiError(404, "NOT_FOUND")
                identifier = parts[3]
                kind = data.get("kind")
                if set(data) != {"kind"} or kind not in ("like", "dislike", "completed"):
                    raise ApiError(400, "INVALID_FEEDBACK")
                row = db.execute("SELECT * FROM recommendations WHERE id=? AND owner=?", (identifier, owner)).fetchone()
                if not row:
                    raise ApiError(404, "NOT_FOUND")
                if kind == "completed":
                    db.execute("UPDATE recommendations SET completed=1 WHERE id=? AND completed=0", (identifier,))
                else:
                    db.execute("UPDATE recommendations SET preference=? WHERE id=? AND preference IS NOT ?", (kind, identifier, kind))
                status, payload = 200, as_card(db.execute("SELECT * FROM recommendations WHERE id=?", (identifier,)).fetchone())
            else:
                raise ApiError(404, "NOT_FOUND")
        self.reply(status, payload)

    def dispatch(self):
        try:
            self.route()
        except ApiError as error:
            self.reply(error.status, {"error": error.code})
        except (ConnectionError, TimeoutError):
            pass
        except sqlite3.Error:
            self.reply(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "STORAGE_UNAVAILABLE"})

    do_GET = do_POST = dispatch


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=ROOT / ".local" / "whynot.sqlite3")
    args = parser.parse_args()
    initialize(args.db)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.db_path = args.db
    print(f"WhyNot  http://127.0.0.1:{server.server_port}/", flush=True)
    server.serve_forever()
