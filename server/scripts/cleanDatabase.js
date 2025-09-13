#!/usr/bin/env node

/**
 * Database Cleaning Script for HomeBrain Smart Home System
 * 
 * This script provides a command-line interface for cleaning/resetting
 * the database by removing all data from smart home collections.
 * 
 * Usage:
 *   node cleanDatabase.js [options] [collections...]
 * 
 * Examples:
 *   node cleanDatabase.js                    # Clean all collections
 *   node cleanDatabase.js devices           # Clean only devices
 *   node cleanDatabase.js devices scenes    # Clean devices and scenes
 *   node cleanDatabase.js --confirm         # Skip confirmation prompt
 *   node cleanDatabase.js --help            # Show help
 */

// Load environment variables from the server directory
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Override system DATABASE_URL with our MongoDB URL if needed
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('mongodb')) {
  process.env.DATABASE_URL = 'mongodb://localhost/HomeBrain';
}
const mongoose = require('mongoose');
const readline = require('readline');
const { connectDB } = require('../config/database');

// Import models to ensure they're registered
require('../models/init');

// Available collections to clean
const COLLECTIONS = {
  devices: 'Device',
  scenes: 'Scene',
  automations: 'Automation',
  voiceDevices: 'VoiceDevice',
  userProfiles: 'UserProfile'
};

// Parse command line arguments
const args = process.argv.slice(2);
const collections = args.filter(arg => !arg.startsWith('--'));
const options = args.filter(arg => arg.startsWith('--'));

/**
 * Display help information
 */
const showHelp = () => {
  console.log(`
HomeBrain Database Cleaning Tool

USAGE:
  node cleanDatabase.js [options] [collections...]

COLLECTIONS:
  ${Object.keys(COLLECTIONS).map(name => `  ${name.padEnd(15)} - Clean ${name} collection`).join('\n')}
  all                 - Clean all collections (default)

OPTIONS:
  --help              Show this help message
  --confirm           Skip confirmation prompt (use with caution)
  --force             Force cleaning even in production (use with extreme caution)

EXAMPLES:
  node cleanDatabase.js                      # Clean all collections (with confirmation)
  node cleanDatabase.js devices             # Clean only devices collection
  node cleanDatabase.js devices scenes      # Clean devices and scenes collections
  node cleanDatabase.js --confirm           # Clean all without confirmation
  node cleanDatabase.js devices --confirm   # Clean devices without confirmation

NOTES:
  - This will permanently delete data from the specified collections
  - Use with extreme caution, especially in production environments
  - Consider backing up your data before running this script
  `);
};

/**
 * Check if running in production
 */
const checkEnvironment = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const forceFlag = options.includes('--force');
  
  if (isProduction && !forceFlag) {
    console.error('⚠️  ERROR: This appears to be a production environment!');
    console.error('    Database cleaning will permanently delete data.');
    console.error('    Use --force flag if you really want to proceed.');
    console.error('    (This is highly discouraged in production!)');
    process.exit(1);
  }
  
  if (isProduction && forceFlag) {
    console.log('🚨 DANGER: Running database cleaning in production!');
    console.log('    This will permanently delete production data!');
  }
};

/**
 * Prompt user for confirmation
 */
const askForConfirmation = (collectionsToClean) => {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    console.log('\n⚠️  WARNING: You are about to permanently delete data!');
    console.log('   Collections to clean:');
    collectionsToClean.forEach(collection => {
      console.log(`     - ${collection}`);
    });
    console.log('');
    
    rl.question('Are you sure you want to continue? (type "yes" to confirm): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
};

/**
 * Clean specified collections
 */
const cleanCollections = async (collectionsToClean) => {
  const results = {};
  
  for (const collectionName of collectionsToClean) {
    try {
      const modelName = COLLECTIONS[collectionName];
      const Model = mongoose.model(modelName);
      
      console.log(`🧹 Cleaning ${collectionName} collection...`);
      const result = await Model.deleteMany({});
      
      results[collectionName] = result.deletedCount;
      console.log(`   ✅ Deleted ${result.deletedCount} documents from ${collectionName}`);
      
    } catch (error) {
      console.error(`   ❌ Error cleaning ${collectionName}:`, error.message);
      results[collectionName] = 'error';
    }
  }
  
  return results;
};

/**
 * Display cleaning results
 */
const displayResults = (results) => {
  console.log('\n📊 Cleaning Results:');
  console.log('='.repeat(30));
  
  let totalDeleted = 0;
  let hasErrors = false;
  
  Object.entries(results).forEach(([collection, count]) => {
    if (count === 'error') {
      console.log(`❌ ${collection.padEnd(15)}: Error occurred`);
      hasErrors = true;
    } else {
      console.log(`✅ ${collection.padEnd(15)}: ${count} documents deleted`);
      totalDeleted += count;
    }
  });
  
  console.log('='.repeat(30));
  console.log(`📈 Total documents deleted: ${totalDeleted}`);
  
  if (hasErrors) {
    console.log('⚠️  Some collections had errors during cleaning');
  }
};

/**
 * Main execution function
 */
const main = async () => {
  try {
    // Handle help option
    if (options.includes('--help')) {
      showHelp();
      return;
    }
    
    // Check environment safety
    checkEnvironment();
    
    // Determine which collections to clean
    let collectionsToClean;
    if (collections.length === 0) {
      // Clean all collections by default
      collectionsToClean = Object.keys(COLLECTIONS);
    } else {
      // Validate specified collections
      const invalidCollections = collections.filter(col => !COLLECTIONS[col]);
      if (invalidCollections.length > 0) {
        throw new Error(`Invalid collections: ${invalidCollections.join(', ')}`);
      }
      collectionsToClean = collections;
    }
    
    // Connect to database
    console.log('🔌 Connecting to database...');
    await connectDB();
    console.log('✅ Database connected successfully');
    
    // Ask for confirmation unless --confirm flag is used
    if (!options.includes('--confirm')) {
      const confirmed = await askForConfirmation(collectionsToClean);
      if (!confirmed) {
        console.log('❌ Operation cancelled by user');
        process.exit(0);
      }
    }
    
    // Clean the collections
    console.log('\n🧹 Starting database cleaning...');
    const startTime = Date.now();
    
    const results = await cleanCollections(collectionsToClean);
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    // Display results
    displayResults(results);
    
    console.log(`\n⏱️  Total time: ${duration} seconds`);
    console.log('🎉 Database cleaning completed!');
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n💥 Database cleaning failed:', error.message);
    
    if (error.message.includes('Invalid collections')) {
      console.error('\nAvailable collections:');
      Object.keys(COLLECTIONS).forEach(name => {
        console.error(`  - ${name}`);
      });
      console.error('\nUse --help for more information');
    }
    
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
};

// Check for required environment variables
if (!process.env.DATABASE_URL) {
  console.error('❌ ERROR: DATABASE_URL environment variable is required');
  console.error('   Please set DATABASE_URL in your .env file');
  process.exit(1);
}

// Run the main function
main();