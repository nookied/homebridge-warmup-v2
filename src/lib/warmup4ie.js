// ---------------------------------------------------------------------------
// Part of homebridge-warmup4ie-v2 — a maintained fork of homebridge-warmup4ie
// (https://github.com/NorthernMan54/homebridge-warmup4ie), whose commits are
// preserved in this repository's history.
//
// Copyright 2019-2024 NorthernMan54  — original homebridge-warmup4ie
// Copyright 2026 Karol Nowacki       — this fork
//
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// ---------------------------------------------------------------------------

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
  // Matches what the official Warmup mobile app and jondarrer's request
  // traces send. Some Warmup error messages localize, so a non-en locale
  // can produce confusing German error strings in our `Warmup API:` errors.
  'accept-language': 'en-gb',
  // The official mobile app's introspection requests include this; not
  // strictly required by the gateway today but cheap insurance against
  // future stricter validation.
  'x-request-type': 'GraphQL'
};
// Raised from 10 s in v3.12.1. Real-host logs showed seven
// `aborted due to timeout` failures across three days — the Warmup cloud
// occasionally takes longer than 10 s from a domestic connection, and each
// timeout costs a whole poll cycle of stale data. 20 s absorbs those without
// letting a stuck request hold a poll slot for anything like the refresh
// interval.
//
// Note the worst case per poll is three requests, not one: a token error
// retries as initial → `_login` → retry. At 20 s each that is up to 60 s,
// which exceeds MIN_REFRESH_SECONDS — see the in-flight guard in
// `startPolling` (src/index.js), which is what keeps polls from overlapping.
const REQUEST_TIMEOUT_MS = 20000;

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
          mainTemp
          mainLabel
          secondaryTemp
          secondaryLabel
          overrideDur
          overrideTemp
          fixedTemp
          energy
          cost
          total
          thermostat4ies {
            deviceSN
            heatingTarget
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

// Fallback setpoint bounds, in tenths of °C, for a Room whose thermostat
// payload is missing (`thermostat4ies: []`). 5–30 °C is the range Warmup's
// own devices ship with and matches what real payloads report.
const DEFAULT_MIN_TEMP = 50;
const DEFAULT_MAX_TEMP = 300;

// Warmup reports `900` (= 90.0 °C) for a probe that is not fitted. It is a
// sentinel, not a reading: observed on all six devices of a real air-mode
// account (2026-08-28 survey, CLAUDE.md), identical across two firmware
// versions, and physically impossible for underfloor heating. Anything that
// surfaces a probe reading must drop it, or it publishes 90 °C to every user
// without that probe.
const NO_PROBE_SENTINEL = 900;

// `deviceAdvanced` is the kitchen-sink mutation for per-thermostat config —
// child lock, brightness, sensor offsets, etc. We currently only use it for
// child lock (M6 batch 5). Other args are sent as-is when the caller passes
// them; the gateway accepts partial argument lists.
const GQL_DEVICE_ADVANCED_LOCK = 'mutation DeviceAdvancedLock($lid: Int!, $rid: Int!, $lock: Boolean!) { deviceAdvanced(lid: $lid, rid: $rid, lock: $lock) }';

// Token-related errors that should trigger one re-auth + retry. Includes
// HTTP 401, REST status.code 100/102/103, and any GraphQL error message
// containing token/auth keywords.
//
// The REST `"code"` branch is vestigial — since v3.0 the REST surface is
// used only by `_login`, and `_isTokenError` is consulted only for errors
// thrown out of `_graphql`, which can never produce a `Warmup API:` message.
// Kept because it costs nothing and documents the v2-era contract.
const TOKEN_ERROR_PATTERN = /Warmup HTTP 401|"code":\s*(?:100|102|103)|Warmup GraphQL: .*\b(token|auth|unauthorized|forbidden)/i;

// Warmup's REST error payloads carry the useful signal in
// `response.errorCode`, not in any prose field — a wrong password comes back
// as `{"status":{"result":"error"},"response":{"errorCode":101}}` with no
// message anywhere. Without a mapping the Homebridge log showed the
// useless `Warmup API: {"result":"error"}` for the single most common
// failure mode users hit.
// Only codes confirmed against the live API get prose. Everything else is
// reported by number: a wrong guess ("access token expired" for something
// else entirely) would send the user down the wrong path, and the raw code
// is still searchable. The 100/102/103 that TOKEN_ERROR_PATTERN lists are
// deliberately absent — they come from the v2-era authenticated REST calls
// we no longer make, and `userLogin` has never been observed returning them.
const REST_ERROR_MESSAGES = {
  // Confirmed 2026-08-28 by logging in with a deliberately invalid
  // email/password pair.
  101: 'invalid email or password'
};

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
      // `cause` keeps the underlying error (DNS failure, TLS error, the
      // AbortSignal timeout) reachable for anyone debugging, while the
      // message stays the stable string that `_isTokenError` and
      // `asHapStatusError` pattern-match on.
      throw new Error(`Warmup network error: ${ex.message}`, { cause: ex });
    }

    if (!response.ok) {
      throw new Error(`Warmup HTTP ${response.status}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (ex) {
      throw new Error(`Warmup JSON parse error: ${ex.message}`, { cause: ex });
    }
  }

  // REST POST. Used only for `userLogin`.
  async _rest(body) {
    const json = await this._fetch(REST_URL, body);
    if (json.status && json.status.result !== 'success') {
      throw new Error(`Warmup API: ${restErrorDetail(json)}`);
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
    // Whether a thermostat is actually paired to this Room. A Room with an
    // empty `thermostat4ies` is real but has no hardware behind it, so every
    // reading below is absent and nothing can be controlled — the platform
    // uses this to report the accessory as inactive rather than inventing a
    // plausible-looking idle thermostat.
    hasThermostat: Boolean(r.thermostat4ies && r.thermostat4ies[0]),
    // Every temperature is normalized to a Number of tenths of °C, or `null`
    // when genuinely absent. GraphQL types these inconsistently (Int on Room,
    // String on Thermostat4iE) and all of them are nullable, so without this
    // a null would coerce to 0 (`Number(null) === 0`) and surface in HomeKit
    // as a real 0 °C reading. `null` lets the platform skip the write.
    targetTemp: tenths(r.targetTemp),
    currentTemp: tenths(r.currentTemp),
    // airTemp lives on the Thermostat4iE in GraphQL (as a String). Falling
    // back to Room.airTemp if the schema ever moves it. `null` (rather than
    // undefined) when absent, so the platform can tell "no reading" apart
    // from a real 0 and skip the HomeKit write instead of pushing NaN.
    airTemp: tenths(t.airTemp ?? r.airTemp),
    // A Room with no paired thermostat (created in the Warmup app but not
    // yet commissioned, or mid-RMA) has an empty `thermostat4ies`, so these
    // come back undefined. They feed HomeKit's TargetTemperature bounds, and
    // `undefined / 10` is NaN — which HAP rejects, leaving the accessory in a
    // broken state. Fall back to the range Warmup's own devices ship with.
    minTemp: tenths(t.minTemp) ?? DEFAULT_MIN_TEMP,
    maxTemp: tenths(t.maxTemp) ?? DEFAULT_MAX_TEMP,
    overrideDur: r.overrideDur,
    overrideTemp: tenths(r.overrideTemp),
    fixedTemp: tenths(r.fixedTemp),
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
    //   - `lastPoll` — drives `StatusActive` (offline detection) since v3.4.
    //   - `parameters { outputStatus }` (relay state) has been in the query
    //     since v3.4 and drives `CurrentHeatingCoolingState`. The 409 seen
    //     during v3 development turned out to be specific to
    //     `user.location(id:)`, not to the `parameters` field.
    // Raw probe readings. Both carry NO_PROBE_SENTINEL when unfitted — use
    // `secondaryTemp` below rather than these, which are sentinel-filtered.
    floor1Temp: probeReading(t.floor1Temp),
    floor2Temp: probeReading(t.floor2Temp),
    // Which reading the device actually regulates on: `air` | `floor`. This
    // is what `Thermostat.CurrentTemperature` ends up showing, and until now
    // the README asked users to work it out for themselves.
    heatingTarget: t.heatingTarget || null,
    // The device's own labels for its two readings — `mainLabel` describes
    // `currentTemp`, `secondaryLabel` the other one. Lowercase on the wire
    // ("air" / "floor"); presentation-cased at the point of use.
    mainLabel: r.mainLabel || null,
    secondaryLabel: r.secondaryLabel || null,
    // The reading the Thermostat is NOT showing. `null` when no probe is
    // fitted, so callers never see the 90 °C sentinel.
    secondaryTemp: probeReading(r.secondaryTemp),
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

// Build the human half of a `Warmup API: …` error from a failed REST
// response. Prefers prose the API actually sent, then our own mapping of
// `response.errorCode`, and always appends the raw code when there is one so
// an unmapped failure is still diagnosable from the Homebridge log.
function restErrorDetail(json) {
  const status = (json && json.status) || {};
  // Modern payloads carry `response.errorCode`; the v2-era REST surface put
  // it at `status.code` (the shape TOKEN_ERROR_PATTERN still matches on).
  // `??` rather than `||` so a legitimate code 0 is not discarded.
  const code = (json && json.response && json.response.errorCode) ?? status.code;
  const prose = json.message || status.message || REST_ERROR_MESSAGES[code];
  if (prose && code != null) return `${prose} (errorCode ${code})`;
  if (prose) return prose;
  if (code != null) return `errorCode ${code}`;
  return JSON.stringify(status);
}

// Coerce a Warmup temperature field to a number of tenths of °C, or `null`
// when it is absent/unparseable. Temperatures arrive as plain numbers on
// `Room` (195) but as strings on `Thermostat4iE` ("195"), so everything the
// platform divides by 10 goes through here first.
function tenths(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A probe reading in tenths of °C, or `null` when the probe is absent.
// Distinct from `tenths()` because only probe fields carry the sentinel —
// applying this to `currentTemp` would silently discard a legitimate (if
// alarming) 90 °C air reading.
function probeReading(value) {
  const n = tenths(value);
  return n === NO_PROBE_SENTINEL ? null : n;
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
