"""Independent transaction, proxy and storage boundaries for the WSGI API."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch

from api import app as api_module
from api.test_api import Client, Clock, HIGH_LIMITS, ORIGIN, PASSWORD, minimal_save


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.clock = Clock()
        self.app = api_module.create_app(self.directory.name, ORIGIN, now=self.clock, rate_limits=HIGH_LIMITS)

    def registered(self, app=None, username="boundary_user"):
        client = Client(app or self.app)
        response = client.request("POST", "/api/auth/register", json_body={"username": username, "password": PASSWORD})
        self.assertEqual(response.status, 200, response.data)
        return client

    def test_private_storage_outside_web_root_and_future_database_are_preserved(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.app.data_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.app.database_path).st_mode), 0o600)
        inside = Path(api_module.__file__).resolve().parent / "forbidden-data"
        self.assertFalse(inside.exists())
        with self.assertRaises(ValueError):
            api_module.create_app(str(inside), ORIGIN)
        self.assertFalse(inside.exists())
        with sqlite3.connect(self.app.database_path) as connection:
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            connection.execute("PRAGMA user_version=99")
        before = self.app.database_path.read_bytes()
        with self.assertRaises(ValueError):
            api_module.create_app(self.directory.name, ORIGIN)
        self.assertEqual(self.app.database_path.read_bytes(), before)

    def test_only_explicit_trusted_proxy_can_supply_a_rate_limit_ip(self):
        limits = {**HIGH_LIMITS, "login_ip": (1, 60)}
        with patch.dict(os.environ, {"FKSSJ_TRUSTED_PROXIES": ""}):
            direct = api_module.create_app(self.directory.name, ORIGIN, now=self.clock, rate_limits=limits)
        client = Client(direct)
        credentials = {"username": "missing_user", "password": PASSWORD}
        first = client.request("POST", "/api/auth/login", json_body=credentials, remote_addr="127.0.0.1", headers={"X-Real-IP": "203.0.113.1"})
        second = client.request("POST", "/api/auth/login", json_body=credentials, remote_addr="127.0.0.1", headers={"X-Real-IP": "203.0.113.2"})
        self.assertEqual(first.status, 401)
        self.assertEqual((second.status, second.data["code"]), (429, "rate_limited"))
        with patch.dict(os.environ, {"FKSSJ_TRUSTED_PROXIES": "127.0.0.1,::1"}):
            proxy = api_module.create_app(self.directory.name, ORIGIN, now=self.clock, rate_limits=limits)
        client = Client(proxy)
        for address in ("203.0.113.3", "203.0.113.4"):
            response = client.request("POST", "/api/auth/login", json_body=credentials, remote_addr="127.0.0.1", headers={"X-Real-IP": address})
            self.assertEqual(response.status, 401)
        first = client.request("POST", "/api/auth/login", json_body=credentials, remote_addr="198.51.100.2", headers={"X-Real-IP": "203.0.113.5"})
        second = client.request("POST", "/api/auth/login", json_body=credentials, remote_addr="198.51.100.2", headers={"X-Real-IP": "203.0.113.6"})
        self.assertEqual(first.status, 401)
        self.assertEqual((second.status, second.data["code"]), (429, "rate_limited"))

    def test_auth_concurrency_lease_is_shared_across_application_instances(self):
        self.registered()
        first_app = api_module.create_app(self.directory.name, ORIGIN, now=self.clock, rate_limits=HIGH_LIMITS, auth_concurrency=1)
        second_app = api_module.create_app(self.directory.name, ORIGIN, now=self.clock, rate_limits=HIGH_LIMITS, auth_concurrency=1)
        entered, release = threading.Event(), threading.Event()
        original = api_module.derive_password

        def gated(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(10))
            return original(*args, **kwargs)

        def login(app):
            return Client(app).request("POST", "/api/auth/login", json_body={"username": "boundary_user", "password": PASSWORD})

        with patch.object(api_module, "derive_password", gated):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(login, first_app)
                try:
                    self.assertTrue(entered.wait(5))
                    blocked = executor.submit(login, second_app).result(timeout=3)
                    self.assertEqual((blocked.status, blocked.data["code"]), (429, "auth_busy"))
                finally:
                    release.set()
                self.assertEqual(first.result(timeout=15).status, 200)
        with sqlite3.connect(self.app.database_path) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM auth_leases").fetchone()[0], 0)

    def _logout_save_race(self, first_method):
        client = self.registered()
        entered, release, second_attempted = threading.Event(), threading.Event(), threading.Event()
        original = self.app._session

        def gated(connection, environ, **kwargs):
            result = original(connection, environ, **kwargs)
            if environ.get("REQUEST_METHOD") == first_method:
                entered.set()
                self.assertTrue(release.wait(10))
            return result

        def put():
            return client.clone().request("PUT", "/api/save", json_body={"expectedRevision": 0, "save": minimal_save(7)})

        def logout():
            return client.clone().request("POST", "/api/auth/logout")

        first_action, second_action = (put, logout) if first_method == "PUT" else (logout, put)

        def second():
            second_attempted.set()
            return second_action()

        with patch.object(self.app, "_session", gated):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(first_action)
                try:
                    self.assertTrue(entered.wait(5))
                    following = executor.submit(second)
                    self.assertTrue(second_attempted.wait(5))
                    self.assertFalse(following.done(), "The second writer must not overtake session verification inside the first transaction")
                finally:
                    release.set()
                first_response, second_response = first.result(15), following.result(15)
        self.assertEqual(first_response.status, 200)
        if first_method == "PUT":
            self.assertEqual(second_response.status, 200)
        else:
            self.assertEqual((second_response.status, second_response.data["code"]), (401, "authentication_required"))
        self.assertEqual(client.request("GET", "/api/save").status, 401)
        with sqlite3.connect(self.app.database_path) as connection:
            rows = connection.execute("SELECT revision,save_json FROM cloud_saves").fetchall()
        self.assertEqual(len(rows), 1 if first_method == "PUT" else 0)
        if rows:
            self.assertEqual(rows[0][0], 1)
            self.assertEqual(json.loads(rows[0][1]), minimal_save(7))

    def test_save_that_holds_the_transaction_finishes_before_logout(self):
        self._logout_save_race("PUT")

    def test_logout_that_holds_the_transaction_prevents_following_save(self):
        self._logout_save_race("POST")

    def test_malformed_unicode_and_huge_json_numbers_are_opaque_client_errors(self):
        malformed_password = Client(self.app).request("POST", "/api/auth/register", raw=json.dumps({"username": "bad_unicode", "password": "\ud800abcdefg"}).encode())
        self.assertEqual(malformed_password.status, 400)
        client = self.registered()
        for change in (lambda save: save.update(text="\ud800"), lambda save: save["resources"].update(wood=10**400)):
            save = minimal_save()
            change(save)
            response = client.request("PUT", "/api/save", raw=json.dumps({"expectedRevision": 0, "save": save}).encode())
            self.assertEqual((response.status, response.data["code"]), (400, "invalid_save"))
            self.assertNotIn("Traceback", response.body.decode())
        response = client.request("PUT", "/api/save", json_body={"expectedRevision": 0, "save": minimal_save()}, csrf="☃" * 64)
        self.assertEqual((response.status, response.data["code"]), (403, "csrf_invalid"))
        self.assertEqual(client.request("GET", "/api/save").data, {"revision": 0, "save": None, "updatedAt": None})


if __name__ == "__main__":
    unittest.main()
