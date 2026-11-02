# 환경 변수 읽기 — .env가 있으면 먼저 불러온다 (이미 설정된 환경 변수가 우선)
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=False)


def env(key: str) -> str:
    return (os.environ.get(key) or "").strip()


PORT = int(env("PORT") or 3000)
BASE_URL = (env("BASE_URL") or f"http://localhost:{PORT}").rstrip("/")
KAKAO_KEY = env("KAKAO_REST_API_KEY")
# 카카오맵 JavaScript 키 — 브라우저에 공개되는 용도의 키라서 /api/config로 내려준다
KAKAO_JS_KEY = env("KAKAO_JS_KEY")
GOOGLE_PLACES_KEY = env("GOOGLE_PLACES_API_KEY")
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "data"
USER_AGENT = "matjip-finder/1.0 (personal project)"
