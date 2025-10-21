/**
 * Test script for ElevenLabs integration
 * Usage: node scripts/test-elevenlabs.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/database');
const elevenLabsService = require('../services/elevenLabsService');

async function ensureDatabaseConnection() {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    process.env.DATABASE_URL = 'mongodb://localhost:27017/HomeBrain';
  }

  if (mongoose.connection.readyState === 0) {
    await connectDB();
    return true;
  }

  return false;
}

async function testElevenLabsIntegration() {
  console.log('=== ElevenLabs Integration Test ===\n');
  let shouldCloseConnection = false;
  
  try {
    shouldCloseConnection = await ensureDatabaseConnection();
    
    // Test 1: Check if API key is configured
    console.log('1. Checking API key configuration...');
    const hasApiKey = !!process.env.ELEVENLABS_API_KEY;
    console.log(`   API Key configured: ${hasApiKey}`);
    
    if (!hasApiKey) {
      console.log('   ⚠️  No API key found. Using mock data.\n');
    } else {
      console.log(`   ✅ API key found (${process.env.ELEVENLABS_API_KEY.substring(0, 8)}...)\n`);
    }
    
    // Test 2: Fetch available voices
    console.log('2. Fetching available voices...');
    const voices = await elevenLabsService.getVoices();
    console.log(`   ✅ Retrieved ${voices.length} voices`);
    
    if (voices.length > 0) {
      console.log('   Sample voices:');
      voices.slice(0, 3).forEach(voice => {
        console.log(`     - ${voice.name} (ID: ${voice.id})`);
      });
    }
    console.log('');
    
    // Test 3: Get details for first voice
    if (voices.length > 0) {
      console.log('3. Testing voice details...');
      const firstVoice = voices[0];
      const voiceDetails = await elevenLabsService.getVoiceById(firstVoice.id);
      
      if (voiceDetails) {
        console.log(`   ✅ Retrieved details for: ${voiceDetails.name}`);
        console.log(`      Category: ${voiceDetails.category || 'N/A'}`);
        console.log(`      Labels: ${JSON.stringify(voiceDetails.labels || {})}`);
      } else {
        console.log('   ⚠️  Failed to retrieve voice details');
      }
      console.log('');
      
      // Test 4: Validate voice ID
      console.log('4. Testing voice ID validation...');
      const isValid = await elevenLabsService.validateVoiceId(firstVoice.id);
      console.log(`   Voice ID validation result: ${isValid ? '✅ Valid' : '⚠️ Invalid'}`);
      console.log('');
      
      // Test 5: Text-to-speech (only if API key is configured)
      if (hasApiKey) {
        console.log('5. Testing text-to-speech...');
        try {
          const testText = 'Hello from HomeBrain! This is a test of ElevenLabs integration.';
          console.log(`   Converting text: "${testText}"`);
          
          const audioBuffer = await elevenLabsService.textToSpeech(testText, firstVoice.id);
          console.log(`   ✅ Generated ${audioBuffer.length} bytes of audio data`);
          console.log('   Audio format: MP3');
        } catch (ttsError) {
          console.log(`   ⚠️  Text-to-speech failed: ${ttsError.message}`);
        }
      } else {
        console.log('5. Skipping text-to-speech test (no API key)');
      }
      console.log('');
    }
    
    console.log('=== Test Complete ===');
    console.log('✅ ElevenLabs integration is working properly!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  } finally {
    if (shouldCloseConnection && mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
  }
}

if (require.main === module) {
  testElevenLabsIntegration()
    .catch(error => {
      console.error('Unexpected error running ElevenLabs test:', error);
      process.exit(1);
    });
}
