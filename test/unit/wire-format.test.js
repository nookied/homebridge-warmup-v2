/* eslint-env jest */

// Wire-format builders: each `setX(...)` method must produce the expected
// GraphQL mutation + variables. Verified against the schema dump at
// jondarrer/warmup-api/warmup-schema.graphql (M3, v3.0.0).

const { Warmup4IE } = require('../../src/lib/warmup4ie');
const { stubGraphQLClient } = require('../helpers');

describe('GraphQL wire-format builders', () => {
  describe('setRoomOff', () => {
    test('uses the deviceOff mutation with lid and rid (per-room hard off)', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setRoomOff(123);

      expect(captured).toHaveLength(1);
      expect(captured[0].query).toMatch(/mutation DeviceOff/);
      expect(captured[0].query).toMatch(/deviceOff\(lid: \$lid, rid: \$rid\)/);
      expect(captured[0].variables).toEqual({ lid: 12345, rid: 123 });
    });

    test('rid is the per-room id (regression sentinel: v2 used location-wide setModes)', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setRoomOff(999);
      // v3 unlock: rid is set, so only that room turns off — not the whole location
      expect(captured[0].variables.rid).toBe(999);
    });
  });

  describe('setTargetTemperature', () => {
    test('uses deviceOverride with temperature×10 and minutes (no HH:MM until)', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      client._duration = 90;

      await client.setTargetTemperature(456, 21.5);

      expect(captured[0].query).toMatch(/mutation DeviceOverride/);
      expect(captured[0].variables).toEqual({
        lid: 12345,
        rid: 456,
        temperature: 215,
        minutes: 90
      });
    });

    test('temperatures are scaled by 10 (HomeKit decimal °C → Warmup integer tenths)', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setTargetTemperature(1, 18);
      await client.setTargetTemperature(1, 22.5);
      await client.setTargetTemperature(1, 5);
      await client.setTargetTemperature(1, 19.9);

      expect(captured[0].variables.temperature).toBe(180);
      expect(captured[1].variables.temperature).toBe(225);
      expect(captured[2].variables.temperature).toBe(50);
      expect(captured[3].variables.temperature).toBe(199);
    });

    test('rejects non-numeric target temperatures before hitting GraphQL', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await expect(client.setTargetTemperature(1, 'not-a-number')).rejects.toThrow(/Invalid target temperature/);
      expect(captured).toHaveLength(0);
    });

    test('duration is sent verbatim as minutes (regression sentinel: v2 had UTC HH:MM bug)', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      client._duration = 60;
      await client.setTargetTemperature(1, 20);
      expect(captured[0].variables.minutes).toBe(60);

      client._duration = 30;
      await client.setTargetTemperature(1, 20);
      expect(captured[1].variables.minutes).toBe(30);
    });
  });

  describe('setRoomAuto', () => {
    test('uses deviceProgram mutation with lid and rid', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setRoomAuto(789);

      expect(captured[0].query).toMatch(/mutation DeviceProgram\b/);
      expect(captured[0].query).toMatch(/deviceProgram\(lid: \$lid, rid: \$rid\)/);
      expect(captured[0].variables).toEqual({ lid: 12345, rid: 789 });
    });
  });

  describe('location-wide mode mutations (M6 batch 4)', () => {
    test('setLocationFrost: deviceFrost(lid) without rid', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setLocationFrost();

      expect(captured[0].query).toMatch(/mutation DeviceFrostAll/);
      expect(captured[0].query).toMatch(/deviceFrost\(lid: \$lid\)/);
      expect(captured[0].variables).toEqual({ lid: 12345 });
    });

    test('clearLocationFrost: deviceProgram(lid) without rid (resume schedule)', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.clearLocationFrost();

      expect(captured[0].query).toMatch(/mutation DeviceProgramAll/);
      expect(captured[0].variables).toEqual({ lid: 12345 });
    });

    test('setLocationHoliday: deviceHoliday with default 5°C × 365 days', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setLocationHoliday();

      expect(captured[0].query).toMatch(/mutation DeviceHoliday/);
      const v = captured[0].variables;
      expect(v.lid).toBe(12345);
      expect(v.temperature).toBe(50);  // 5°C × 10
      expect(v.days).toBe(365);
      expect(v.start).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
      expect(v.end).toMatch(/^\d{4}-\d{2}-\d{2} 23:59:59$/);
    });

    test('setLocationHoliday with explicit temperature + days args', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setLocationHoliday(8, 14);

      const v = captured[0].variables;
      expect(v.temperature).toBe(80);
      expect(v.days).toBe(14);
    });

    test('clearLocationHoliday: cancelHoliday(lid)', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.clearLocationHoliday();

      expect(captured[0].query).toMatch(/mutation CancelHoliday/);
      expect(captured[0].variables).toEqual({ lid: 12345 });
    });
  });

  describe('child lock (M6 batch 5)', () => {
    test('setRoomChildLock(roomId, true) sends deviceAdvanced(lock: true)', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setRoomChildLock(123, true);

      expect(captured[0].query).toMatch(/mutation DeviceAdvancedLock/);
      expect(captured[0].query).toMatch(/deviceAdvanced\(lid: \$lid, rid: \$rid, lock: \$lock\)/);
      expect(captured[0].variables).toEqual({ lid: 12345, rid: 123, lock: true });
    });

    test('setRoomChildLock(roomId, false) sends lock: false', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setRoomChildLock(456, false);

      expect(captured[0].variables).toEqual({ lid: 12345, rid: 456, lock: false });
    });

    test('setRoomChildLock coerces truthy/falsy values to Boolean', async () => {
      const { client, captured } = stubGraphQLClient(Warmup4IE);
      await client.setRoomChildLock(1, 1);
      await client.setRoomChildLock(1, 0);
      await client.setRoomChildLock(1, null);
      await client.setRoomChildLock(1, 'on');

      expect(captured[0].variables.lock).toBe(true);
      expect(captured[1].variables.lock).toBe(false);
      expect(captured[2].variables.lock).toBe(false);
      expect(captured[3].variables.lock).toBe(true);
    });
  });

  describe('write cache behaviour', () => {
    test('setRoomOff preserves the last known room snapshot until the next poll', async () => {
      const { client } = stubGraphQLClient(Warmup4IE);
      client.room[123] = { roomId: 123, runMode: 'schedule' };
      await client.setRoomOff(123);
      expect(client.room[123]).toEqual({ roomId: 123, runMode: 'schedule' });
    });

    test('setTargetTemperature preserves the last known room snapshot until the next poll', async () => {
      const { client } = stubGraphQLClient(Warmup4IE);
      client.room[456] = { roomId: 456, runMode: 'schedule', targetTemp: 200 };
      await client.setTargetTemperature(456, 21);
      expect(client.room[456]).toEqual({ roomId: 456, runMode: 'schedule', targetTemp: 200 });
    });

    test('setRoomAuto preserves the last known room snapshot until the next poll', async () => {
      const { client } = stubGraphQLClient(Warmup4IE);
      client.room[789] = { roomId: 789, runMode: 'fixed' };
      await client.setRoomAuto(789);
      expect(client.room[789]).toEqual({ roomId: 789, runMode: 'fixed' });
    });
  });
});
