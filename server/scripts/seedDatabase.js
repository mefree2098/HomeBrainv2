#!/usr/bin/env node

/**
 * Database Seeding Script for HomeBrain Smart Home System
 * 
 * This script provides a command-line interface for seeding the database
 * with initial smart home data including devices, scenes, automations,
 * voice devices, and user profiles.
 * 
 * Usage:
 *   node seedDatabase.js [options] [seeder]
 * 
 * Examples:
 *   node seedDatabase.js                    # Seed all collections
 *   node seedDatabase.js devices           # Seed only devices
 *   node seedDatabase.js scenes            # Seed only scenes
 *   node seedDatabase.js --list            # List available seeders
 *   node seedDatabase.js --help            # Show help
 */

// Load environment variables from the server directory
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Override system DATABASE_URL with our MongoDB URL if needed
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('mongodb')) {
  process.env.DATABASE_URL = 'mongodb://localhost/HomeBrain';
}
const { connectDB } = require('../config/database');
const { seedAll, runSeeder, getAvailableSeeders } = require('./seeds/index');

// Parse command line arguments
const args = process.argv.slice(2);
const seederName = args.find(arg => !arg.startsWith('--'));
const options = args.filter(arg => arg.startsWith('--'));

/**
 * Display help information
 */
const showHelp = () => {
  console.log(`
HomeBrain Database Seeding Tool

USAGE:
  node seedDatabase.js [options] [seeder]

SEEDERS:
  ${getAvailableSeeders().map(name => `  ${name.padEnd(15)} - Seed ${name} collection`).join('\n')}

OPTIONS:
  --help              Show this help message
  --list              List all available seeders
  --force             Force seeding even in production (use with caution)

EXAMPLES:
  node seedDatabase.js                    # Seed all collections
  node seedDatabase.js devices           # Seed only devices
  node seedDatabase.js scenes            # Seed only scenes and their dependencies
  node seedDatabase.js --list            # List available seeders

NOTES:
  - Seeding will clear existing data in the target collections
  - Dependencies are automatically handled (e.g., scenes depend on devices)
  - Use --force flag to run in production environment (not recommended)
  `);
};

/**
 * List available seeders
 */
const listSeeders = () => {
  console.log('\nAvailable seeders:');
  getAvailableSeeders().forEach(name => {
    console.log(`  📁 ${name}`);
  });
  console.log('');
};

/**
 * Check if running in production
 */
const checkEnvironment = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const forceFlag = options.includes('--force');
  
  if (isProduction && !forceFlag) {
    console.error('⚠️  WARNING: This appears to be a production environment!');
    console.error('    Seeding will overwrite existing data.');
    console.error('    Use --force flag if you really want to proceed.');
    process.exit(1);
  }
  
  if (isProduction && forceFlag) {
    console.log('⚠️  WARNING: Running in production with --force flag!');
  }
};

/**
 * Main execution function
 */
const main = async () => {
  try {
    // Handle help and list options
    if (options.includes('--help')) {
      showHelp();
      return;
    }
    
    if (options.includes('--list')) {
      listSeeders();
      return;
    }
    
    // Check environment safety
    checkEnvironment();
    
    // Connect to database
    console.log('🔌 Connecting to database...');
    await connectDB();
    console.log('✅ Database connected successfully');
    console.log('');
    
    // Determine what to seed
    if (seederName) {
      // Seed specific collection
      await runSeeder(seederName);
    } else {
      // Seed all collections
      await seedAll();
    }
    
    console.log('');
    console.log('🎉 Database seeding completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('');
    console.error('💥 Seeding failed:', error.message);
    
    if (error.message.includes('Unknown seeder')) {
      console.error('');
      console.error('Available seeders:');
      getAvailableSeeders().forEach(name => {
        console.error(`  - ${name}`);
      });
      console.error('');
      console.error('Use --help for more information');
    }
    
    console.error('');
    console.error('Stack trace:', error.stack);
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