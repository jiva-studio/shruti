import pytest

from share_transcript import config

REQUIRED = {
    "STORAGE_ZONE": "test-zone",
    "STORAGE_KEY": "test-key",
    "PDFS_PUBLIC_BASE": "https://cdn.example.test/",
}


@pytest.fixture
def bunny_env(monkeypatch):
    for key, value in REQUIRED.items():
        monkeypatch.setenv(key, value)
    for key in ("SHRUTI_S3_BUCKET", "BUCKET", "S3_ENDPOINT_URL", "STORAGE_ENDPOINT"):
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


def test_load_reads_the_storage_zone(bunny_env):
    s = config.load()
    assert s.storage_zone == "test-zone"
    assert s.storage_key == "test-key"
    assert s.storage_endpoint == "https://storage.bunnycdn.com"
    assert s.public_url("public/tracks/t/exports/ru.pdf") == (
        "https://cdn.example.test/public/tracks/t/exports/ru.pdf"
    )


@pytest.mark.parametrize("missing", sorted(REQUIRED))
def test_load_refuses_without_a_bunny_setting(bunny_env, missing):
    bunny_env.setenv("SHRUTI_S3_BUCKET", "test-bucket")
    bunny_env.delenv(missing)
    with pytest.raises(RuntimeError, match=missing):
        config.load()
