#!/usr/bin/env node

/**
 * Script to make a user an admin
 * Usage: node scripts/makeUserAdmin.js <email>
 */

const mongoose = require('mongoose');
require('dotenv').config();
require('../models/init');
const User = require('../models/User');

async function makeUserAdmin(email) {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(process.env.DATABASE_URL);
    console.log('Connected to database');

    if (!email) {
      // If no email provided, list all users
      const users = await User.find({}, 'email role').sort({ createdAt: 1 });

      if (users.length === 0) {
        console.log('No users found in database');
        process.exit(0);
      }

      console.log('\nAvailable users:');
      users.forEach((user, index) => {
        console.log(`${index + 1}. ${user.email} (${user.role})`);
      });

      console.log('\nUsage: node scripts/makeUserAdmin.js <email>');
      process.exit(0);
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      console.error(`User with email "${email}" not found`);
      process.exit(1);
    }

    console.log(`\nCurrent user: ${user.email}`);
    console.log(`Current role: ${user.role}`);

    if (user.role === 'admin') {
      console.log('User is already an admin!');
      process.exit(0);
    }

    // Update to admin
    user.role = 'admin';
    await user.save();

    console.log(`\n✓ User "${user.email}" is now an admin!`);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Get email from command line arguments
const email = process.argv[2];
makeUserAdmin(email);
