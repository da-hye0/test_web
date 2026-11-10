# 환경별로 찜 저장 위치가 나뉘는지 (dev/stg가 운영 데이터를 건드리지 않게)
from app import store


def test_collection_name_per_env():
    assert store.collection_name(None) == "favorites"
    assert store.collection_name("prd") == "favorites"
    assert store.collection_name("dev") == "favorites-dev"
    assert store.collection_name(" STG ") == "favorites-stg"


def test_firestore_doc_url_uses_env_collection(monkeypatch):
    monkeypatch.setenv("APP_ENV", "dev")
    s = store.FirestoreStore()
    s.project_id = "p"
    assert "/documents/favorites-dev/kakao%3A1" in s._doc_url("kakao:1")
