'use strict';

// Warmup cloud API client.
//
// Authentication: REST `userLogin` at api.warmup.com → access token.
// All other operations: GraphQL at apil.warmup.com (the canonical Warmup API).
//
// The REST surface at /apps/app/v1 is a legacy compatibility layer. The
// GraphQL surface is what the Warmup mobile app actually uses for the
// modern feature set — per-room off, override-with-minutes, energy data,
// holiday mode, etc. See ROADMAP.md M3 for the full migration story.

const debug = require('debug')('warmup4ie:lib');

const REST_URL = 'https://api.warmup.com/apps/app/v1';
const GRAPHQL_URL = 'https://apil.warmup.com/graphql';
const APP_TOKEN = 'M=;He<Xtg"$}4N%5k{$:PD+WA"]D<;#PriteY|VTuA>_iyhs+vA"4lic{6-LqNM:';

const REQUEST_HEADERS = {
  'user-agent': 'WARMUP_APP',
  'accept-encoding': 'br, gzip, deflate',
  'accept': '*/*',
  'connection': 'close',
  'content-type': 'application/json',
  'app-token': APP_TOKEN,
  'app-version': '1.8.1',
  'accept-language': 'de-de'
};
const REQUEST_TIMEOUT_MS = 10000;

// Mutation arg types verbatim from jondarrer/warmup-api/warmup-schema.graphql.
// `lid: Int!` (required), `rid: Int` (nullable — omit for location-wide;
// pass for per-room).
//
// For reads we use `user.owned[].rooms` — this is the path the real Warmup
// mobile app uses (per http-requests.http in the same repo). The
// `user.location(id: $lid)` schema field exists but the gateway rejects
// it with HTTP 409 in practice; `owned[]` is the supported shape.
const GQL_OWNED_AND_ROOMS = `
  query OwnedAndRooms {
    user {
      owned {
        id
        name
        rooms {
          id
          roomName
          runMode
          roomMode
          targetTemp
          currentTemp
          overrideDur
          overrideTemp
          fixedTemp
          energy
          cost
          total
          thermostat4ies {
            deviceSN
            appFw
            wifiFw
            airTemp
            floor1Temp
            floor2Temp
            minTemp
            maxTemp
            lastPoll
            isFaultAir
            isFaultFloor1
            isFaultFloor2
            parameters { outputStatus lock }
          }
        }
      }
    }
  }
`.trim();

const GQL_DEVICE_PROGRAM = 'mutation DeviceProgram($lid: Int!, $rid: Int) { deviceProgram(lid: $lid, rid: $rid) }';
const GQL_DEVICE_OFF = 'mutation DeviceOff($lid: Int!, $rid: Int) { deviceOff(lid: $lid, rid: $rid) }';
const GQL_DEVICE_OVERRIDE = 'mutation DeviceOverride($lid: Int!, $rid: Int, $temperature: Int!, $minutes: Int!) { deviceOverride(lid: $lid, rid: $rid, temperature: $temperature, minutes: $minutes) }';

// Location-wide modes (M6 batch 4 — v3.6.0). All take only `lid` and apply
// to every room at the location. `rid` is omitted (the schema accepts that;
// see jondarrer/warmup-api).
const GQL_DEVICE_FROST_ALL = 'mutation DeviceFrostAll($lid: Int!) { deviceFrost(lid: $lid) }';
const GQL_DEVICE_PROGRAM_ALL = 'mutation DeviceProgramAll($lid: Int!) { deviceProgram(lid: $lid) }';
const GQL_DEVICE_HOLIDAY = 'mutation DeviceHoliday($lid: Int!, $temperature: Int!, $days: Int!, $start: String!, $end: String!) { deviceHoliday(lid: $lid, temperature: $temperature, days: $days, start: $start, end: $end) }';
const GQL_CANCEL_HOLIDAY = 'mutation CancelHoliday($lid: Int!) { cancelHoliday(lid: $lid) }';

// Defaults for the "Vacation Mode" switch — frost-low temperature for a
// year. Users wanting custom values use the Warmup app; HomeKit gives one
// tap-to-vacation, tap-to-resume.
const HOLIDAY_DEFAULT_TEMP_C = 5;
const HOLIDAY_DEFAULT_DAYS = 365;

// `deviceAdvanced` is the kitchen-sink mutation for per-thermostat config —
// child lock, brightness, sensor offsets, etc. We currently only use it for
// child lock (M6 batch 5). Other args are sent as-is when the caller passes
// them; the gateway accepts partial argument lists.
const GQL_DEVICE_ADVANCED_LOCK = 'mutation DeviceAdvancedLock($lid: Int!, $rid: Int!, $lock: Boolean!) { deviceAdvanced(lid: $lid, rid: $rid, lock: $lock) }';

// Token-related errors that should trigger one re-auth + retry. Includes
// HTTP 401, REST status.code 100/102/103, and any GraphQL error message
// containing token/auth keywords.
const TOKEN_ERROR_PATTERN = /Warmup HTTP 401|"code":\s*(?:100|102|103)|Warmup GraphQL: .*\b(token|auth|unauthorized|forbidden)/i;

class Warmup4IE {
  constructor(options, callback) {
    this._username = options.username;
    this._password = options.password;
    this._duration = options.duration;
    this._token = null;
    this._locId = null;
    this.room = [];

    if (typeof callback === 'function') {
      this._bootstrap().then(
        (rooms) => callback(null, rooms),
        (err) => callback(err)
      );
    }
  }

  async _bootstrap() {
    await this._login();
    return this._fetchRooms();
  }

  // ---------------------------------------------------------------------------
  // Transport — generic HTTP, then per-protocol (REST / GraphQL) wrappers.
  // ---------------------------------------------------------------------------

  async _fetch(url, body, extraHeaders = {}) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { ...REQUEST_HEADERS, ...extraHeaders },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (ex) {
      throw new Error(`Warmup network error: ${ex.message}`);
    }

    if (!response.ok) {
      throw new Error(`Warmup HTTP ${response.status}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (ex) {
      throw new Error(`Warmup JSON parse error: ${ex.message}`);
    }
  }

  // REST POST. Used only for `userLogin`.
  async _rest(body) {
    const json = await this._fetch(REST_URL, body);
    if (json.status && json.status.result !== 'success') {
      const detail = json.message || json.status.message || JSON.stringify(json.status);
      throw new Error(`Warmup API: ${detail}`);
    }
    return json;
  }

  // GraphQL POST. The token rides as `warmup-authorization` (NOT in the body).
  async _graphql(query, variables = {}) {
    const json = await this._fetch(GRAPHQL_URL, { query, variables }, {
      'warmup-authorization': this._token || ''
    });
    if (json.errors && json.errors.length) {
      const detail = json.errors.map((e) => e.message).join('; ');
      throw new Error(`Warmup GraphQL: ${detail}`);
    }
    return json.data;
  }

  // GraphQL with one re-auth + retry on token-related failures.
  async _authenticatedGraphQL(query, variables = {}) {
    try {
      return await this._graphql(query, variables);
    } catch (err) {
      if (!this._isTokenError(err)) throw err;
      debug('Token rejected by Warmup, re-authenticating');
      this._token = null;
      await this._login();
      return this._graphql(query, variables);
    }
  }

  _isTokenError(err) {
    return TOKEN_ERROR_PATTERN.test((err && err.message) || '');
  }

  // ---------------------------------------------------------------------------
  // Auth + bootstrap
  // ---------------------------------------------------------------------------

  async _login() {
    const json = await this._rest({
      request: {
        email: this._username,
        password: this._password,
        method: 'userLogin',
        appId: 'WARMUP-APP-V001'
      }
    });
    const token = json && json.response && json.response.token;
    if (!token) {
      throw new Error('Warmup API: login response did not include a token');
    }
    this._token = token;
  }

  // ---------------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------------

  // Single GraphQL round trip that returns owned locations + their rooms.
  // We pick `owned[0]` (by design — multi-location accounts use the first
  // location only) and store its id as `_locId` for use by write mutations.
  async _fetchRooms() {
    const data = await this._authenticatedGraphQL(GQL_OWNED_AND_ROOMS);
    const owned = (data && data.user && data.user.owned) || [];
    const first = owned[0];
    if (!first) throw new Error('No locations on Warmup account.');

    this._locId = first.id;
    const rooms = (first.rooms || []).map((r) => normalizeRoom(r));
    const nextRoomCache = [];
    rooms.forEach((room) => {
      nextRoomCache[room.roomId] = room;
    });
    this.room = nextRoomCache;
    return rooms;
  }

  async getStatus() {
    return this._fetchRooms();
  }

  // ---------------------------------------------------------------------------
  // Write API — all GraphQL, all per-room (the v3 unlock).
  // ---------------------------------------------------------------------------

  async setRoomAuto(roomId) {
    return this._authenticatedGraphQL(GQL_DEVICE_PROGRAM, { lid: this._locId, rid: roomId });
  }

  // Per-room hard off (replaces the v2 location-wide `setModes locMode:"off"`
  // workaround). Tapping Off on one HomeKit thermostat now affects only that
  // room, matching the Warmup mobile app's per-room Off button.
  async setRoomOff(roomId) {
    return this._authenticatedGraphQL(GQL_DEVICE_OFF, { lid: this._locId, rid: roomId });
  }

  async setTargetTemperature(roomId, value) {
    return this._authenticatedGraphQL(GQL_DEVICE_OVERRIDE, {
      lid: this._locId,
      rid: roomId,
      temperature: toWarmupTemperature(value),
      minutes: this._duration
    });
  }

  // Location-wide modes — `rid` omitted = applies to every room.

  async setLocationFrost() {
    return this._authenticatedGraphQL(GQL_DEVICE_FROST_ALL, { lid: this._locId });
  }

  // No "clear frost" mutation in the schema. Resume schedule (program) for
  // the whole location — that's what the Warmup app does.
  async clearLocationFrost() {
    return this._authenticatedGraphQL(GQL_DEVICE_PROGRAM_ALL, { lid: this._locId });
  }

  async setLocationHoliday(temperatureC = HOLIDAY_DEFAULT_TEMP_C, days = HOLIDAY_DEFAULT_DAYS) {
    return this._authenticatedGraphQL(GQL_DEVICE_HOLIDAY, {
      lid: this._locId,
      temperature: Math.round(temperatureC * 10),
      days,
      start: warmupDateString(new Date(), '00:00:00'),
      end: warmupDateString(new Date(Date.now() + days * 86400000), '23:59:59')
    });
  }

  async clearLocationHoliday() {
    return this._authenticatedGraphQL(GQL_CANCEL_HOLIDAY, { lid: this._locId });
  }

  // Child lock — toggles `Thermostat4iE.parameters.lock` via deviceAdvanced.
  // True = locked (touch screen disabled), false = unlocked (normal).
  async setRoomChildLock(roomId, locked) {
    return this._authenticatedGraphQL(GQL_DEVICE_ADVANCED_LOCK, {
      lid: this._locId,
      rid: roomId,
      lock: Boolean(locked)
    });
  }
}

// ---------------------------------------------------------------------------
// Internal — normalize a GraphQL Room payload into the shape the platform
// expects. The schema spreads fields across `Room` and the embedded
// `thermostat4ies[0]` (airTemp, minTemp, maxTemp, lastPoll, fault flags
// all live there). We flatten so index.js can consume rooms uniformly
// regardless of transport.
// ---------------------------------------------------------------------------
function normalizeRoom(r) {
  const t = (r.thermostat4ies && r.thermostat4ies[0]) || {};
  const params = t.parameters || {};
  const lockValue = params.lock;
  return {
    // GraphQL returns Room.id; the platform (legacy from REST) expects roomId.
    roomId: r.id,
    roomName: r.roomName,
    runMode: r.runMode,
    roomMode: r.roomMode,
    targetTemp: r.targetTemp,
    currentTemp: r.currentTemp,
    // airTemp lives on the Thermostat4iE in GraphQL (as a String). Falling
    // back to Room.airTemp if the schema ever moves it.
    airTemp: t.airTemp || r.airTemp,
    minTemp: t.minTemp,
    maxTemp: t.maxTemp,
    overrideDur: r.overrideDur,
    overrideTemp: r.overrideTemp,
    fixedTemp: r.fixedTemp,
    energy: r.energy,
    cost: r.cost,
    // Cumulative energy since first install — Eve.app reads this for the
    // long-term TotalConsumption graph. `r.energy` is today-only and
    // resets daily; `r.total` is monotonic.
    total: r.total,
    // Per-thermostat metadata. Fault flags drive the platform's `StatusFault`
    // characteristic (M6 batch 1). The rest are queued for follow-up:
    //   - `floor1Temp`/`floor2Temp` — exposed as a separate sensor in M6+.
    //   - `deviceSN` — could replace `warmup4ie-<roomId>` as SerialNumber, but
    //     would force HomeKit to re-pair existing accessories. Not worth it.
    //   - `lastPoll` — drives `StatusActive` (offline detection) in M6+.
    //   - `parameters { outputStatus }` (relay state) is not in the GraphQL
    //     query yet — re-adding caused a 409 during v3 development; M6 will
    //     try again carefully and use it for `CurrentHeatingCoolingState`.
    floor1Temp: t.floor1Temp,
    floor2Temp: t.floor2Temp,
    isFaultAir: t.isFaultAir,
    isFaultFloor1: t.isFaultFloor1,
    isFaultFloor2: t.isFaultFloor2,
    deviceSN: t.deviceSN,
    // Device firmware versions. `appFw` populates AccessoryInformation's
    // FirmwareRevision when it parses as a valid SemVer-ish string.
    appFw: t.appFw,
    wifiFw: t.wifiFw,
    // Child lock state from Thermostat4iE.parameters.lock (Int — 0/1 in
    // practice). Cast to boolean for HomeKit; null when the field isn't
    // in the payload (older API responses).
    lock: typeof lockValue === 'number' ? lockValue !== 0 : null,
    lastPoll: t.lastPoll,
    // Real "is currently heating" relay signal — non-zero when the relay
    // is closed. Used by `deriveCurrentHeatingState` in preference to the
    // currentTemp<targetTemp heuristic when present.
    outputStatus: typeof params.outputStatus === 'number' ? params.outputStatus : null
  };
}

function toWarmupTemperature(value) {
  const temperature = Number(value);
  if (!Number.isFinite(temperature)) {
    throw new Error(`Invalid target temperature: ${value}`);
  }
  return Math.round(temperature * 10);
}

// "YYYY-MM-DD HH:MM:SS" — the format `deviceHoliday` expects per the schema's
// arg description (jondarrer/warmup-api). Built from local components so the
// Warmup server interprets it in the same wall-clock zone the user lives in.
function warmupDateString(date, timeOfDay) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${timeOfDay}`;
}

module.exports = { Warmup4IE };
