'use strict';

const debug = require('debug')('warmup4ie:lib');

const TOKEN_URL = 'https://api.warmup.com/apps/app/v1';
const APP_TOKEN = 'M=;He<Xtg"$}4N%5k{$:PD+WA"]D<;#PriteY|VTuA>_iyhs+vA"4lic{6-LqNM:';
const REQUEST_HEADERS = {
  'user-agent': 'WARMUP_APP',
  'accept-encoding': 'br, gzip, deflate',
  'accept': '*/*',
  'content-type': 'application/json',
  'app-token': APP_TOKEN,
  'app-version': '1.8.1',
  'accept-language': 'de-de'
};
const REQUEST_TIMEOUT_MS = 10000;

// Error codes the Warmup API returns for token-related failures, observed
// in OSS ports (alex-0103, ha-warmup, openHAB) and confirmed against the
// public schema. We use these to trigger one re-auth + retry per request.
const TOKEN_ERROR_CODES = new Set([100, 102, 103]);

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
    await this._generateAccessToken();
    await this._getLocations();
    return this._fetchRooms();
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  // Wrap `_fetch` with one re-auth + retry on token-related failures.
  // The body must be a *factory* (function returning a body) so that the
  // retry sees the freshly minted token, not the stale one captured at the
  // first call.
  async _authenticatedFetch(buildBody) {
    try {
      return await this._fetch(buildBody());
    } catch (err) {
      if (!this._isTokenError(err)) throw err;
      debug('Token rejected by Warmup, re-authenticating');
      this._token = null;
      await this._generateAccessToken();
      return this._fetch(buildBody());
    }
  }

  _isTokenError(err) {
    const msg = err.message || '';
    if (msg.startsWith('Warmup HTTP 401')) return true;
    const codeMatch = msg.match(/Warmup API: .*"code":\s*(\d+)/);
    if (codeMatch && TOKEN_ERROR_CODES.has(parseInt(codeMatch[1], 10))) return true;
    return false;
  }

  async _fetch(body) {
    let response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: REQUEST_HEADERS,
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
    let json;
    try {
      json = JSON.parse(text);
    } catch (ex) {
      throw new Error(`Warmup JSON parse error: ${ex.message}`);
    }

    // Warmup returns 200 OK with `{status:{result:"error",...}}` on rejection.
    if (json.status && json.status.result !== 'success') {
      const detail = json.message || json.status.message || JSON.stringify(json.status);
      throw new Error(`Warmup API: ${detail}`);
    }

    return json;
  }

  // ---------------------------------------------------------------------------
  // Auth + bootstrap
  // ---------------------------------------------------------------------------

  async _generateAccessToken() {
    const json = await this._fetch({
      request: {
        email: this._username,
        password: this._password,
        method: 'userLogin',
        appId: 'WARMUP-APP-V001'
      }
    });
    this._token = json.response.token;
  }

  // By design: multi-location accounts use the first location only. The Warmup
  // app does the same when no location is explicitly selected. If you need a
  // second location, run a second Homebridge child bridge with another account.
  async _getLocations() {
    if (!this._token) throw new Error('Missing access token.');

    const json = await this._fetch({
      account: { email: this._username, token: this._token },
      request: { method: 'getLocations' }
    });

    const first = json.response.locations && json.response.locations[0];
    if (!first) throw new Error('No locations on Warmup account.');
    this._locId = first.id;
  }

  // ---------------------------------------------------------------------------
  // Public read API
  // ---------------------------------------------------------------------------

  async _fetchRooms() {
    if (!this._locId) throw new Error('Missing locId.');

    const json = await this._authenticatedFetch(() => ({
      account: { email: this._username, token: this._token },
      request: { method: 'getRooms', locId: this._locId }
    }));

    const rooms = json.response.rooms || [];
    rooms.forEach((room) => {
      this.room[room.roomId] = room;
    });
    return rooms;
  }

  async getStatus() {
    return this._fetchRooms();
  }

  // ---------------------------------------------------------------------------
  // Public write API
  // ---------------------------------------------------------------------------

  async setTargetTemperature(roomId, value) {
    // `until` is local-time HH:MM. The Warmup app sends local time; UTC here
    // makes the override expire at the wrong wall-clock time (off by the
    // timezone offset).
    const end = new Date(Date.now() + this._duration * 60000);
    const until = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;

    this.room[roomId] = null;
    return this._authenticatedFetch(() => ({
      account: { email: this._username, token: this._token },
      request: {
        method: 'setOverride',
        rooms: [roomId],
        type: 3,
        temp: parseInt(value * 10, 10),
        until
      }
    }));
  }

  async setRoomAuto(roomId) {
    this.room[roomId] = null;
    return this._authenticatedFetch(() => ({
      account: { email: this._username, token: this._token },
      request: {
        method: 'setProgramme',
        roomId,
        roomMode: 'prog'
      }
    }));
  }

  // Hard-off — the Warmup mobile app does this exact same call when you turn
  // a thermostat off, which is location-wide (`locMode: off`). There is no
  // per-room hard-off in the Warmup REST API; this is the documented
  // behaviour. Filler keys (`holEnd`, `holStart`, `holTemp`, `fixedTemp`,
  // `geoMode`) are *required* — without them the API returns 200 OK with a
  // JSON error body and the thermostats never receive the command. Match the
  // Python reference body byte-for-byte (alex-0103/warmup4IE).
  //
  // Note: per-room off becomes possible via the GraphQL `deviceOff(lid, rid)`
  // mutation in v3.0.0. See ROADMAP.md milestone 3.
  async setRoomOff(roomId) {
    this.room[roomId] = null;
    return this._authenticatedFetch(() => ({
      account: { email: this._username, token: this._token },
      request: {
        method: 'setModes',
        values: {
          holEnd: '-',
          fixedTemp: '',
          holStart: '-',
          geoMode: '0',
          holTemp: '-',
          locId: this._locId,
          locMode: 'off'
        }
      }
    }));
  }
}

module.exports = { Warmup4IE };
