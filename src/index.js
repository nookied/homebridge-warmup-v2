// Homebridge platform for Warmup Wi-Fi underfloor-heating thermostats.
// Supports the entire smart-thermostat range that pairs with my.warmup.com /
// the MyHeating app: 4iE, 6iE, 7iE Smart Matter, Element Wi-Fi, Terra Wi-Fi,
// plus rebadged OEM units (Laticrete, Rointe, Porcelanosa, Equus, Savant).
//
// Each Warmup "room" is exposed as a HomeKit Thermostat (primary) plus a
// paired TemperatureSensor for the air-temp probe. Static accessory platform
// (legacy `accessories(callback)` flow) — Homebridge v2 still supports this.
// A migration to dynamic platform is planned in v3.1 (Roadmap M4); see
// ROADMAP.md for the broader development plan.

'use strict';

const debug = require('debug')('warmup4ie');
const { Warmup4IE } = require('./lib/warmup4ie');
const { deriveCurrentHeatingState, deriveTargetHeatingState } = require('./lib/state');
const { version: PLUGIN_VERSION, name: PLUGIN_NAME } = require('../package.json');

const SLIDER_DEBOUNCE_MS = 300;

let Service, Characteristic, HapStatusError, HAPStatus;
const myAccessories = [];
let thermostats;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HapStatusError = homebridge.hap.HapStatusError;
  HAPStatus = homebridge.hap.HAPStatus;

  // First arg matches the npm package name (Homebridge uses it for plugin
  // disambiguation). Second arg is the platform identifier users put in
  // their config.json — kept as `warmup4ie` for migration compatibility.
  homebridge.registerPlatform(PLUGIN_NAME, 'warmup4ie', warmup4iePlatform);
};

function warmup4iePlatform(log, config /* , api */) {
  this.username = config.username;
  this.password = config.password;
  this.refresh = config.refresh || 60;   // polling interval, seconds
  this.duration = config.duration || 60; // override duration, minutes
  this.log = log;
}

warmup4iePlatform.prototype = {
  accessories: function (callback) {
    this.log.info('Logging into warmup4ie...');

    thermostats = new Warmup4IE(this, (err, rooms) => {
      if (err) {
        this.log.error('Warmup login/initial fetch failed:', err.message);
        callback([]);
        return;
      }
      this.log.info('Found %s room(s)', rooms.length);
      rooms.forEach((room) => {
        this.log.info('Adding %s', room.roomName);
        myAccessories.push(new Warmup4ieAccessory(this, room.roomName, thermostats.room[room.roomId]));
      });
      callback(myAccessories);
    });

    setInterval(async () => {
      try {
        await thermostats.getStatus();
        thermostats.room.forEach((room) => {
          if (room) updateStatus(room);
        });
      } catch (err) {
        this.log.error('Warmup poll failed:', err.message);
      }
    }, this.refresh * 1000);
  }
};

function getAccessory(accessories, roomId) {
  return accessories.find((accessory) => accessory.roomId === roomId);
}

// Warmup's API can return targetTemp below the device's configured minimum
// (e.g. just after switching modes); HomeKit rejects values out of the
// characteristic's [minTemp, maxTemp] range, so clamp.
function effectiveTargetTemp(room) {
  return room.targetTemp > room.minTemp ? room.targetTemp : room.minTemp;
}

function updateStatus(room) {
  const acc = getAccessory(myAccessories, room.roomId);
  if (!acc) return;

  // Refresh the per-accessory snapshot so .runMode-dependent setters see fresh state.
  acc.room = room;

  acc.thermostatService
    .getCharacteristic(Characteristic.TargetTemperature)
    .updateValue(Number(effectiveTargetTemp(room) / 10));

  acc.thermostatService
    .getCharacteristic(Characteristic.CurrentTemperature)
    .updateValue(Number(room.currentTemp / 10));

  acc.thermostatService
    .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .updateValue(deriveCurrentHeatingState(room));

  acc.thermostatService
    .getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .updateValue(deriveTargetHeatingState(room));

  acc.temperatureService
    .getCharacteristic(Characteristic.CurrentTemperature)
    .updateValue(Number(room.airTemp / 10));
}

// Map a Warmup error to an HAP status code. Coarse but better than the
// generic "Service Communication Failure" that a plain Error produces.
function asHapStatusError(err) {
  const msg = err && err.message ? err.message : '';
  if (msg.startsWith('Warmup network error') || msg.includes('aborted') || msg.includes('timeout')) {
    return new HapStatusError(HAPStatus.OPERATION_TIMED_OUT);
  }
  if (msg.startsWith('Warmup HTTP 4')) {
    return new HapStatusError(HAPStatus.INSUFFICIENT_AUTHORIZATION);
  }
  return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
}

function Warmup4ieAccessory(that, name, room) {
  this.log = that.log;
  this.log.info('Adding warmup4ie Device %s', name);
  this.name = name;
  this.room = room;
  this.roomId = room.roomId;
  // Per-characteristic debounce timers. HomeKit emits one `set` per slider
  // tick; coalesce trailing-edge so a drag results in one HTTP call, not N.
  this._timers = {};
}

Warmup4ieAccessory.prototype = {

  // Mode changes are usually single taps — no debounce needed.
  handleTargetHeatingCoolingSet: async function (value) {
    this.log.debug('Set HeatingCoolingState for %s → %s', this.name, value);
    try {
      switch (value) {
        case 0: // Off — per-room since v3 (was location-wide in v2 due to API limit)
          await thermostats.setRoomOff(this.roomId);
          break;
        case 1: // Heat — keep override/fixed if already set, otherwise resume schedule
          if (this.room.runMode === 'fixed' || this.room.runMode === 'override') return;
          await thermostats.setRoomAuto(this.roomId);
          break;
        case 3: // Auto
          await thermostats.setRoomAuto(this.roomId);
          break;
      }
    } catch (err) {
      this.log.error('Set HeatingCoolingState for %s failed: %s', this.name, err.message);
      throw asHapStatusError(err);
    }
  },

  // Temperature changes are debounced — slider drag emits many setters.
  handleTargetTemperatureSet: async function (value) {
    this.log.debug('Set TargetTemperature for %s → %s°', this.name, value);

    // Trailing-edge debounce: cancel any pending timer, schedule a new one.
    if (this._timers.targetTemp) clearTimeout(this._timers.targetTemp);

    return new Promise((resolve, reject) => {
      this._timers.targetTemp = setTimeout(async () => {
        try {
          await thermostats.setTargetTemperature(this.roomId, value);
          resolve();
        } catch (err) {
          this.log.error('Set TargetTemperature for %s failed: %s', this.name, err.message);
          reject(asHapStatusError(err));
        }
      }, SLIDER_DEBOUNCE_MS);
    });
  },

  getServices: function () {
    const informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Warmup')
      // Generic label that's accurate for any model in the supported range.
      // The Warmup GraphQL schema exposes per-device fields (`appFw`,
      // `wifiFw`, `deviceSN`) on `Thermostat4iE` — surfacing them as the
      // real Model/FirmwareRevision is queued for Roadmap M6.
      .setCharacteristic(Characteristic.Model, 'Wi-Fi Thermostat')
      // Stable serial: roomId is unique per Warmup account and survives host moves.
      .setCharacteristic(Characteristic.SerialNumber, `warmup4ie-${this.roomId}`)
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    this.temperatureService = new Service.TemperatureSensor(this.name + ' Air');
    this.temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100 })
      .updateValue(Number(this.room.airTemp / 10));

    this.thermostatService = new Service.Thermostat(this.name);
    if (typeof this.thermostatService.setPrimaryService === 'function') {
      this.thermostatService.setPrimaryService(true);
    } else {
      this.thermostatService.isPrimaryService = true;
    }

    this.thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [0, 1, 3] })
      .onSet(this.handleTargetHeatingCoolingSet.bind(this));

    this.thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.room.minTemp / 10,
        maxValue: this.room.maxTemp / 10
      })
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100 });

    this.thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .updateValue(Number(effectiveTargetTemp(this.room) / 10));

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .updateValue(Number(this.room.currentTemp / 10));

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .updateValue(deriveCurrentHeatingState(this.room));

    this.thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(deriveTargetHeatingState(this.room));

    debug('getServices for %s', this.name);
    return [informationService, this.thermostatService, this.temperatureService];
  }
};
