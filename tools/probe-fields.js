// Probe candidate Warmup GraphQL fields against a real account.
//
// Kept in the repo because the Warmup API is unofficial and unversioned: the
// only way to learn what a field actually returns is to ask a real account.
// The 2026-08-28 survey recorded in CLAUDE.md was produced with this, and it
// caught a trap before any code was written — `secondaryTemp` returns 900 as
// a "no probe fitted" sentinel, so a naive floor-temperature sensor would
// have published 90 °C to every user without a floor probe.
//
// Edit GROUPS below to probe new fields. Nothing here ships to users; the
// npm tarball excludes tools/ (see .npmignore).
//
// The schema we work from (jondarrer/warmup-api) is an introspected snapshot,
// and the gateway has rejected schema-valid queries before — `user.location(id:)`
// 409s despite being in the schema. So each field group is queried SEPARATELY:
// a rejection then isolates the culprit instead of failing the whole probe.
//
// Usage:
//   WARMUP_USERNAME=you@example.com WARMUP_PASSWORD='...' node probe-fields.js
//
// Prints field availability and sample values. Room names will appear in the
// output; nothing else identifying is requested.

const REST_URL = 'https://api.warmup.com/apps/app/v1';
const GRAPHQL_URL = 'https://apil.warmup.com/graphql';
const APP_TOKEN = 'M=;He<Xtg"$}4N%5k{$:PD+WA"]D<;#PriteY|VTuA>_iyhs+vA"4lic{6-LqNM:';
const H = {
  'user-agent': 'WARMUP_APP', 'accept-encoding': 'br, gzip, deflate', 'accept': '*/*',
  'connection': 'close', 'content-type': 'application/json', 'app-token': APP_TOKEN,
  'app-version': '1.8.1', 'accept-language': 'en-gb', 'x-request-type': 'GraphQL'
};

const user = process.env.WARMUP_USERNAME;
const pass = process.env.WARMUP_PASSWORD;
if (!user || !pass) {
  console.error('Set WARMUP_USERNAME and WARMUP_PASSWORD.');
  process.exit(1);
}

let token = null;

async function login() {
  const r = await fetch(REST_URL, {
    method: 'POST', headers: H,
    body: JSON.stringify({ request: { email: user, password: pass, method: 'userLogin', appId: 'WARMUP-APP-V001' } }),
    signal: AbortSignal.timeout(20000)
  });
  const j = JSON.parse(await r.text());
  token = j && j.response && j.response.token;
  if (!token) throw new Error('login failed: ' + JSON.stringify(j.status || j));
}

async function gql(query) {
  const r = await fetch(GRAPHQL_URL, {
    method: 'POST', headers: { ...H, 'warmup-authorization': token },
    body: JSON.stringify({ query, variables: {} }),
    signal: AbortSignal.timeout(20000)
  });
  const text = await r.text();
  if (!r.ok) return { httpError: r.status, body: text.slice(0, 200) };
  const j = JSON.parse(text);
  if (j.errors) return { gqlError: j.errors.map((e) => e.message).join('; ') };
  return { data: j.data };
}

// Each group is queried on its own so one rejected field cannot mask the rest.
const GROUPS = [
  ['BASELINE (what we ship today)', 'id roomName runMode targetTemp currentTemp', ''],
  ['Room: main/secondary labelled readings', 'id roomName mainTemp mainLabel secondaryTemp secondaryLabel', ''],
  ['Room: floor + room type', 'id roomName floorType floorTypeInt roomType roomTypeStr', ''],
  ['Thermostat: heatingTarget / systemType / type', 'id roomName', 'heatingTarget systemType type'],
  ['Thermostat: parameters detail', 'id roomName', 'parameters { heatingTarget floorType rssi fwVer brightness offsetAir offsetFloor1 controlMethod }'],
  ['Room: energy fields', 'id roomName energy cost total', '']
];

(async () => {
  await login();
  console.log('login OK\n');

  for (const [label, roomFields, thermoFields] of GROUPS) {
    const thermo = thermoFields ? `thermostat4ies { ${thermoFields} }` : '';
    const q = `query { user { owned { id rooms { ${roomFields} ${thermo} } } } }`;
    const res = await gql(q);

    if (res.httpError) { console.log(`✗ ${label}\n    HTTP ${res.httpError} — ${res.body}\n`); continue; }
    if (res.gqlError) { console.log(`✗ ${label}\n    ${res.gqlError}\n`); continue; }

    const rooms = ((res.data.user.owned || [])[0] || {}).rooms || [];
    console.log(`✓ ${label}  (${rooms.length} rooms)`);
    for (const r of rooms) {
      const t = (r.thermostat4ies || [])[0] || {};
      const bits = [];
      for (const [k, v] of Object.entries(r)) {
        if (k === 'thermostat4ies' || k === 'id') continue;
        bits.push(`${k}=${JSON.stringify(v)}`);
      }
      for (const [k, v] of Object.entries(t)) bits.push(`${k}=${JSON.stringify(v)}`);
      console.log('    ' + bits.join('  '));
    }
    console.log();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
