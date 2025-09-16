const axios = require('axios');
const settingsService = require('./settingsService');

class ElevenLabsService {
  constructor() {
    this.baseUrl = 'https://api.elevenlabs.io/v1';
    console.log('ElevenLabs Service initialized - API key will be retrieved from settings');
  }

  /**
   * Get the API key from settings (prioritizes database over environment variables)
   * @returns {Promise<string|null>} The ElevenLabs API key
   * @private
   */
  async _getApiKey() {
    try {
      const apiKey = await settingsService.getElevenLabsApiKey();
      return apiKey;
    } catch (error) {
      console.error('Error retrieving ElevenLabs API key from settings:', error.message);
      return null;
    }
  }

  /**
   * Get all available voices from ElevenLabs
   * @returns {Promise<Array>} Array of voice objects
   */
  async getVoices() {
    try {
      console.log('Fetching voices from ElevenLabs API');
      
      const apiKey = await this._getApiKey();
      
      if (!apiKey) {
        console.log('ElevenLabs API key not configured, returning mock data');
        return this._getMockVoices();
      }

      console.log('ElevenLabs API key retrieved from settings, making API call');
      
      const response = await axios.get(`${this.baseUrl}/voices`, {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      });

      console.log(`Retrieved ${response.data.voices.length} voices from ElevenLabs`);
      
      return response.data.voices.map(voice => ({
        id: voice.voice_id,
        name: voice.name,
        preview_url: voice.preview_url,
        category: voice.category,
        labels: voice.labels,
        description: voice.description
      }));

    } catch (error) {
      console.error('Error fetching voices from ElevenLabs:', error.response?.data || error.message);
      console.error('Full error:', error);
      
      // Fallback to mock data if API fails
      console.log('Falling back to mock voice data');
      return this._getMockVoices();
    }
  }

  /**
   * Get voice details by voice ID
   * @param {string} voiceId - The ElevenLabs voice ID
   * @returns {Promise<Object>} Voice details object
   */
  async getVoiceById(voiceId) {
    try {
      console.log(`Fetching voice details for ID: ${voiceId}`);
      
      const apiKey = await this._getApiKey();
      
      if (!apiKey) {
        console.log('ElevenLabs API key not configured, returning mock data');
        const mockVoices = this._getMockVoices();
        return mockVoices.find(voice => voice.id === voiceId) || null;
      }

      const response = await axios.get(`${this.baseUrl}/voices/${voiceId}`, {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      });

      console.log(`Retrieved voice details for: ${response.data.name}`);
      
      return {
        id: response.data.voice_id,
        name: response.data.name,
        preview_url: response.data.preview_url,
        category: response.data.category,
        labels: response.data.labels,
        description: response.data.description,
        settings: response.data.settings
      };

    } catch (error) {
      console.error(`Error fetching voice ${voiceId} from ElevenLabs:`, error.response?.data || error.message);
      console.error('Full error:', error);
      
      // Fallback to mock data if API fails
      const mockVoices = this._getMockVoices();
      return mockVoices.find(voice => voice.id === voiceId) || null;
    }
  }

  /**
   * Generate speech from text using ElevenLabs TTS
   * @param {string} text - Text to convert to speech
   * @param {string} voiceId - ElevenLabs voice ID
   * @param {Object} options - TTS options (stability, similarity_boost, etc.)
   * @returns {Promise<Buffer>} Audio buffer
   */
  async textToSpeech(text, voiceId, options = {}) {
    try {
      // Input validation
      if (!text || typeof text !== 'string') {
        throw new Error('Text is required and must be a string');
      }
      
      if (!voiceId || typeof voiceId !== 'string') {
        throw new Error('Voice ID is required and must be a string');
      }
      
      if (text.trim().length === 0) {
        throw new Error('Text cannot be empty');
      }
      
      if (text.length > 5000) {
        throw new Error('Text is too long. Maximum 5000 characters allowed.');
      }
      
      console.log(`Generating speech for voice ${voiceId}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
      
      const apiKey = await this._getApiKey();
      
      if (!apiKey) {
        throw new Error('ElevenLabs API key not configured');
      }

      // Validate and normalize voice settings
      const stability = Math.max(0.0, Math.min(1.0, options.stability || 0.5));
      const similarity_boost = Math.max(0.0, Math.min(1.0, options.similarity_boost || 0.75));
      const style = Math.max(0.0, Math.min(1.0, options.style || 0.0));
      
      const requestBody = {
        text: text,
        model_id: options.model_id || 'eleven_monolingual_v1',
        voice_settings: {
          stability: stability,
          similarity_boost: similarity_boost,
          style: style,
          use_speaker_boost: options.use_speaker_boost !== undefined ? !!options.use_speaker_boost : true
        }
      };

      // Retry logic for network issues
      let lastError;
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`Attempt ${attempt}/${maxRetries} - Making request to ElevenLabs TTS API`);
          
          const response = await axios.post(
            `${this.baseUrl}/text-to-speech/${voiceId}`,
            requestBody,
            {
              headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
              },
              responseType: 'arraybuffer',
              timeout: 30000 // 30 second timeout
            }
          );
          
          console.log(`Generated ${response.data.byteLength} bytes of audio data on attempt ${attempt}`);
          return Buffer.from(response.data);
          
        } catch (retryError) {
          lastError = retryError;
          console.log(`Attempt ${attempt} failed:`, retryError.code || retryError.message);
          
          // Don't retry on authentication errors
          if (retryError.response?.status === 401 || retryError.response?.status === 403) {
            console.log('Authentication error - not retrying');
            break;
          }
          
          // Don't retry on client errors (4xx except 429)
          if (retryError.response?.status >= 400 && retryError.response?.status < 500 && retryError.response?.status !== 429) {
            console.log('Client error - not retrying');
            break;
          }
          
          // Wait before retry (exponential backoff)
          if (attempt < maxRetries) {
            const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 1s, 2s, 4s max
            console.log(`Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      }
      
      // All retries failed
      console.error('All retry attempts failed');
      throw lastError;

    } catch (error) {
      console.error('Error generating speech with ElevenLabs:', error.response?.data || error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Validate if a voice ID exists in ElevenLabs
   * @param {string} voiceId - ElevenLabs voice ID
   * @returns {Promise<boolean>} True if voice exists
   */
  async validateVoiceId(voiceId) {
    try {
      console.log(`Validating voice ID: ${voiceId}`);
      
      const apiKey = await this._getApiKey();
      
      if (!apiKey) {
        // When API key is not available, validate against mock data
        const mockVoices = this._getMockVoices();
        return mockVoices.some(voice => voice.id === voiceId);
      }

      const voice = await this.getVoiceById(voiceId);
      const isValid = voice !== null;
      
      console.log(`Voice ID ${voiceId} is ${isValid ? 'valid' : 'invalid'}`);
      return isValid;

    } catch (error) {
      console.error(`Error validating voice ID ${voiceId}:`, error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Get mock voice data for when ElevenLabs API is not available
   * @returns {Array} Array of mock voice objects
   * @private
   */
  _getMockVoices() {
    return [
      { 
        id: 'elevenlabs-voice-1', 
        name: 'Sarah - Friendly Female', 
        preview_url: '',
        category: 'generated',
        labels: { gender: 'female', age: 'young', accent: 'american' },
        description: 'A friendly, warm female voice perfect for home assistance'
      },
      { 
        id: 'elevenlabs-voice-2', 
        name: 'James - Professional Male', 
        preview_url: '',
        category: 'generated', 
        labels: { gender: 'male', age: 'middle_aged', accent: 'british' },
        description: 'A professional, clear male voice ideal for formal interactions'
      },
      { 
        id: 'elevenlabs-voice-3', 
        name: 'Alex - Neutral Voice', 
        preview_url: '',
        category: 'generated',
        labels: { gender: 'neutral', age: 'young', accent: 'american' },
        description: 'A neutral, versatile voice suitable for all users'
      },
      { 
        id: 'elevenlabs-voice-4', 
        name: 'Emma - Warm Female', 
        preview_url: '',
        category: 'generated',
        labels: { gender: 'female', age: 'middle_aged', accent: 'american' },
        description: 'A warm, caring female voice with a comforting tone'
      },
      { 
        id: 'elevenlabs-voice-5', 
        name: 'David - Deep Male', 
        preview_url: '',
        category: 'generated',
        labels: { gender: 'male', age: 'mature', accent: 'american' },
        description: 'A deep, authoritative male voice with commanding presence'
      }
    ];
  }
}

module.exports = new ElevenLabsService();