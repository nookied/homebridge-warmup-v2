/* eslint-env jest */

// Wire-format builders: each `setX(...)` method must produce a body that
// matches what the Warmup mobile app sends — verified against the Python
// reference impl (alex-0103/warmup4IE). Regression sentinels for the bugs
// introduced in the 0.1.0 rewrite.

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { stubClient } = require('../helpers');

describe('wire-format builders', () => {
  describe('setRoomOff', () => {
    test('body includes the full filler `values` dict (regression: 0.1.0–0.1.1 dropped these)', async () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      await client.setRoomOff(123);

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
    });

    test('body has no `roomId` — setRoomOff is location-wide by API design', async () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      await client.setRoomOff(123);
      expect(captured[0].request.roomId).toBeUndefined();
      expect(captured[0].request.values.locId).toBeDefined();
    });
  });

  describe('setTargetTemperature', () => {
    test('body shape: setOverride, type=3, temp in tenths', async () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      await client.setTargetTemperature(456, 21.5);
      const { request } = captured[0];
      expect(request.method).toBe('setOverride');
      expect(request.rooms).toEqual([456]);
      expect(request.type).toBe(3);
      expect(request.temp).toBe(215);
      expect(request.until).toMatch(/^\d{2}:\d{2}$/);
    });

    test('temperatures are scaled by 10 (HomeKit decimal °C → Warmup integer tenths)', async () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      await client.setTargetTemperature(1, 18);
      await client.setTargetTemperature(1, 22.5);
      await client.setTargetTemperature(1, 5);

      expect(captured[0].request.temp).toBe(180);
      expect(captured[1].request.temp).toBe(225);
      expect(captured[2].request.temp).toBe(50);
    });
  });

  describe('setRoomAuto', () => {
    test('body shape: setProgramme roomMode=prog with the roomId', async () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);

      await client.setRoomAuto(789);
      expect(captured[0].request).toMatchObject({
        method: 'setProgramme',
        roomId: 789,
        roomMode: 'prog'
      });
    });
  });

  describe('cache invalidation', () => {
    test('setRoomOff invalidates the targeted roomId in this.room cache', async () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);
      client.room[123] = { roomId: 123, runMode: 'schedule' };

      await client.setRoomOff(123);
      expect(client.room[123]).toBeNull();
    });

    test('setTargetTemperature invalidates the targeted roomId in this.room cache', async () => {
      const captured = [];
      const client = stubClient(Warmup4IE, captured);
      client.room[456] = { roomId: 456, runMode: 'schedule', targetTemp: 200 };

      await client.setTargetTemperature(456, 21);
      expect(client.room[456]).toBeNull();
    });
  });
});
