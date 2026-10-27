const $ = (sel) => document.querySelector(sel);

const state = {
  center: null, // { lat, lng, label }
  type: 'all',
  radius: 500,
  places: [],
};

// ---------- 지도 ----------

// 키 없이 쓸 수 있는 OSM 타일 하나를 쓰고, 다크맵은 CSS 필터로 만든다
const mapEl = $('#map');
const map = L.map(mapEl, { zoomControl: false }).setView([37.5665, 126.978], 13); // 서울시청
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
mapEl.classList.add('dark');

const placeLayer = L.layerGroup().addTo(map);
let centerMarker = null;
let radiusCircle = null;
const markers = new Map();

const placeIcon = (kind) => L.divIcon({
  className: '',
  html: `<div class="pin ${kind}">${kind === 'bar' ? '🦇' : '🎃'}</div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -18],
});

const meIcon = L.divIcon({ className: '', html: '<div class="me-pin"><i></i></div>', iconSize: [24, 24] });

// 지도 클릭으로도 기준 위치 변경
map.on('click', (e) => setCenter(e.latlng.lat, e.latlng.lng, null));

document.querySelectorAll('.map-style button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const style = btn.dataset.style;
    document.querySelectorAll('.map-style button').forEach((b) => b.classList.toggle('active', b === btn));
    mapEl.classList.toggle('dark', style === 'dark');
  });
});

$('#recenter').addEventListener('click', () => {
  if (radiusCircle) map.fitBounds(radiusCircle.getBounds(), { padding: [20, 20] });
});

// ---------- 데이터 (providers.js) ----------

const backendReady = createBackend();

// ---------- 표시 ----------

function setStatus(html, isError = false) {
  const el = $('#status');
  el.innerHTML = html;
  el.classList.toggle('error', isError);
}

function setOrigin(label) {
  const el = $('#origin');
  el.hidden = !label;
  el.textContent = label ? `기준: ${label}` : '';
}

const formatDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ---------- 핵심 흐름 ----------

async function setCenter(lat, lng, label) {
  state.center = { lat, lng, label };
  setOrigin(label);

  if (centerMarker) centerMarker.remove();
  centerMarker = L.marker([lat, lng], { icon: meIcon, zIndexOffset: 1000, interactive: false }).addTo(map);

  if (!label) {
    const center = state.center;
    backendReady
      .then((backend) => backend.reverse(lat, lng))
      .then((address) => {
        if (address && state.center === center) {
          center.label = address;
          setOrigin(address);
        }
      })
      .catch(() => {});
  }

  await loadPlaces();
}

async function loadPlaces() {
  const { center, radius, type } = state;
  if (!center) return;

  if (radiusCircle) radiusCircle.remove();
  radiusCircle = L.circle([center.lat, center.lng], {
    radius,
    color: '#ff7b00',
    weight: 2.5,
    dashArray: '10 8',
    fillColor: '#ff7b00',
    fillOpacity: 0.06,
    interactive: false,
  }).addTo(map);
  map.fitBounds(radiusCircle.getBounds(), { padding: [20, 20] });
  $('#recenter').hidden = false;

  setStatus('🔮 주변 가게를 소환하는 중…');
  $('#list').innerHTML = '';
  placeLayer.clearLayers();
  markers.clear();

  try {
    const backend = await backendReady;
    const places = await backend.places(center.lat, center.lng, radius, type);
    // 응답이 늦게 오는 사이 다른 검색이 시작됐으면 무시
    if (state.center !== center || state.radius !== radius || state.type !== type) return;
    state.places = places;
    render(backend.provider);
  } catch (e) {
    setStatus(`👻 ${escapeHtml(e.message)}`, true);
  }
}

function render(provider) {
  const { places } = state;
  const label = { all: '맛집·술집', food: '맛집', bar: '술집' }[state.type];
  const foodCount = places.filter((p) => p.kind === 'food').length;

  setStatus(`반경 ${formatDistance(state.radius)} 안에 ${label} <span class="count">${places.length}곳</span>`);

  $('#legend').hidden = false;
  $('#count-food').textContent = foodCount;
  $('#count-bar').textContent = places.length - foodCount;

  $('#source').textContent = provider === 'kakao'
    ? '데이터: 카카오 로컬 · 평점은 카카오맵에서'
    : '데이터: OpenStreetMap';

  const list = $('#list');
  if (!places.length) {
    list.innerHTML = `<li class="empty"><span class="big">🕸️</span>이 근처엔 ${label}이(가) 안 보여요.<br>반경을 넓혀보세요.</li>`;
    return;
  }

  list.innerHTML = places.map((p) => {
    const naverUrl = `https://map.naver.com/p/search/${encodeURIComponent(p.name)}?c=${p.lng},${p.lat},17,0,0,0,dh`;
    const kakaoUrl = p.url || `https://map.kakao.com/link/map/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
    const routeUrl = `https://map.kakao.com/link/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
    return `
      <li class="card ${p.kind}" data-id="${escapeHtml(p.id)}">
        <div class="card-head">
          <span class="badge ${p.kind}">${p.kind === 'bar' ? '🦇 술집' : '🎃 맛집'}</span>
          <span class="dist">${formatDistance(p.distance)}</span>
        </div>
        <h3>${escapeHtml(p.name)}</h3>
        ${p.category ? `<div class="category">${escapeHtml(p.category.replace(/ > /g, ' • '))}</div>` : ''}
        ${p.address || p.phone ? `
          <div class="info">
            ${p.address ? `<div>📌 ${escapeHtml(p.address)}</div>` : ''}
            ${p.phone ? `<div class="phone">📞 ${escapeHtml(p.phone)}</div>` : ''}
          </div>` : ''}
        <div class="actions">
          <a href="${escapeHtml(kakaoUrl)}" target="_blank" rel="noopener">🟡 카카오맵</a>
          <a href="${escapeHtml(naverUrl)}" target="_blank" rel="noopener">🟢 네이버지도</a>
          <a class="go" href="${escapeHtml(routeUrl)}" target="_blank" rel="noopener">🧭 길찾기</a>
        </div>
      </li>`;
  }).join('');

  for (const p of places) {
    const marker = L.marker([p.lat, p.lng], { icon: placeIcon(p.kind) })
      .bindPopup(
        `<strong>${p.kind === 'bar' ? '🦇' : '🎃'} ${escapeHtml(p.name)}</strong>${escapeHtml(p.category || '')}<br>거리 <b>${formatDistance(p.distance)}</b>`,
        { className: p.kind },
      )
      .on('click', () => highlight(p.id, true))
      .addTo(placeLayer);
    markers.set(p.id, marker);
  }
}

function highlight(id, scrollList) {
  document.querySelectorAll('.card.active, .pin.active').forEach((el) => el.classList.remove('active'));
  markers.get(id)?.getElement()?.querySelector('.pin')?.classList.add('active');
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.add('active');
  if (scrollList) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- 이벤트 ----------

$('#list').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  const marker = markers.get(card.dataset.id);
  if (marker) {
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17));
    marker.openPopup();
  }
  highlight(card.dataset.id, false);
});

const suggestions = $('#suggestions');

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#address').value.trim();
  if (!q) return;
  suggestions.hidden = true;
  setStatus('🔮 주소를 찾는 중…');
  try {
    const results = await (await backendReady).geocode(q);
    if (!results.length) return setStatus('👻 주소를 찾지 못했어요. 다르게 입력해보세요.', true);
    if (results.length === 1) return setCenter(results[0].lat, results[0].lng, results[0].name);
    // 후보가 여러 개면 고르게 함
    suggestions.innerHTML = results
      .map((r, i) => `<li data-i="${i}">📍 ${escapeHtml(r.name)}</li>`)
      .join('');
    suggestions.hidden = false;
    suggestions.onclick = (ev) => {
      const li = ev.target.closest('li');
      if (!li) return;
      const r = results[li.dataset.i];
      suggestions.hidden = true;
      setCenter(r.lat, r.lng, r.name);
    };
    setStatus('검색 결과 중 하나를 선택하세요.');
  } catch (err) {
    setStatus(`👻 ${escapeHtml(err.message)}`, true);
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#search-form')) suggestions.hidden = true;
});

$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('👻 이 브라우저는 위치 기능을 지원하지 않아요.', true);
  const btn = $('#locate');
  btn.disabled = true;
  setStatus('🔮 현재 위치를 확인하는 중…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      $('#address').value = '';
      setCenter(pos.coords.latitude, pos.coords.longitude, null);
    },
    (err) => {
      btn.disabled = false;
      const msg = err.code === err.PERMISSION_DENIED
        ? '👻 위치 권한이 거부됐어요. 브라우저 설정에서 허용하거나 주소를 입력해주세요.'
        : '👻 현재 위치를 가져오지 못했어요. 주소를 입력해주세요.';
      setStatus(msg, true);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    state.type = chip.dataset.type;
    loadPlaces();
  });
});

$('#radius').addEventListener('change', (e) => {
  state.radius = Number(e.target.value);
  loadPlaces();
});
