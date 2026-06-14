import os
import tempfile

from denoiser_service.models import Job, S3Dest, Status
from denoiser_service.store import Store


def _store():
    d = tempfile.mkdtemp()
    return Store(os.path.join(d, "jobs.db"))


def _job(job_id="j1"):
    return Job(
        job_id=job_id, filename="lecture.mp3", source_url="https://x/lecture.mp3",
        dest_bucket="b", dest_key="clean/lecture.mp3", status=Status.QUEUED,
        uploaded_at=1000,
    )


def test_insert_get_roundtrip():
    s = _store()
    s.insert(_job())
    j = s.get("j1")
    assert j is not None
    assert j.status == Status.QUEUED
    assert j.dest_key == "clean/lecture.mp3"
    assert s.get("missing") is None


def test_lifecycle_transitions():
    s = _store()
    s.insert(_job())
    s.mark_running("j1")
    assert s.get("j1").status == Status.RUNNING
    s.mark_done("j1", duration_s=600, proc_s=55, rtfx=10.9, dest_url="https://x/clean.mp3")
    j = s.get("j1")
    assert j.status == Status.DONE
    assert j.rtfx == 10.9
    assert j.dest_url == "https://x/clean.mp3"


def test_mark_failed():
    s = _store()
    s.insert(_job())
    s.mark_failed("j1", "boom")
    j = s.get("j1")
    assert j.status == Status.FAILED
    assert j.error == "boom"


def test_fail_orphans():
    s = _store()
    s.insert(_job("a"))
    s.insert(_job("b"))
    s.mark_running("b")
    n = s.fail_orphans("restarted")
    assert n == 2
    assert s.get("a").status == Status.FAILED
    assert s.get("b").status == Status.FAILED


def test_counts_and_list():
    s = _store()
    s.insert(_job("a"))
    s.insert(_job("b"))
    s.mark_done("b", duration_s=1, proc_s=1, rtfx=1, dest_url="u")
    c = s.counts()
    assert c["queued"] == 1 and c["done"] == 1
    assert len(s.list()) == 2
    assert len(s.list(status="done")) == 1


def test_job_to_dict_omits_none_and_secrets():
    j = _job()
    d = j.to_dict()
    assert d["status"] == "queued"
    assert "started_at" not in d  # None omitted
    # Job has no credential fields at all
    assert not any("secret" in k or "access_key" in k for k in d)


def test_s3dest_public_url():
    aws = S3Dest(bucket="b", key="k.mp3", access_key_id="x", secret_access_key="y",
                 region="us-east-1")
    assert aws.public_url() == "https://b.s3.us-east-1.amazonaws.com/k.mp3"
    yc = S3Dest(bucket="b", key="k.mp3", access_key_id="x", secret_access_key="y",
                endpoint_url="https://storage.yandexcloud.net")
    assert yc.public_url() == "https://storage.yandexcloud.net/b/k.mp3"
