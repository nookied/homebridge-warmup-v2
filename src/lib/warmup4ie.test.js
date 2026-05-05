/* eslint-env jest */

// Most tests below hit the live `api.warmup.com` endpoint with hard-coded
// credentials and expect a specific account's room layout. They are kept as
// `describe.skip` for documentation; the only tests that run are the offline
// regression checks below (no network).

const { Warmup4IE } = require('./warmup4ie');

function stubClient(captureInto) {
  const fakeClient = Object.create(Warmup4IE.prototype);
  fakeClient._username = 'user@example.com';
  fakeClient._duration = 60;
  fakeClient.room = [];
  fakeClient._sendRequest = (body, cb) => {
    captureInto.push(body);
    cb(null, { status: { result: 'success' }, response: {} });
  };
  return fakeClient;
}

describe('Warmup4IE — offline', () => {
  test('setTargetTemperature builds local-time HH:MM `until` (regression: was UTC in 0.1.1)', () => {
    const captured = [];
    const client = stubClient(captured);

    return new Promise((resolve) => {
      client.setTargetTemperature(123, 21.5, (err) => {
        expect(err).toBeNull();
        expect(captured).toHaveLength(1);
        const { request } = captured[0];

        expect(request.method).toBe('setOverride');
        expect(request.rooms).toEqual([123]);
        expect(request.type).toBe(3);
        expect(request.temp).toBe(215);

        const end = new Date(Date.now() + 60 * 60000);
        const expected = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
        expect(request.until).toBe(expected);

        resolve();
      });
    });
  });

  test('setRoomOff body includes the full filler `values` dict (regression: was {locId, locMode} only)', () => {
    const captured = [];
    const client = stubClient(captured);

    return new Promise((resolve) => {
      client.setRoomOff(123, (err) => {
        expect(err).toBeNull();
        const { values } = captured[0].request;
        expect(values).toMatchObject({
          holEnd: '-',
          fixedTemp: '',
          holStart: '-',
          geoMode: '0',
          holTemp: '-',
          locMode: 'off'
        });
        resolve();
      });
    });
  });

  test('setRoomAuto sends setProgramme roomMode=prog', () => {
    const captured = [];
    const client = stubClient(captured);

    return new Promise((resolve) => {
      client.setRoomAuto(123, (err) => {
        expect(err).toBeNull();
        expect(captured[0].request).toMatchObject({
          method: 'setProgramme',
          roomId: 123,
          roomMode: 'prog'
        });
        resolve();
      });
    });
  });

});

// ---------------------------------------------------------------------------
// LIVE API — disabled. To run, set valid credentials and remove `.skip`.
// ---------------------------------------------------------------------------
// eslint-disable-next-line jest/no-disabled-tests
describe.skip('Warmup4IE — live API', () => {
  let warmup;
  const options = {
    username: 'test@example.com',
    password: 'password',
    refresh: 60,
    duration: 30
  };

  test('Login with proper credentials', () => new Promise((resolve) => {
    warmup = new Warmup4IE(options, (err, data) => {
      expect(err).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      resolve();
    });
  }), 30000);

  test('getStatus should return rooms', () => new Promise((resolve) => {
    warmup.getStatus((err, data) => {
      expect(err).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      resolve();
    });
  }), 11000);
});
