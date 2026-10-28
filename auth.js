// 소셜 로그인 (카카오 · 네이버 · 구글) — OAuth 2.0 Authorization Code 방식, 외부 의존성 없음
// - .env에 키가 있는 제공자만 켜진다
// - 세션은 서명된 쿠키(HMAC)라서 서버를 재시작하거나 여러 대로 늘려도 유지된다 (SESSION_SECRET 필요)
//
// 라우트
//   GET  /auth/:provider           → 제공자 로그인 페이지로 이동
//   GET  /auth/:provider/callback  → 코드 교환, 프로필 조회, 세션 쿠키 발급 후 / 로 이동
//   POST /auth/logout              → 세션 삭제
//   GET  /api/me                   → { user, providers }
const crypto = require('crypto');

const env = (k) => (process.env[k] || '').trim();
const BASE_URL = (env('BASE_URL') || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/$/, '');

// 이름이 없으면(동의항목 미설정 등) 이메일 앞부분, 그것도 없으면 계정 ID를 보여준다
const displayName = (...candidates) => candidates.find((v) => v && String(v).trim()) || '';
const emailId = (email) => (email ? String(email).split('@')[0] : null);

const PROVIDERS = {
  kakao: {
    clientId: env('KAKAO_REST_API_KEY'),
    clientSecret: env('KAKAO_CLIENT_SECRET'), // 콘솔에서 Client Secret을 "사용함"으로 했을 때만 필요
    authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    scope: '',
    async profile(token) {
      const me = await getJson('https://kapi.kakao.com/v2/user/me', token);
      const p = me.kakao_account?.profile || {};
      const email = me.kakao_account?.email || null;
      return {
        id: String(me.id),
        name: displayName(p.nickname, emailId(email), String(me.id)),
        image: p.thumbnail_image_url || p.profile_image_url || null,
        email,
      };
    },
  },
  naver: {
    clientId: env('NAVER_CLIENT_ID'),
    clientSecret: env('NAVER_CLIENT_SECRET'),
    authorizeUrl: 'https://nid.naver.com/oauth2.0/authorize',
    tokenUrl: 'https://nid.naver.com/oauth2.0/token',
    scope: '',
    async profile(token) {
      const { response: r } = await getJson('https://openapi.naver.com/v1/nid/me', token);
      return {
        id: r.id,
        name: displayName(r.nickname, r.name, emailId(r.email), r.id),
        image: r.profile_image || null,
        email: r.email || null,
      };
    },
  },
  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    async profile(token) {
      const r = await getJson('https://openidconnect.googleapis.com/v1/userinfo', token);
      return { id: r.sub, name: displayName(r.name, emailId(r.email), r.sub), image: r.picture || null, email: r.email || null };
    },
  },
};

// 키가 있는 제공자만 사용 (네이버·구글은 Client Secret까지 있어야 함)
const enabled = Object.keys(PROVIDERS).filter((name) => {
  const p = PROVIDERS[name];
  return p.clientId && (name === 'kakao' || p.clientSecret);
});

async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${url} ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- 세션 (서명된 쿠키) ----------
// 쿠키 값 = base64url(JSON{user, exp}) + "." + HMAC-SHA256. 서버에 저장하는 것이 없다.

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL_SEC = 10 * 60;

let SECRET = env('SESSION_SECRET');
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET이 없어 임시 키를 씁니다. 서버를 재시작하면 모두 로그아웃됩니다.');
}

const randomId = () => crypto.randomBytes(24).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function seal(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data)}`;
}

function unseal(value) {
  const [data, mac] = String(value || '').split('.');
  if (!data || !mac) return null;
  const expected = sign(data);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeSec) {
  const secure = BASE_URL.startsWith('https://') ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function getUser(req) {
  return unseal(parseCookies(req).sid)?.user || null;
}

// 찜 등 사용자별 데이터의 키 (예: "kakao:123456")
const userKey = (user) => `${user.provider}:${user.id}`;

// ---------- 라우트 ----------

const redirect = (res, location, headers = {}) => {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
};

const callbackUrl = (name) => `${BASE_URL}/auth/${name}/callback`;

function startLogin(name, res) {
  const p = PROVIDERS[name];
  const state = randomId();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: callbackUrl(name),
    state,
  });
  if (p.scope) params.set('scope', p.scope);
  // state는 서명 쿠키에 담아 두고 콜백에서 비교 (로그인 요청 위조 방지)
  const stateCookie = cookie('oauth_state', seal({ state, provider: name, exp: Date.now() + STATE_TTL_SEC * 1000 }), STATE_TTL_SEC);
  redirect(res, `${p.authorizeUrl}?${params}`, { 'Set-Cookie': stateCookie });
}

async function finishLogin(name, url, req, res) {
  const params = url.searchParams;
  const state = params.get('state');
  const pending = unseal(parseCookies(req).oauth_state);
  const clearState = cookie('oauth_state', '', 0);

  // 사용자가 동의 화면에서 취소한 경우 등
  if (params.get('error')) return redirect(res, '/?login=cancelled', { 'Set-Cookie': clearState });
  if (!pending || pending.provider !== name || pending.state !== state) {
    return redirect(res, '/?login=expired', { 'Set-Cookie': clearState });
  }

  const p = PROVIDERS[name];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: p.clientId,
    redirect_uri: callbackUrl(name),
    code: params.get('code') || '',
    state,
  });
  if (p.clientSecret) body.set('client_secret', p.clientSecret);

  const tokenRes = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) {
    throw new Error(`${name} 토큰 발급 실패: ${tokenRes.status} ${JSON.stringify(token).slice(0, 200)}`);
  }

  const profile = await p.profile(token.access_token);
  // 카카오 프로필 사진이 http로 오는 경우가 있어 https로 (HTTPS 페이지에서 깨짐 방지)
  if (profile.image) profile.image = profile.image.replace(/^http:\/\//, 'https://');
  const sid = seal({ user: { provider: name, ...profile }, exp: Date.now() + SESSION_TTL });
  redirect(res, '/', { 'Set-Cookie': [cookie('sid', sid, SESSION_TTL / 1000), clearState] });
}

function logout(res) {
  res.writeHead(204, { 'Set-Cookie': cookie('sid', '', 0), 'Cache-Control': 'no-store' });
  res.end();
}

// 처리했으면 true
async function handleAuth(url, req, res) {
  const { pathname } = url;

  if (pathname === '/api/me') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ user: getUser(req), providers: enabled }));
    return true;
  }

  if (pathname === '/auth/logout' && req.method === 'POST') {
    logout(res);
    return true;
  }

  const m = pathname.match(/^\/auth\/([a-z]+)(\/callback)?$/);
  if (!m) return false;
  const [, name, isCallback] = m;
  if (!enabled.includes(name)) {
    redirect(res, '/?login=unavailable');
    return true;
  }

  try {
    if (isCallback) await finishLogin(name, url, req, res);
    else startLogin(name, res);
  } catch (e) {
    console.error(`[auth:${name}]`, e.message);
    redirect(res, '/?login=failed');
  }
  return true;
}

module.exports = { handleAuth, getUser, userKey, enabledProviders: enabled, BASE_URL };
