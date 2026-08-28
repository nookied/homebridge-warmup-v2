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

var fs = require('fs');
var os = require('os');
var path = require('path');
var hostname = os.hostname().split(".")[0];


var fileSuffix = '_persist.json';

var thisStorage;

class FakeGatoStorage {
	constructor(params) {
		if (!params)
			params = {};

		this.writers = [];

		this.log = params.log || {};
		if (!this.log.debug) {
			this.log.debug = DEBUG ? console.log : function () { };
		}
		thisStorage = this;
		this.addingWriter = false;
	}

	addWriter(service, params) {
		if (!this.addingWriter) {
			this.addingWriter = true;
			if (!params)
				params = {};

			this.log.debug("** Fakegato-storage AddWriter :", service.accessoryName);

			let newWriter = {
				'service': service,
				'callback': params.callback,
				'storage': params.storage || 'fs',
				'fileName': params.filename || hostname + "_" + service.accessoryName + fileSuffix		// Unique filename per homebridge server.  Allows test environments on other servers not to break prod.
			};
			var onReady = typeof (params.onReady) == 'function' ? params.onReady : function () { }.bind(this);

			switch (newWriter.storage) {
				case 'fs':
					newWriter.storageHandler = fs;
					newWriter.path = params.path || path.join(os.homedir(), '.homebridge');
					this.writers.push(newWriter);
					this.addingWriter = false;
					onReady();
					break;
				/*
				case 'memcached' :

				break;
				*/
			}
		} else {
			setTimeout(function () {
				this.addWriter(service, params);
			}.bind(this), 100);
		}
	}
	getWriter(service) {
		let findServ = function (element) {
			return element.service === service;
		};
		return this.writers.find(findServ);
	}
	_getWriterIndex(service) {
		let findServ = function (element) {
			return element.service === service;
		};
		return this.writers.findIndex(findServ);
	}
	getWriters() {
		return this.writers;
	}
	delWriter(service) {
		let index = this._getWriterIndex(service);
		this.writers.splice(index, 1);
	}

	write(params) { // must be asynchronous
		if (!this.writing) {
			this.writing = true;
			let writer = this.getWriter(params.service);
			let callBack = typeof (params.callback) == 'function' ? params.callback : (typeof (writer.callback) == 'function' ? writer.callback : function () { }); // use parameter callback or writer callback or empty function
			switch (writer.storage) {
				case 'fs':
					this.log.debug("** Fakegato-storage write FS file:", path.join(writer.path, writer.fileName), params.data.substr(1, 80));
					writer.storageHandler.writeFile(path.join(writer.path, writer.fileName), params.data, 'utf8', function () {
						this.writing = false;
						callBack(arguments);
					}.bind(this));
					break;
				/*
				case 'memcached' :

				break;
				*/
			}
		} else {
			setTimeout(function () { // retry in 100ms
				this.write(params);
			}.bind(this), 100);
		}
	}
	read(params) {
		let writer = this.getWriter(params.service);
		let callBack = typeof (params.callback) == 'function' ? params.callback : (typeof (writer.callback) == 'function' ? writer.callback : function () { }); // use parameter callback or writer callback or empty function
		switch (writer.storage) {
			case 'fs':
				this.log.debug("** Fakegato-storage read FS file:", path.join(writer.path, writer.fileName));
				writer.storageHandler.readFile(path.join(writer.path, writer.fileName), 'utf8', callBack);
				break;
			/*
			case 'memcached' :

			break;
			*/
		}
	}
	remove(params) {
		let writer = this.getWriter(params.service);
		let callBack = typeof (params.callback) == 'function' ? params.callback : (typeof (writer.callback) == 'function' ? writer.callback : function () { }); // use parameter callback or writer callback or empty function
		switch (writer.storage) {
			case 'fs':
				this.log.debug("** Fakegato-storage delete FS file:", path.join(writer.path, writer.fileName));
				writer.storageHandler.unlink(path.join(writer.path, writer.fileName), callBack);
				break;
			/*
			case 'memcached' :

			break;
			*/
		}
	}
}

module.exports = {
	FakeGatoStorage: FakeGatoStorage
};
