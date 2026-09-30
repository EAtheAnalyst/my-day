"""Daily Todo app backend: FastAPI + SQLite (on your PC) or PostgreSQL (online).

Run from the app folder:  python -m uvicorn backend.main:app --port 8000
Then open http://localhost:8000

Settings come from environment variables (all optional on your PC):
  DATABASE_URL    PostgreSQL connection string. If empty, the local todo.db file is used.
"""
import csv
import html
import io
import os
import re
import secrets
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "todo.db"
BACKUP_DIR = BASE_DIR / "backups"
FRONTEND_DIR = BASE_DIR / "frontend"

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))

MAX_PRIORITIES = 3
BACKUPS_TO_KEEP = 14
MAX_IMPORT_BYTES = 50 * 1024 * 1024
DEFAULT_SETTINGS = {
    "morning_time": "08:00",
    "afternoon_time": "13:00",
    "night_time": "21:00",
}
REMINDER_KINDS = {"morning", "afternoon", "night", "yesterday"}

# Every table and its columns (used for backups, downloads and imports)
TABLES = {
    "todos": ["id", "day", "text", "done", "position", "created_at", "done_at", "priority"],
    "notes": ["id", "day", "text", "created_at", "is_html"],
    "reviews": ["day", "went_well", "not_well", "do_better", "grateful", "updated_at"],
    "reminders_seen": ["day", "kind", "seen_at"],
    "settings": ["key", "value"],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS todos (
    id {id_column},
    day TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    done_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
    id {id_column},
    day TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_html INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reviews (
    day TEXT PRIMARY KEY,
    went_well TEXT NOT NULL DEFAULT '',
    not_well TEXT NOT NULL DEFAULT '',
    do_better TEXT NOT NULL DEFAULT '',
    grateful TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders_seen (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (day, kind)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


# ---------- Database ----------

class DB:
    """Small wrapper so the same code works with SQLite and PostgreSQL.

    Queries are written with ? placeholders; they are converted for PostgreSQL.
    """

    def __init__(self, conn, postgres: bool):
        self.conn = conn
        self.postgres = postgres

    def _sql(self, sql):
        return sql.replace("?", "%s") if self.postgres else sql

    def run(self, sql, params=()):
        self.conn.execute(self._sql(sql), params)

    def all(self, sql, params=()) -> list[dict]:
        return [dict(r) for r in self.conn.execute(self._sql(sql), params).fetchall()]

    def one(self, sql, params=()) -> Optional[dict]:
        found = self.all(sql, params)
        return found[0] if found else None

    def value(self, sql, params=()):
        row = self.one(sql, params)
        return next(iter(row.values())) if row else None

    def insert(self, sql, params=()) -> int:
        """Run an INSERT and return the new row's id."""
        if self.postgres:
            return self.value(sql + " RETURNING id", params)
        return self.conn.execute(sql, params).lastrowid

    def create_tables(self):
        id_column = "SERIAL PRIMARY KEY" if self.postgres else "INTEGER PRIMARY KEY AUTOINCREMENT"
        for statement in SCHEMA.format(id_column=id_column).split(";"):
            if statement.strip():
                self.run(statement)
        # Add columns introduced after the first version (older databases)
        for table, column in (("todos", "priority"), ("notes", "is_html")):
            if self.postgres:
                self.run(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} INTEGER NOT NULL DEFAULT 0")
            elif column not in self.columns(table):
                self.run(f"ALTER TABLE {table} ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")

    def columns(self, table) -> set[str]:
        """Column names of a table (SQLite only)."""
        return {r["name"] for r in self.all(f"PRAGMA table_info({table})")}


def sqlite_db(path: Path) -> DB:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return DB(conn, postgres=False)


@contextmanager
def db():
    if USE_POSTGRES:
        import psycopg
        from psycopg.rows import dict_row

        # prepare_threshold=None: works with connection poolers (e.g. Supabase)
        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row, prepare_threshold=None)
        database = DB(conn, postgres=True)
    else:
        database = sqlite_db(DB_PATH)
    try:
        yield database
        database.conn.commit()
    finally:
        database.conn.close()


def init_db():
    with db() as conn:
        conn.create_tables()
        for key, value in DEFAULT_SETTINGS.items():
            conn.run(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING", (key, value)
            )


def copy_tables(src: DB, dst: DB):
    """Replace everything in `dst` with the data from `src`."""
    for table, wanted in TABLES.items():
        rows = src.all(f"SELECT * FROM {table}")
        dst.run(f"DELETE FROM {table}")
        for row in rows:
            cols = [c for c in wanted if c in row and row[c] is not None]
            dst.run(
                f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                [row[c] for c in cols],
            )
    if dst.postgres:
        # Make new ids continue after the imported ones
        for table in ("todos", "notes"):
            dst.run(
                f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                f"(SELECT COALESCE(MAX(id), 0) + 1 FROM {table}), false)"
            )


def make_backup(path: Path):
    """Save a complete copy of the database as a SQLite file."""
    if path.exists():
        path.unlink()
    if USE_POSTGRES:
        dst = sqlite_db(path)
        try:
            dst.create_tables()
            with db() as src:
                copy_tables(src, dst)
            dst.conn.commit()
        finally:
            dst.conn.close()
    else:
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(path)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()


def daily_auto_backup():
    """Keep one automatic backup per day, and only the most recent few (PC only)."""
    if USE_POSTGRES:
        return  # the online database provider keeps its own backups
    BACKUP_DIR.mkdir(exist_ok=True)
    target = BACKUP_DIR / f"auto-{date.today().isoformat()}.db"
    if not target.exists():
        make_backup(target)
    for old in sorted(BACKUP_DIR.glob("auto-*.db"))[:-BACKUPS_TO_KEEP]:
        old.unlink()


def now():
    return datetime.now().isoformat(timespec="seconds")


def shift(day: str, delta: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=delta)).isoformat()


# ---------- Request models ----------

class TodoIn(BaseModel):
    day: str
    text: str


class TodoPatch(BaseModel):
    text: Optional[str] = None
    done: Optional[bool] = None
    priority: Optional[bool] = None


class ReorderIn(BaseModel):
    ids: list[int]


class NoteIn(BaseModel):
    day: str
    text: str
    is_html: bool = False


class ReviewIn(BaseModel):
    went_well: str = ""
    not_well: str = ""
    do_better: str = ""
    grateful: str = ""


class CarryOverIn(BaseModel):
    from_day: str
    to_day: str


app = FastAPI(title="Daily Todo")
init_db()
daily_auto_backup()


# ---------- App info ----------

@app.get("/api/info")
def info():
    return {"online": USE_POSTGRES}


# ---------- Todos ----------

@app.get("/api/todos")
def list_todos(day: str):
    with db() as conn:
        return conn.all("SELECT * FROM todos WHERE day = ? ORDER BY position, id", (day,))


@app.post("/api/todos")
def create_todo(item: TodoIn):
    text = item.text.strip()
    if not text:
        raise HTTPException(400, "Text cannot be empty")
    with db() as conn:
        pos = conn.value(
            "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM todos WHERE day = ?", (item.day,)
        )
        new_id = conn.insert(
            "INSERT INTO todos (day, text, position, created_at) VALUES (?, ?, ?, ?)",
            (item.day, text, pos, now()),
        )
        return conn.one("SELECT * FROM todos WHERE id = ?", (new_id,))


@app.patch("/api/todos/{todo_id}")
def update_todo(todo_id: int, patch: TodoPatch):
    with db() as conn:
        todo = conn.one("SELECT * FROM todos WHERE id = ?", (todo_id,))
        if not todo:
            raise HTTPException(404, "Todo not found")
        if patch.text is not None:
            conn.run("UPDATE todos SET text = ? WHERE id = ?", (patch.text.strip(), todo_id))
        if patch.done is not None:
            conn.run(
                "UPDATE todos SET done = ?, done_at = ? WHERE id = ?",
                (int(patch.done), now() if patch.done else None, todo_id),
            )
        if patch.priority is not None:
            if patch.priority and not todo["priority"]:
                count = conn.value(
                    "SELECT COUNT(*) AS n FROM todos WHERE day = ? AND priority = 1", (todo["day"],)
                )
                if count >= MAX_PRIORITIES:
                    raise HTTPException(400, f"You can only star {MAX_PRIORITIES} top tasks per day")
            conn.run("UPDATE todos SET priority = ? WHERE id = ?", (int(patch.priority), todo_id))
        return conn.one("SELECT * FROM todos WHERE id = ?", (todo_id,))


@app.delete("/api/todos/{todo_id}")
def delete_todo(todo_id: int):
    with db() as conn:
        conn.run("DELETE FROM todos WHERE id = ?", (todo_id,))
    return {"ok": True}


@app.put("/api/todos/reorder")
def reorder_todos(body: ReorderIn):
    with db() as conn:
        for pos, todo_id in enumerate(body.ids):
            conn.run("UPDATE todos SET position = ? WHERE id = ?", (pos, todo_id))
    return {"ok": True}


@app.post("/api/todos/carry-over")
def carry_over(body: CarryOverIn):
    """Copy unfinished tasks from one day to another."""
    with db() as conn:
        unfinished = conn.all(
            "SELECT text FROM todos WHERE day = ? AND done = 0 ORDER BY position, id",
            (body.from_day,),
        )
        existing = {r["text"] for r in conn.all("SELECT text FROM todos WHERE day = ?", (body.to_day,))}
        pos = conn.value(
            "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM todos WHERE day = ?", (body.to_day,)
        )
        added = 0
        for r in unfinished:
            if r["text"] in existing:
                continue
            conn.run(
                "INSERT INTO todos (day, text, position, created_at) VALUES (?, ?, ?, ?)",
                (body.to_day, r["text"], pos, now()),
            )
            pos += 1
            added += 1
    return {"added": added}


# ---------- Notes ----------

@app.get("/api/notes")
def list_notes(day: str):
    with db() as conn:
        return conn.all("SELECT * FROM notes WHERE day = ? ORDER BY id DESC", (day,))


@app.post("/api/notes")
def create_note(note: NoteIn):
    text = note.text.strip()
    if not text:
        raise HTTPException(400, "Note cannot be empty")
    with db() as conn:
        new_id = conn.insert(
            "INSERT INTO notes (day, text, is_html, created_at) VALUES (?, ?, ?, ?)",
            (note.day, text, int(note.is_html), now()),
        )
        return conn.one("SELECT * FROM notes WHERE id = ?", (new_id,))


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: int):
    with db() as conn:
        conn.run("DELETE FROM notes WHERE id = ?", (note_id,))
    return {"ok": True}


# ---------- Night reviews ----------

@app.get("/api/reviews/previous")
def previous_review(day: str):
    """Most recent review before `day` that has a 'do better' answer."""
    with db() as conn:
        return conn.one(
            "SELECT * FROM reviews WHERE day < ? AND TRIM(do_better) != '' "
            "ORDER BY day DESC LIMIT 1",
            (day,),
        )


@app.get("/api/reviews/{day}")
def get_review(day: str):
    with db() as conn:
        return conn.one("SELECT * FROM reviews WHERE day = ?", (day,))


@app.put("/api/reviews/{day}")
def save_review(day: str, review: ReviewIn):
    with db() as conn:
        conn.run(
            """
            INSERT INTO reviews (day, went_well, not_well, do_better, grateful, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(day) DO UPDATE SET
                went_well = excluded.went_well,
                not_well = excluded.not_well,
                do_better = excluded.do_better,
                grateful = excluded.grateful,
                updated_at = excluded.updated_at
            """,
            (day, review.went_well, review.not_well, review.do_better, review.grateful, now()),
        )
        return conn.one("SELECT * FROM reviews WHERE day = ?", (day,))


# ---------- Streak & weekly summary ----------

REVIEWED_DAYS_SQL = (
    "SELECT day FROM reviews WHERE TRIM(went_well || not_well || do_better || grateful) != ''"
)


@app.get("/api/streak")
def streak(day: str):
    """Consecutive days with a night review. Today not reviewed yet doesn't break it."""
    with db() as conn:
        reviewed = {r["day"] for r in conn.all(REVIEWED_DAYS_SQL)}

    current = 0
    cursor = day if day in reviewed else shift(day, -1)
    while cursor in reviewed:
        current += 1
        cursor = shift(cursor, -1)

    best = run = 0
    previous = None
    for d in sorted(reviewed):
        run = run + 1 if previous and shift(previous, 1) == d else 1
        best = max(best, run)
        previous = d

    return {"current": current, "best": best, "reviewed_today": day in reviewed}


@app.get("/api/week")
def week(end: str):
    """Stats for the 7 days ending on `end`."""
    days = [shift(end, -i) for i in range(6, -1, -1)]
    with db() as conn:
        result = []
        for d in days:
            stats = conn.one(
                "SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done, "
                "COALESCE(SUM(priority), 0) AS top_total, "
                "COALESCE(SUM(done * priority), 0) AS top_done FROM todos WHERE day = ?",
                (d,),
            )
            review = conn.one("SELECT * FROM reviews WHERE day = ?", (d,))
            result.append({"day": d, **{k: int(v) for k, v in stats.items()}, "review": review})
    return result


# ---------- Reminders ----------

@app.get("/api/reminders/{day}")
def reminders_seen(day: str):
    with db() as conn:
        return [r["kind"] for r in conn.all("SELECT kind FROM reminders_seen WHERE day = ?", (day,))]


@app.post("/api/reminders/{day}/{kind}")
def mark_reminder_seen(day: str, kind: str):
    if kind not in REMINDER_KINDS:
        raise HTTPException(400, "Unknown reminder kind")
    with db() as conn:
        conn.run(
            "INSERT INTO reminders_seen (day, kind, seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            (day, kind, now()),
        )
    return {"ok": True}


# ---------- Settings ----------

@app.get("/api/settings")
def get_settings():
    with db() as conn:
        return {r["key"]: r["value"] for r in conn.all("SELECT key, value FROM settings")}


@app.put("/api/settings")
def save_settings(values: dict[str, str]):
    with db() as conn:
        for key, value in values.items():
            if key in DEFAULT_SETTINGS:
                conn.run(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, value),
                )
    return get_settings()


# ---------- History ----------

@app.get("/api/history")
def history():
    """One row per day that has any activity, newest first."""
    with db() as conn:
        return conn.all(
            """
            SELECT d.day,
                   (SELECT COUNT(*) FROM todos t WHERE t.day = d.day) AS total,
                   (SELECT COUNT(*) FROM todos t WHERE t.day = d.day AND t.done = 1) AS done,
                   (SELECT COUNT(*) FROM notes n WHERE n.day = d.day) AS notes,
                   EXISTS(SELECT 1 FROM reviews r WHERE r.day = d.day) AS reviewed
            FROM (SELECT day FROM todos UNION SELECT day FROM notes UNION SELECT day FROM reviews) d
            ORDER BY d.day DESC
            LIMIT 60
            """
        )


# ---------- Backup, import & export ----------

@app.post("/api/backup")
def backup_now():
    """Save a copy of the database into the backups folder (PC only)."""
    if USE_POSTGRES:
        raise HTTPException(400, "Use 'Download database' to keep a copy of the online data")
    BACKUP_DIR.mkdir(exist_ok=True)
    target = BACKUP_DIR / f"manual-{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.db"
    make_backup(target)
    return {"file": str(target)}


@app.get("/api/export/database")
def download_database():
    target = Path(tempfile.gettempdir()) / "my-day-download.db"
    make_backup(target)
    return FileResponse(target, filename=f"my-day-backup-{date.today().isoformat()}.db")


@app.post("/api/import")
async def import_database(request: Request):
    """Replace all data with the contents of an uploaded backup (.db) file."""
    data = await request.body()
    if not data.startswith(b"SQLite format 3"):
        raise HTTPException(400, "That file isn't a My Day backup (.db) file")
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(400, "That file is too big")

    upload = Path(tempfile.gettempdir()) / f"my-day-import-{secrets.token_hex(4)}.db"
    upload.write_bytes(data)
    try:
        src = sqlite_db(upload)
        try:
            missing = [t for t in TABLES if not src.columns(t)]
            if missing:
                raise HTTPException(400, "That file isn't a My Day backup (missing: " + ", ".join(missing) + ")")
            if not USE_POSTGRES:
                BACKUP_DIR.mkdir(exist_ok=True)
                make_backup(BACKUP_DIR / f"before-import-{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.db")
            with db() as dst:
                copy_tables(src, dst)
                counts = {t: dst.value(f"SELECT COUNT(*) AS n FROM {t}") for t in ("todos", "notes", "reviews")}
        finally:
            src.conn.close()
    finally:
        upload.unlink(missing_ok=True)
    return {"ok": True, "counts": counts}


def html_to_text(value: str) -> str:
    """Turn a formatted note into readable plain text for spreadsheets."""
    def number_list(match):
        items = re.split(r"<li[^>]*>", match.group(1), flags=re.I)[1:]
        return "".join(f"\n{i}. {item}" for i, item in enumerate(items, 1))

    value = re.sub(r"<ol[^>]*>(.*?)</ol>", number_list, value, flags=re.S | re.I)
    value = re.sub(r"<li[^>]*>", "\n• ", value, flags=re.I)
    value = re.sub(r"<br\s*/?>|</(p|div|h\d)>", "\n", value, flags=re.I)
    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"\n{3,}", "\n\n", html.unescape(value))
    return value.strip()


EXPORTS = {
    "tasks": (
        ["day", "order", "task", "done", "top_task", "created_at", "done_at"],
        "SELECT * FROM todos ORDER BY day, position",
        lambda r: [r["day"], r["position"] + 1, r["text"], "yes" if r["done"] else "no",
                   "yes" if r["priority"] else "no", r["created_at"], r["done_at"]],
    ),
    "notes": (
        ["day", "created_at", "note"],
        "SELECT * FROM notes ORDER BY day, id",
        lambda r: [r["day"], r["created_at"], html_to_text(r["text"]) if r["is_html"] else r["text"]],
    ),
    "reviews": (
        ["day", "went_well", "didnt_go_well", "do_better", "grateful"],
        "SELECT * FROM reviews ORDER BY day",
        lambda r: [r["day"], r["went_well"], r["not_well"], r["do_better"], r["grateful"]],
    ),
}


@app.get("/api/export/{kind}.csv")
def export_csv(kind: str):
    if kind not in EXPORTS:
        raise HTTPException(404, "Unknown export")
    header, sql, to_row = EXPORTS[kind]
    with db() as conn:
        found = conn.all(sql)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(to_row(r) for r in found)
    # utf-8-sig so Excel shows emojis/accents correctly
    return Response(
        buffer.getvalue().encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="my-day-{kind}.csv"'},
    )


# ---------- Frontend ----------

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")
