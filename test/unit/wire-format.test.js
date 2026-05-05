/* eslint-env jest */

// Wire-format builders: each `setX(...)` method must produce a body that
// matches what the Warmup mobile app sends — verified against the Python
// reference impl (alex-0103/warmup4IE). Regression sentinels for the bugs
// introduced in the 0.1.0 rewrite.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { stubClient } = require('../helpers');

describe('wire-format builders', () => {
  describe('setRoomOff', () => {
    test('body includes the full filler `values` dict (regression: 0.1.0–0.1.1 dropped these)', () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      return new Promise((resolve) => {
        client.setRoomOff(123, (err) => {
          expect(err).toBeNull();
          expect(captured).toHaveLength(1);
          const { request, account } = captured[0];

          expect(request.method).toBe('setModes');
          expect(request.values).toMatchObject({
            holEnd: '-',
            fixedTemp: '',
            holStart: '-',
            geoMode: '0',
            holTemp: '-',
            locMode: 'off'
          });
          expect(account.email).toBe('user@example.com');
          resolve();
        });
      });
    });

    test('body has no `roomId` — setRoomOff is location-wide by API design', () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      return new Promise((resolve) => {
        client.setRoomOff(123, () => {
          expect(captured[0].request.roomId).toBeUndefined();
          expect(captured[0].request.values.locId).toBeDefined();
          resolve();
        });
      });
    });
  });

  describe('setTargetTemperature', () => {
    test('body shape: setOverride, type=3, temp in tenths', () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      return new Promise((resolve) => {
        client.setTargetTemperature(456, 21.5, (err) => {
          expect(err).toBeNull();
          const { request } = captured[0];
          expect(request.method).toBe('setOverride');
          expect(request.rooms).toEqual([456]);
          expect(request.type).toBe(3);
          expect(request.temp).toBe(215);
          expect(request.until).toMatch(/^\d{2}:\d{2}$/);
          resolve();
        });
      });
    });

    test('temperatures are scaled by 10 (HomeKit decimal °C → Warmup integer tenths)', () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      return Promise.all([
        new Promise((r) => client.setTargetTemperature(1, 18, () => { expect(captured[0].request.temp).toBe(180); r(); })),
        new Promise((r) => client.setTargetTemperature(1, 22.5, () => { expect(captured[1].request.temp).toBe(225); r(); })),
        new Promise((r) => client.setTargetTemperature(1, 5, () => { expect(captured[2].request.temp).toBe(50); r(); }))
      ]);
    });
  });

  describe('setRoomAuto', () => {
    test('body shape: setProgramme roomMode=prog with the roomId', () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      return new Promise((resolve) => {
        client.setRoomAuto(789, (err) => {
          expect(err).toBeNull();
          expect(captured[0].request).toMatchObject({
            method: 'setProgramme',
            roomId: 789,
            roomMode: 'prog'
          });
          resolve();
        });
      });
    });
  });

  describe('cache invalidation', () => {
    test('setRoomOff invalidates the targeted roomId in this.room cache', () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);
      client.room[123] = { roomId: 123, runMode: 'schedule' };

      return new Promise((resolve) => {
        client.setRoomOff(123, () => {
          expect(client.room[123]).toBeNull();
          resolve();
        });
      });
    });

    test('setTargetTemperature invalidates the targeted roomId in this.room cache', () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);
      client.room[456] = { roomId: 456, runMode: 'schedule', targetTemp: 200 };

      return new Promise((resolve) => {
        client.setTargetTemperature(456, 21, () => {
          expect(client.room[456]).toBeNull();
          resolve();
        });
      });
    });
  });
});
