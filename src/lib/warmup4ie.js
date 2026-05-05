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

let WarmupAccessToken = null;
let LocId = null;

class Warmup4IE {
  constructor(options, callback) {
    this._username = options.username;
    this._password = options.password;
    this._duration = options.duration;
    this.room = [];

    this._bootstrap().then(
      (rooms) => callback(null, rooms),
      (err) => callback(err)
    );
  }

  async _bootstrap() {
    await this._generateAccessToken();
    await this._getLocations();
    return this._fetchRooms();
  }

  // Public callback-style transport. Stubbed by tests.
  _sendRequest(body, callback) {
    this._fetch(body).then(
      (json) => callback(null, json),
      (err) => {
        console.error(err);
        callback(err);
      }
    );
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

    // The Warmup API returns 200 with `{status:{result:"error",...}}` on rejection.
    if (json.status && json.status.result !== 'success') {
      const msg = json.message || json.status.message || JSON.stringify(json.status);
      throw new Error(`Warmup API: ${msg}`);
    }

    return json;
  }

  async _generateAccessToken() {
    const json = await this._fetch({
      request: {
        email: this._username,
        password: this._password,
        method: 'userLogin',
        appId: 'WARMUP-APP-V001'
      }
    });
    WarmupAccessToken = json.response.token;
  }

  // By design: multi-location accounts use the first location only. The Warmup
  // app does the same when no location is explicitly selected. If you need a
  // second location, run a second Homebridge child bridge with another account.
  async _getLocations() {
    if (!WarmupAccessToken) throw new Error('Missing access token.');

    const json = await this._fetch({
      account: { email: this._username, token: WarmupAccessToken },
      request: { method: 'getLocations' }
    });

    const first = json.response.locations && json.response.locations[0];
    if (!first) throw new Error('No locations on Warmup account.');
    LocId = first.id;
  }

  async _fetchRooms() {
    if (!LocId || !WarmupAccessToken) throw new Error('Missing LocId or access token.');

    const json = await this._fetch({
      account: { email: this._username, token: WarmupAccessToken },
      request: { method: 'getRooms', locId: LocId }
    });

    const rooms = json.response.rooms || [];
    rooms.forEach((room) => {
      this.room[room.roomId] = room;
    });
    return rooms;
  }

  getStatus(callback) {
    this._fetchRooms().then(
      (rooms) => callback(null, rooms),
      (err) => callback(err)
    );
  }

  setTargetTemperature(roomId, value, callback) {
    // `until` is local-time HH:MM. The Warmup app sends local time; UTC here makes
    // the override expire at the wrong wall-clock time (off by the timezone offset).
    const end = new Date(Date.now() + this._duration * 60000);
    const until = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;

    const body = {
      account: { email: this._username, token: WarmupAccessToken },
      request: {
        method: 'setOverride',
        rooms: [roomId],
        type: 3,
        temp: parseInt(value * 10, 10),
        until
      }
    };

    debug('setTargetTemperature', JSON.stringify(body));
    this.room[roomId] = null;
    this._sendRequest(body, callback);
  }

  setRoomAuto(roomId, callback) {
    const body = {
      account: { email: this._username, token: WarmupAccessToken },
      request: {
        method: 'setProgramme',
        roomId,
        roomMode: 'prog'
      }
    };

    this.room[roomId] = null;
    this._sendRequest(body, callback);
  }

  // Hard-off — the Warmup mobile app does this exact same call when you turn a
  // thermostat off, which is location-wide (`locMode: off`). There is no
  // per-room hard-off in the Warmup API; this is the documented behaviour.
  // Filler keys (`holEnd`, `holStart`, `holTemp`, `fixedTemp`, `geoMode`) are
  // *required* — without them the API returns 200 OK with a JSON error body
  // and the thermostats never receive the command. Match the Python reference
  // body byte-for-byte (alex-0103/warmup4IE).
  setRoomOff(roomId, callback) {
    const body = {
      account: { email: this._username, token: WarmupAccessToken },
      request: {
        method: 'setModes',
        values: {
          holEnd: '-',
          fixedTemp: '',
          holStart: '-',
          geoMode: '0',
          holTemp: '-',
          locId: LocId,
          locMode: 'off'
        }
      }
    };

    this.room[roomId] = null;
    this._sendRequest(body, callback);
  }
}

module.exports = { Warmup4IE };
