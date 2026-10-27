"""API contract and persistence tests using real, in-process WSGI requests.

Run from the repository root with ``python3 -m unittest api.test_api -v``.
Every test uses a temporary database outside the public project directory.
Password derivation uses the production scrypt configuration throughout.
"""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from http.cookies import SimpleCookie
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from wsgiref.util import setup_testing_defaults

try:
    from . import app as api_module
except ImportError:  # Also support unittest discovery with ``-s api``.
    import app as api_module


ORIGIN = "https://fkssj.example"
COOKIE_NAME = "__Host-fkssj_session"
SESSION_SECONDS = 2_592_000
MAX_PAYLOAD_BYTES = 1_048_576
PASSWORD = "correct-horse-fkssj-42"
HIGH_LIMITS = {
    key: (1_000, 60)
    for key in ("login_ip", "login_account", "register_ip", "register_account")
}
_AUTO = object()


def minimal_save(wood=1):
    return {
        "version": 1,
        "savedAt": 123456,
        "elapsed": 0,
        "resources": {"wood": wood},
        "population": {"total": 1},
        "raft": [{"x": 0, "z": 0}],
        "buildings": [
            {"id": "command", "type": "command", "x": 0, "z": 0, "level": 1}
        ],
        "stats": {},
        "quests": {"claimed": []},
        "production": {"version": 6, "queue": []},
    }


def encode_json(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class Clock:
    def __init__(self):
        self.value = 1_800_000_000.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class Response:
    def __init__(self, status, headers, body):
        self.status = int(status.split(" ", 1)[0])
        self.headers = headers
        self.body = body
        self.data = json.loads(body) if body else None

    def header(self, name):
        return next(
            (value for key, value in self.headers if key.lower() == name.lower()), None
        )


class Client:
    def __init__(self, application, origin=ORIGIN):
        self.app = application
        self.origin = origin
        self.cookies = {}
        self.csrf = None
        self.user_id = None

    def clone(self, application=None):
        result = Client(application or self.app, self.origin)
        result.cookies = self.cookies.copy()
        result.csrf = self.csrf
        result.user_id = self.user_id
        return result

    def request(
        self,
        method,
        path,
        *,
        json_body=_AUTO,
        raw=None,
        origin=_AUTO,
        csrf=_AUTO,
        owner=_AUTO,
        content_type=_AUTO,
        remote_addr="192.0.2.10",
        headers=None,
    ):
        if raw is not None and json_body is not _AUTO:
            raise ValueError("Choose a raw body or a JSON body, not both")
        body = raw if raw is not None else (
            b"" if json_body is _AUTO else encode_json(json_body)
        )
        environ = {}
        setup_testing_defaults(environ)
        environ.update(
            REQUEST_METHOD=method,
            PATH_INFO=path,
            QUERY_STRING="",
            SERVER_NAME="fkssj.example",
            SERVER_PORT="443",
            REMOTE_ADDR=remote_addr,
            CONTENT_LENGTH=str(len(body)),
        )
        environ["wsgi.url_scheme"] = "https"
        environ["wsgi.input"] = io.BytesIO(body)
        environ["wsgi.errors"] = io.StringIO()
        environ["wsgi.multithread"] = True
        environ["wsgi.multiprocess"] = True
        request_headers = {}
        writing = method in ("POST", "PUT", "PATCH", "DELETE")
        actual_origin = self.origin if origin is _AUTO and writing else origin
        if actual_origin is not _AUTO and actual_origin is not None:
            request_headers["Origin"] = actual_origin
        actual_csrf = self.csrf if csrf is _AUTO and writing else csrf
        if actual_csrf is not _AUTO and actual_csrf is not None:
            request_headers["X-CSRF-Token"] = actual_csrf
        save_request = path == "/api/save" and method in ("GET", "PUT")
        actual_owner = self.user_id if owner is _AUTO and save_request else owner
        if actual_owner is not _AUTO and actual_owner is not None:
            request_headers["X-FKSSJ-User"] = str(actual_owner)
        if self.cookies:
            request_headers["Cookie"] = "; ".join(
                f"{name}={value}" for name, value in self.cookies.items()
            )
        if content_type is _AUTO:
            content_type = "application/json" if raw is not None or json_body is not _AUTO else None
        if content_type is not None:
            environ["CONTENT_TYPE"] = content_type
        for name, value in (headers or {}).items():
            if value is None:
                request_headers.pop(name, None)
            else:
                request_headers[name] = value
        for name, value in request_headers.items():
            environ["HTTP_" + name.upper().replace("-", "_")] = str(value)
        captured = {}

        def start_response(status, response_headers, exc_info=None):
            captured["status"] = status
            captured["headers"] = list(response_headers)

        iterable = self.app(environ, start_response)
        try:
            response_body = b"".join(iterable)
            response = Response(captured["status"], captured["headers"], response_body)
        finally:
            if hasattr(iterable, "close"):
                iterable.close()
        for name, value in response.headers:
            if name.lower() != "set-cookie":
                continue
            cookies = SimpleCookie()
            cookies.load(value)
            for cookie_name, morsel in cookies.items():
                if morsel["max-age"] == "0":
                    self.cookies.pop(cookie_name, None)
                else:
                    self.cookies[cookie_name] = morsel.value
        if response.status in (200, 201) and isinstance(response.data, dict):
            if isinstance(response.data.get("user"), dict):
                self.user_id = response.data["user"]["id"]
            if isinstance(response.data.get("csrfToken"), str):
                self.csrf = response.data["csrfToken"]
        return response


class APITestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fkssj-api-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.data_dir = Path(self.temporary.name) / "private-data"
        self.clock = Clock()
        self.app = self.make_app()
        self.client = Client(self.app)

    def make_app(self, *, rate_limits=None, auth_concurrency=2):
        limits = dict(HIGH_LIMITS)
        limits.update(rate_limits or {})
        return api_module.create_app(
            data_dir=str(self.data_dir),
            public_origin=ORIGIN,
            now=self.clock,
            rate_limits=limits,
            auth_concurrency=auth_concurrency,
        )

    def assert_security_headers(self, response):
        self.assertIn("no-store", response.header("Cache-Control") or "")
        self.assertEqual(response.header("X-Content-Type-Options"), "nosniff")
        self.assertTrue((response.header("Content-Type") or "").startswith("application/json"))
        self.assertFalse(
            any(name.lower().startswith("access-control-") for name, _ in response.headers)
        )

    def assert_status(self, response, status):
        self.assertEqual(response.status, status, response.data)
        self.assert_security_headers(response)
        return response.data

    def assert_error(self, response, status, code):
        data = self.assert_status(response, status)
        self.assertEqual(data["code"], code)
        self.assertIsInstance(data["message"], str)
        self.assertTrue(data["message"])
        return data

    def register(self, username="alice", *, client=None, remote_addr="192.0.2.10"):
        client = client or self.client
        response = client.request(
            "POST", "/api/auth/register",
            json_body={"username": username, "password": PASSWORD},
            remote_addr=remote_addr,
        )
        data = self.assert_status(response, 200)
        self.assertEqual(set(data), {"user", "csrfToken"})
        self.assertEqual(data["user"]["username"], username)
        self.assertIs(type(data["user"]["id"]), int)
        self.assertIsInstance(data["csrfToken"], str)
        self.assertTrue(data["csrfToken"])
        return response

    def upload(self, save=None, revision=0, *, client=None, **kwargs):
        return (client or self.client).request(
            "PUT", "/api/save",
            json_body={"expectedRevision": revision, "save": minimal_save() if save is None else save},
            **kwargs,
        )

    def history_for(self, user_id):
        with sqlite3.connect(self.app.database_path) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                "SELECT user_id,revision,save_json,updated_at,replaced_at "
                "FROM save_history WHERE user_id=? ORDER BY revision",
                (user_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def test_routes_anonymous_contract_and_method_errors(self):
        me = self.assert_status(self.client.request("GET", "/api/auth/me"), 200)
        self.assertEqual(me, {"user": None})
        self.assert_error(self.client.request("GET", "/api/save"), 401, "authentication_required")
        self.assert_error(self.upload(), 401, "authentication_required")
        self.assert_status(self.client.request("GET", "/api/does-not-exist"), 404)
        for method, path in (
            ("GET", "/api/auth/register"),
            ("GET", "/api/auth/login"),
            ("GET", "/api/auth/logout"),
            ("POST", "/api/auth/me"),
            ("POST", "/api/save"),
            ("DELETE", "/api/save"),
        ):
            with self.subTest(method=method, path=path):
                self.assert_status(self.client.request(method, path, json_body={}), 405)

    def test_register_login_cookie_and_server_side_logout(self):
        registered = self.register()
        cookies = SimpleCookie()
        cookies.load(registered.header("Set-Cookie"))
        cookie = cookies[COOKIE_NAME]
        self.assertTrue(cookie["secure"])
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"].lower(), "lax")
        self.assertEqual(cookie["path"], "/")
        self.assertEqual(cookie["domain"], "")
        self.assertEqual(int(cookie["max-age"]), SESSION_SECONDS)
        user = registered.data["user"]
        self.assertEqual(
            self.assert_status(self.client.request("GET", "/api/auth/me"), 200),
            {"user": user, "csrfToken": self.client.csrf},
        )
        old_token = self.client.cookies[COOKIE_NAME]
        login = self.client.request(
            "POST", "/api/auth/login", json_body={"username": "alice", "password": PASSWORD}
        )
        self.assertEqual(self.assert_status(login, 200)["user"], user)
        self.assertNotEqual(self.client.cookies[COOKIE_NAME], old_token)
        replay = self.client.clone()
        self.assert_status(self.client.request("POST", "/api/auth/logout", json_body={}), 200)
        self.assertNotIn(COOKIE_NAME, self.client.cookies)
        self.assertEqual(self.assert_status(replay.request("GET", "/api/auth/me"), 200), {"user": None})
        self.assert_error(replay.request("GET", "/api/save"), 401, "authentication_required")
        self.assert_error(self.upload(client=replay), 401, "authentication_required")
        self.assert_status(self.client.request("POST", "/api/auth/logout", raw=b"", content_type=None), 200)

    def test_bad_credentials_duplicate_registration_and_input_validation(self):
        self.register()
        anonymous = Client(self.app)
        duplicate = anonymous.request(
            "POST", "/api/auth/register", json_body={"username": "alice", "password": PASSWORD}
        )
        self.assert_error(duplicate, 409, "username_taken")
        messages = []
        for username in ("alice", "unknown_user"):
            response = anonymous.request(
                "POST", "/api/auth/login", json_body={"username": username, "password": "wrong-password"}
            )
            messages.append(self.assert_error(response, 401, "invalid_credentials")["message"])
            self.assertIsNone(response.header("Set-Cookie"))
        self.assertEqual(messages[0], messages[1])
        for endpoint in ("register", "login"):
            for payload in (
                {}, {"username": [], "password": PASSWORD},
                {"username": "bad/name", "password": PASSWORD},
                {"username": "valid_user", "password": []},
                {"username": "valid_user", "password": ""},
                {"username": "valid_user", "password": "x" * 1025},
            ):
                with self.subTest(endpoint=endpoint, payload=repr(payload)[:80]):
                    self.assert_error(
                        anonymous.request("POST", f"/api/auth/{endpoint}", json_body=payload),
                        400, "invalid_credentials_input",
                    )

    def test_exact_origin_is_required_for_every_write(self):
        self.register()
        original = self.client.cookies.copy()
        for origin in (None, "null", "https://foreign.example", ORIGIN + ".evil", ORIGIN + "/"):
            for method, path, payload in (
                ("POST", "/api/auth/register", {"username": "new_user", "password": PASSWORD}),
                ("POST", "/api/auth/login", {"username": "alice", "password": PASSWORD}),
                ("POST", "/api/auth/logout", {}),
                ("PUT", "/api/save", {"expectedRevision": 0, "save": minimal_save()}),
            ):
                with self.subTest(origin=origin, path=path):
                    self.assert_error(
                        self.client.request(method, path, json_body=payload, origin=origin),
                        403, "origin_invalid",
                    )
        self.assertEqual(self.client.cookies, original)
        self.assertEqual(self.client.request("GET", "/api/save").data["revision"], 0)

    def test_json_media_type_and_malformed_json(self):
        self.register()
        for content_type in (None, "text/plain", "application/x-www-form-urlencoded"):
            for method, path, payload in (
                ("POST", "/api/auth/register", {"username": "new_user", "password": PASSWORD}),
                ("POST", "/api/auth/login", {"username": "alice", "password": PASSWORD}),
                ("PUT", "/api/save", {"expectedRevision": 0, "save": minimal_save()}),
            ):
                with self.subTest(content_type=content_type, path=path):
                    self.assert_error(
                        self.client.request(method, path, raw=encode_json(payload), content_type=content_type),
                        415, "unsupported_media_type",
                    )
        for raw in (
            b"{", b"", b"[]", b"null",
            b'{"expectedRevision":NaN,"save":{}}',
            b'{"expectedRevision":Infinity,"save":{}}',
            b'{"expectedRevision":0,"expectedRevision":1,"save":{}}',
        ):
            with self.subTest(raw=raw):
                response = self.client.request("PUT", "/api/save", raw=raw, content_type="application/json")
                self.assert_status(response, 400)
                self.assertIn("code", response.data)
                self.assertIn("message", response.data)

    def test_csrf_and_owner_checks_do_not_mutate_save_or_logout(self):
        self.register()
        for csrf in (None, "forged-token"):
            self.assert_error(self.upload(csrf=csrf), 403, "csrf_invalid")
            self.assert_error(
                self.client.request("POST", "/api/auth/logout", json_body={}, csrf=csrf),
                403, "csrf_invalid",
            )
        for owner in (None, self.client.user_id + 1, "not-an-id"):
            with self.subTest(owner=owner):
                self.assert_error(self.upload(owner=owner), 403, "user_mismatch")
        self.assertEqual(self.client.request("GET", "/api/save").data, {"revision": 0, "save": None, "updatedAt": None})
        self.assertEqual(self.client.request("GET", "/api/auth/me").data["user"]["username"], "alice")
        self.assert_status(self.upload(), 200)

    def test_account_isolation_and_paid_snapshots_round_trip_without_normalization(self):
        self.register()
        other = Client(self.app)
        self.register("bob", client=other)
        snapshot = minimal_save(37)
        snapshot["production"]["queue"] = [{
            "id": "already-paid", "recipeId": "dailyGoods", "buildingId": "historic-station",
            "name": "旧已付批次", "quantity": 2, "inputs": {"scrap": 20},
            "outputs": {"dailyGoods": 2}, "duration": 300, "remaining": 12.25,
            "status": "running", "unknownSnapshotField": {"preserve": True},
        }]
        snapshot["opaqueFutureData"] = {"array": [1, "kept", {"x": None}]}
        result = self.assert_status(self.upload(snapshot), 200)
        self.assertEqual(result["revision"], 1)
        self.assertEqual(self.client.request("GET", "/api/save").data["save"], snapshot)
        self.assertEqual(other.request("GET", "/api/save").data, {"revision": 0, "save": None, "updatedAt": None})
        self.assert_error(self.upload(snapshot, client=other, owner=self.client.user_id), 403, "user_mismatch")
        self.assert_status(self.upload(minimal_save(99), client=other), 200)
        self.assertEqual(other.request("GET", "/api/save").data["save"]["resources"]["wood"], 99)
        self.assertEqual(self.client.request("GET", "/api/save").data["save"], snapshot)

    def test_save_get_requires_an_exact_identity_header_even_when_cloud_is_empty(self):
        self.register()
        own_id = self.client.user_id
        for owner in (None, "", own_id + 1, "not-an-id", f"0{own_id}", f" {own_id}", f"{own_id} "):
            with self.subTest(owner=owner):
                data = self.assert_error(
                    self.client.request("GET", "/api/save", owner=owner),
                    403, "user_mismatch",
                )
                self.assertEqual(set(data), {"code", "message"})
        self.assertEqual(
            self.assert_status(self.client.request("GET", "/api/save"), 200),
            {"revision": 0, "save": None, "updatedAt": None},
        )

    def test_stale_identity_header_with_another_cookie_does_not_disclose_or_change_either_save(self):
        self.register()
        self.assert_status(self.upload(minimal_save(11)), 200)
        self.assert_status(self.upload(minimal_save(12), 1), 200)
        other = Client(self.app)
        self.register("bob", client=other)
        self.assert_status(self.upload(minimal_save(91), client=other), 200)
        before_a = self.client.request("GET", "/api/save").data
        before_b = other.request("GET", "/api/save").data
        history_a, history_b = self.history_for(self.client.user_id), self.history_for(other.user_id)

        # The transport now sends B's cookie, while an old A page still sends
        # A's captured identity. Neither A nor B may be returned in this error.
        stale_page = self.client.clone()
        stale_page.cookies = other.cookies.copy()
        denied = self.assert_error(stale_page.request("GET", "/api/save"), 403, "user_mismatch")
        self.assertEqual(set(denied), {"code", "message"})
        self.assertEqual(self.assert_status(other.request("GET", "/api/save"), 200), before_b)
        self.assertEqual(self.assert_status(self.client.request("GET", "/api/save"), 200), before_a)
        self.assertEqual(self.history_for(self.client.user_id), history_a)
        self.assertEqual(self.history_for(other.user_id), history_b)

    def test_compare_and_swap_conflict_preserves_authoritative_data(self):
        self.register()
        initial = self.assert_status(self.client.request("GET", "/api/save"), 200)
        self.assertEqual(initial, {"revision": 0, "save": None, "updatedAt": None})
        saved = self.assert_status(self.upload(minimal_save(12)), 200)
        self.assertEqual(saved["revision"], 1)
        self.assertIs(type(saved["updatedAt"]), int)
        self.assertEqual(saved["updatedAt"], int(self.clock() * 1000))
        conflict = self.assert_error(self.upload(minimal_save(99)), 409, "save_conflict")
        self.assertEqual(conflict["revision"], 1)
        self.assertEqual(conflict["updatedAt"], saved["updatedAt"])
        self.assertEqual(self.client.request("GET", "/api/save").data["save"], minimal_save(12))
        next_save = self.assert_status(self.upload(minimal_save(22), 1), 200)
        self.assertEqual(next_save["revision"], 2)

    def concurrent_uploads(self, *, expected_revision):
        count = 6
        barrier = threading.Barrier(count)
        history_before = self.history_for(self.client.user_id)

        def write(index):
            client = self.client.clone()
            barrier.wait(timeout=10)
            return index, self.upload(minimal_save(100 + index), expected_revision, client=client)

        with ThreadPoolExecutor(max_workers=count) as executor:
            futures = [executor.submit(write, index) for index in range(count)]
            results = [future.result(timeout=20) for future in futures]
        winners = [(index, response) for index, response in results if response.status == 200]
        self.assertEqual(len(winners), 1, [(index, response.status, response.data) for index, response in results])
        for index, response in results:
            if response.status == 200:
                self.assert_status(response, 200)
            else:
                data = self.assert_error(response, 409, "save_conflict")
                self.assertEqual(data["revision"], expected_revision + 1)
        authoritative = self.assert_status(self.client.request("GET", "/api/save"), 200)
        self.assertEqual(authoritative["revision"], expected_revision + 1)
        self.assertEqual(authoritative["save"], minimal_save(100 + winners[0][0]))
        self.assertEqual(authoritative["updatedAt"], winners[0][1].data["updatedAt"])
        history_after = self.history_for(self.client.user_id)
        if expected_revision:
            self.assertEqual(len(history_after), len(history_before) + 1)
            self.assertEqual(history_after[-1]["revision"], expected_revision)
        else:
            self.assertEqual(history_after, history_before)

    def test_threaded_cas_existing_save_has_exactly_one_winner(self):
        self.register()
        self.assert_status(self.upload(), 200)
        self.concurrent_uploads(expected_revision=1)

    def test_threaded_cas_first_save_has_exactly_one_winner(self):
        self.register()
        self.concurrent_uploads(expected_revision=0)

    def test_invalid_revisions_leave_save_unchanged(self):
        self.register()
        self.assert_status(self.upload(minimal_save(12)), 200)
        before = self.client.request("GET", "/api/save").data
        for revision in (None, -1, True, False, 1.5, "1", [], {}):
            with self.subTest(revision=revision):
                self.assert_error(self.upload(minimal_save(99), revision), 400, "invalid_revision")
        self.assert_error(
            self.client.request("PUT", "/api/save", json_body={"save": minimal_save(99)}),
            400, "invalid_revision",
        )
        self.assertEqual(self.client.request("GET", "/api/save").data, before)

    def test_invalid_save_shapes_versions_and_nonfinite_numbers_are_rejected(self):
        self.register()
        self.assert_status(self.upload(minimal_save(12)), 200)
        before = self.client.request("GET", "/api/save").data
        invalid = [None, [], "save", {}]
        for key, value in (
            ("version", 2), ("version", True), ("resources", []),
            ("population", []), ("raft", {}), ("buildings", {}),
            ("stats", []), ("quests", []),
        ):
            snapshot = minimal_save()
            snapshot[key] = value
            invalid.append(snapshot)
        snapshot = minimal_save()
        snapshot["opaqueFutureData"] = {"nested": [{"bad": 10**1000}]}
        invalid.append(snapshot)
        for snapshot in invalid:
            with self.subTest(snapshot=repr(snapshot)[:100]):
                response = self.client.request(
                    "PUT", "/api/save", json_body={"expectedRevision": 1, "save": snapshot}
                )
                self.assert_error(response, 400, "invalid_save")
        for numeric_literal in (b"1e309", b"-1e309"):
            snapshot = minimal_save()
            snapshot["opaqueFutureData"] = {"nested": [{"bad": "REPLACE_NUMBER"}]}
            body = encode_json({"expectedRevision": 1, "save": snapshot}).replace(
                b'"REPLACE_NUMBER"', numeric_literal
            )
            self.assert_error(
                self.client.request("PUT", "/api/save", raw=body), 400, "invalid_save"
            )
        self.assertEqual(self.client.request("GET", "/api/save").data, before)

    def test_history_keeps_ten_replaced_snapshots_per_account_and_survives_restart(self):
        self.register()
        other = Client(self.app)
        self.register("history_bob", client=other)
        alice_snapshots, alice_times = {}, {}
        for revision in range(1, 14):
            self.clock.advance(0.01)
            snapshot = minimal_save(revision)
            snapshot["production"]["queue"] = [{
                "id": "already-paid", "inputs": {"scrap": 20},
                "outputs": {"dailyGoods": 2}, "duration": 300, "remaining": 12.25,
                "unknownSnapshotField": {"revisionMarker": revision},
            }]
            data = self.assert_status(self.upload(snapshot, revision - 1), 200)
            alice_snapshots[revision] = deepcopy(snapshot)
            alice_times[revision] = data["updatedAt"]
            self.assertIs(type(data["updatedAt"]), int)
            self.assertEqual(data["updatedAt"], int(self.clock() * 1000))
            if revision <= 3:
                self.assert_status(self.upload(minimal_save(100 + revision), revision - 1, client=other), 200)
        alice_history = self.history_for(self.client.user_id)
        bob_history = self.history_for(other.user_id)
        self.assertEqual([row["revision"] for row in alice_history], list(range(3, 13)))
        self.assertEqual([row["revision"] for row in bob_history], [1, 2])
        for row in alice_history:
            revision = row["revision"]
            self.assertEqual(json.loads(row["save_json"]), alice_snapshots[revision])
            self.assertIs(type(row["updated_at"]), int)
            self.assertIs(type(row["replaced_at"]), int)
            self.assertEqual(row["updated_at"], alice_times[revision])
            self.assertEqual(row["replaced_at"], alice_times[revision + 1])
        self.assertEqual([json.loads(row["save_json"])["resources"]["wood"] for row in bob_history], [101, 102])
        self.assert_error(self.upload(minimal_save(99), 3), 409, "save_conflict")
        self.assertEqual(self.history_for(self.client.user_id), alice_history)
        self.assertEqual(self.history_for(other.user_id), bob_history)
        public = self.assert_status(self.client.request("GET", "/api/save"), 200)
        self.assertEqual(set(public), {"revision", "save", "updatedAt"})
        self.assertEqual(public["revision"], 13)
        self.assertEqual(public["save"], alice_snapshots[13])
        self.assert_status(self.client.request("GET", "/api/save/history"), 404)
        restarted = self.make_app()
        self.assertEqual(self.client.clone(restarted).request("GET", "/api/save").data, public)
        self.assertEqual(self.history_for(self.client.user_id), alice_history)

    def test_excessive_json_depth_is_rejected_without_changing_save(self):
        self.register()
        self.assert_status(self.upload(minimal_save(12)), 200)
        at_limit = "leaf"
        for _ in range(63):
            at_limit = {"child": at_limit}
        snapshot = minimal_save()
        snapshot["opaqueFutureData"] = at_limit
        self.assert_status(self.upload(snapshot, 1), 200)
        before = self.client.request("GET", "/api/save").data
        snapshot["opaqueFutureData"] = {"child": at_limit}
        self.assert_error(self.upload(snapshot, 2), 400, "invalid_save")
        self.assertEqual(self.client.request("GET", "/api/save").data, before)

    def test_payload_limit_counts_the_entire_wrapper_and_accepts_exact_limit(self):
        self.register()
        payload = {"expectedRevision": 0, "save": minimal_save()}
        payload["save"]["padding"] = ""
        payload["save"]["padding"] = "x" * (MAX_PAYLOAD_BYTES - len(encode_json(payload)))
        body = encode_json(payload)
        self.assertEqual(len(body), MAX_PAYLOAD_BYTES)
        self.assert_status(self.client.request("PUT", "/api/save", raw=body), 200)
        before = self.client.request("GET", "/api/save").data
        self.assert_status(self.client.request("PUT", "/api/save", raw=body + b" "), 413)
        self.assertEqual(self.client.request("GET", "/api/save").data, before)

    def test_sessions_and_saves_survive_application_restart_outside_web_root(self):
        self.register()
        snapshot = minimal_save(52)
        self.assert_status(self.upload(snapshot), 200)
        before = self.client.request("GET", "/api/save").data
        restarted = self.make_app()
        restored_client = self.client.clone(restarted)
        self.assertEqual(restored_client.request("GET", "/api/auth/me").data["user"]["username"], "alice")
        self.assertEqual(self.assert_status(restored_client.request("GET", "/api/save"), 200), before)
        self.assertEqual(Path(restarted.data_dir).resolve(), self.data_dir.resolve())
        database = Path(restarted.database_path).resolve()
        self.assertTrue(database.is_file())
        self.assertTrue(database.is_relative_to(self.data_dir.resolve()))
        self.assertFalse(database.is_relative_to(Path(__file__).resolve().parents[1]))
        login_client = Client(restarted)
        self.assert_status(
            login_client.request("POST", "/api/auth/login", json_body={"username": "alice", "password": PASSWORD}),
            200,
        )
        self.assertEqual(login_client.user_id, self.client.user_id)

    def test_future_database_version_is_rechecked_under_the_initialization_write_lock(self):
        original_connect = self.app._connect
        database_path = self.app.database_path
        observed_versions = []
        injected = []

        class VersionCursor:
            def __init__(self, cursor):
                self.cursor = cursor

            def fetchone(self):
                row = self.cursor.fetchone()
                self.cursor.close()
                observed_versions.append(row[0])
                with sqlite3.connect(database_path, isolation_level=None) as newer:
                    newer.execute("PRAGMA user_version = 2")
                injected.append(True)
                return row

        class InitializationConnection:
            def __init__(self, connection):
                self.connection = connection

            def execute(self, sql, parameters=()):
                cursor = self.connection.execute(sql, parameters)
                if sql.strip().upper() == "PRAGMA USER_VERSION" and not injected:
                    return VersionCursor(cursor)
                return cursor

            def __getattr__(self, name):
                return getattr(self.connection, name)

        def interleaved_connect():
            return InitializationConnection(original_connect())

        with patch.object(self.app, "_connect", side_effect=interleaved_connect):
            with self.assertRaises(ValueError):
                self.app._initialize_database()
        self.assertEqual(observed_versions, [1])
        self.assertEqual(injected, [True])
        with sqlite3.connect(database_path) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)

    def test_session_expiry_is_enforced_by_the_server_at_the_boundary(self):
        self.register()
        self.clock.advance(SESSION_SECONDS - 1)
        self.assertIsInstance(self.client.request("GET", "/api/auth/me").data["user"], dict)
        self.clock.advance(1)
        self.assertEqual(self.assert_status(self.client.request("GET", "/api/auth/me"), 200), {"user": None})
        self.assert_error(self.client.request("GET", "/api/save"), 401, "authentication_required")
        self.assert_error(self.upload(), 401, "authentication_required")

    def test_login_ip_rate_limit_retries_after_window_and_is_shared_between_apps(self):
        app = self.make_app(rate_limits={"login_ip": (2, 60)})
        clients = [Client(app), Client(self.make_app(rate_limits={"login_ip": (2, 60)}))]
        credentials = {"username": "unknown_user", "password": PASSWORD}
        for client in clients:
            self.assert_error(client.request("POST", "/api/auth/login", json_body=credentials), 401, "invalid_credentials")
        blocked = clients[0].request("POST", "/api/auth/login", json_body=credentials)
        self.assert_error(blocked, 429, "rate_limited")
        self.assertGreater(int(blocked.header("Retry-After")), 0)
        self.assert_error(
            clients[0].request("POST", "/api/auth/login", json_body=credentials, remote_addr="192.0.2.11"),
            401, "invalid_credentials",
        )
        self.clock.advance(60)
        self.assert_error(clients[1].request("POST", "/api/auth/login", json_body=credentials), 401, "invalid_credentials")

    def test_login_account_rate_limit_applies_across_source_ips(self):
        self.app = self.make_app(rate_limits={"login_account": (2, 60)})
        self.client = Client(self.app)
        self.register()
        for address in ("192.0.2.11", "192.0.2.12"):
            self.assert_error(
                self.client.request("POST", "/api/auth/login", json_body={"username": "alice", "password": "wrong-password"}, remote_addr=address),
                401, "invalid_credentials",
            )
        blocked = self.client.request("POST", "/api/auth/login", json_body={"username": "alice", "password": PASSWORD}, remote_addr="192.0.2.13")
        self.assert_error(blocked, 429, "rate_limited")
        self.clock.advance(60)
        self.assert_status(self.client.request("POST", "/api/auth/login", json_body={"username": "alice", "password": PASSWORD}), 200)

    def test_ip_blocked_unique_usernames_do_not_allocate_account_keys_and_window_recovers(self):
        client = Client(self.make_app(rate_limits={"login_ip": (2, 60)}))

        def attempt(index):
            return client.request(
                "POST", "/api/auth/login",
                json_body={"username": f"unique_user_{index}", "password": PASSWORD},
            )

        def account_key_count():
            with sqlite3.connect(self.app.database_path) as connection:
                return connection.execute(
                    "SELECT COUNT(*) FROM rate_limits WHERE scope='login_account'"
                ).fetchone()[0]

        for index in range(100):
            response = attempt(index)
            if index < 2:
                self.assert_error(response, 401, "invalid_credentials")
            else:
                self.assert_error(response, 429, "rate_limited")
        self.assertEqual(account_key_count(), 2)
        self.clock.advance(60)
        self.assert_error(attempt(100), 401, "invalid_credentials")
        self.assertEqual(account_key_count(), 3)
        self.assert_error(attempt(101), 401, "invalid_credentials")
        self.assert_error(attempt(102), 429, "rate_limited")
        self.assertEqual(account_key_count(), 4)

    def test_register_ip_and_account_rate_limits(self):
        app = self.make_app(rate_limits={"register_ip": (2, 60)})
        client = Client(app)
        self.register("first_user", client=client)
        self.register("second_user", client=client)
        third = client.request("POST", "/api/auth/register", json_body={"username": "third_user", "password": PASSWORD})
        self.assert_error(third, 429, "rate_limited")
        self.assertGreater(int(third.header("Retry-After")), 0)
        self.clock.advance(60)
        self.register("third_user", client=client)
        account_app = self.make_app(rate_limits={"register_account": (2, 60)})
        account_client = Client(account_app)
        self.register("limited_user", client=account_client, remote_addr="192.0.2.21")
        self.assert_error(
            account_client.request("POST", "/api/auth/register", json_body={"username": "limited_user", "password": PASSWORD}, remote_addr="192.0.2.22"),
            409, "username_taken",
        )
        self.assert_error(
            account_client.request("POST", "/api/auth/register", json_body={"username": "limited_user", "password": PASSWORD}, remote_addr="192.0.2.23"),
            429, "rate_limited",
        )

    def test_concurrent_registration_creates_one_account_without_server_errors(self):
        count = 4
        barrier = threading.Barrier(count)
        app = self.make_app(auth_concurrency=count)

        def register(index):
            client = Client(app)
            barrier.wait(timeout=10)
            return client.request(
                "POST", "/api/auth/register",
                json_body={"username": "one_account", "password": PASSWORD},
                remote_addr=f"192.0.2.{30 + index}",
            )

        with ThreadPoolExecutor(max_workers=count) as executor:
            responses = list(executor.map(register, range(count)))
        self.assertEqual(sum(response.status == 200 for response in responses), 1)
        for response in responses:
            if response.status == 200:
                self.assert_status(response, 200)
            else:
                self.assert_error(response, 409, "username_taken")

    def test_auth_concurrency_is_bounded_without_replacing_real_scrypt(self):
        self.register()
        app = self.make_app(auth_concurrency=1)
        entered = threading.Event()
        release = threading.Event()
        original = api_module.derive_password

        def gated_derivation(*args, **kwargs):
            entered.set()
            if not release.wait(timeout=10):
                raise AssertionError("Test did not release the password derivation gate")
            return original(*args, **kwargs)

        def login():
            return Client(app).request(
                "POST", "/api/auth/login", json_body={"username": "alice", "password": PASSWORD}
            )

        with patch.object(api_module, "derive_password", gated_derivation):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(login)
                try:
                    self.assertTrue(entered.wait(timeout=5), "First login never entered password derivation")
                    second = executor.submit(login)
                    self.assert_error(second.result(timeout=3), 429, "auth_busy")
                finally:
                    release.set()
                self.assert_status(first.result(timeout=15), 200)


if __name__ == "__main__":
    unittest.main()
