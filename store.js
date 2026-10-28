// 사용자별 찜 목록 저장소 — 외부 의존성 없음
// - Cloud Run(K_SERVICE 환경변수가 있음): Firestore REST API, 인증은 메타데이터 서버 토큰
//   문서: favorites/{userKey} = { items: "<찜 목록 JSON 문자열>" }
// - 로컬: data/favorites.json
const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 300;

// ---------- 로컬 파일 ----------

const FILE = path.join(__dirname, 'data', 'favorites.json');

function fileStore() {
  let db = {};
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return {
    async get(key) {
      return db[key] || [];
    },
    async put(key, items) {
      db[key] = items;
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(db));
    },
  };
}

// ---------- Firestore ----------

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';

async function metadata(p) {
  const res = await fetch(`${METADATA}/${p}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`metadata ${p} ${res.status}`);
  return res;
}

function firestoreStore() {
  let token = null; // { value, exp }
  let projectId = process.env.GOOGLE_CLOUD_PROJECT || null;

  async function auth() {
    if (!token || token.exp < Date.now() + 60_000) {
      const t = await (await metadata('instance/service-accounts/default/token')).json();
      token = { value: t.access_token, exp: Date.now() + t.expires_in * 1000 };
    }
    projectId ||= await (await metadata('project/project-id')).text();
    return token.value;
  }

  const docUrl = (key) => `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/favorites/${encodeURIComponent(key)}`;

  return {
    async get(key) {
      const t = await auth();
      const res = await fetch(docUrl(key), { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(8000) });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`Firestore get ${res.status} ${(await res.text()).slice(0, 200)}`);
      const doc = await res.json();
      return JSON.parse(doc.fields?.items?.stringValue || '[]');
    },
    async put(key, items) {
      const t = await auth();
      const res = await fetch(docUrl(key), {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { items: { stringValue: JSON.stringify(items) } } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Firestore put ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
  };
}

const backend = process.env.K_SERVICE ? firestoreStore() : fileStore();

// ---------- 찜 ----------

const str = (v, max) => (v == null ? null : String(v).slice(0, max));

// 클라이언트가 보낸 가게 정보에서 필요한 필드만 저장
function cleanPlace(p) {
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!p.id || !p.name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    id: str(p.id, 80),
    name: str(p.name, 80),
    kind: p.kind === 'bar' ? 'bar' : 'food',
    category: str(p.category, 120),
    address: str(p.address, 160),
    phone: str(p.phone, 30),
    lat,
    lng,
    url: /^https?:\/\//.test(p.url || '') ? str(p.url, 300) : null,
    savedAt: Date.now(),
  };
}

const favorites = {
  list: (key) => backend.get(key),

  async add(key, place) {
    const item = cleanPlace(place);
    if (!item) throw Object.assign(new Error('bad place'), { userMessage: '가게 정보가 올바르지 않아요.' });
    const items = (await backend.get(key)).filter((x) => x.id !== item.id);
    items.unshift(item);
    await backend.put(key, items.slice(0, MAX_ITEMS));
    return item;
  },

  async remove(key, id) {
    const items = await backend.get(key);
    await backend.put(key, items.filter((x) => x.id !== id));
  },
};

module.exports = { favorites };
