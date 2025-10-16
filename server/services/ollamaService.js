const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const OllamaConfig = require('../models/OllamaConfig');
const os = require('os');

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

      // Check current user
      let currentUser = 'unknown';
      try {
        const { stdout } = await execAsync('whoami', { timeout: 2000 });
        currentUser = stdout.trim();
        console.log(`Running as user: ${currentUser}`);
      } catch (error) {
        console.log('Could not determine current user');
      }

      // Check if we're root
      const isRoot = currentUser === 'root';

      // Check if sudo is available and working
      let hasSudo = false;
      if (!isRoot) {
        try {
          await execAsync('which sudo', { timeout: 2000 });
          // Verify we can actually use sudo without password
          try {
            await execAsync('sudo -n true', { timeout: 2000 });
            hasSudo = true;
            console.log('sudo command found and user has passwordless sudo privileges');
          } catch (sudoError) {
            console.log('sudo found but user does not have passwordless sudo privileges');
          }
        } catch (error) {
          console.log('sudo command not found');
        }
      }

      // If we're not root and don't have working sudo, installation cannot proceed
      if (!isRoot && !hasSudo) {
        const errorMessage = `Ollama installation requires root privileges. This system is running as user "${currentUser}" without sudo access.

To install Ollama, one of the following is required:
• Run this application as root user
• Grant sudo privileges to user "${currentUser}"
• Pre-install Ollama on the host system before starting this container

Please contact your system administrator for assistance.`;

        console.error(errorMessage);

        const config = await OllamaConfig.getConfig();
        config.serviceStatus = 'error';
        await config.setError(errorMessage);

        throw new Error(errorMessage);
      }

      // Prepare installation command
      let installCommand = 'curl -fsSL https://ollama.com/install.sh | sh';
      if (hasSudo) {
        installCommand = 'curl -fsSL https://ollama.com/install.sh | sudo sh';
        console.log('Running Ollama installation script with sudo...');
      } else {
        console.log('Running Ollama installation script as root...');
      }

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
    const config = await OllamaConfig.getConfig();
    if (config.configuration?.apiUrl) {
      this.apiUrl = config.configuration.apiUrl;
    }

    try {
      console.log('Starting Ollama service...');

      const status = await this.checkServiceStatus();
      if (status.running) {
        console.log('Ollama service is already running');
        config.serviceStatus = 'running';
        if (!config.servicePid) {
          const existingOwnedProcess = await this.findOwnedOllamaProcess();
          if (existingOwnedProcess) {
            config.servicePid = existingOwnedProcess.pid;
            config.serviceOwner = existingOwnedProcess.user;
          }
        }
        config.lastError = null;
        await config.save();
        return { success: true, message: 'Service already running' };
      }

      const childEnv = {
        ...process.env,
        OLLAMA_HOST: '127.0.0.1'
      };

      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        env: childEnv
      });

      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });

      const childPid = child.pid;
      config.servicePid = childPid;
      config.serviceOwner = this.getCurrentUser();
      config.serviceStatus = 'running';
      config.lastError = null;
      await config.save();

      child.unref();

      const started = await this.waitForServiceReady();
      if (!started) {
        await this.terminateManagedProcess(childPid);
        config.servicePid = null;
        config.serviceOwner = null;
        config.serviceStatus = 'error';
        await config.setError('Failed to start Ollama service within timeout.');
        throw new Error('Failed to start Ollama service');
      }

      console.log('Ollama service started successfully');
      return { success: true, message: 'Service started' };
    } catch (error) {
      console.error('Error starting Ollama service:', error);
      config.servicePid = null;
      config.serviceOwner = null;
      config.serviceStatus = 'error';
      await config.setError(`Start service failed: ${error.message}`);
      await config.save();
      throw error;
    }
  }

  /**
   * Stop Ollama service
   */
  async stopService() {
    const config = await OllamaConfig.getConfig();
    if (config.configuration?.apiUrl) {
      this.apiUrl = config.configuration.apiUrl;
    }

    try {
      console.log('Stopping Ollama service...');

      const candidates = [];
      if (config.servicePid) {
        candidates.push({ pid: config.servicePid, managed: true });
      } else {
        const ownedProcess = await this.findOwnedOllamaProcess();
        if (ownedProcess) {
          candidates.push({ pid: ownedProcess.pid, managed: false });
        }
      }

      for (const candidate of candidates) {
        const result = await this.terminateManagedProcess(candidate.pid);
        if (result.success) {
          config.servicePid = null;
          config.serviceOwner = null;
          config.serviceStatus = 'stopped';
          config.lastError = null;
          await config.save();
          console.log('Ollama service stopped');
          return { success: true, message: 'Service stopped' };
        }

        if (result.reason === 'permission') {
          console.warn('Unable to terminate managed process due to insufficient permissions. Escalating to privileged stop.');
          break;
        }

        if (result.reason === 'still_running') {
          throw new Error('Failed to stop Ollama service: process still running after signals.');
        }
      }

      const pkillResult = await this.stopServiceWithPkill();
      config.servicePid = null;
      config.serviceOwner = null;
      config.serviceStatus = pkillResult.success ? 'stopped' : config.serviceStatus;
      config.lastError = pkillResult.success ? null : config.lastError;
      await config.save();
      return pkillResult;
    } catch (error) {
      console.error('Error stopping Ollama service:', error);
      await config.setError(`Stop service failed: ${error.message}`);
      config.servicePid = null;
      config.serviceOwner = null;
      await config.save();
      throw error;
    }
  }

  async stopServiceWithPkill() {
    try {
      await execAsync('pkill -f "ollama serve"');
      console.log('Ollama service stopped using pkill');
      return { success: true, message: 'Service stopped' };
    } catch (error) {
      if (error.code === 1) {
        return { success: true, message: 'Service was not running' };
      }

      const errorOutput = `${error.stderr || ''}${error.stdout || ''}`.toLowerCase();

      if (errorOutput.includes('operation not permitted') || error.code === 126 || error.code === 127) {
        console.warn('Initial attempt to stop Ollama failed due to insufficient permissions. Trying sudo...');
        try {
          await execAsync('sudo -n pkill -f "ollama serve"');
          console.log('Ollama service stopped via sudo');
          return { success: true, message: 'Service stopped with elevated privileges' };
        } catch (sudoError) {
          const sudoOutput = `${sudoError.stderr || ''}${sudoError.stdout || ''}`.toLowerCase();

          if (sudoError.code === 1 && sudoOutput.includes('no process found')) {
            return { success: true, message: 'Service was not running' };
          }

          if (sudoOutput.includes('command not found')) {
            const message = 'Unable to stop Ollama service: sudo command not available. Please stop the service manually or install sudo.';
            console.error(message);
            throw new Error(message);
          }

          if (sudoOutput.includes('a password is required') || sudoOutput.includes('permission denied')) {
            const message = 'Insufficient privileges to stop the Ollama service. Please run "sudo pkill -f \\"ollama serve\\"" manually, add this service to sudoers, or stop the system-level Ollama service (e.g., "sudo systemctl stop ollama").';
            console.error(message);
            throw new Error(message);
          }

          console.error('Error stopping Ollama service with sudo:', sudoError);
          throw sudoError;
        }
      }

      throw error;
    }
  }

  async waitForServiceReady(retries = 10, delayMs = 500) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const status = await this.checkServiceStatus();
      if (status.running) {
        return true;
      }
      await this.delay(delayMs);
    }
    return false;
  }

  async findOwnedOllamaProcess() {
    const processes = await this.listOllamaProcesses();
    if (!processes.length) {
      return null;
    }
    const currentUser = this.getCurrentUser();
    return processes.find(proc => proc.user === currentUser) || null;
  }

  async listOllamaProcesses() {
    try {
      const { stdout } = await execAsync('ps -eo pid=,user=,command= | grep "ollama serve" | grep -v grep');
      const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
      return lines.map((line) => {
        const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) {
          return null;
        }
        return {
          pid: Number(match[1]),
          user: match[2],
          command: match[3]
        };
      }).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  getCurrentUser() {
    try {
      return os.userInfo().username;
    } catch (error) {
      return process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || 'unknown';
    }
  }

  async terminateManagedProcess(pid) {
    if (!pid) {
      return { success: true };
    }

    const sendSignal = (signal) => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') {
          return false;
        }
        if (error.code === 'EPERM') {
          return 'permission';
        }
        try {
          process.kill(pid, signal);
          return true;
        } catch (innerError) {
          if (innerError.code === 'ESRCH') {
            return false;
          }
          if (innerError.code === 'EPERM') {
            return 'permission';
          }
          throw innerError;
        }
      }
    };

    const termResult = sendSignal('SIGTERM');
    if (termResult === 'permission') {
      return { success: false, reason: 'permission' };
    }
    if (termResult === false) {
      return { success: true };
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!this.isProcessRunning(pid)) {
        return { success: true };
      }
      await this.delay(300);
    }

    const killResult = sendSignal('SIGKILL');
    if (killResult === 'permission') {
      return { success: false, reason: 'permission' };
    }
    if (killResult === false) {
      return { success: true };
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!this.isProcessRunning(pid)) {
        return { success: true };
      }
      await this.delay(300);
    }

    return { success: false, reason: 'still_running' };
  }

  isProcessRunning(pid) {
    if (!pid) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'EPERM') {
        return true;
      }
      return false;
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

      // Check current user
      let currentUser = 'unknown';
      try {
        const { stdout } = await execAsync('whoami', { timeout: 2000 });
        currentUser = stdout.trim();
        console.log(`Running as user: ${currentUser}`);
      } catch (error) {
        console.log('Could not determine current user');
      }

      // Check if we're root
      const isRoot = currentUser === 'root';

      // Check if sudo is available and working
      let hasSudo = false;
      if (!isRoot) {
        try {
          await execAsync('which sudo', { timeout: 2000 });
          // Verify we can actually use sudo without password
          try {
            await execAsync('sudo -n true', { timeout: 2000 });
            hasSudo = true;
            console.log('sudo command found and user has passwordless sudo privileges');
          } catch (sudoError) {
            console.log('sudo found but user does not have passwordless sudo privileges');
          }
        } catch (error) {
          console.log('sudo command not found');
        }
      }

      // If we're not root and don't have working sudo, update cannot proceed
      if (!isRoot && !hasSudo) {
        const errorMessage = `Ollama update requires root privileges. This system is running as user "${currentUser}" without sudo access. Please contact your system administrator for assistance.`;
        console.error(errorMessage);

        const config = await OllamaConfig.getConfig();
        config.serviceStatus = 'error';
        await config.setError(errorMessage);

        throw new Error(errorMessage);
      }

      // Prepare update command
      let updateCommand = 'curl -fsSL https://ollama.com/install.sh | sh';
      if (hasSudo) {
        updateCommand = 'curl -fsSL https://ollama.com/install.sh | sudo sh';
        console.log('Running Ollama update script with sudo...');
      } else {
        console.log('Running Ollama update script as root...');
      }

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
