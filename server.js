// 맛집·술집 찾기 서버 (외부 의존성 없음, Node 18+)
// - 카카오 REST API 키가 있으면 카카오 로컬 API 사용
// - 없으면 OpenStreetMap(Nominatim + Overpass) 사용
const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const KAKAO_KEY = (process.env.KAKAO_REST_API_KEY || '').trim();
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_AGENT = 'matjip-finder/1.0 (personal project)';
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// ---------- 유틸 ----------

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return res.json();
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// ---------- 카카오 ----------

function kakao(endpoint, params) {
  const url = `https://dapi.kakao.com/v2/local/${endpoint}?${new URLSearchParams(params)}`;
  return fetchJson(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
}

async function kakaoGeocode(q) {
  const addr = await kakao('search/address.json', { query: q, size: 5 });
  const fromAddr = addr.documents.map((d) => ({
    name: d.address_name,
    lat: Number(d.y),
    lng: Number(d.x),
  }));
  if (fromAddr.length) return fromAddr;
  // "강남역", "홍대입구" 같은 장소명은 키워드 검색으로
  const kw = await kakao('search/keyword.json', { query: q, size: 5 });
  return kw.documents.map((d) => ({
    name: `${d.place_name} (${d.road_address_name || d.address_name})`,
    lat: Number(d.y),
    lng: Number(d.x),
  }));
}

async function kakaoReverse(lat, lng) {
  const data = await kakao('geo/coord2address.json', { x: lng, y: lat });
  const d = data.documents[0];
  return d ? (d.road_address?.address_name || d.address?.address_name) : null;
}

// 카카오는 한 검색당 최대 45개(15개 x 3페이지)
async function kakaoAllPages(endpoint, params) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const data = await kakao(endpoint, { ...params, page, size: 15 });
    out.push(...data.documents);
    if (data.meta.is_end) break;
  }
  return out;
}

async function kakaoPlaces(lat, lng, radius, type) {
  const base = { x: lng, y: lat, radius, sort: 'distance' };
  const jobs = [];
  if (type !== 'bar') jobs.push(kakaoAllPages('search/category.json', { ...base, category_group_code: 'FD6' }));
  if (type !== 'food') jobs.push(kakaoAllPages('search/keyword.json', { ...base, query: '술집' }));

  const seen = new Set();
  const places = [];
  for (const d of (await Promise.all(jobs)).flat()) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const categoryPath = d.category_name || '';
    const isBar = categoryPath.includes('술집'); // 예: 음식점 > 술집 > 호프,요리주점
    const kind = isBar ? 'bar' : 'food';
    if (type !== 'all' && kind !== type) continue;
    places.push({
      id: `kakao-${d.id}`,
      name: d.place_name,
      kind,
      category: categoryPath.split(' > ').slice(1).join(' > ') || categoryPath,
      address: d.road_address_name || d.address_name,
      phone: d.phone || null,
      lat: Number(d.y),
      lng: Number(d.x),
      distance: Number(d.distance),
      url: d.place_url,
    });
  }
  return places;
}

// ---------- OpenStreetMap ----------

async function osmGeocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q, format: 'json', limit: 5, countrycodes: 'kr', 'accept-language': 'ko',
  })}`;
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } });
  return data.map((d) => ({ name: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }));
}

async function osmReverse(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({
    lat, lon: lng, format: 'json', 'accept-language': 'ko', zoom: 18,
  })}`;
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } });
  return data.display_name || null;
}

const OSM_FOOD = ['restaurant', 'fast_food', 'food_court'];
const OSM_BAR = ['bar', 'pub', 'biergarten'];

async function osmPlaces(lat, lng, radius, type) {
  const amenities = type === 'food' ? OSM_FOOD : type === 'bar' ? OSM_BAR : [...OSM_FOOD, ...OSM_BAR];
  const query = `[out:json][timeout:25];nwr["amenity"~"^(${amenities.join('|')})$"](around:${radius},${lat},${lng});out center tags 200;`;

  let data;
  let lastError;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      data = await fetchJson(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({ data: query }),
      }, 30000);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!data) throw lastError;

  return data.elements
    .map((el) => {
      const t = el.tags || {};
      const pLat = el.lat ?? el.center?.lat;
      const pLng = el.lon ?? el.center?.lon;
      const name = t['name:ko'] || t.name;
      if (!name || pLat == null) return null;
      const address = [t['addr:city'], t['addr:district'], t['addr:street'], t['addr:housenumber']]
        .filter(Boolean).join(' ') || t['addr:full'] || null;
      return {
        id: `osm-${el.type}-${el.id}`,
        name,
        kind: OSM_BAR.includes(t.amenity) ? 'bar' : 'food',
        category: [t.amenity, t.cuisine].filter(Boolean).join(' · '),
        address,
        phone: t.phone || t['contact:phone'] || null,
        lat: pLat,
        lng: pLng,
        distance: distanceMeters(lat, lng, pLat, pLng),
        url: null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
}

// ---------- 라우팅 ----------

const provider = KAKAO_KEY ? 'kakao' : 'osm';
const api = {
  geocode: KAKAO_KEY ? kakaoGeocode : osmGeocode,
  reverse: KAKAO_KEY ? kakaoReverse : osmReverse,
  places: KAKAO_KEY ? kakaoPlaces : osmPlaces,
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function parseCoord(params) {
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) };
}

async function handleApi(url, res) {
  const p = url.searchParams;
  switch (url.pathname) {
    case '/api/config':
      return sendJson(res, 200, { provider });

    case '/api/geocode': {
      const q = (p.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { error: '주소를 입력해주세요.' });
      const results = await cached(`geo:${q}`, () => api.geocode(q));
      return sendJson(res, 200, { results });
    }

    case '/api/reverse': {
      const c = parseCoord(p);
      if (!c) return sendJson(res, 400, { error: '좌표가 올바르지 않습니다.' });
      const address = await cached(`rev:${c.lat},${c.lng}`, () => api.reverse(c.lat, c.lng));
      return sendJson(res, 200, { address });
    }

    case '/api/places': {
      const c = parseCoord(p);
      if (!c) return sendJson(res, 400, { error: '좌표가 올바르지 않습니다.' });
      const radius = Math.min(Math.max(Number(p.get('radius')) || 500, 100), 20000);
      const type = ['food', 'bar'].includes(p.get('type')) ? p.get('type') : 'all';
      const places = await cached(`places:${c.lat},${c.lng},${radius},${type}`,
        () => api.places(c.lat, c.lng, radius, type));
      return sendJson(res, 200, { provider, places });
    }

    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
  try {
    await handleApi(url, res);
  } catch (e) {
    console.error(`[${url.pathname}]`, e.message);
    sendJson(res, 502, { error: '외부 지도 서비스 호출에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }
}).listen(PORT, () => {
  console.log(`🍻 맛집·술집 찾기: http://localhost:${PORT}`);
  console.log(`   데이터 소스: ${provider === 'kakao' ? '카카오 로컬 API' : 'OpenStreetMap (카카오 키를 .env에 넣으면 더 정확해집니다)'}`);
});
