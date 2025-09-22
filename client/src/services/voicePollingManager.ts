// Global singleton to manage voice status polling
// Prevents multiple component instances from creating duplicate polling intervals

import { getVoiceStatus } from '@/api/voice';

// Debug mode controlled by environment variable
const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_POLLING_DEBUG === 'true';

interface VoicePollingCallback {
  id: string;
  callback: (status: any) => void;
  onError?: (error: Error) => void;
}

class VoicePollingManager {
  private static instance: VoicePollingManager;
  private callbacks = new Map<string, VoicePollingCallback>();
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private currentStatus: any = null;
  private lastFetch = 0;
  private errorCount = 0;
  
  // Singleton pattern
  static getInstance(): VoicePollingManager {
    if (!VoicePollingManager.instance) {
      VoicePollingManager.instance = new VoicePollingManager();
    }
    return VoicePollingManager.instance;
  }

  // Register a component to receive voice status updates
  subscribe(id: string, callback: (status: any) => void, onError?: (error: Error) => void): void {
    if (DEBUG_MODE) console.log(`VoicePollingManager: Subscribing component ${id}`);

    this.callbacks.set(id, { id, callback, onError });

    // If we have current status, immediately call the callback
    if (this.currentStatus) {
      callback(this.currentStatus);
    }

    // Start polling if not already started
    this.startPolling();
  }

  // Unregister a component
  unsubscribe(id: string): void {
    if (DEBUG_MODE) console.log(`VoicePollingManager: Unsubscribing component ${id}`);
    this.callbacks.delete(id);

    // Stop polling if no more callbacks
    if (this.callbacks.size === 0) {
      this.stopPolling();
    }
  }

  // Get current cached status without triggering a fetch
  getCurrentStatus(): any {
    return this.currentStatus;
  }

  // Force a refresh (useful for user-triggered updates)
  async refresh(): Promise<void> {
    if (this.isPolling) {
      if (DEBUG_MODE) console.log('VoicePollingManager: Refresh requested but polling already in progress');
      return;
    }

    await this.fetchAndNotify();
  }

  private startPolling(): void {
    if (this.pollInterval) {
      if (DEBUG_MODE) console.log('VoicePollingManager: Polling already active');
      return;
    }

    if (DEBUG_MODE) console.log('VoicePollingManager: Starting voice status polling');

    // Initial fetch
    this.fetchAndNotify();

    // Set up polling interval with exponential backoff on errors
    const getInterval = () => {
      const baseInterval = 30000; // 30 seconds
      const maxInterval = 300000;  // 5 minutes
      const backoffInterval = Math.min(baseInterval * Math.pow(1.5, this.errorCount), maxInterval);
      return backoffInterval;
    };

    const setupInterval = () => {
      const intervalTime = getInterval();
      if (DEBUG_MODE) console.log(`VoicePollingManager: Setting up polling with ${intervalTime/1000}s interval`);

      this.pollInterval = setInterval(() => {
        this.fetchAndNotify();
      }, intervalTime);
    };

    setupInterval();
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      if (DEBUG_MODE) console.log('VoicePollingManager: Stopping voice status polling');
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async fetchAndNotify(): Promise<void> {
    if (this.isPolling) {
      if (DEBUG_MODE) console.log('VoicePollingManager: Fetch already in progress, skipping');
      return;
    }

    this.isPolling = true;
    const now = Date.now();

    try {
      if (DEBUG_MODE) console.log('VoicePollingManager: Fetching voice status');
      const status = await getVoiceStatus();
      
      this.currentStatus = status;
      this.lastFetch = now;
      this.errorCount = 0; // Reset error count on success
      
      // Notify all subscribers
      this.callbacks.forEach(({ callback }) => {
        try {
          callback(status);
        } catch (error) {
          console.error('VoicePollingManager: Error in callback:', error);
        }
      });
      
    } catch (error) {
      this.errorCount += 1;
      console.error(`VoicePollingManager: Fetch failed (attempt ${this.errorCount}):`, error);
      
      // Notify error callbacks
      this.callbacks.forEach(({ onError }) => {
        if (onError) {
          try {
            onError(error as Error);
          } catch (callbackError) {
            console.error('VoicePollingManager: Error in error callback:', callbackError);
          }
        }
      });
      
      // Restart polling with backoff if we have persistent errors
      if (this.errorCount >= 3 && this.pollInterval) {
        this.stopPolling();
        setTimeout(() => {
          if (this.callbacks.size > 0) {
            this.startPolling();
          }
        }, 5000); // Wait 5 seconds before restarting
      }
      
    } finally {
      this.isPolling = false;
    }
  }

  // Get debug info
  getDebugInfo() {
    return {
      subscriberCount: this.callbacks.size,
      subscribers: Array.from(this.callbacks.keys()),
      isPolling: this.isPolling,
      hasInterval: !!this.pollInterval,
      lastFetch: this.lastFetch,
      errorCount: this.errorCount,
      currentStatus: this.currentStatus
    };
  }
}

// Export singleton instance
export const voicePollingManager = VoicePollingManager.getInstance();