// 데이터 백엔드 선택
// 1) server.js 가 떠 있으면 서버 API 사용 (npm start)
// 2) 서버가 없고(GitHub Pages 등) config.js 에 카카오 JavaScript 키가 있으면 카카오 지도 SDK 사용
// 3) 둘 다 아니면 브라우저에서 OpenStreetMap 직접 호출
// 반환 형태는 server.js 의 /api/* 응답과 동일하다.

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OSM_FOOD = ['restaurant', 'fast_food', 'food_court'];
const OSM_BAR = ['bar', 'pub', 'biergarten'];

function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, fn(...args).catch((e) => { cache.delete(key); throw e; }));
    return cache.get(key);
  };
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `요청 실패 (${res.status})`);
  return body;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(a)));
}

// ---------- 1) server.js ----------

async function serverBackend() {
  const { provider } = await fetchJson('api/config', {}, 3000);
  const qs = (params) => new URLSearchParams(params);
  return {
    provider,
    geocode: async (q) => (await fetchJson(`api/geocode?${qs({ q })}`)).results,
    reverse: async (lat, lng) => (await fetchJson(`api/reverse?${qs({ lat, lng })}`)).address,
    // 서버가 Overpass 미러를 차례로 시도(각 30초)하므로 넉넉히 기다린다
    places: async (lat, lng, radius, type) => (await fetchJson(`api/places?${qs({ lat, lng, radius, type })}`, {}, 100000)).places,
  };
}

// ---------- 2) 카카오 지도 JavaScript SDK ----------

function loadKakaoSdk(appKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&libraries=services&autoload=false`;
    script.onload = () => window.kakao.maps.load(resolve);
    script.onerror = () => reject(new Error('카카오 지도 SDK를 불러오지 못했습니다. 키와 등록된 도메인을 확인하세요.'));
    document.head.appendChild(script);
  });
}

async function kakaoBackend(appKey) {
  await loadKakaoSdk(appKey);
  const { services, LatLng } = window.kakao.maps;
  const geocoder = new services.Geocoder();
  const ps = new services.Places();

  // 카카오 SDK 콜백 → Promise. 결과 없음은 빈 배열로.
  const call = (fn, ...args) => new Promise((resolve, reject) => {
    fn(...args, (data, status, pagination) => {
      if (status === services.Status.OK) resolve({ data, pagination });
      else if (status === services.Status.ZERO_RESULT) resolve({ data: [], pagination: null });
      else reject(new Error('카카오 지도 검색에 실패했습니다.'));
    });
  });

  // 한 검색당 최대 45개(15개 x 3페이지)
  async function allPages(fn, first, options) {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const { data, pagination } = await call(fn, first, { ...options, page });
      out.push(...data);
      if (!pagination?.hasNextPage) break;
    }
    return out;
  }

  return {
    provider: 'kakao',

    async geocode(q) {
      const addr = await call(geocoder.addressSearch.bind(geocoder), q);
      if (addr.data.length) {
        return addr.data.slice(0, 5).map((d) => ({ name: d.address_name, lat: Number(d.y), lng: Number(d.x) }));
      }
      const kw = await call(ps.keywordSearch.bind(ps), q, { size: 5 });
      return kw.data.map((d) => ({
        name: `${d.place_name} (${d.road_address_name || d.address_name})`,
        lat: Number(d.y),
        lng: Number(d.x),
      }));
    },

    async reverse(lat, lng) {
      const { data } = await call(geocoder.coord2Address.bind(geocoder), lng, lat);
      const d = data[0];
      return d ? (d.road_address?.address_name || d.address?.address_name) : null;
    },

    async places(lat, lng, radius, type) {
      const options = { location: new LatLng(lat, lng), radius, sort: services.SortBy.DISTANCE, size: 15 };
      const jobs = [];
      if (type !== 'bar') jobs.push(allPages(ps.categorySearch.bind(ps), 'FD6', options));
      if (type !== 'food') jobs.push(allPages(ps.keywordSearch.bind(ps), '술집', options));

      const seen = new Set();
      const places = [];
      for (const d of (await Promise.all(jobs)).flat()) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        const categoryPath = d.category_name || '';
        const kind = categoryPath.includes('술집') ? 'bar' : 'food'; // 예: 음식점 > 술집 > 호프,요리주점
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
      return places.sort((a, b) => a.distance - b.distance);
    },
  };
}

// ---------- 3) OpenStreetMap (브라우저 직접 호출) ----------

function osmBackend() {
  return {
    provider: 'osm',

    async geocode(q) {
      const params = new URLSearchParams({ q, format: 'json', limit: 5, countrycodes: 'kr', 'accept-language': 'ko' });
      const data = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`);
      return data.map((d) => ({ name: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }));
    },

    async reverse(lat, lng) {
      const params = new URLSearchParams({ lat, lon: lng, format: 'json', 'accept-language': 'ko', zoom: 18 });
      const data = await fetchJson(`https://nominatim.openstreetmap.org/reverse?${params}`);
      return data.display_name || null;
    },

    async places(lat, lng, radius, type) {
      const amenities = type === 'food' ? OSM_FOOD : type === 'bar' ? OSM_BAR : [...OSM_FOOD, ...OSM_BAR];
      const query = `[out:json][timeout:25];nwr["amenity"~"^(${amenities.join('|')})$"](around:${radius},${lat},${lng});out center tags 200;`;

      let data;
      let lastError;
      for (const mirror of OVERPASS_MIRRORS) {
        try {
          data = await fetchJson(mirror, { method: 'POST', body: new URLSearchParams({ data: query }) }, 30000);
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (!data) throw new Error(`가게 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요. (${lastError?.message})`);

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
    },
  };
}

// ---------- 선택 ----------

async function createBackend() {
  let backend;
  try {
    backend = await serverBackend();
  } catch {
    const kakaoKey = (window.APP_CONFIG?.kakaoJsKey || '').trim();
    backend = kakaoKey ? await kakaoBackend(kakaoKey).catch((e) => {
      console.warn(e.message, '→ OpenStreetMap 사용');
      return osmBackend();
    }) : osmBackend();
  }
  return {
    provider: backend.provider,
    geocode: memoize(backend.geocode),
    reverse: memoize(backend.reverse),
    places: memoize(backend.places),
  };
}
