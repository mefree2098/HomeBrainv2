const { exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const OllamaConfig = require('../models/OllamaConfig');

const execAsync = promisify(exec);

class OllamaService {
  constructor() {
    this.apiUrl = 'http://localhost:11434';
  }

  /**
   * Check if Ollama is installed
   */
  async checkInstallation() {
    try {
      console.log('Checking Ollama installation status...');

      // Check if ollama command exists
      try {
        const { stdout } = await execAsync('which ollama', { timeout: 5000 });
        if (!stdout.trim()) {
          return { isInstalled: false, version: null };
        }
      } catch (error) {
        return { isInstalled: false, version: null };
      }

      // Get version
      try {
        const { stdout } = await execAsync('ollama --version', { timeout: 5000 });
        const version = stdout.trim().replace('ollama version is ', '').replace('ollama version ', '');
        console.log(`Ollama is installed, version: ${version}`);
        return { isInstalled: true, version };
      } catch (error) {
        console.error('Error getting Ollama version:', error);
        return { isInstalled: true, version: 'unknown' };
      }
    } catch (error) {
      console.error('Error checking Ollama installation:', error);
      throw error;
    }
  }

  /**
   * Check if Ollama service is running
   */
  async checkServiceStatus() {
    try {
      console.log('Checking Ollama service status...');
      const response = await axios.get(`${this.apiUrl}/api/tags`, { timeout: 3000 });
      return { running: true, error: null };
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        return { running: false, error: 'Service not running' };
      }
      return { running: false, error: error.message };
    }
  }

  /**
   * Install Ollama
   */
  async install() {
    try {
      console.log('Starting Ollama installation...');

      const config = await OllamaConfig.getConfig();
      config.serviceStatus = 'installing';
      await config.save();

      // Download and install Ollama with sudo
      const installCommand = 'curl -fsSL https://ollama.com/install.sh | sudo sh';
      console.log('Running Ollama installation script with sudo...');

      const { stdout, stderr } = await execAsync(installCommand, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000 // 5 minutes timeout
      });

      console.log('Ollama installation output:', stdout);
      if (stderr) {
        console.log('Ollama installation stderr:', stderr);
      }

      // Verify installation
      const installStatus = await this.checkInstallation();

      if (!installStatus.isInstalled) {
        throw new Error('Ollama installation failed - binary not found after installation');
      }

      // Start Ollama service
      console.log('Starting Ollama service...');
      await this.startService();

      // Update config
      await config.updateInstallation(installStatus.version, true);

      console.log('Ollama installation completed successfully');
      return { success: true, version: installStatus.version };
    } catch (error) {
      console.error('Error installing Ollama:', error);

      const config = await OllamaConfig.getConfig();
      config.serviceStatus = 'error';
      await config.setError(`Installation failed: ${error.message}`);

      throw error;
    }
  }

  /**
   * Start Ollama service
   */
  async startService() {
    try {
      console.log('Starting Ollama service...');

      // Check if already running
      const status = await this.checkServiceStatus();
      if (status.running) {
        console.log('Ollama service is already running');
        return { success: true, message: 'Service already running' };
      }

      // Start as background service
      exec('nohup ollama serve > /tmp/ollama.log 2>&1 &');

      // Wait for service to start
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify it's running
      const newStatus = await this.checkServiceStatus();
      if (!newStatus.running) {
        throw new Error('Failed to start Ollama service');
      }

      console.log('Ollama service started successfully');
      return { success: true, message: 'Service started' };
    } catch (error) {
      console.error('Error starting Ollama service:', error);
      throw error;
    }
  }

  /**
   * Stop Ollama service
   */
  async stopService() {
    try {
      console.log('Stopping Ollama service...');
      await execAsync('pkill -f "ollama serve"');
      console.log('Ollama service stopped');
      return { success: true, message: 'Service stopped' };
    } catch (error) {
      // pkill returns error if no process found
      if (error.code === 1) {
        return { success: true, message: 'Service was not running' };
      }
      console.error('Error stopping Ollama service:', error);
      throw error;
    }
  }

  /**
   * Check for Ollama updates
   */
  async checkForUpdates() {
    try {
      console.log('Checking for Ollama updates...');

      const config = await OllamaConfig.getConfig();

      // Get current version
      const installStatus = await this.checkInstallation();
      if (!installStatus.isInstalled) {
        return { updateAvailable: false, currentVersion: null, latestVersion: null };
      }

      // Get latest version from GitHub API
      try {
        const response = await axios.get('https://api.github.com/repos/ollama/ollama/releases/latest', {
          timeout: 10000
        });

        const latestVersion = response.data.tag_name.replace('v', '');
        const currentVersion = installStatus.version.replace('v', '');

        const updateAvailable = latestVersion !== currentVersion;

        // Update config
        config.updateAvailable = updateAvailable;
        config.latestVersion = latestVersion;
        config.lastUpdateCheck = new Date();
        await config.save();

        console.log(`Update check complete. Current: ${currentVersion}, Latest: ${latestVersion}, Update available: ${updateAvailable}`);

        return {
          updateAvailable,
          currentVersion,
          latestVersion
        };
      } catch (error) {
        console.error('Error fetching latest version from GitHub:', error);
        return {
          updateAvailable: false,
          currentVersion: installStatus.version,
          latestVersion: 'unknown',
          error: 'Could not check for updates'
        };
      }
    } catch (error) {
      console.error('Error checking for updates:', error);
      throw error;
    }
  }

  /**
   * Update Ollama to latest version
   */
  async update() {
    try {
      console.log('Starting Ollama update...');

      const config = await OllamaConfig.getConfig();
      config.serviceStatus = 'installing';
      await config.save();

      // Run update command (same as install) with sudo
      const updateCommand = 'curl -fsSL https://ollama.com/install.sh | sudo sh';
      console.log('Running Ollama update script with sudo...');

      const { stdout, stderr } = await execAsync(updateCommand, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000
      });

      console.log('Ollama update output:', stdout);
      if (stderr) {
        console.log('Ollama update stderr:', stderr);
      }

      // Restart service
      await this.stopService();
      await this.startService();

      // Verify update
      const installStatus = await this.checkInstallation();
      await config.updateInstallation(installStatus.version, true);

      config.updateAvailable = false;
      await config.save();

      console.log('Ollama update completed successfully');
      return { success: true, version: installStatus.version };
    } catch (error) {
      console.error('Error updating Ollama:', error);

      const config = await OllamaConfig.getConfig();
      config.serviceStatus = 'error';
      await config.setError(`Update failed: ${error.message}`);

      throw error;
    }
  }

  /**
   * List installed models
   */
  async listModels() {
    try {
      console.log('Fetching installed Ollama models...');

      const response = await axios.get(`${this.apiUrl}/api/tags`, { timeout: 10000 });

      const models = response.data.models || [];
      console.log(`Found ${models.length} installed models`);

      // Transform to our schema
      const transformedModels = models.map(model => ({
        name: model.name,
        tag: model.name.includes(':') ? model.name.split(':')[1] : 'latest',
        size: model.size || 0,
        digest: model.digest || '',
        modifiedAt: model.modified_at ? new Date(model.modified_at) : new Date(),
        family: model.details?.family || '',
        parameterSize: model.details?.parameter_size || '',
        quantizationLevel: model.details?.quantization_level || '',
        format: model.details?.format || '',
        details: model.details || {}
      }));

      // Update config
      const config = await OllamaConfig.getConfig();
      await config.updateModels(transformedModels);

      return transformedModels;
    } catch (error) {
      console.error('Error listing Ollama models:', error);
      if (error.code === 'ECONNREFUSED') {
        throw new Error('Ollama service is not running');
      }
      throw error;
    }
  }

  /**
   * Pull/download a model
   */
  async pullModel(modelName) {
    try {
      console.log(`Starting download of model: ${modelName}`);

      // Use ollama CLI to pull model
      const pullCommand = `ollama pull ${modelName}`;

      const { stdout, stderr } = await execAsync(pullCommand, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 1800000 // 30 minutes timeout for large models
      });

      console.log(`Model ${modelName} downloaded successfully`);
      console.log('Pull output:', stdout);
      if (stderr) {
        console.log('Pull stderr:', stderr);
      }

      // Refresh model list
      await this.listModels();

      return { success: true, message: `Model ${modelName} downloaded successfully` };
    } catch (error) {
      console.error(`Error pulling model ${modelName}:`, error);
      throw new Error(`Failed to download model: ${error.message}`);
    }
  }

  /**
   * Delete a model
   */
  async deleteModel(modelName) {
    try {
      console.log(`Deleting model: ${modelName}`);

      const deleteCommand = `ollama rm ${modelName}`;
      await execAsync(deleteCommand, { timeout: 30000 });

      console.log(`Model ${modelName} deleted successfully`);

      // Refresh model list
      const config = await OllamaConfig.getConfig();
      await this.listModels();

      // If deleted model was active, clear active model
      if (config.activeModel === modelName) {
        config.activeModel = null;
        await config.save();
      }

      return { success: true, message: `Model ${modelName} deleted successfully` };
    } catch (error) {
      console.error(`Error deleting model ${modelName}:`, error);
      throw new Error(`Failed to delete model: ${error.message}`);
    }
  }

  /**
   * Set active model
   */
  async setActiveModel(modelName) {
    try {
      console.log(`Setting active model to: ${modelName}`);

      const config = await OllamaConfig.getConfig();
      await config.setActiveModel(modelName);

      console.log(`Active model set to ${modelName}`);
      return { success: true, activeModel: modelName };
    } catch (error) {
      console.error(`Error setting active model:`, error);
      throw error;
    }
  }

  /**
   * Chat with model
   */
  async chat(modelName, messages, stream = false) {
    try {
      console.log(`Sending chat request to model: ${modelName}`);

      const config = await OllamaConfig.getConfig();

      const requestBody = {
        model: modelName,
        messages: messages,
        stream: stream
      };

      const response = await axios.post(
        `${this.apiUrl}/api/chat`,
        requestBody,
        {
          timeout: 120000, // 2 minutes
          responseType: stream ? 'stream' : 'json'
        }
      );

      if (stream) {
        return response.data; // Return stream
      }

      const assistantMessage = response.data.message.content;

      // Save to chat history
      await config.addChatMessage('assistant', assistantMessage, modelName);

      console.log(`Chat response received from ${modelName}`);

      return {
        message: assistantMessage,
        model: modelName,
        done: response.data.done,
        totalDuration: response.data.total_duration,
        loadDuration: response.data.load_duration,
        promptEvalDuration: response.data.prompt_eval_duration,
        evalDuration: response.data.eval_duration,
      };
    } catch (error) {
      console.error(`Error during chat with ${modelName}:`, error);
      if (error.response?.data) {
        throw new Error(`Chat failed: ${error.response.data.error || error.message}`);
      }
      throw new Error(`Chat failed: ${error.message}`);
    }
  }

  /**
   * Generate text completion (non-chat)
   */
  async generate(modelName, prompt) {
    try {
      console.log(`Generating text with model: ${modelName}`);

      const response = await axios.post(
        `${this.apiUrl}/api/generate`,
        {
          model: modelName,
          prompt: prompt,
          stream: false
        },
        { timeout: 120000 }
      );

      console.log(`Generation complete for ${modelName}`);

      return {
        response: response.data.response,
        model: modelName,
        done: response.data.done,
        totalDuration: response.data.total_duration
      };
    } catch (error) {
      console.error(`Error during generation with ${modelName}:`, error);
      throw new Error(`Generation failed: ${error.message}`);
    }
  }

  /**
   * Get chat history
   */
  async getChatHistory(limit = 100) {
    try {
      const config = await OllamaConfig.getConfig();

      // Get last N messages
      const history = config.chatHistory.slice(-limit);

      return history;
    } catch (error) {
      console.error('Error getting chat history:', error);
      throw error;
    }
  }

  /**
   * Clear chat history
   */
  async clearChatHistory() {
    try {
      console.log('Clearing chat history...');

      const config = await OllamaConfig.getConfig();
      config.chatHistory = [];
      await config.save();

      console.log('Chat history cleared');
      return { success: true, message: 'Chat history cleared' };
    } catch (error) {
      console.error('Error clearing chat history:', error);
      throw error;
    }
  }

  /**
   * Get full status
   */
  async getStatus() {
    try {
      console.log('Getting Ollama full status...');

      const config = await OllamaConfig.getConfig();
      console.log('Got config from database');

      const installStatus = await Promise.race([
        this.checkInstallation(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Installation check timeout')), 10000))
      ]).catch(error => {
        console.error('Installation check failed:', error.message);
        return { isInstalled: false, version: null };
      });
      console.log('Installation status checked:', installStatus);

      const serviceStatus = await Promise.race([
        this.checkServiceStatus(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Service check timeout')), 5000))
      ]).catch(error => {
        console.error('Service check failed:', error.message);
        return { running: false, error: error.message };
      });
      console.log('Service status checked:', serviceStatus);

      // Update config with current status
      if (serviceStatus.running) {
        config.serviceStatus = 'running';
      } else if (installStatus.isInstalled) {
        config.serviceStatus = 'stopped';
      } else {
        config.serviceStatus = 'not_installed';
      }
      await config.save();

      return {
        isInstalled: installStatus.isInstalled,
        version: installStatus.version,
        serviceRunning: serviceStatus.running,
        serviceStatus: config.serviceStatus,
        installedModels: config.installedModels,
        activeModel: config.activeModel,
        configuration: config.configuration,
        updateAvailable: config.updateAvailable,
        latestVersion: config.latestVersion,
        lastUpdateCheck: config.lastUpdateCheck,
        statistics: config.statistics,
        lastError: config.lastError
      };
    } catch (error) {
      console.error('Error getting Ollama status:', error);
      throw error;
    }
  }

  /**
   * Get available models to download
   */
  async getAvailableModels() {
    // Popular models list - in production, this could be fetched from Ollama library
    return [
      { name: 'llama3.2:latest', description: 'Meta Llama 3.2 - Latest version', size: '2.0 GB', parameterSize: '3B' },
      { name: 'llama3.2:1b', description: 'Meta Llama 3.2 1B', size: '1.3 GB', parameterSize: '1B' },
      { name: 'llama3.1:8b', description: 'Meta Llama 3.1 8B', size: '4.7 GB', parameterSize: '8B' },
      { name: 'llama3.1:70b', description: 'Meta Llama 3.1 70B', size: '40 GB', parameterSize: '70B' },
      { name: 'mistral:latest', description: 'Mistral 7B - Latest version', size: '4.1 GB', parameterSize: '7B' },
      { name: 'mixtral:latest', description: 'Mixtral 8x7B MoE', size: '26 GB', parameterSize: '8x7B' },
      { name: 'phi3:latest', description: 'Microsoft Phi-3', size: '2.3 GB', parameterSize: '3.8B' },
      { name: 'gemma2:2b', description: 'Google Gemma 2 2B', size: '1.6 GB', parameterSize: '2B' },
      { name: 'gemma2:9b', description: 'Google Gemma 2 9B', size: '5.5 GB', parameterSize: '9B' },
      { name: 'qwen2.5:latest', description: 'Qwen 2.5 - Latest', size: '4.7 GB', parameterSize: '7B' },
      { name: 'codellama:latest', description: 'Code Llama for coding', size: '3.8 GB', parameterSize: '7B' },
      { name: 'deepseek-coder:latest', description: 'DeepSeek Coder', size: '3.8 GB', parameterSize: '6.7B' },
    ];
  }
}

module.exports = new OllamaService();
