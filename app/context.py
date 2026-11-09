# 지금 이 순간의 한국 상황: 날짜·요일·시간대·계절, 날씨·기온, 미세먼지
# AI 추천과 채팅 화면이 같이 쓴다. 날씨는 Open-Meteo (키 없음, 무료)
# Cloud Run처럼 IP를 여럿이 같이 쓰는 곳에선 Open-Meteo 하루 한도가 금방 차서, 실패하면 노르웨이 기상청(MET Norway, 키 없음)으로 넘어간다
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


# MET Norway 날씨 기호 → (한국어, 분류)
def _met_sky(symbol: str) -> tuple[str, str]:
    s = symbol.split("_")[0]
    if "thunder" in s:
        return "뇌우", "rain"
    if "snow" in s:
        return "눈", "snow"
    if "sleet" in s:
        return "진눈깨비", "snow"
    if "drizzle" in s:
        return "이슬비", "rain"
    if "rain" in s:
        return "비", "rain"
    if s == "fog":
        return "안개", "cloudy"
    if s == "cloudy":
        return "흐림", "cloudy"
    if s == "clearsky":
        return "맑음", "clear"
    return "구름 조금", "clear"


async def _fetch_met(lat: float, lng: float) -> dict:
    data = await fetch_json(
        "https://api.met.no/weatherapi/locationforecast/2.0/complete", timeout=6,
        params={"lat": lat, "lon": lng},
        headers={"User-Agent": "matjip/1.0 https://matjip.dahye.dev"},  # MET Norway는 앱 이름을 요구한다
    )
    series = data["properties"]["timeseries"]
    first = series[0]["data"]
    cur = first["instant"]["details"]
    hour = first.get("next_1_hours") or first.get("next_6_hours") or {}
    sky, kind = _met_sky(hour.get("summary", {}).get("symbol_code", "cloudy"))
    if hour.get("details", {}).get("precipitation_amount", 0) > 0 and kind not in ("rain", "snow"):
        sky, kind = "비", "rain"
    today = datetime.now(KST).date()
    temps, chances = [], []
    for item in series:
        if datetime.fromisoformat(item["time"].replace("Z", "+00:00")).astimezone(KST).date() != today:
            continue
        temps.append(item["data"]["instant"]["details"]["air_temperature"])
        chance = (item["data"].get("next_1_hours") or {}).get("details", {}).get("probability_of_precipitation")
        if chance is not None:
            chances.append(chance)
    temps = temps or [cur["air_temperature"]]
    return {
        "sky": sky,
        "kind": kind,
        "temp": round(cur["air_temperature"]),
        "feels": round(cur.get("apparent_air_temperature", cur["air_temperature"])),
        "min": round(min(temps)),
        "max": round(max(temps)),
        "rainChance": round(max(chances)) if chances else None,
        "wind": round(cur.get("wind_speed", 0), 1),
    }


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
    air_cur = {} if isinstance(air, Exception) else air.get("current", {})
    dust = _dust_grade(air_cur.get("pm10"), air_cur.get("pm2_5"))
    if isinstance(forecast, Exception):
        log.warning("[context] Open-Meteo 실패, MET Norway로: %s", forecast)
        return {**await _fetch_met(lat, lng), "dust": dust}
    cur, daily = forecast["current"], forecast["daily"]
    sky, kind = _sky(int(cur["weather_code"]))
    if cur.get("precipitation", 0) > 0 and kind not in ("rain", "snow"):
        sky, kind = "비", "rain"
    return {
        "sky": sky,
        "kind": kind,
        "temp": round(cur["temperature_2m"]),
        "feels": round(cur["apparent_temperature"]),
        "min": round(daily["temperature_2m_min"][0]),
        "max": round(daily["temperature_2m_max"][0]),
        "rainChance": daily["precipitation_probability_max"][0],
        "wind": round(cur["wind_speed_10m"] / 3.6, 1),  # m/s (한국 일기예보 단위)
        "dust": dust,
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
    hour = snap["now"].hour
    if hour >= 22 or hour < 5:
        lines.append("시간 주의: 지금은 대부분의 식당(양식·이탈리안·한정식·브런치·카페)이 문을 닫았거나 곧 닫는 시간. "
                     "술집·이자카야·포차·바, 늦게까지 하는 고깃집·국밥·해장국·24시간 식당만 추천할 것.")
    elif hour >= 20:
        lines.append("시간 주의: 식당은 곧 마지막 주문 시간(라스트 오더). 식사라면 늦게까지 하는 곳 위주로, 술집은 괜찮음.")
    elif 15 <= hour < 17:
        lines.append("시간 주의: 오후 브레이크 타임인 식당이 많은 시간.")
    w = snap["weather"]
    if w:
        lines.append(
            f"날씨: {w['sky']}, {w['temp']}°C (체감 {w['feels']}°C), 오늘 최저 {w['min']}°C / 최고 {w['max']}°C, "
            + (f"강수확률 {w['rainChance']}%, " if w["rainChance"] is not None else "")
            + f"바람 {w['wind']}m/s"
            + (f", 미세먼지 {w['dust']}" if w["dust"] else "")
        )
    else:
        lines.append("날씨: 정보를 가져오지 못했어요")
    return "\n".join(lines)
