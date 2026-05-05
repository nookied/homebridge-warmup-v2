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

      expect(captured[0].variables.temperature).toBe(180);
      expect(captured[1].variables.temperature).toBe(225);
      expect(captured[2].variables.temperature).toBe(50);
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

      expect(captured[0].query).toMatch(/mutation DeviceProgram/);
      expect(captured[0].query).toMatch(/deviceProgram\(lid: \$lid, rid: \$rid\)/);
      expect(captured[0].variables).toEqual({ lid: 12345, rid: 789 });
    });
  });

  describe('cache invalidation', () => {
    test('setRoomOff invalidates the targeted roomId', async () => {
      const { client } = stubGraphQLClient(Warmup4IE);
      client.room[123] = { roomId: 123, runMode: 'schedule' };
      await client.setRoomOff(123);
      expect(client.room[123]).toBeNull();
    });

    test('setTargetTemperature invalidates the targeted roomId', async () => {
      const { client } = stubGraphQLClient(Warmup4IE);
      client.room[456] = { roomId: 456, runMode: 'schedule', targetTemp: 200 };
      await client.setTargetTemperature(456, 21);
      expect(client.room[456]).toBeNull();
    });

    test('setRoomAuto invalidates the targeted roomId', async () => {
      const { client } = stubGraphQLClient(Warmup4IE);
      client.room[789] = { roomId: 789, runMode: 'fixed' };
      await client.setRoomAuto(789);
      expect(client.room[789]).toBeNull();
    });
  });
});
