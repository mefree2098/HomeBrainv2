const mongoose = require('mongoose');

// Import all models to ensure they are registered
require('./User');
require('./Device');
require('./Room');
require('./DeviceCommandClaim');
require('./DeviceGroup');
require('./DeviceEnergySample');
require('./Scene');
require('./Automation');
require('./AutomationHistory');
require('./Workflow');
require('./VoiceDevice');
require('./UserProfile');
require('./Settings');
require('./AlexaExposure');
require('./AlexaBrokerRegistration');
require('./AlexaBrokerConfig');
require('./AlexaLinkedAccount');
require('./AlexaVoiceUser');
require('./SecurityAlarm');
require('./VoiceCommand');
require('./SmartThingsIntegration');
require('./TempestIntegration');
require('./TempestObservation');
require('./TempestEvent');
require('./GoveeIntegration');
require('./RainMachineIntegration');
require('./RainMachineDailyStat');
require('./RainMachineWateringDay');
require('./SenseIntegration');
require('./SenseMonitorSnapshot');
require('./SenseTrendSnapshot');
require('./TelemetrySample');
require('./TelemetrySourceSummary');
require('./SSLCertificate');
require('./OllamaConfig');
require('./ReverseProxyRoute');
require('./ReverseProxyAuditLog');
require('./ReverseProxySettings');
require('./OIDCProviderSettings');
require('./OIDCClient');
require('./OIDCAuthorizationCode');

// Partial-unique indexes on the two globally-unique device identity fields, as a
// defense-in-depth backstop behind the application-level identity guards.
// Scoped with $type:'string' so devices that omit the field (most of them) are
// not indexed and cannot collide on null. Deliberately NOT applied to
// properties.smartThingsMigration.smartThingsDeviceId (intentionally shared by a
// retired-source tombstone and its migrated device) or homebrainDirect.nodeId
// (only unique per controller and reassigned on re-pair). Guarded so any
// pre-existing duplicate rows make the build skip-and-log instead of crashing
// startup; it applies on a later start once duplicates are cleaned up.
async function ensureDeviceIdentityIndexes(model) {
  const Device = model || require('./Device');
  const collection = Device && Device.collection;
  if (!collection || typeof collection.createIndex !== 'function') {
    return;
  }
  const indexes = [
    { name: 'uniq_smartThingsDeviceId', field: 'properties.smartThingsDeviceId' },
    { name: 'uniq_homebrainDirect_ieeeAddr', field: 'properties.homebrainDirect.ieeeAddr' }
  ];
  for (const index of indexes) {
    try {
      await collection.createIndex(
        { [index.field]: 1 },
        {
          name: index.name,
          unique: true,
          partialFilterExpression: { [index.field]: { $type: 'string' } }
        }
      );
    } catch (error) {
      console.warn(`dbInit: skipped unique index ${index.name} (likely pre-existing duplicate device rows); it will apply on a later start once duplicates are cleaned. ${error.message}`);
    }
  }
}

const dbInit = async (options = {}) => {
  const mongoUrl = process.env.DATABASE_URL || 'mongodb://localhost/myDb';

  try {
    await mongoose.connect(mongoUrl, options);
    console.log(`Connected to MongoDB at ${mongoUrl}`);
    console.log('All models registered successfully');
    await ensureDeviceIdentityIndexes();
  } catch (err) {
    console.error(`Error connecting to database ${mongoUrl}:`, err);
    throw err;
  }
};

module.exports = dbInit;
module.exports.ensureDeviceIdentityIndexes = ensureDeviceIdentityIndexes;
