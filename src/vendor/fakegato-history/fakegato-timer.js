// ---------------------------------------------------------------------------
// VENDORED from fakegato-history v0.6.7 — https://github.com/simont77/fakegato-history
// MIT License, Copyright (c) 2017 simont77. Full text in ./LICENSE.
//
// Why this is here rather than an npm dependency: fakegato-history declares
// `googleapis` as a hard dependency for a Google Drive storage backend this
// plugin never selects, and required it at module load. That cost ~207 MB on
// disk, ~115 MB RSS and ~800 ms of startup for every user, on hardware that
// is usually a Raspberry Pi.
//
// Changes from upstream, kept deliberately minimal so this stays a faithful
// copy rather than a rewrite:
//   - fakegato-storage.js: the Google Drive backend is removed — the
//     top-level `require('./lib/googleDrive')` and the four
//     `case 'googleDrive':` branches. `storage: 'fs'` is the only mode.
//   - lib/googleDrive.js is not vendored at all.
//   - This header.
// Nothing else is edited. See CLAUDE.md for the full reasoning.
// ---------------------------------------------------------------------------

/*jshint esversion: 6,node: true,-W041: false */
'use strict';

const DEBUG = true;

class FakeGatoTimer {
	constructor(params) {
		if (!params)
			params = {};
		this.subscribedServices = [];
		this.minutes = params.minutes || 10;

		this.intervalID = null;
		this.running = false;
		this.log = params.log || {};
		if (!this.log.debug) {
			this.log.debug = DEBUG ? console.log : function () { };
		}
	}

	// Subscription management
	subscribe(service, callback) {
		this.log.debug("** Fakegato-timer Subscription :", service.accessoryName);
		let newService = {
			'service': service,
			'callback': callback,
			'backLog': [],
			'previousBackLog': [],
			'previousAvrg': {}
		};

		this.subscribedServices.push(newService);
	}
	getSubscriber(service) {
		let findServ = function (element) {
			return element.service === service;
		};
		return this.subscribedServices.find(findServ);
	}
	_getSubscriberIndex(service) {
		let findServ = function (element) {
			return element.service === service;
		};
		return this.subscribedServices.findIndex(findServ);
	}
	getSubscribers() {
		return this.subscribedServices;
	}
	unsubscribe(service) {
		let index = this._getSubscriberIndex(service);
		this.subscribedServices.splice(index, 1);
		if (this.subscribedServices.length === 0 && this.running)
			this.stop();
	}

	// Timer management
	start() {
		this.log.debug("**Start Global Fakegato-Timer - " + this.minutes + "min**");
		if (this.running)
			this.stop();
		this.running = true;
		this.intervalID = setInterval(this.executeCallbacks.bind(this), this.minutes * 60 * 1000);
	}
	stop() {
		this.log.debug("**Stop Global Fakegato-Timer****");
		clearInterval(this.intervalID);
		this.running = false;
		this.intervalID = null;
	}

	// Data management
	executeCallbacks() {
		this.log.debug("**Fakegato-timer: executeCallbacks**");
		if (this.subscribedServices.length !== 0) {
			for (let s in this.subscribedServices) {
				if (this.subscribedServices.hasOwnProperty(s)) {

					let service = this.subscribedServices[s];
					if (typeof (service.callback) == 'function') {
						service.previousAvrg = service.callback({
							'backLog': service.backLog,
							'previousAvrg': service.previousAvrg,
							'timer': this,
							'immediate': false
						});
					}
				}
			}
		}
	}
	executeImmediateCallback(service) {
		this.log.debug("**Fakegato-timer: executeImmediateCallback**");

		if (typeof (service.callback) == 'function' && service.backLog.length)
			service.callback({
				'backLog': service.backLog,
				'timer': this,
				'immediate': true
			});
	}
	addData(params) {
		let data = params.entry;
		let service = params.service;
		let immediateCallback = params.immediateCallback || false;

		this.log.debug("**Fakegato-timer: addData ", service.accessoryName, data, " immediate: ", immediateCallback);

		if (immediateCallback) // door or motion -> replace
			this.getSubscriber(service).backLog[0] = data;
		else
			this.getSubscriber(service).backLog.push(data);

		if (immediateCallback) {
			//setTimeout(this.executeImmediateCallback.bind(this), 0,service);
			this.executeImmediateCallback(this.getSubscriber(service));
		}

		if (this.running === false)
			this.start();
	}
	emptyData(service) {
		this.log.debug("**Fakegato-timer: emptyData **", service.accessoryName);
		let source = this.getSubscriber(service);

		if (source.backLog.length) source.previousBackLog = source.backLog;
		source.backLog = [];
	}

}

module.exports = {
	FakeGatoTimer: FakeGatoTimer
};
