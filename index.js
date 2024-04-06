let Accessory, hap;
let adt = require('./lib/adt').ADT;
let contactSensor = require('./lib/contactSensor').ContactSensor;
let securitySystem = require('./lib/securitySystem').SecuritySystem;

const smartSecurityPlatform = function (log, config, api) {
    this.log = log;
    this.name = config.name;
    this.platformAccessories = [];
    this.cachedAccessories = [];
    this.api = api;

    this.adt = new adt(config, log)
        .on('init', this.initialize.bind(this));
};

smartSecurityPlatform.prototype.configureAccessory = function (accessory) {
    this.log.debug("Refreshing cached accessory", accessory.displayName);
    let platformAccessory;

    if (accessory.category === hap.Accessory.Categories.SECURITY_SYSTEM) {
        platformAccessory = securitySystem.from(accessory, this.adt, this.log, hap);
    } else {
        throw new Error("Cannot refresh cached accessory with category " + accessory.category);
    }

    this.cachedAccessories.push(platformAccessory);
};

smartSecurityPlatform.prototype.initialize = function (state) {
    this.platformAccessories = this.cachedAccessories;

    let newAccessories = [];

    if (!this.platformAccessories.some(cached => cached.name === this.name)) {
        let newSecuritySystem = securitySystem.with(this.name, this.adt, this.log, hap, Accessory);
        this.platformAccessories.push(newSecuritySystem);
        newAccessories.push(newSecuritySystem);
    }

    state.contactSensors
        .filter(sensor => !this.platformAccessories.some(cached => cached.name === sensor.name))
        .forEach(sensor => {
            let newContactSensor = contactSensor.with(sensor, this.log, hap, Accessory);

            this.platformAccessories.push(newContactSensor);
            newAccessories.push(newContactSensor);
        });

    this.log("Initializing platform with %s accessories", this.platformAccessories.length);
    this.log("Found %s new platform accessories", newAccessories.length);

    this.api.registerPlatformAccessories("homebridge-fidelity-adt-secure-home", "ADT", newAccessories.map(accessory => accessory.getAccessory()));

    this.setupCameras(state.cameras);

    this.adt.on('state', this.updateState.bind(this));
};

smartSecurityPlatform.prototype.updateState = function (state) {
    this.log.debug("Updating platform accessories with", JSON.stringify(state));
    this.platformAccessories.forEach(accessory => accessory.updateCharacteristics(state));
};

module.exports = function (homebridge) {
    Accessory = homebridge.platformAccessory;
    hap = homebridge.hap;
    homebridge.registerPlatform("homebridge-fidelity-adt-secure-home", "ADT", smartSecurityPlatform, true);
};