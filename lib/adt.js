const events = require('events');
const cheerio = require('cheerio');
const request = require('request-promise');
const nodeCache = require('node-cache');

const BASE_URL = 'https://ids.trintel.co.za/Inhep-Impl-1.0-SNAPSHOT'
const LOGIN_PATH = '/auth/login';
const SYNC_INFO = '/device/getSyncInfo';
const STATE_INFO = '/device/getStateInfo';

class ADT extends events.EventEmitter {
    constructor(config, log) {
        super();

        this.log = log;
        this.name = config.name;
        this.username = config.username;
        this.password = config.password;
        this.cacheTTL = config.cacheTTL || 5;
        this.keypadPin = config.keypadPin;

        if (!this.username || !this.password) {
            throw new Error('Missing parameter. Please check configuration.');
        }

        this.log.debug('Initializing with username=%s, password=%s, cacheTTL=%s,', this.username, this.password, this.cacheTTL);

        this.statusCache = new nodeCache({
            stdTTL: this.cacheTTL,
            checkperiod: 1,
            useClones: false
        });

        this.on('error', this.attemptToRecoverFromFailure.bind(this));

        this.init();
    }

    async init() {
        try {
            this.log('Initializing status...');
            this.log.debug('Enabling autoRefresh every %s seconds', this.statusCache.options.stdTTL);

            this.statusCache
                .on('set', (key, state) => {
                    if (state && state.alarm) this.emit('state', state);
                })
                .on('expired', (key) => {
                    this.log.debug(key + ' expired');

                    this.getStatusFromDevice()
                        .then((state) => {
                            this.statusCache.set(STATUS, state);
                        })
                        .catch((error) => {
                            this.log.error('Failed refreshing status. Waiting for recovery.', error.message);
                            this.log.debug(error);
                            this.statusCache.del(STATUS);
                            this.emit('error');
                        });
                });

            await this.login();
            let state = await this.getStatusFromDevice();

            this.statusCache.set(STATUS, state);

            this.log.debug('ADT platform initialized', JSON.stringify(state));

            this.emit('init', state);
        } catch (error) {
            this.log.error('Initialization failed', error);
        }
    }

    getState() {
        return this.statusCache.get(STATUS);
    }

    setState(status) {
        this.targetState = status;

        let currentStatus = this.getState();

        if (currentStatus && currentStatus.alarm) {
            if (currentStatus.alarm.armingState === status) {
                this.log.debug('No status change needed');
                this.targetState = undefined;

                return null;
            } else if (currentStatus.alarm.armingState === 3 && currentStatus.alarm.faultStatus === 1) {
                this.log.error("Can't arm system. System is not ready.");
                this.targetState = undefined;

                return new Error("Can't arm system. System is not ready.");
            }
        }

        this.log('Setting status to', status);
        this.sendStateToDevice(status);

        return null;
    }

    async login() {
        try {
            const loginUrl = BASE_URL + LOGIN_PATH;
            const options = {
                method: 'GET',
                uri: loginUrl,
                qs: {
                    email: this.username,
                    password: this.password,
                    pkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    deviceName: 'iPhone',
                    _appVersionCode: '415',
                    _appPkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    imei: '11B9F5D6-5B09-4FCD-882A-4055B9B8AE16',
                    deviceOS: '17.4.1'
                },
                json: true
            };

            const response = await request(options);

            if (response.status === 'SUCCESS' && response.token) {
                this.token = response.token;
                this.userId = response.user.id;
                await this.getSyncInfo();
                this.log.debug('Login successful. Token:', this.token);
            } else {
                throw new Error('Login failed');
            }
        } catch (error) {
            throw new Error('Login failed: ' + error.message);
        }
    }

    async getSyncInfo() {
        try {
            const syncInfoUrl = BASE_URL + '/device/getSyncInfo';
            const options = {
                method: 'POST',
                uri: syncInfoUrl,
                headers: {
                    'Host': 'ids.trintel.co.za',
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/x-www-form-urlencoded',
                    'user-agent': 'SecureHome/152 CFNetwork/1496.0.1 Darwin/23.5.0',
                    'accept-language': 'en-GB,en;q=0.9'
                },
                body: {
                    token: this.token,
                    pkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    imei: '11B9F5D6-5B09-4FCD-882A-4055B9B8AE16'
                },
                json: true,
                gzip: true
            };
    
            const response = await request(options);
    
            if (response.status === 'SUCCESS' && response.masterSites && response.masterSites.length > 0) {
                this.siteId = response.masterSites[0].id;
            } else {
                throw new Error('Failed to retrieve sync info or masterSites array is empty');
            }
        } catch (error) {
            throw new Error('Failed to retrieve sync info or save ID: ' + error.message);
        }
    }

    async getStateInfo() {
        try {
            const stateInfoUrl = BASE_URL + '/device/getStateInfo';
            const options = {
                method: 'POST',
                uri: stateInfoUrl,
                headers: {
                    'Host': 'ids.trintel.co.za',
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/x-www-form-urlencoded',
                    'user-agent': 'SecureHome/152 CFNetwork/1496.0.1 Darwin/23.5.0',
                    'accept-language': 'en-GB,en;q=0.9'
                },
                body: {
                    token: this.token,
                    pkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    deviceName: 'iPhone',
                    _appVersionCode: '415',
                    _appPkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    imei: '11B9F5D6-5B09-4FCD-882A-4055B9B8AE16',
                    deviceOS: '17.5'
                },
                json: true,
                gzip: true
            };
    
            const response = await request(options);
    
            if (response.status === 'SUCCESS') {
                // State information retrieved successfully
                return response;
            } else {
                throw new Error('Failed to retrieve state info');
            }
        } catch (error) {
            throw new Error('Failed to retrieve state info: ' + error.message);
        }
    }
    

    async getUserPreferences() {
        try {
            const preferencesUrl = BASE_URL + '/user/getUserPreferences';
            const options = {
                method: 'POST',
                uri: preferencesUrl,
                headers: {
                    'Host': 'ids.trintel.co.za',
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/x-www-form-urlencoded',
                    'user-agent': 'SecureHome/152 CFNetwork/1496.0.1 Darwin/23.5.0',
                    'accept-language': 'en-GB,en;q=0.9'
                },
                body: {
                    token: this.token,
                    userId: this.userId,
                    siteId: this.siteId
                },
                json: true,
                gzip: true
            };
    
            const response = await request(options);
    
            if (response.success) {
                // Preferences retrieval successful
                return response;
            } else {
                throw new Error('Failed to retrieve user preferences');
            }
        } catch (error) {
            throw new Error('Failed to retrieve user preferences: ' + error.message);
        }
    }
    

    async getStatusFromDevice() {
        let state = {
            alarm: {},
            contactSensors: {}
        }
    }

    async armBeamsOnly() {
        try {
            const armUrl = BASE_URL + '/device/armSite';
            const options = {
                method: 'POST',
                uri: armUrl,
                headers: {
                    'Host': 'ids.trintel.co.za',
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/x-www-form-urlencoded',
                    'user-agent': 'SecureHome/152 CFNetwork/1496.0.1 Darwin/23.5.0',
                    'accept-language': 'en-GB,en;q=0.9'
                },
                body: {
                    token: this.token,
                    userId: this.userId,
                    clientImei: '11B9F5D6-5B09-4FCD-882A-4055B9B8AE16',
                    arm: true,
                    siteId: this.siteId,
                    stayProfileId: 293224,
                    partitionId: 2261370,
                    pkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    deviceName: 'iPhone',
                    _appVersionCode: '415',
                    _appPkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    imei: '11B9F5D6-5B09-4FCD-882A-4055B9B8AE16',
                    deviceOS: '17.5'
                },
                json: true,
                gzip: true
            };
    
            const response = await request(options);
    
            if (response.success) {
                await this.getSyncInfo();
                await this.getStateInfo();
                return response;
            } else {
                throw new Error('Arm operation failed');
            }
        } catch (error) {
            throw new Error('Arm operation failed: ' + error.message);
        }
    }
    

    async disarmSite() {
        try {
            const disarmUrl = BASE_URL + '/device/armSite';
            const options = {
                method: 'POST',
                uri: disarmUrl,
                headers: {
                    'Host': 'ids.trintel.co.za',
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/x-www-form-urlencoded',
                    'user-agent': 'SecureHome/152 CFNetwork/1496.0.1 Darwin/23.5.0',
                    'accept-language': 'en-GB,en;q=0.9'
                },
                body: {
                    token: this.token,
                    userId: this.userId,
                    siteId: this.siteId,
                    arm: false,
                    pin: this.keypadPin,
                    pkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    deviceName: 'iPhone',
                    _appVersionCode: '415',
                    _appPkg: 'com.adtsa.adtsa.chfd.mobile.ios.fadtsh',
                    imei: clientImei,
                    deviceOS: '17.5'
                },
                json: true,
                gzip: true
            };
    
            const response = await request(options);
    
            if (response.success) {
                await this.getSyncInfo();
                await this.getStateInfo();
                return response;
            } else {
                throw new Error('Disarm operation failed');
            }
        } catch (error) {
            throw new Error('Disarm operation failed: ' + error.message);
        }
    }
    
}

module.exports = {
    ADT
};