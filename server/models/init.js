const mongoose = require('mongoose');

// Import all models to ensure they are registered
require('./User');
require('./Device');
require('./Scene');
require('./Automation');
require('./AutomationHistory');
require('./VoiceDevice');
require('./UserProfile');
require('./Settings');
require('./SecurityAlarm');
require('./VoiceCommand');
require('./SmartThingsIntegration');
require('./SSLCertificate');
require('./OllamaConfig');
require('./ReverseProxyRoute');
require('./ReverseProxyAuditLog');
require('./ReverseProxySettings');
require('./OIDCProviderSettings');
require('./OIDCClient');
require('./OIDCAuthorizationCode');

const dbInit = async (options = {}) => {
  const mongoUrl = process.env.DATABASE_URL || 'mongodb://localhost/myDb';

  try {
    await mongoose.connect(mongoUrl, options);
    console.log(`Connected to MongoDB at ${mongoUrl}`);
    console.log('All models registered successfully');
  } catch (err) {
    console.error(`Error connecting to database ${mongoUrl}:`, err);
    throw err;
  }
};

module.exports = dbInit;
