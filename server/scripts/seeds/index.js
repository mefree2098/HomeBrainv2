const { seedDevices } = require('./deviceSeeds');
const { seedScenes } = require('./sceneSeeds');
const { seedAutomations } = require('./automationSeeds');
const { seedVoiceDevices } = require('./voiceDeviceSeeds');
const { seedUserProfiles } = require('./userProfileSeeds');

/**
 * Seed all collections with sample data
 * The order is important due to dependencies between collections
 */
const seedAll = async () => {
  try {
    console.log('🚀 Starting complete database seeding...\n');
    
    const startTime = Date.now();
    
    // Step 1: Seed devices first (no dependencies)
    console.log('='.repeat(50));
    await seedDevices();
    console.log('='.repeat(50));
    console.log('');
    
    // Step 2: Seed scenes (depends on devices)
    console.log('='.repeat(50));
    await seedScenes();
    console.log('='.repeat(50));
    console.log('');
    
    // Step 3: Seed automations (depends on devices and scenes)
    console.log('='.repeat(50));
    await seedAutomations();
    console.log('='.repeat(50));
    console.log('');
    
    // Step 4: Seed voice devices (no dependencies)
    console.log('='.repeat(50));
    await seedVoiceDevices();
    console.log('='.repeat(50));
    console.log('');
    
    // Step 5: Seed user profiles (depends on devices, scenes, automations)
    console.log('='.repeat(50));
    await seedUserProfiles();
    console.log('='.repeat(50));
    console.log('');
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log('🎉 Complete database seeding finished successfully!');
    console.log(`⏱️  Total time: ${duration} seconds`);
    console.log('');
    console.log('📋 Summary:');
    console.log('   ✅ Devices seeded');
    console.log('   ✅ Scenes seeded');
    console.log('   ✅ Automations seeded');
    console.log('   ✅ Voice devices seeded');
    console.log('   ✅ User profiles seeded');
    console.log('');
    console.log('🏠 Your HomeBrain smart home is now ready with sample data!');
    
  } catch (error) {
    console.error('💥 Database seeding failed:', error.message);
    console.error(error.stack);
    throw error;
  }
};

/**
 * Seed individual collections
 */
const seeders = {
  devices: seedDevices,
  scenes: seedScenes,
  automations: seedAutomations,
  voiceDevices: seedVoiceDevices,
  userProfiles: seedUserProfiles,
  all: seedAll
};

/**
 * Get available seeding options
 */
const getAvailableSeeders = () => {
  return Object.keys(seeders);
};

/**
 * Run specific seeder by name
 */
const runSeeder = async (seederName) => {
  if (!seeders[seederName]) {
    const available = getAvailableSeeders().join(', ');
    throw new Error(`Unknown seeder: ${seederName}. Available seeders: ${available}`);
  }
  
  console.log(`🌱 Running ${seederName} seeder...`);
  await seeders[seederName]();
  console.log(`✅ ${seederName} seeding completed!`);
};

module.exports = {
  seedAll,
  seeders,
  getAvailableSeeders,
  runSeeder
};