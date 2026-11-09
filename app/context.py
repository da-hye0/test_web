# 지금 이 순간의 한국 상황: 날짜·요일·시간대·계절, 날씨·기온, 미세먼지
# AI 추천과 채팅 화면이 같이 쓴다. 날씨는 Open-Meteo (키 없음, 무료)
import asyncio
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from .cache import cached
from .fetch import fetch_json

log = logging.getLogger("context")
KST = ZoneInfo("Asia/Seoul")
WEATHER_TTL = 20 * 60

WEEKDAYS = "월화수목금토일"

# WMO 날씨 코드 → (한국어, 분류)
def _sky(code: int) -> tuple[str, str]:
    if code == 0:
        return "맑음", "clear"
    if code in (1, 2):
        return "구름 조금", "clear"
    if code == 3:
        return "흐림", "cloudy"
    if code in (45, 48):
        return "안개", "cloudy"
    if 51 <= code <= 57:
        return "이슬비", "rain"
    if 61 <= code <= 67 or 80 <= code <= 82:
        return "비", "rain"
    if 71 <= code <= 77 or code in (85, 86):
        return "눈", "snow"
    if code >= 95:
        return "뇌우", "rain"
    return "흐림", "cloudy"


def _dust_grade(pm10: float | None, pm25: float | None) -> str | None:
    """환경부 기준으로 미세먼지·초미세먼지 중 나쁜 쪽 등급"""
    grades = []
    if pm10 is not None:
        grades.append(0 if pm10 <= 30 else 1 if pm10 <= 80 else 2 if pm10 <= 150 else 3)
    if pm25 is not None:
        grades.append(0 if pm25 <= 15 else 1 if pm25 <= 35 else 2 if pm25 <= 75 else 3)
    return ["좋음", "보통", "나쁨", "매우 나쁨"][max(grades)] if grades else None


def _season(month: int) -> str:
    return {12: "초겨울", 1: "한겨울", 2: "늦겨울", 3: "초봄", 4: "봄", 5: "늦봄",
            6: "초여름", 7: "한여름", 8: "늦여름", 9: "초가을", 10: "가을", 11: "늦가을"}[month]


def _time_of_day(hour: int) -> str:
    if hour < 5:
        return "새벽"
    if hour < 11:
        return "아침"
    if hour < 14:
        return "점심"
    if hour < 17:
        return "오후"
    if hour < 21:
        return "저녁"
    return "밤"


async def _fetch_weather(lat: float, lng: float) -> dict:
    common = {"latitude": lat, "longitude": lng, "timezone": "Asia/Seoul"}
    forecast, air = await asyncio.gather(
        fetch_json("https://api.open-meteo.com/v1/forecast", timeout=6, params={
            **common,
            "current": "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "forecast_days": 1,
        }),
        fetch_json("https://air-quality-api.open-meteo.com/v1/air-quality", timeout=6, params={
            **common, "current": "pm10,pm2_5",
        }),
        return_exceptions=True,
    )
    if isinstance(forecast, Exception):
        raise forecast
    cur, daily = forecast["current"], forecast["daily"]
    sky, kind = _sky(int(cur["weather_code"]))
    if cur.get("precipitation", 0) > 0 and kind not in ("rain", "snow"):
        sky, kind = "비", "rain"
    air_cur = {} if isinstance(air, Exception) else air.get("current", {})
    return {
        "sky": sky,
        "kind": kind,
        "temp": round(cur["temperature_2m"]),
        "feels": round(cur["apparent_temperature"]),
        "min": round(daily["temperature_2m_min"][0]),
        "max": round(daily["temperature_2m_max"][0]),
        "rainChance": daily["precipitation_probability_max"][0],
        "wind": round(cur["wind_speed_10m"] / 3.6, 1),  # m/s (한국 일기예보 단위)
        "dust": _dust_grade(air_cur.get("pm10"), air_cur.get("pm2_5")),
    }


async def weather(lat: float, lng: float) -> dict | None:
    """약 1km 단위로 묶어 20분 캐시. 실패하면 None (날씨 없이도 추천은 된다)"""
    try:
        return await cached(f"weather:{lat:.2f},{lng:.2f}", lambda: _fetch_weather(round(lat, 2), round(lng, 2)), WEATHER_TTL)
    except Exception as e:  # noqa: BLE001
        log.warning("[context] 날씨 실패: %s", e)
        return None


def feel_tags(w: dict | None, now: datetime) -> list[str]:
    """화면의 예시 질문을 고르는 데 쓰는 상황 꼬리표"""
    tags = []
    if w:
        if w["kind"] == "rain":
            tags.append("rain")
        elif w["kind"] == "snow":
            tags.append("snow")
        if w["feels"] <= 5:
            tags.append("cold")
        elif w["feels"] >= 27:
            tags.append("hot")
        if w["dust"] in ("나쁨", "매우 나쁨"):
            tags.append("dust")
    if now.hour >= 21 or now.hour < 5:
        tags.append("late")
    if now.weekday() >= 4 and now.hour >= 17:
        tags.append("weekend-night")
    return tags


async def snapshot(lat: float | None, lng: float | None) -> dict:
    now = datetime.now(KST)
    w = await weather(lat, lng) if lat is not None and lng is not None else None
    return {
        "now": now,
        "date": f"{now.year}년 {now.month}월 {now.day}일 ({WEEKDAYS[now.weekday()]})",
        "time": f"{_time_of_day(now.hour)} {now.hour}시 {now.minute:02d}분",
        "season": _season(now.month),
        "weekend": now.weekday() >= 5,
        "weather": w,
        "tags": feel_tags(w, now),
    }


def describe(snap: dict) -> str:
    """AI에게 넘기는 한 단락"""
    lines = [f"지금: {snap['date']} {snap['time']}, {snap['season']}{', 주말' if snap['weekend'] else ''}"]
    w = snap["weather"]
    if w:
        lines.append(
            f"날씨: {w['sky']}, {w['temp']}°C (체감 {w['feels']}°C), 오늘 최저 {w['min']}°C / 최고 {w['max']}°C, "
            f"강수확률 {w['rainChance']}%, 바람 {w['wind']}m/s"
            + (f", 미세먼지 {w['dust']}" if w["dust"] else "")
        )
    else:
        lines.append("날씨: 정보를 가져오지 못했어요")
    return "\n".join(lines)
