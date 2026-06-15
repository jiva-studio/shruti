"""HTTP-layer tests with a fake runner + mocked S3 so they run fast (no real
denoise, no network). Exercises single create, batch (explicit + enumerate),
source listing, and error modes."""
import os
import tempfile
import time

import pytest
from fastapi.testclient import TestClient

import denoiser_service.s3util as s3util
from denoiser_service.app import create_app
from denoiser_service.runner import Runner
from denoiser_service.store import Store
from denoiser_service.worker import Worker


class FakeRunner(Runner):
    def __init__(self):
        super().__init__(python="x", script="x", noise_profile="x")

    def ready(self):
        return True

    def probe_duration(self, path):
        return 12.0

    def denoise(self, in_path, out_path, params, timeout):
        with open(out_path, "wb") as f:
            f.write(b"denoised")


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(s3util, "download", lambda url, dest: open(dest, "wb").write(b"in"))
    uploads = []
    monkeypatch.setattr(s3util, "upload",
                        lambda local, dest: uploads.append(dest.key) or dest.public_url())
    d = tempfile.mkdtemp()
    store = Store(os.path.join(d, "jobs.db"))
    worker = Worker(store, FakeRunner(), workers=3, job_timeout=30)
    worker.start()
    app = create_app(store, worker, workers=3, started_at=time.time())
    c = TestClient(app)
    c.uploads = uploads
    yield c
    worker.stop()


def _dest(**over):
    d = {"bucket": "out", "key": "ignored", "access_key_id": "k", "secret_access_key": "s",
         "region": "ru-central1", "endpoint_url": "https://storage.yandexcloud.net",
         "acl": "public-read"}
    d.update(over)
    return d


def _wait_done(c, job_id, n=80):
    for _ in range(n):
        j = c.get(f"/jobs/{job_id}").json()
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_single_job(client):
    r = client.post("/jobs", json={
        "source_url": "https://x/a.mp3",
        "dest": _dest(key="clean/a.mp3"),
        "params": {},
    })
    assert r.status_code == 201
    j = _wait_done(client, r.json()["job_id"])
    assert j["status"] == "done"
    assert j["dest_url"].endswith("/out/clean/a.mp3")
    assert j["duration_seconds"] == 12.0


def test_batch_explicit(client):
    r = client.post("/jobs/batch", json={
        "dest": _dest(),
        "items": [
            {"source_url": "https://x/1.mp3", "dest_key": "clean/1.mp3"},
            {"source_url": "https://x/2.mp3", "dest_key": "clean/2.mp3"},
        ],
        "params": {},
    })
    assert r.status_code == 201
    body = r.json()
    assert body["count"] == 2
    for jid in body["job_ids"]:
        assert _wait_done(client, jid)["status"] == "done"
    assert set(client.uploads) == {"clean/1.mp3", "clean/2.mp3"}


def test_batch_enumerate(client, monkeypatch):
    monkeypatch.setattr(s3util, "list_objects",
                        lambda src, limit=100000: [{"key": "raw/x/a.mp3", "size": 1},
                                                   {"key": "raw/x/b.mp3", "size": 2}])
    monkeypatch.setattr(s3util, "presign_get",
                        lambda src, key, exp: f"https://signed/{key}")
    r = client.post("/jobs/batch", json={
        "dest": _dest(),
        "source": {"bucket": "in", "prefix": "raw/x/",
                   "access_key_id": "k", "secret_access_key": "s"},
        "dest_prefix": "clean/",
        "params": {},
    })
    assert r.status_code == 201
    assert r.json()["count"] == 2
    for jid in r.json()["job_ids"]:
        assert _wait_done(client, jid)["status"] == "done"
    # source-relative layout preserved under dest_prefix
    assert set(client.uploads) == {"clean/a.mp3", "clean/b.mp3"}


def test_batch_rejects_both_modes(client):
    r = client.post("/jobs/batch", json={
        "dest": _dest(),
        "items": [{"source_url": "u", "dest_key": "k"}],
        "source": {"bucket": "in", "access_key_id": "k", "secret_access_key": "s"},
    })
    assert r.status_code == 400


def test_source_list(client, monkeypatch):
    monkeypatch.setattr(s3util, "list_objects",
                        lambda src, limit=100000: [{"key": "raw/a.mp3", "size": 10}])
    r = client.post("/source/list", json={
        "source": {"bucket": "in", "prefix": "raw/",
                   "access_key_id": "k", "secret_access_key": "s"},
    })
    assert r.status_code == 200
    assert r.json() == {"count": 1, "objects": [{"key": "raw/a.mp3", "size": 10}]}
