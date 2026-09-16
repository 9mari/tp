#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WARDOGS 出勤投票 —— 单文件 Flask 后端

启动（开发）:
    python app.py
启动（生产）:
    gunicorn -w 1 -k gthread --threads 8 -b 0.0.0.0:8000 app:app

环境变量:
    SECRET_KEY      签名 cookie 用的密钥（生产必填，否则重启后 cookie 失效）
    DATA_DIR        数据库存放目录，默认当前目录
    ADMIN_TOKEN     管理口令，用于清空/重置投票（默认随机生成，打印在日志里）
    STRICT_IP       "1" 时同一 IP+设备指纹只能投一票（同一 WiFi 下会互相挡住，默认关闭）
    VOTE_DEADLINE   可选，形如 2026-09-20T20:00 的本地时间，到点后前端显示"已截止"并拒绝投票
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import datetime
from typing import Any

from flask import Flask, g, jsonify, make_response, render_template, request

# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #

APP_TITLE = "WARDOGS 出勤投票"

OPTIONS: list[dict[str, str]] = [
    {"id": "yes", "label": "玩！", "desc": "我上号，随时开玩", "emoji": "🐺"},
    {"id": "maybe", "label": "随缘", "desc": "人齐就来，别等我", "emoji": "🎲"},
    {"id": "no", "label": "不玩", "desc": "这次跳过，下次一定", "emoji": "💤"},
]
OPTION_IDS = {o["id"] for o in OPTIONS}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR") or BASE_DIR
DB_PATH = os.path.join(DATA_DIR, "votes.db")

SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN") or secrets.token_urlsafe(9)
STRICT_IP = os.environ.get("STRICT_IP", "0") == "1"
VOTE_DEADLINE_RAW = os.environ.get("VOTE_DEADLINE", "").strip()

COOKIE_NAME = "wd_voter"
COOKIE_MAX_AGE = 60 * 60 * 24 * 180  # 180 天
NAME_MAX_LEN = 16

app = Flask(__name__)
app.config["SECRET_KEY"] = SECRET_KEY
app.config["JSON_AS_ASCII"] = False

_write_lock = threading.Lock()


def _parse_deadline(raw: str) -> float | None:
    if not raw:
        return None
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).timestamp()
        except ValueError:
            continue
    app.logger.warning("VOTE_DEADLINE 格式无法解析: %r，已忽略", raw)
    return None


DEADLINE_TS = _parse_deadline(VOTE_DEADLINE_RAW)


# --------------------------------------------------------------------------- #
# 数据库
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE IF NOT EXISTS votes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    voter_id    TEXT    NOT NULL UNIQUE,      -- 浏览器身份（签名 cookie）
    name        TEXT    NOT NULL,
    name_key    TEXT    NOT NULL UNIQUE,      -- 归一化后的昵称，保证一人一票
    choice      TEXT    NOT NULL,
    note        TEXT    NOT NULL DEFAULT '',
    fingerprint TEXT    NOT NULL DEFAULT '',  -- IP + UA 哈希
    created_at  REAL    NOT NULL,
    updated_at  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_fp ON votes(fingerprint);
"""


def get_db() -> sqlite3.Connection:
    conn = getattr(g, "_db", None)
    if conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        g._db = conn
    return conn


@app.teardown_appcontext
def close_db(_exc: BaseException | None) -> None:
    conn = getattr(g, "_db", None)
    if conn is not None:
        conn.close()


def init_db() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #

_sign_re = re.compile(r"^([0-9a-f-]{36})\.([0-9a-f]{32})$")


def _sign(value: str) -> str:
    mac = hashlib.blake2b(value.encode(), key=SECRET_KEY.encode(), digest_size=16)
    return f"{value}.{mac.hexdigest()}"


def _unsign(token: str | None) -> str | None:
    if not token:
        return None
    m = _sign_re.match(token)
    if not m:
        return None
    value, mac = m.group(1), m.group(2)
    expect = hashlib.blake2b(
        value.encode(), key=SECRET_KEY.encode(), digest_size=16
    ).hexdigest()
    return value if secrets.compare_digest(mac, expect) else None


def client_ip() -> str:
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.headers.get("X-Real-IP") or request.remote_addr or "?"


def fingerprint() -> str:
    raw = f"{client_ip()}|{request.headers.get('User-Agent', '')}|{SECRET_KEY}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


_ws_re = re.compile(r"\s+")


def normalize_name(name: str) -> str:
    """归一化昵称：去空白、转小写、去掉常见装饰符，避免 "阿伟" / "阿 伟 " 算两个人。"""
    key = _ws_re.sub("", name).lower()
    key = re.sub(r"[·•.\-_~!@#$%^&*()+=\[\]{}|\\/:;\"'<>,?，。！？、（）【】]", "", key)
    return key


def clean_name(raw: Any) -> str:
    name = _ws_re.sub(" ", str(raw or "")).strip()
    return name[:NAME_MAX_LEN]


def deadline_passed() -> bool:
    return DEADLINE_TS is not None and time.time() > DEADLINE_TS


def build_state(voter_id: str | None) -> dict[str, Any]:
    db = get_db()
    rows = db.execute(
        "SELECT voter_id, name, choice, note, updated_at FROM votes ORDER BY updated_at ASC"
    ).fetchall()

    counts = {o["id"]: 0 for o in OPTIONS}
    voters = []
    me = None
    for r in rows:
        if r["choice"] in counts:
            counts[r["choice"]] += 1
        voters.append(
            {
                "name": r["name"],
                "choice": r["choice"],
                "note": r["note"],
                "at": r["updated_at"],
                "isMe": voter_id is not None and r["voter_id"] == voter_id,
            }
        )
        if voter_id is not None and r["voter_id"] == voter_id:
            me = {"name": r["name"], "choice": r["choice"], "note": r["note"]}

    total = len(rows)
    results = [
        {
            **o,
            "count": counts[o["id"]],
            "percent": round(counts[o["id"]] * 100 / total, 1) if total else 0.0,
        }
        for o in OPTIONS
    ]
    return {
        "title": APP_TITLE,
        "options": OPTIONS,
        "results": results,
        "total": total,
        "voters": voters,
        "me": me,
        "closed": deadline_passed(),
        "deadline": DEADLINE_TS,
        "serverTime": time.time(),
    }


def with_voter_cookie(payload: Any, voter_id: str, status: int = 200):
    resp = make_response(payload, status)
    resp.set_cookie(
        COOKIE_NAME,
        _sign(voter_id),
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="Lax",
        secure=request.headers.get("X-Forwarded-Proto") == "https" or request.is_secure,
        path="/",
    )
    return resp


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #


@app.route("/")
def index():
    voter_id = _unsign(request.cookies.get(COOKIE_NAME)) or str(uuid.uuid4())
    html = render_template(
        "index.html",
        title=APP_TITLE,
        state=build_state(voter_id),
        name_max_len=NAME_MAX_LEN,
    )
    resp = with_voter_cookie(html, voter_id)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/state")
def api_state():
    voter_id = _unsign(request.cookies.get(COOKIE_NAME)) or str(uuid.uuid4())
    resp = with_voter_cookie(jsonify(build_state(voter_id)), voter_id)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/api/vote")
def api_vote():
    voter_id = _unsign(request.cookies.get(COOKIE_NAME)) or str(uuid.uuid4())
    data = request.get_json(silent=True) or {}

    name = clean_name(data.get("name"))
    choice = str(data.get("choice") or "").strip()
    note = clean_note(data.get("note"))

    if deadline_passed():
        return _err("投票已经截止啦，下一次再约～", 403, voter_id)
    if len(name) < 1:
        return _err("先写个名字，方便点人头 🙂", 400, voter_id)
    if not normalize_name(name):
        return _err("这个名字看不出是谁，换一个吧", 400, voter_id)
    if choice not in OPTION_IDS:
        return _err("选项不合法", 400, voter_id)

    name_key = normalize_name(name)
    now = time.time()
    fp = fingerprint()

    with _write_lock:
        db = get_db()
        mine = db.execute(
            "SELECT * FROM votes WHERE voter_id = ?", (voter_id,)
        ).fetchone()
        clash = db.execute(
            "SELECT * FROM votes WHERE name_key = ? AND voter_id != ?",
            (name_key, voter_id),
        ).fetchone()
        if clash is not None:
            return _err(
                f"「{clash['name']}」已经投过了，同名不能重复投票 🙅",
                409,
                voter_id,
            )

        if mine is None and STRICT_IP:
            same_dev = db.execute(
                "SELECT name FROM votes WHERE fingerprint = ?", (fp,)
            ).fetchone()
            if same_dev is not None:
                return _err(
                    f"这台设备已经由「{same_dev['name']}」投过票了 🙅",
                    409,
                    voter_id,
                )

        if mine is None:
            db.execute(
                "INSERT INTO votes (voter_id, name, name_key, choice, note, fingerprint,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (voter_id, name, name_key, choice, note, fp, now, now),
            )
            changed = False
        else:
            db.execute(
                "UPDATE votes SET name=?, name_key=?, choice=?, note=?, updated_at=?"
                " WHERE voter_id=?",
                (name, name_key, choice, note, now, voter_id),
            )
            changed = True
        db.commit()

    state = build_state(voter_id)
    state["ok"] = True
    state["changed"] = changed
    return with_voter_cookie(jsonify(state), voter_id)


@app.post("/api/withdraw")
def api_withdraw():
    """撤回自己的投票（只能撤自己的）。"""
    voter_id = _unsign(request.cookies.get(COOKIE_NAME)) or str(uuid.uuid4())
    if deadline_passed():
        return _err("已经截止，改不动了", 403, voter_id)
    with _write_lock:
        db = get_db()
        db.execute("DELETE FROM votes WHERE voter_id = ?", (voter_id,))
        db.commit()
    state = build_state(voter_id)
    state["ok"] = True
    return with_voter_cookie(jsonify(state), voter_id)


@app.post("/api/admin/reset")
def api_reset():
    token = request.headers.get("X-Admin-Token") or (
        request.get_json(silent=True) or {}
    ).get("token", "")
    if not secrets.compare_digest(str(token), ADMIN_TOKEN):
        return jsonify({"ok": False, "error": "口令不对"}), 403
    with _write_lock:
        db = get_db()
        db.execute("DELETE FROM votes")
        db.commit()
    return jsonify({"ok": True})


@app.get("/healthz")
def healthz():
    return {"ok": True, "total": build_state(None)["total"]}


def clean_note(raw: Any) -> str:
    note = _ws_re.sub(" ", str(raw or "")).strip()
    return note[:40]


def _err(msg: str, status: int, voter_id: str):
    return with_voter_cookie(jsonify({"ok": False, "error": msg}), voter_id, status)


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"ok": False, "error": "没有这个页面"}), 404


init_db()

if __name__ == "__main__":
    print("=" * 56)
    print(f"  {APP_TITLE}")
    print(f"  数据库   : {DB_PATH}")
    print(f"  管理口令 : {ADMIN_TOKEN}   (重置: 页面底部 / POST /api/admin/reset)")
    print(f"  同设备限制: {'开' if STRICT_IP else '关'}")
    if DEADLINE_TS:
        print(f"  截止时间 : {datetime.fromtimestamp(DEADLINE_TS)}")
    print("  本地访问 : http://127.0.0.1:8000")
    print("=" * 56)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
