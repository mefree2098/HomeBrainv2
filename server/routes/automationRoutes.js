const express = require('express');
const router = express.Router();
const automationService = require('../services/automationService');

/**
 * GET /api/automations
 * Get all automations
 */
router.get('/', async (req, res) => {
  try {
    console.log('AutomationRoutes: GET /api/automations - Fetching all automations');
    
    const automations = await automationService.getAllAutomations();
    
    console.log(`AutomationRoutes: Successfully retrieved ${automations.length} automations`);
    res.status(200).json({
      success: true,
      automations: automations,
      count: automations.length
    });
  } catch (error) {
    console.error('AutomationRoutes: Error fetching automations:', error.message);
    console.error('AutomationRoutes: Full error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch automations'
    });
  }
});

/**
 * GET /api/automations/stats
 * Get automation statistics
 */
router.get('/stats', async (req, res) => {
  try {
    console.log('AutomationRoutes: GET /api/automations/stats - Fetching automation statistics');
    
    const stats = await automationService.getAutomationStats();
    
    console.log('AutomationRoutes: Successfully retrieved automation statistics');
    res.status(200).json({
      success: true,
      stats: stats
    });
  } catch (error) {
    console.error('AutomationRoutes: Error fetching automation statistics:', error.message);
    console.error('AutomationRoutes: Full error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch automation statistics'
    });
  }
});

/**
 * GET /api/automations/:id
 * Get a single automation by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`AutomationRoutes: GET /api/automations/${id} - Fetching single automation`);
    
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        message: 'Automation ID is required'
      });
    }
    
    const automation = await automationService.getAutomationById(id);
    
    console.log(`AutomationRoutes: Successfully retrieved automation: ${automation.name}`);
    res.status(200).json({
      success: true,
      automation: automation
    });
  } catch (error) {
    console.error(`AutomationRoutes: Error fetching automation ${req.params.id}:`, error.message);
    console.error('AutomationRoutes: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch automation'
      });
    }
  }
});

/**
 * POST /api/automations
 * Create a new automation
 */
router.post('/', async (req, res) => {
  try {
    console.log('AutomationRoutes: POST /api/automations - Creating new automation');
    console.log('AutomationRoutes: Automation data received:', req.body);
    
    const { name, description, trigger, actions, enabled, priority, category, conditions, cooldown } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Automation name is required'
      });
    }
    
    if (!trigger) {
      return res.status(400).json({
        success: false,
        message: 'Automation trigger is required'
      });
    }
    
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one action is required'
      });
    }
    
    const automationData = {
      name: name.trim(),
      description: description ? description.trim() : '',
      trigger,
      actions,
      enabled: enabled !== undefined ? enabled : true,
      priority: priority || 5,
      category: category || 'custom',
      conditions: conditions || [],
      cooldown: cooldown || 0
    };
    
    const newAutomation = await automationService.createAutomation(automationData);
    
    console.log(`AutomationRoutes: Automation created successfully with ID: ${newAutomation._id}`);
    res.status(201).json({
      success: true,
      message: 'Automation created successfully',
      automation: newAutomation
    });
  } catch (error) {
    console.error('AutomationRoutes: Error creating automation:', error.message);
    console.error('AutomationRoutes: Full error:', error);
    
    if (error.message.includes('required') || error.message.includes('already exists')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to create automation'
      });
    }
  }
});

/**
 * POST /api/automations/create-from-text
 * Create automation from natural language text
 */
router.post('/create-from-text', async (req, res) => {
  try {
    console.log('AutomationRoutes: POST /api/automations/create-from-text - Creating automation from natural language');
    console.log('AutomationRoutes: Text received:', req.body);
    
    const { text } = req.body;
    
    if (!text || text.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Automation text description is required'
      });
    }
    
    const result = await automationService.createAutomationFromText(text.trim());

    if (result?.handledDirectCommand) {
      console.log('AutomationRoutes: Request was handled as a direct device command; no automation created.');
      return res.status(200).json(result);
    }

    console.log(`AutomationRoutes: Automation created from text successfully with ID: ${result.automation._id}`);
    res.status(201).json(result);
  } catch (error) {
    console.error('AutomationRoutes: Error creating automation from text:', error.message);
    console.error('AutomationRoutes: Full error:', error);
    
    if (error.message.includes('required') || error.message.includes('unavailable')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to create automation from text'
      });
    }
  }
});

/**
 * PUT /api/automations/:id
 * Update an existing automation
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`AutomationRoutes: PUT /api/automations/${id} - Updating automation`);
    console.log('AutomationRoutes: Update data received:', req.body);
    
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        message: 'Automation ID is required'
      });
    }
    
    const updateData = req.body;
    
    // Validate name if provided
    if (updateData.name !== undefined && updateData.name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Automation name cannot be empty'
      });
    }
    
    // Validate actions if provided
    if (updateData.actions !== undefined) {
      if (!Array.isArray(updateData.actions) || updateData.actions.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one action is required'
        });
      }
    }
    
    const updatedAutomation = await automationService.updateAutomation(id, updateData);
    
    console.log(`AutomationRoutes: Automation updated successfully: ${updatedAutomation.name}`);
    res.status(200).json({
      success: true,
      message: 'Automation updated successfully',
      automation: updatedAutomation
    });
  } catch (error) {
    console.error(`AutomationRoutes: Error updating automation ${req.params.id}:`, error.message);
    console.error('AutomationRoutes: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else if (error.message.includes('required') || error.message.includes('cannot be empty') || 
               error.message.includes('already exists')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to update automation'
      });
    }
  }
});

/**
 * PUT /api/automations/:id/toggle
 * Toggle automation enabled status
 */
router.put('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;
    
    console.log(`AutomationRoutes: PUT /api/automations/${id}/toggle - Toggling automation`);
    console.log('AutomationRoutes: Toggle data received:', { enabled });
    
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        message: 'Automation ID is required'
      });
    }
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Enabled status must be a boolean value'
      });
    }
    
    const result = await automationService.toggleAutomation(id, enabled);
    
    console.log(`AutomationRoutes: Automation toggled successfully: ${result.automation.name}`);
    res.status(200).json({
      success: true,
      message: result.message,
      automation: result.automation
    });
  } catch (error) {
    console.error(`AutomationRoutes: Error toggling automation ${req.params.id}:`, error.message);
    console.error('AutomationRoutes: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else if (error.message.includes('must be a boolean')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to toggle automation'
      });
    }
  }
});

/**
 * POST /api/automations/:id/execute
 * Manually execute an automation
 */
router.post('/:id/execute', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`AutomationRoutes: POST /api/automations/${id}/execute - Manually executing automation`);
    
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        message: 'Automation ID is required'
      });
    }
    
    const result = await automationService.executeAutomation(id);
    
    console.log(`AutomationRoutes: Automation executed successfully: ${result.automation.name}`);
    res.status(200).json(result);
  } catch (error) {
    console.error(`AutomationRoutes: Error executing automation ${req.params.id}:`, error.message);
    console.error('AutomationRoutes: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else if (error.message.includes('disabled')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to execute automation'
      });
    }
  }
});

/**
 * DELETE /api/automations/:id
 * Delete an automation
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`AutomationRoutes: DELETE /api/automations/${id} - Deleting automation`);
    
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        message: 'Automation ID is required'
      });
    }
    
    const result = await automationService.deleteAutomation(id);
    
    console.log(`AutomationRoutes: Automation deleted successfully: ${result.deletedAutomation.name}`);
    res.status(200).json({
      success: true,
      message: result.message,
      deletedAutomation: result.deletedAutomation
    });
  } catch (error) {
    console.error(`AutomationRoutes: Error deleting automation ${req.params.id}:`, error.message);
    console.error('AutomationRoutes: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to delete automation'
      });
    }
  }
});

// Description: Get automation execution history
// Endpoint: GET /api/automations/history{/:id}
// Request: { limit?: number }
// Response: { success: boolean, history: Array<object> }
router.get('/history{/:id}', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit } = req.query;

    console.log(`AutomationRoutes: GET /api/automations/history${id ? `/${id}` : ''} - Fetching execution history`);

    const history = await automationService.getAutomationHistory(id || null, limit ? parseInt(limit) : 50);

    console.log(`AutomationRoutes: Retrieved ${history.length} history entries`);
    res.status(200).json({
      success: true,
      history: history,
      count: history.length
    });
  } catch (error) {
    console.error('AutomationRoutes: Error fetching automation history:', error.message);
    console.error('AutomationRoutes: Full error:', error);

    if (error.message.includes('Invalid')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch automation history'
      });
    }
  }
});

// Description: Get execution statistics
// Endpoint: GET /api/automations/execution-stats
// Request: { startDate?: string, endDate?: string }
// Response: { success: boolean, stats: object }
router.get('/execution-stats', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    console.log('AutomationRoutes: GET /api/automations/execution-stats - Fetching execution statistics');

    const dateRange = (startDate && endDate) ? { start: startDate, end: endDate } : null;
    const stats = await automationService.getExecutionStats(dateRange);

    console.log('AutomationRoutes: Retrieved execution statistics');
    res.status(200).json({
      success: true,
      stats: stats
    });
  } catch (error) {
    console.error('AutomationRoutes: Error fetching execution statistics:', error.message);
    console.error('AutomationRoutes: Full error:', error);

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch execution statistics'
    });
  }
});

module.exports = router;
