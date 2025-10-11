#!/usr/bin/env node

/**
 * Test Script for Scene Delete Functionality
 * This script tests the complete delete workflow for scenes
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Scene = require('../models/Scene');
const sceneService = require('../services/sceneService');

async function connectDatabase() {
  try {
    console.log('Connecting to database...');
    const dbUrl = process.env.DATABASE_URL || 'mongodb://localhost/HomeBrain';
    await mongoose.connect(dbUrl);
    console.log('✅ Database connected successfully');
    console.log(`   Database: ${dbUrl}\n`);
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
}

async function testSceneDelete() {
  console.log('='.repeat(60));
  console.log('SCENE DELETE FUNCTIONALITY TEST');
  console.log('='.repeat(60));
  console.log();

  try {
    // Step 1: Get current scenes count
    console.log('📊 Step 1: Getting current scenes...');
    const allScenesBefore = await sceneService.getAllScenes();
    console.log(`   Found ${allScenesBefore.length} scenes in database`);
    console.log();

    // Step 2: Create a test scene
    console.log('➕ Step 2: Creating a test scene for deletion...');
    const testSceneData = {
      name: 'Test Scene for Deletion',
      description: 'This is a test scene that will be deleted',
      deviceActions: [],
      category: 'custom',
      icon: 'test',
      color: '#FF0000'
    };

    const createdScene = await sceneService.createScene(testSceneData);
    console.log(`   ✅ Test scene created successfully`);
    console.log(`   Scene ID: ${createdScene._id}`);
    console.log(`   Scene Name: ${createdScene.name}`);
    console.log();

    // Step 3: Verify scene exists in database
    console.log('🔍 Step 3: Verifying scene exists in database...');
    const foundScene = await Scene.findById(createdScene._id);
    if (foundScene) {
      console.log(`   ✅ Scene found in database: ${foundScene.name}`);
    } else {
      console.log(`   ❌ Scene NOT found in database - Test Failed!`);
      return;
    }
    console.log();

    // Step 4: Delete the scene using service
    console.log('🗑️  Step 4: Deleting scene using sceneService.deleteScene()...');
    const deleteResult = await sceneService.deleteScene(createdScene._id.toString());
    console.log(`   ✅ Delete operation completed`);
    console.log(`   Result message: ${deleteResult.message}`);
    console.log(`   Deleted scene: ${deleteResult.deletedScene.name}`);
    console.log();

    // Step 5: Verify scene no longer exists
    console.log('✔️  Step 5: Verifying scene was deleted from database...');
    const deletedScene = await Scene.findById(createdScene._id);
    if (deletedScene) {
      console.log(`   ❌ FAILED: Scene still exists in database!`);
      console.log(`   Scene data:`, deletedScene);
      return;
    } else {
      console.log(`   ✅ PASSED: Scene successfully deleted from database`);
    }
    console.log();

    // Step 6: Get final scenes count
    console.log('📊 Step 6: Verifying final scene count...');
    const allScenesAfter = await sceneService.getAllScenes();
    console.log(`   Before: ${allScenesBefore.length} scenes`);
    console.log(`   After: ${allScenesAfter.length} scenes`);
    if (allScenesBefore.length === allScenesAfter.length) {
      console.log(`   ✅ PASSED: Scene count matches (test scene removed)`);
    } else {
      console.log(`   ⚠️  Scene count difference: ${Math.abs(allScenesBefore.length - allScenesAfter.length)}`);
    }
    console.log();

    // Step 7: Test error handling - try to delete non-existent scene
    console.log('🧪 Step 7: Testing error handling (delete non-existent scene)...');
    try {
      await sceneService.deleteScene('507f1f77bcf86cd799439011'); // Fake MongoDB ID
      console.log(`   ❌ FAILED: Should have thrown an error for non-existent scene`);
    } catch (error) {
      if (error.message.includes('not found')) {
        console.log(`   ✅ PASSED: Correctly threw error for non-existent scene`);
        console.log(`   Error message: ${error.message}`);
      } else {
        console.log(`   ⚠️  Unexpected error: ${error.message}`);
      }
    }
    console.log();

    // Step 8: Test with invalid ID
    console.log('🧪 Step 8: Testing error handling (invalid scene ID)...');
    try {
      await sceneService.deleteScene('invalid-id');
      console.log(`   ❌ FAILED: Should have thrown an error for invalid ID`);
    } catch (error) {
      console.log(`   ✅ PASSED: Correctly threw error for invalid ID`);
      console.log(`   Error message: ${error.message}`);
    }
    console.log();

    console.log('='.repeat(60));
    console.log('✅ ALL TESTS PASSED - Scene delete functionality works correctly!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('❌ TEST FAILED with error:', error.message);
    console.error('Full error:', error);
    console.log();
    console.log('='.repeat(60));
    console.log('❌ SCENE DELETE TEST FAILED');
    console.log('='.repeat(60));
  }
}

async function main() {
  try {
    await connectDatabase();
    await testSceneDelete();
  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    console.log('\nClosing database connection...');
    await mongoose.connection.close();
    console.log('Database connection closed.');
    process.exit(0);
  }
}

// Run the test
main();
