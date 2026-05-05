// Homebridge platform for Warmup 4iE underfloor-heating thermostats.
// Each Warmup "room" is exposed as a HomeKit Thermostat (primary) plus a
// paired TemperatureSensor for the air-temp probe. Static accessory platform
// (legacy `accessories(callback)` flow) — Homebridge v2 still supports this.

'use strict';

const debug = require('debug')('warmup4ie');
const { Warmup4IE } = require('./lib/warmup4ie');
const { version: PLUGIN_VERSION } = require('../package.json');

let Service, Characteristic;
const myAccessories = [];
let thermostats;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerPlatform('homebridge-warmup4ie', 'warmup4ie', warmup4iePlatform);
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
    this.log('Logging into warmup4ie...');

    thermostats = new Warmup4IE(this, (err, rooms) => {
      if (err) {
        this.log.error('Warmup login/initial fetch failed:', err.message);
        callback([]);
        return;
      }
      this.log('Found %s room(s)', rooms.length);
      rooms.forEach((room) => {
        this.log('Adding', room.roomName);
        myAccessories.push(new Warmup4ieAccessory(this, room.roomName, thermostats.room[room.roomId]));
      });
      callback(myAccessories);
    });

    setInterval(() => {
      thermostats.getStatus((err) => {
        if (err) {
          this.log.error('Warmup poll failed:', err.message);
          return;
        }
        thermostats.room.forEach((room) => {
          if (room) updateStatus(room);
        });
      });
    }, this.refresh * 1000);
  }
};

function getAccessory(accessories, roomId) {
  return accessories.find((accessory) => accessory.roomId === roomId);
}

function updateStatus(room) {
  const acc = getAccessory(myAccessories, room.roomId);
  if (!acc) return;

  // Refresh the per-accessory snapshot so .runMode-dependent setters see fresh state.
  acc.room = room;

  const targetTemperature = (room.targetTemp > room.minTemp ? room.targetTemp : room.minTemp);
  acc.thermostatService
    .getCharacteristic(Characteristic.TargetTemperature)
    .updateValue(Number(targetTemperature / 10));

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

function deriveCurrentHeatingState(room) {
  if (room.runMode === 'off') return 0;
  return room.currentTemp < room.targetTemp ? 1 : 0;
}

function deriveTargetHeatingState(room) {
  switch (room.runMode) {
    case 'off': return 0;
    case 'fixed':
    case 'override': return 1;
    case 'schedule': return 3;
    default: return 1;
  }
}

function Warmup4ieAccessory(that, name, room) {
  this.log = that.log;
  this.log('Adding warmup4ie Device', name);
  this.name = name;
  this.room = room;
  this.roomId = room.roomId;
}

Warmup4ieAccessory.prototype = {

  setTargetHeatingCooling: function (value, callback) {
    this.log('Setting system switch for', this.name, 'to', value);
    switch (value) {
      case 0: // Off (location-wide — see lib note)
        thermostats.setRoomOff(this.roomId, (err, json) => {
          if (err) return callback(err);
          debug('setRoomOff - Result', json);
          callback(null);
        });
        break;
      case 1: // Heat — keep override/fixed if already set, otherwise resume schedule
        if (this.room.runMode === 'fixed' || this.room.runMode === 'override') {
          callback(null);
        } else {
          thermostats.setRoomAuto(this.roomId, (err, json) => {
            if (err) return callback(err);
            debug('setRoomAuto - Result', json);
            callback(null);
          });
        }
        break;
      case 3: // Auto
        thermostats.setRoomAuto(this.roomId, (err, json) => {
          if (err) return callback(err);
          debug('setRoomAuto - Result', json);
          callback(null);
        });
        break;
      default:
        callback(null);
    }
  },

  setTargetTemperature: function (value, callback) {
    this.log('Setting target temperature for', this.name, 'to', value + '°');
    thermostats.setTargetTemperature(this.roomId, value, (err, json) => {
      if (err) return callback(err);
      debug('setTargetTemperature - Result', json);
      callback(null);
    });
  },

  getServices: function () {
    const informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'warmup4ie')
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
      .on('set', this.setTargetHeatingCooling.bind(this));

    this.thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.room.minTemp / 10,
        maxValue: this.room.maxTemp / 10
      })
      .on('set', this.setTargetTemperature.bind(this));

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100 });

    const targetTemperature = (this.room.targetTemp > this.room.minTemp ? this.room.targetTemp : this.room.minTemp);
    this.thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .updateValue(Number(targetTemperature / 10));

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .updateValue(Number(this.room.currentTemp / 10));

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .updateValue(deriveCurrentHeatingState(this.room));

    this.thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(deriveTargetHeatingState(this.room));

    return [informationService, this.thermostatService, this.temperatureService];
  }
};
