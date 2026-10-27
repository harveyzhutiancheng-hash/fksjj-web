"""Small same-origin WSGI API. Application data must live outside the web root."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from email.utils import formatdate
from http.cookies import CookieError, SimpleCookie
from http import HTTPStatus
from urllib.parse import urlsplit

COOKIE_NAME = "__Host-fkssj_session"
SESSION_SECONDS = 30 * 24 * 60 * 60
MAX_BODY_BYTES = 1024 * 1024
MAX_AUTH_BODY_BYTES = 4096
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**15, 8, 3
SCRYPT_MAXMEM = 64 * 1024 * 1024
DB_VERSION = 1
USERNAME = re.compile(r"[a-zA-Z0-9_]{3,24}\Z", re.ASCII)
SESSION_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}\Z", re.ASCII)
DEFAULT_LIMITS = {
    "login_ip": (30, 600),
    "login_account": (10, 900),
    "register_ip": (5, 3600),
    "register_account": (5, 3600),
}


class ApiError(Exception):
    def __init__(self, status, code, message, *, extra=None, headers=None):
        super().__init__(code)
        self.status, self.code, self.message = status, code, message
        self.extra, self.headers = extra or {}, headers or []


def derive_password(password, salt, *, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
                          maxmem=SCRYPT_MAXMEM, dklen=32)


def _token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _csrf(token):
    # The raw session is available only in its HttpOnly cookie. Derivation lets
    # /me return a stable CSRF token without storing the raw session in SQLite.
    return hmac.new(token.encode("ascii"), b"fkssj-csrf-v1", hashlib.sha256).hexdigest()


def _json_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON member")
        value[key] = item
    return value


def _finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _json_body(environ, maximum):
    if environ.get("CONTENT_TYPE", "").split(";", 1)[0].strip().lower() != "application/json":
        raise ApiError(415, "unsupported_media_type", "请使用 application/json 请求。")
    try:
        raw_length = environ.get("CONTENT_LENGTH", "")
        if not raw_length or not re.fullmatch(r"[0-9]+", raw_length):
            raise ApiError(400, "invalid_json", "请求内容不完整。")
        length = int(raw_length)
    except (TypeError, ValueError):
        raise ApiError(400, "invalid_json", "请求内容不完整。") from None
    if length > maximum:
        raise ApiError(413, "payload_too_large", "请求内容超过大小上限。")
    if length < 1:
        raise ApiError(400, "invalid_json", "请提供 JSON 对象。")
    raw = environ["wsgi.input"].read(length)
    if len(raw) != length:
        raise ApiError(400, "invalid_json", "请求内容不完整。")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_json_pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON")))
    except (UnicodeError, ValueError, RecursionError):
        raise ApiError(400, "invalid_json", "JSON 内容格式不正确。") from None
    if not isinstance(value, dict):
        raise ApiError(400, "invalid_json", "请提供 JSON 对象。")
    return value


def _validate_save(save):
    # Only the stable outer shape is interpreted here. New nested versions,
    # paid input/output snapshots, timestamps and unrecognised fields survive.
    if not isinstance(save, dict) or type(save.get("version")) is not int or save["version"] != 1:
        raise ApiError(400, "invalid_save", "存档版本或内容不正确。")
    for name, kind in (("resources", dict), ("population", dict), ("raft", list),
                       ("buildings", list), ("stats", dict), ("quests", dict)):
        if not isinstance(save.get(name), kind):
            raise ApiError(400, "invalid_save", "存档内容不完整。")
    if not save["raft"] or not save["buildings"]:
        raise ApiError(400, "invalid_save", "存档需要保留营地与设施。")
    if any(not _finite_number(value) or value < 0
           for value in save["resources"].values()):
        raise ApiError(400, "invalid_save", "存档物资数据不正确。")
    pending, count = [(save, 0)], 0
    while pending:
        value, depth = pending.pop()
        count += 1
        if depth > 64 or count > 100_000:
            raise ApiError(400, "invalid_save", "存档结构过于复杂。")
        if isinstance(value, dict):
            try:
                for key in value:
                    key.encode("utf-8")
            except UnicodeError:
                raise ApiError(400, "invalid_save", "存档包含无效文字。") from None
            pending.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            pending.extend((item, depth + 1) for item in value)
        elif isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeError:
                raise ApiError(400, "invalid_save", "存档包含无效文字。") from None
        elif type(value) in (int, float) and not _finite_number(value):
            raise ApiError(400, "invalid_save", "存档不能包含无效数值。")
    for name in ("savedAt", "elapsed"):
        if name in save and (not _finite_number(save[name]) or save[name] < 0):
            raise ApiError(400, "invalid_save", "存档时间数据不正确。")


def _public_origin(value):
    try:
        parts = urlsplit(value)
        valid = (parts.scheme in ("https", "http") and parts.hostname and
                 parts.username is None and parts.password is None and
                 parts.path in ("", "/") and not parts.query and not parts.fragment)
        parts.port  # Validate an explicit port, if present.
        if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
            valid = False
        if not valid:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError("FKSSJ_PUBLIC_ORIGIN must be one HTTPS origin or an explicit localhost HTTP origin") from None
    return value.rstrip("/")


class Application:
    def __init__(self, data_dir, public_origin, *, now=time.time, rate_limits=None, auth_concurrency=2):
        if not data_dir:
            raise ValueError("FKSSJ_DATA_DIR is required")
        requested = Path(data_dir).expanduser()
        if not requested.is_absolute():
            raise ValueError("FKSSJ_DATA_DIR must be absolute")
        self.data_dir = requested.resolve()
        web_root = Path(os.environ.get("FKSSJ_WEB_ROOT", str(Path(__file__).resolve().parent.parent))).resolve()
        if self.data_dir == web_root or web_root in self.data_dir.parents:
            raise ValueError("FKSSJ_DATA_DIR must be outside the web root")
        self.public_origin = _public_origin(public_origin)
        self.now = now
        self.rate_limits = {**DEFAULT_LIMITS, **(rate_limits or {})}
        if any(not isinstance(rule, (tuple, list)) or len(rule) != 2 or
               type(rule[0]) is not int or rule[0] < 1 or rule[1] <= 0 for rule in self.rate_limits.values()):
            raise ValueError("Invalid rate limit configuration")
        if type(auth_concurrency) is not int or not 1 <= auth_concurrency <= 4:
            raise ValueError("auth_concurrency must be between one and four")
        self.auth_concurrency = auth_concurrency
        self.trusted_proxies = {ipaddress.ip_address(value.strip()) for value in os.environ.get("FKSSJ_TRUSTED_PROXIES", "").split(",") if value.strip()}
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.data_dir, 0o700)
        self.database_path = self.data_dir / "fkssj.sqlite3"
        # Create the database with private mode before SQLite creates its WAL.
        try:
            descriptor = os.open(self.database_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if self.database_path.is_symlink() or not self.database_path.is_file():
                raise ValueError("Invalid database file") from None
        else:
            os.close(descriptor)
        os.chmod(self.database_path, 0o600)
        self._initialize_database()

    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def _transaction(self, *, write=False):
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize_database(self):
        connection = self._connect()
        try:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > DB_VERSION:
                raise ValueError("Database version is newer than this API; no data was changed")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("BEGIN IMMEDIATE")
            # A newer worker may have migrated after our first read. Recheck
            # under the same write lock as all DDL and the version marker.
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > DB_VERSION:
                raise ValueError("Database version is newer than this API; no data was changed")
            schema = """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL,
                    scrypt_n INTEGER NOT NULL,
                    scrypt_r INTEGER NOT NULL,
                    scrypt_p INTEGER NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS cloud_saves (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL CHECK (revision >= 1),
                    save_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS save_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL,
                    save_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    replaced_at INTEGER NOT NULL,
                    UNIQUE(user_id, revision)
                );
                CREATE TABLE IF NOT EXISTS rate_limits (
                    scope TEXT NOT NULL,
                    key_hash TEXT NOT NULL,
                    window_started REAL NOT NULL,
                    hits INTEGER NOT NULL,
                    PRIMARY KEY (scope, key_hash)
                );
                CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(window_started);
                CREATE TABLE IF NOT EXISTS auth_leases (
                    token TEXT PRIMARY KEY,
                    expires_at REAL NOT NULL
                );
            """
            # This is static SQL with no embedded/user-provided semicolons.
            # executescript() is deliberately avoided: it commits an existing
            # transaction before running its script.
            for statement in schema.split(";"):
                if statement.strip():
                    connection.execute(statement)
            connection.execute(f"PRAGMA user_version = {DB_VERSION}")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _origin(self, environ):
        if environ.get("HTTP_ORIGIN") != self.public_origin:
            raise ApiError(403, "origin_invalid", "请求来源不正确，请从游戏页面操作。")

    def _client_ip(self, environ):
        value = environ.get("REMOTE_ADDR", "unknown")
        try:
            address = ipaddress.ip_address(value)
            if address in self.trusted_proxies:
                forwarded = environ.get("HTTP_X_REAL_IP", "")
                if forwarded:
                    address = ipaddress.ip_address(forwarded)
            return str(address)
        except ValueError:
            return "unknown"

    def _credentials(self, environ):
        value = _json_body(environ, MAX_AUTH_BODY_BYTES)
        username, password = value.get("username"), value.get("password")
        if not isinstance(username, str) or USERNAME.fullmatch(username) is None or not isinstance(password, str) or not 8 <= len(password) <= 128:
            raise ApiError(400, "invalid_credentials_input", "用户名需为3至24位字母、数字或下划线，密码需为8至128个字符。")
        try:
            password.encode("utf-8")
        except UnicodeError:
            raise ApiError(400, "invalid_credentials_input", "密码含有无效字符。") from None
        return username.lower(), password

    def _rate_limit(self, environ, action, username):
        now = self.now()
        keys = [(action + "_ip", self._client_ip(environ)), (action + "_account", username)]
        ip_scope, ip_value = keys[0]
        ip_key = hashlib.sha256(ip_value.encode("utf-8")).hexdigest()
        ip_limit, ip_window = self.rate_limits[ip_scope]
        # A blocked source cannot manufacture new per-account keys or contend
        # for SQLite's write lock by changing usernames. The write transaction
        # below repeats this check so parallel accepted attempts stay bounded.
        with self._transaction() as connection:
            ip_row = connection.execute("SELECT window_started,hits FROM rate_limits WHERE scope=? AND key_hash=?", (ip_scope, ip_key)).fetchone()
        if ip_row and 0 <= now - ip_row["window_started"] < ip_window and ip_row["hits"] >= ip_limit:
            retry = max(1, math.ceil(ip_row["window_started"] + ip_window - now))
            raise ApiError(429, "rate_limited", "尝试次数较多，请稍后再试。", headers=[("Retry-After", str(retry))])
        retry = 0
        with self._transaction(write=True) as connection:
            connection.execute("DELETE FROM rate_limits WHERE window_started < ?", (now - 86400,))
            for scope, raw_key in keys:
                limit, window = self.rate_limits[scope]
                key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
                row = connection.execute("SELECT window_started, hits FROM rate_limits WHERE scope=? AND key_hash=?", (scope, key)).fetchone()
                start, hits = (row["window_started"], row["hits"]) if row and 0 <= now - row["window_started"] < window else (now, 0)
                if hits >= limit:
                    retry = max(retry, max(1, math.ceil(start + window - now)))
                    break
                connection.execute("INSERT INTO rate_limits(scope,key_hash,window_started,hits) VALUES(?,?,?,?) ON CONFLICT(scope,key_hash) DO UPDATE SET window_started=excluded.window_started,hits=excluded.hits", (scope, key, start, hits + 1))
        if retry:
            raise ApiError(429, "rate_limited", "尝试次数较多，请稍后再试。", headers=[("Retry-After", str(retry))])

    @contextmanager
    def _auth_slot(self):
        token, now = secrets.token_urlsafe(24), self.now()
        with self._transaction(write=True) as connection:
            connection.execute("DELETE FROM auth_leases WHERE expires_at <= ?", (now,))
            if connection.execute("SELECT COUNT(*) FROM auth_leases").fetchone()[0] >= self.auth_concurrency:
                raise ApiError(429, "auth_busy", "登录服务正忙，请稍后再试。", headers=[("Retry-After", "2")])
            connection.execute("INSERT INTO auth_leases(token,expires_at) VALUES(?,?)", (token, now + 120))
        try:
            yield
        finally:
            with self._transaction(write=True) as connection:
                connection.execute("DELETE FROM auth_leases WHERE token=?", (token,))

    def _cookie_token(self, environ):
        try:
            cookie = SimpleCookie()
            cookie.load(environ.get("HTTP_COOKIE", ""))
            token = cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else None
        except CookieError:
            return None
        return token if token and SESSION_TOKEN.fullmatch(token) else None

    def _session(self, connection, environ, *, required=True):
        token = self._cookie_token(environ)
        row = connection.execute("SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > ?", (_token_hash(token), self.now())).fetchone() if token else None
        if row is None:
            if required:
                raise ApiError(401, "authentication_required", "请先登录账号。")
            return None
        return {"user": {"id": row["id"], "username": row["username"]}, "token": token}

    def _check_csrf(self, environ, session):
        supplied = environ.get("HTTP_X_CSRF_TOKEN", "")
        if not isinstance(supplied, str) or not re.fullmatch(r"[0-9a-f]{64}", supplied) or not hmac.compare_digest(supplied, _csrf(session["token"])):
            raise ApiError(403, "csrf_invalid", "操作校验已失效，请刷新页面后重试。")

    def _set_cookie(self, token=None):
        cookie = SimpleCookie()
        cookie[COOKIE_NAME] = token or ""
        item = cookie[COOKIE_NAME]
        item["path"], item["secure"], item["httponly"], item["samesite"] = "/", True, True, "Lax"
        item["max-age"] = SESSION_SECONDS if token else 0
        item["expires"] = formatdate(self.now() + SESSION_SECONDS if token else 0, usegmt=True)
        return ("Set-Cookie", item.OutputString())

    def _new_session(self, connection, environ, user_id):
        previous, token, now = self._cookie_token(environ), secrets.token_urlsafe(32), self.now()
        if previous:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(previous),))
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        connection.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)", (_token_hash(token), user_id, now, now + SESSION_SECONDS))
        return token

    def _authenticate(self, environ, action):
        self._origin(environ)
        username, password = self._credentials(environ)
        self._rate_limit(environ, action, username)
        with self._auth_slot():
            if action == "register":
                salt = secrets.token_bytes(32)
                password_hash = derive_password(password, salt)
                try:
                    with self._transaction(write=True) as connection:
                        cursor = connection.execute("INSERT INTO users(username,password_salt,password_hash,scrypt_n,scrypt_r,scrypt_p,created_at) VALUES(?,?,?,?,?,?,?)", (username, salt, password_hash, SCRYPT_N, SCRYPT_R, SCRYPT_P, self.now()))
                        user = {"id": cursor.lastrowid, "username": username}
                        token = self._new_session(connection, environ, user["id"])
                except sqlite3.IntegrityError:
                    raise ApiError(409, "username_taken", "这个用户名已被使用。") from None
            else:
                with self._transaction() as connection:
                    row = connection.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
                # Unknown accounts pay the same fixed scrypt cost as wrong
                # passwords. Nothing in a request can choose the cost factors.
                salt = bytes(row["password_salt"]) if row else b"fkssj-dummy-salt-v1-32-bytes....."
                candidate = derive_password(password, salt)
                expected = bytes(row["password_hash"]) if row else b"\0" * 32
                if not hmac.compare_digest(candidate, expected) or row is None:
                    raise ApiError(401, "invalid_credentials", "用户名或密码不正确。")
                user = {"id": row["id"], "username": row["username"]}
                with self._transaction(write=True) as connection:
                    token = self._new_session(connection, environ, user["id"])
        return 200, {"user": user, "csrfToken": _csrf(token)}, [self._set_cookie(token)]

    def _me(self, environ):
        with self._transaction() as connection:
            session = self._session(connection, environ, required=False)
        return 200, {"user": session["user"], "csrfToken": _csrf(session["token"])} if session else {"user": None}, []

    def _logout(self, environ):
        self._origin(environ)
        with self._transaction(write=True) as connection:
            session = self._session(connection, environ, required=False)
            if session:
                self._check_csrf(environ, session)
                connection.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(session["token"]),))
        return 200, {"ok": True}, [self._set_cookie()]

    def _save_get(self, environ):
        with self._transaction() as connection:
            session = self._session(connection, environ)
            user_id = session["user"]["id"]
            # A shared browser cookie may have changed since this page bound
            # its local save. Reject that stale page before reading another
            # account's cloud snapshot, using the same transaction as auth.
            if environ.get("HTTP_X_FKSSJ_USER") != str(user_id):
                raise ApiError(403, "user_mismatch", "当前账号已经变化，请重新载入账号存档。")
            row = connection.execute("SELECT revision,save_json,updated_at FROM cloud_saves WHERE user_id=?", (user_id,)).fetchone()
        return 200, {"revision": row["revision"], "save": json.loads(row["save_json"]), "updatedAt": row["updated_at"]} if row else {"revision": 0, "save": None, "updatedAt": None}, []

    def _save_put(self, environ):
        self._origin(environ)
        value = _json_body(environ, MAX_BODY_BYTES)
        revision, save = value.get("expectedRevision"), value.get("save")
        if type(revision) is not int or not 0 <= revision <= 9_007_199_254_740_991:
            raise ApiError(400, "invalid_revision", "存档修订号不正确。")
        _validate_save(save)
        encoded = json.dumps(save, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        with self._transaction(write=True) as connection:
            # Auth, CSRF, owner binding, revision comparison and write all use
            # this single transaction. A concurrent logout or CAS cannot race.
            session = self._session(connection, environ)
            self._check_csrf(environ, session)
            user_id = session["user"]["id"]
            if environ.get("HTTP_X_FKSSJ_USER") != str(user_id):
                raise ApiError(403, "user_mismatch", "当前账号已经变化，请重新载入账号存档。")
            current = connection.execute("SELECT revision,save_json,updated_at FROM cloud_saves WHERE user_id=?", (user_id,)).fetchone()
            current_revision = current["revision"] if current else 0
            if revision != current_revision:
                raise ApiError(409, "save_conflict", "云端已有更新的进度，请先选择要保留的存档。", extra={"revision": current_revision, "updatedAt": current["updated_at"] if current else None})
            updated_at = int(self.now() * 1000)
            next_revision = current_revision + 1
            if current:
                connection.execute("INSERT INTO save_history(user_id,revision,save_json,updated_at,replaced_at) VALUES(?,?,?,?,?)", (user_id, current_revision, current["save_json"], current["updated_at"], updated_at))
                connection.execute("UPDATE cloud_saves SET revision=?,save_json=?,updated_at=? WHERE user_id=? AND revision=?", (next_revision, encoded, updated_at, user_id, current_revision))
                connection.execute("DELETE FROM save_history WHERE user_id=? AND id NOT IN (SELECT id FROM save_history WHERE user_id=? ORDER BY revision DESC LIMIT 10)", (user_id, user_id))
            else:
                connection.execute("INSERT INTO cloud_saves(user_id,revision,save_json,updated_at) VALUES(?,?,?,?)", (user_id, next_revision, encoded, updated_at))
        return 200, {"revision": next_revision, "updatedAt": updated_at}, []

    def __call__(self, environ, start_response):
        try:
            route = environ.get("PATH_INFO", "")
            method = environ.get("REQUEST_METHOD", "GET").upper()
            allowed = {"/api/health": "GET", "/api/auth/me": "GET", "/api/auth/register": "POST", "/api/auth/login": "POST", "/api/auth/logout": "POST", "/api/save": "GET, PUT"}
            if route not in allowed:
                raise ApiError(404, "not_found", "没有这个接口。")
            if method not in allowed[route].split(", "):
                raise ApiError(405, "method_not_allowed", "不支持这种请求方式。", headers=[("Allow", allowed[route])])
            if route == "/api/health":
                with self._transaction() as connection:
                    connection.execute("SELECT id FROM users LIMIT 1").fetchone()
                result = (200, {"ok": True}, [])
            elif route == "/api/auth/me":
                result = self._me(environ)
            elif route in ("/api/auth/register", "/api/auth/login"):
                result = self._authenticate(environ, route.rsplit("/", 1)[1])
            elif route == "/api/auth/logout":
                result = self._logout(environ)
            elif method == "GET":
                result = self._save_get(environ)
            else:
                result = self._save_put(environ)
        except ApiError as error:
            result = error.status, {"code": error.code, "message": error.message, **error.extra}, error.headers
        except (sqlite3.Error, OSError):
            result = 503, {"code": "service_unavailable", "message": "账号服务暂时繁忙，请稍后重试。"}, [("Retry-After", "2")]
        except Exception:
            # Responses never expose SQL, credentials, filesystem paths or
            # tracebacks. The process manager can log unexpected exceptions.
            result = 500, {"code": "internal_error", "message": "操作暂时未完成，请稍后重试。"}, []
        status, payload, extra_headers = result
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        headers = [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), *extra_headers]
        start_response(f"{status} {HTTPStatus(status).phrase}", headers)
        return [body]


def create_app(data_dir=None, public_origin=None, *, now=time.time, rate_limits=None, auth_concurrency=2):
    return Application(data_dir or os.environ.get("FKSSJ_DATA_DIR"), public_origin or os.environ.get("FKSSJ_PUBLIC_ORIGIN"), now=now, rate_limits=rate_limits, auth_concurrency=auth_concurrency)
