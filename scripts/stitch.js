// Google Stitch MCP 엔드포인트를 호출하는 작은 CLI
// 사용법: node scripts/stitch.js <tool_name> '<json args>'   (tool_name 생략 시 도구 목록)
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
const KEY = process.env.STITCH_API_KEY;
if (!KEY) throw new Error('.env 에 STITCH_API_KEY 를 설정하세요.');

async function rpc(method, params) {
  const res = await fetch('https://stitch.googleapis.com/mcp', {
    method: 'POST',
    headers: { 'X-Goog-Api-Key': KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const text = await res.text();
  const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).pop().slice(5));
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

(async () => {
  const [tool, args] = process.argv.slice(2);
  if (!tool) {
    const { tools } = await rpc('tools/list');
    for (const t of tools) console.log(`${t.name}\n  ${t.description.trim().split('\n')[0]}\n  args: ${JSON.stringify(Object.keys(t.inputSchema.properties || {}))} required: ${JSON.stringify(t.inputSchema.required || [])}`);
    return;
  }
  const result = await rpc('tools/call', { name: tool, arguments: args ? JSON.parse(args) : {} });
  console.log(JSON.stringify(result.structuredContent ?? result, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
