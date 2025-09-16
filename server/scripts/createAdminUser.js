#!/usr/bin/env node

/**
 * Admin User Creation Script for HomeBrain Smart Home System
 * 
 * This script creates a default admin user that can be used to manage
 * the HomeBrain system. The admin user has elevated privileges and
 * cannot be deleted through normal user management operations.
 * 
 * Usage:
 *   node createAdminUser.js [options]
 * 
 * Examples:
 *   node createAdminUser.js                           # Interactive mode
 *   node createAdminUser.js --email admin@homebrain.local --password AdminPass123!
 *   node createAdminUser.js --help                    # Show help
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
const { generatePasswordHash } = require('../utils/password');
const { ROLES } = require('../../shared/config/roles');

// Import models to ensure they're registered
require('../models/init');
const User = require('../models/User');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

// Parse options
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--email' && args[i + 1]) {
    options.email = args[i + 1];
    i++;
  } else if (args[i] === '--password' && args[i + 1]) {
    options.password = args[i + 1];
    i++;
  } else if (args[i] === '--help') {
    options.help = true;
  } else if (args[i] === '--force') {
    options.force = true;
  }
}

/**
 * Display help information
 */
const showHelp = () => {
  console.log(`
HomeBrain Admin User Creation Tool

USAGE:
  node createAdminUser.js [options]

OPTIONS:
  --email <email>         Admin email address
  --password <password>   Admin password (min 8 chars, must include uppercase, lowercase, number, special char)
  --force                 Force creation even if admin user exists
  --help                  Show this help message

EXAMPLES:
  node createAdminUser.js                                    # Interactive mode
  node createAdminUser.js --email admin@homebrain.local --password AdminPass123!
  node createAdminUser.js --force --email new@admin.com --password NewPass123!

NOTES:
  - Admin users have elevated privileges for system management
  - Passwords must be at least 8 characters and include:
    * At least one uppercase letter
    * At least one lowercase letter  
    * At least one number
    * At least one special character (!@#$%^&*)
  - Use --force to replace existing admin user
  `);
};

/**
 * Validate email format
 */
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Validate password strength
 */
const validatePasswordStrength = (password) => {
  if (password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[!@#$%^&*]/.test(password);
  
  if (!hasUppercase) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!hasLowercase) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!hasNumber) {
    return 'Password must contain at least one number';
  }
  if (!hasSpecial) {
    return 'Password must contain at least one special character (!@#$%^&*)';
  }
  
  return null;
};

/**
 * Interactive input for email
 */
const getEmailInput = () => {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const askEmail = () => {
      rl.question('Enter admin email address: ', (email) => {
        if (!validateEmail(email)) {
          console.log('❌ Invalid email format. Please try again.');
          askEmail();
        } else {
          rl.close();
          resolve(email);
        }
      });
    };
    
    askEmail();
  });
};

/**
 * Interactive input for password (hidden)
 */
const getPasswordInput = () => {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    // Hide password input
    rl.stdoutMuted = true;
    rl._writeToOutput = function _writeToOutput(stringToWrite) {
      if (rl.stdoutMuted) {
        rl.output.write("*");
      } else {
        rl.output.write(stringToWrite);
      }
    };
    
    const askPassword = () => {
      rl.question('Enter admin password (hidden): ', (password) => {
        rl.stdoutMuted = false;
        console.log(''); // New line after hidden input
        
        const validation = validatePasswordStrength(password);
        if (validation) {
          console.log(`❌ ${validation}`);
          rl.stdoutMuted = true;
          askPassword();
        } else {
          rl.close();
          resolve(password);
        }
      });
      rl.stdoutMuted = true;
    };
    
    askPassword();
  });
};

/**
 * Check if admin user already exists
 */
const checkExistingAdmin = async () => {
  try {
    console.log('🔍 Checking for existing admin users...');
    
    const existingAdmin = await User.findOne({ role: ROLES.ADMIN });
    
    if (existingAdmin) {
      console.log(`⚠️  Admin user already exists: ${existingAdmin.email}`);
      console.log(`   Created: ${existingAdmin.createdAt.toISOString()}`);
      console.log(`   Last login: ${existingAdmin.lastLoginAt.toISOString()}`);
      return existingAdmin;
    } else {
      console.log('✅ No existing admin user found');
      return null;
    }
  } catch (error) {
    console.error('❌ Error checking for existing admin:', error.message);
    throw error;
  }
};

/**
 * Create admin user
 */
const createAdminUser = async (email, password) => {
  try {
    console.log('🔐 Hashing admin password...');
    const hashedPassword = await generatePasswordHash(password);
    
    console.log('👤 Creating admin user...');
    const adminUser = new User({
      email: email,
      password: hashedPassword,
      role: ROLES.ADMIN,
      isActive: true,
      createdAt: new Date(),
      lastLoginAt: new Date()
    });
    
    const savedUser = await adminUser.save();
    
    console.log('✅ Admin user created successfully!');
    console.log(`   Email: ${savedUser.email}`);
    console.log(`   Role: ${savedUser.role}`);
    console.log(`   ID: ${savedUser._id}`);
    console.log(`   Created: ${savedUser.createdAt.toISOString()}`);
    
    return savedUser;
    
  } catch (error) {
    if (error.code === 11000) {
      throw new Error('Admin user with this email already exists');
    }
    throw error;
  }
};

/**
 * Update existing admin user
 */
const updateAdminUser = async (existingAdmin, email, password) => {
  try {
    console.log('🔐 Hashing new admin password...');
    const hashedPassword = await generatePasswordHash(password);
    
    console.log('📝 Updating existing admin user...');
    existingAdmin.email = email;
    existingAdmin.password = hashedPassword;
    existingAdmin.isActive = true;
    existingAdmin.lastLoginAt = new Date();
    
    const updatedUser = await existingAdmin.save();
    
    console.log('✅ Admin user updated successfully!');
    console.log(`   Email: ${updatedUser.email}`);
    console.log(`   Role: ${updatedUser.role}`);
    console.log(`   ID: ${updatedUser._id}`);
    console.log(`   Updated: ${new Date().toISOString()}`);
    
    return updatedUser;
    
  } catch (error) {
    if (error.code === 11000) {
      throw new Error('Another user with this email already exists');
    }
    throw error;
  }
};

/**
 * Main execution function
 */
const main = async () => {
  try {
    // Handle help option
    if (options.help) {
      showHelp();
      return;
    }
    
    console.log('🏠 HomeBrain Admin User Creation Tool\n');
    
    // Connect to database
    console.log('🔌 Connecting to database...');
    await connectDB();
    console.log('✅ Database connected successfully\n');
    
    // Check for existing admin
    const existingAdmin = await checkExistingAdmin();
    
    if (existingAdmin && !options.force) {
      console.log('\n❌ Admin user already exists!');
      console.log('   Use --force flag to replace the existing admin user');
      console.log('   Use --help for more information');
      process.exit(1);
    }
    
    // Get email and password
    let email, password;
    
    if (options.email && options.password) {
      // Use provided options
      email = options.email;
      password = options.password;
      
      console.log('\n📋 Using provided credentials...');
      
    } else {
      // Interactive mode
      console.log('\n📋 Interactive mode: Please provide admin credentials');
      
      if (!options.email) {
        email = await getEmailInput();
      } else {
        email = options.email;
      }
      
      if (!options.password) {
        password = await getPasswordInput();
      } else {
        password = options.password;
      }
    }
    
    // Validate inputs
    console.log('\n🔍 Validating credentials...');
    
    if (!validateEmail(email)) {
      throw new Error('Invalid email format');
    }
    
    const passwordValidation = validatePasswordStrength(password);
    if (passwordValidation) {
      throw new Error(passwordValidation);
    }
    
    console.log('✅ Credentials validated successfully');
    
    // Create or update admin user
    let adminUser;
    if (existingAdmin && options.force) {
      adminUser = await updateAdminUser(existingAdmin, email, password);
    } else {
      adminUser = await createAdminUser(email, password);
    }
    
    console.log('\n🎉 Admin user setup completed successfully!');
    console.log('\n💡 You can now log in with these credentials:');
    console.log(`   Email: ${email}`);
    console.log('   Password: [hidden for security]');
    console.log(`\n🔗 Login at: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`);
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n💥 Admin user creation failed:', error.message);
    
    if (error.message.includes('Admin user with this email already exists')) {
      console.error('\n💡 Try using --force flag to replace the existing admin user');
      console.error('   Or use a different email address');
    }
    
    if (process.env.NODE_ENV === 'development') {
      console.error('\nStack trace:', error.stack);
    }
    
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