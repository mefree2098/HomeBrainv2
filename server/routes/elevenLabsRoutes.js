const express = require('express');
const router = express.Router();
const elevenLabsService = require('../services/elevenLabsService');
const { requireUser } = require('./middlewares/auth');

// Create auth middleware instance
const auth = requireUser();

/**
 * GET /api/elevenlabs/voices
 * Get all available voices from ElevenLabs
 */
router.get('/voices', auth, async (req, res) => {
  try {
    console.log('GET /api/elevenlabs/voices - Fetching all available voices from ElevenLabs');
    
    const voices = await elevenLabsService.getVoices();
    
    console.log(`Successfully retrieved ${voices.length} voices from ElevenLabs`);
    res.status(200).json({
      success: true,
      voices: voices,
      count: voices.length
    });

  } catch (error) {
    console.error('Error in GET /api/elevenlabs/voices:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch voices from ElevenLabs',
      error: error.message
    });
  }
});

/**
 * GET /api/elevenlabs/voices/:voiceId
 * Get detailed information about a specific voice
 */
router.get('/voices/:voiceId', auth, async (req, res) => {
  try {
    console.log(`GET /api/elevenlabs/voices/${req.params.voiceId} - Fetching voice details`);
    
    const voice = await elevenLabsService.getVoiceById(req.params.voiceId);
    
    if (!voice) {
      console.log(`Voice not found: ${req.params.voiceId}`);
      return res.status(404).json({
        success: false,
        message: 'Voice not found'
      });
    }

    console.log(`Successfully retrieved voice details: ${voice.name}`);
    res.status(200).json({
      success: true,
      voice: voice
    });

  } catch (error) {
    console.error(`Error in GET /api/elevenlabs/voices/${req.params.voiceId}:`, error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch voice details',
      error: error.message
    });
  }
});

/**
 * POST /api/elevenlabs/voices/:voiceId/validate
 * Validate if a voice ID exists in ElevenLabs
 */
router.post('/voices/:voiceId/validate', auth, async (req, res) => {
  try {
    console.log(`POST /api/elevenlabs/voices/${req.params.voiceId}/validate - Validating voice ID`);
    
    const isValid = await elevenLabsService.validateVoiceId(req.params.voiceId);
    
    console.log(`Voice ID ${req.params.voiceId} validation result: ${isValid}`);
    res.status(200).json({
      success: true,
      valid: isValid,
      voiceId: req.params.voiceId
    });

  } catch (error) {
    console.error(`Error in POST /api/elevenlabs/voices/${req.params.voiceId}/validate:`, error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate voice ID',
      error: error.message
    });
  }
});

/**
 * POST /api/elevenlabs/text-to-speech
 * Convert text to speech using ElevenLabs TTS
 */
router.post('/text-to-speech', auth, async (req, res) => {
  try {
    console.log('POST /api/elevenlabs/text-to-speech - Converting text to speech');
    
    const { text, voiceId, options = {} } = req.body;

    // Validate required parameters
    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'Text is required for text-to-speech conversion'
      });
    }

    if (!voiceId) {
      return res.status(400).json({
        success: false,
        message: 'Voice ID is required for text-to-speech conversion'
      });
    }

    // Validate text length (ElevenLabs has limits)
    if (text.length > 5000) {
      return res.status(400).json({
        success: false,
        message: 'Text is too long. Maximum 5000 characters allowed.'
      });
    }

    console.log(`Generating speech for voice ${voiceId}: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
    
    const audioBuffer = await elevenLabsService.textToSpeech(text, voiceId, options);
    
    console.log(`Successfully generated ${audioBuffer.length} bytes of audio data`);
    
    // Set appropriate headers for audio response
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
      'Content-Disposition': 'inline; filename="speech.mp3"'
    });
    
    res.status(200).send(audioBuffer);

  } catch (error) {
    console.error('Error in POST /api/elevenlabs/text-to-speech:', error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('API key not configured')) {
      res.status(503).json({
        success: false,
        message: 'ElevenLabs API key is not configured. Please configure it in the settings.',
        error: error.message
      });
    } else if (error.message.includes('rate limit') || error.message.includes('quota')) {
      res.status(429).json({
        success: false,
        message: 'ElevenLabs API rate limit exceeded. Please try again later.',
        error: error.message
      });
    } else if (error.message.includes('Invalid voice')) {
      res.status(400).json({
        success: false,
        message: 'Invalid voice ID provided',
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to generate speech',
        error: error.message
      });
    }
  }
});

/**
 * POST /api/elevenlabs/preview
 * Generate a preview of a voice with default text
 */
router.post('/preview', auth, async (req, res) => {
  try {
    console.log('POST /api/elevenlabs/preview - Generating voice preview');
    
    const { voiceId, text } = req.body;

    // Validate required parameters
    if (!voiceId) {
      return res.status(400).json({
        success: false,
        message: 'Voice ID is required for preview'
      });
    }

    // Use provided text or default preview text
    const previewText = text || "Hello! This is a preview of this voice from your HomeBrain system.";

    console.log(`Generating preview for voice ${voiceId}`);
    
    const audioBuffer = await elevenLabsService.textToSpeech(previewText, voiceId, {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true
    });
    
    console.log(`Successfully generated preview audio (${audioBuffer.length} bytes)`);
    
    // Set appropriate headers for audio response
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'public, max-age=86400', // Cache for 1 day
      'Content-Disposition': 'inline; filename="voice-preview.mp3"'
    });
    
    res.status(200).send(audioBuffer);

  } catch (error) {
    console.error('Error in POST /api/elevenlabs/preview:', error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('API key not configured')) {
      return res.status(503).json({
        success: false,
        message: 'ElevenLabs API key is not configured. Please configure it in the settings.',
        error: error.message
      });
    } else if (error.message.includes('rate limit') || error.message.includes('quota')) {
      return res.status(429).json({
        success: false,
        message: 'ElevenLabs API rate limit exceeded. Please try again later.',
        error: error.message
      });
    } else if (error.message.includes('Invalid voice')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid voice ID provided',
        error: error.message
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Failed to generate voice preview',
        error: error.message
      });
    }
  }
});

/**
 * GET /api/elevenlabs/status
 * Get ElevenLabs integration status and API key validation
 */
router.get('/status', auth, async (req, res) => {
  try {
    console.log('GET /api/elevenlabs/status - Checking ElevenLabs integration status');
    
    const hasApiKey = !!process.env.ELEVENLABS_API_KEY;
    let apiKeyValid = false;
    let totalVoices = 0;
    
    if (hasApiKey) {
      try {
        // Test API key by fetching voices
        const voices = await elevenLabsService.getVoices();
        apiKeyValid = Array.isArray(voices) && voices.length > 0;
        totalVoices = voices.length;
      } catch (error) {
        console.log('API key validation failed:', error.message);
        apiKeyValid = false;
      }
    }
    
    const status = {
      configured: hasApiKey,
      apiKeyValid: apiKeyValid,
      totalVoices: totalVoices,
      service: 'ElevenLabs',
      baseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io/v1'
    };
    
    console.log('ElevenLabs integration status:', status);
    res.status(200).json({
      success: true,
      status: status
    });

  } catch (error) {
    console.error('Error in GET /api/elevenlabs/status:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check ElevenLabs status',
      error: error.message
    });
  }
});

module.exports = router;