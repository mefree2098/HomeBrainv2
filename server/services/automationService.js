const Automation = require('../models/Automation');
const { sendLLMRequest } = require('./llmService');
const mongoose = require('mongoose');

/**
 * Get all automations
 */
async function getAllAutomations() {
  console.log('AutomationService: Fetching all automations');
  
  try {
    const automations = await Automation.find()
      .sort({ createdAt: -1 }) // Sort by newest first
      .lean(); // Use lean for better performance
    
    console.log(`AutomationService: Successfully retrieved ${automations.length} automations`);
    return automations;
  } catch (error) {
    console.error('AutomationService: Error fetching automations:', error.message);
    console.error('AutomationService: Full error:', error);
    throw new Error(`Failed to fetch automations: ${error.message}`);
  }
}

/**
 * Get automation by ID
 */
async function getAutomationById(id) {
  console.log(`AutomationService: Fetching automation with ID: ${id}`);
  
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }
    
    const automation = await Automation.findById(id).lean();
    
    if (!automation) {
      throw new Error(`Automation with ID ${id} not found`);
    }
    
    console.log(`AutomationService: Successfully retrieved automation: ${automation.name}`);
    return automation;
  } catch (error) {
    console.error(`AutomationService: Error fetching automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      throw error;
    }
    throw new Error(`Failed to fetch automation: ${error.message}`);
  }
}

/**
 * Create new automation
 */
async function createAutomation(automationData) {
  console.log('AutomationService: Creating new automation');
  console.log('AutomationService: Automation data:', automationData);
  
  try {
    // Validate required fields
    if (!automationData.name || automationData.name.trim() === '') {
      throw new Error('Automation name is required');
    }
    
    if (!automationData.trigger) {
      throw new Error('Automation trigger is required');
    }
    
    if (!automationData.actions || !Array.isArray(automationData.actions) || automationData.actions.length === 0) {
      throw new Error('At least one action is required');
    }
    
    // Check for duplicate names
    const existingAutomation = await Automation.findOne({ 
      name: { $regex: new RegExp(`^${automationData.name.trim()}$`, 'i') }
    });
    
    if (existingAutomation) {
      throw new Error(`Automation with name "${automationData.name}" already exists`);
    }
    
    // Create automation with proper data structure
    const newAutomation = new Automation({
      name: automationData.name.trim(),
      description: automationData.description || '',
      trigger: automationData.trigger,
      actions: automationData.actions,
      enabled: automationData.enabled !== undefined ? automationData.enabled : true,
      priority: automationData.priority || 5,
      category: automationData.category || 'custom',
      conditions: automationData.conditions || [],
      cooldown: automationData.cooldown || 0
    });
    
    const savedAutomation = await newAutomation.save();
    
    console.log(`AutomationService: Automation created successfully with ID: ${savedAutomation._id}`);
    return savedAutomation.toObject();
  } catch (error) {
    console.error('AutomationService: Error creating automation:', error.message);
    console.error('AutomationService: Full error:', error);
    
    if (error.message.includes('required') || error.message.includes('already exists')) {
      throw error;
    }
    throw new Error(`Failed to create automation: ${error.message}`);
  }
}

/**
 * Update automation
 */
async function updateAutomation(id, updateData) {
  console.log(`AutomationService: Updating automation with ID: ${id}`);
  console.log('AutomationService: Update data:', updateData);
  
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }
    
    // Check if automation exists
    const existingAutomation = await Automation.findById(id);
    if (!existingAutomation) {
      throw new Error(`Automation with ID ${id} not found`);
    }
    
    // Validate name if being updated
    if (updateData.name !== undefined) {
      if (!updateData.name || updateData.name.trim() === '') {
        throw new Error('Automation name cannot be empty');
      }
      
      // Check for duplicate names (excluding current automation)
      const duplicateAutomation = await Automation.findOne({
        _id: { $ne: id },
        name: { $regex: new RegExp(`^${updateData.name.trim()}$`, 'i') }
      });
      
      if (duplicateAutomation) {
        throw new Error(`Automation with name "${updateData.name}" already exists`);
      }
    }
    
    // Validate actions if being updated
    if (updateData.actions !== undefined) {
      if (!Array.isArray(updateData.actions) || updateData.actions.length === 0) {
        throw new Error('At least one action is required');
      }
    }
    
    // Update automation
    const updatedAutomation = await Automation.findByIdAndUpdate(
      id,
      { ...updateData, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).lean();
    
    console.log(`AutomationService: Automation updated successfully: ${updatedAutomation.name}`);
    return updatedAutomation;
  } catch (error) {
    console.error(`AutomationService: Error updating automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('required') || 
        error.message.includes('cannot be empty') || error.message.includes('already exists') ||
        error.message.includes('Invalid')) {
      throw error;
    }
    throw new Error(`Failed to update automation: ${error.message}`);
  }
}

/**
 * Delete automation
 */
async function deleteAutomation(id) {
  console.log(`AutomationService: Deleting automation with ID: ${id}`);
  
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }
    
    const deletedAutomation = await Automation.findByIdAndDelete(id).lean();
    
    if (!deletedAutomation) {
      throw new Error(`Automation with ID ${id} not found`);
    }
    
    console.log(`AutomationService: Automation deleted successfully: ${deletedAutomation.name}`);
    return {
      message: `Automation "${deletedAutomation.name}" has been deleted successfully`,
      deletedAutomation
    };
  } catch (error) {
    console.error(`AutomationService: Error deleting automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      throw error;
    }
    throw new Error(`Failed to delete automation: ${error.message}`);
  }
}

/**
 * Toggle automation enabled status
 */
async function toggleAutomation(id, enabled) {
  console.log(`AutomationService: Toggling automation ${id} to ${enabled ? 'enabled' : 'disabled'}`);
  
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }
    
    if (typeof enabled !== 'boolean') {
      throw new Error('Enabled status must be a boolean value');
    }
    
    const updatedAutomation = await Automation.findByIdAndUpdate(
      id,
      { enabled, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).lean();
    
    if (!updatedAutomation) {
      throw new Error(`Automation with ID ${id} not found`);
    }
    
    console.log(`AutomationService: Automation ${enabled ? 'enabled' : 'disabled'} successfully: ${updatedAutomation.name}`);
    return {
      message: `Automation "${updatedAutomation.name}" has been ${enabled ? 'enabled' : 'disabled'}`,
      automation: updatedAutomation
    };
  } catch (error) {
    console.error(`AutomationService: Error toggling automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid') ||
        error.message.includes('must be a boolean')) {
      throw error;
    }
    throw new Error(`Failed to toggle automation: ${error.message}`);
  }
}

/**
 * Create automation from natural language text
 */
async function createAutomationFromText(text) {
  console.log('AutomationService: Creating automation from natural language text');
  console.log('AutomationService: Input text:', text);
  
  try {
    if (!text || text.trim() === '') {
      throw new Error('Automation text description is required');
    }
    
    // Create a prompt for the LLM to parse the natural language
    const prompt = `
Parse the following smart home automation request into a structured format. 
Return a JSON object with the following structure:
{
  "name": "Brief descriptive name for the automation",
  "description": "The original text description",
  "trigger": {
    "type": "time|device_state|weather|location|sensor|schedule|manual",
    "conditions": {}
  },
  "actions": [
    {
      "type": "device_control|scene_activate|notification|delay|condition",
      "target": "device_id_or_scene_id",
      "parameters": {}
    }
  ],
  "category": "security|comfort|energy|convenience|custom",
  "priority": 1-10
}

Automation request: "${text.trim()}"

Examples of trigger types and conditions:
- time: {"hour": 7, "minute": 0, "days": ["monday", "tuesday", "wednesday", "thursday", "friday"]}
- device_state: {"device_id": "device123", "state": "on", "property": "brightness", "value": ">50"}
- schedule: {"cron": "0 7 * * 1-5"}

Examples of actions:
- device_control: {"type": "device_control", "target": "kitchen_lights", "parameters": {"action": "turn_on", "brightness": 80}}
- scene_activate: {"type": "scene_activate", "target": "morning_scene", "parameters": {}}
- notification: {"type": "notification", "target": "user", "parameters": {"message": "Good morning!"}}

Please analyze the request and return only valid JSON.`;

    // Send request to LLM
    let llmResponse;
    try {
      // Try Anthropic first, fallback to OpenAI if needed
      llmResponse = await sendLLMRequest('anthropic', 'claude-3-haiku-20240307', prompt);
    } catch (anthropicError) {
      console.log('AutomationService: Anthropic failed, trying OpenAI:', anthropicError.message);
      try {
        llmResponse = await sendLLMRequest('openai', 'gpt-3.5-turbo', prompt);
      } catch (openaiError) {
        console.error('AutomationService: Both LLM providers failed');
        throw new Error('LLM service unavailable. Please try again later.');
      }
    }
    
    console.log('AutomationService: LLM response:', llmResponse);
    
    // Parse LLM response
    let parsedAutomation;
    try {
      // Clean the response to extract JSON
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in LLM response');
      }
      
      parsedAutomation = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('AutomationService: Error parsing LLM response:', parseError.message);
      // Fallback to a basic automation structure
      parsedAutomation = {
        name: 'Custom Automation',
        description: text.trim(),
        trigger: {
          type: 'manual',
          conditions: { description: text.trim() }
        },
        actions: [
          {
            type: 'notification',
            target: 'user',
            parameters: { message: `Execute: ${text.trim()}` }
          }
        ],
        category: 'custom',
        priority: 5
      };
    }
    
    // Validate and clean the parsed automation
    const automationData = {
      name: parsedAutomation.name || 'Custom Automation',
      description: parsedAutomation.description || text.trim(),
      trigger: parsedAutomation.trigger || { type: 'manual', conditions: {} },
      actions: Array.isArray(parsedAutomation.actions) ? parsedAutomation.actions : [
        {
          type: 'notification',
          target: 'user',
          parameters: { message: `Execute: ${text.trim()}` }
        }
      ],
      category: parsedAutomation.category || 'custom',
      priority: parsedAutomation.priority || 5,
      enabled: true
    };
    
    // Create the automation
    const newAutomation = await createAutomation(automationData);
    
    console.log('AutomationService: Automation created from natural language successfully');
    return {
      success: true,
      automation: newAutomation,
      message: 'Automation created successfully from natural language'
    };
  } catch (error) {
    console.error('AutomationService: Error creating automation from text:', error.message);
    console.error('AutomationService: Full error:', error);
    
    if (error.message.includes('required') || error.message.includes('unavailable')) {
      throw error;
    }
    throw new Error(`Failed to create automation from text: ${error.message}`);
  }
}

/**
 * Get automation statistics
 */
async function getAutomationStats() {
  console.log('AutomationService: Getting automation statistics');
  
  try {
    const [
      totalCount,
      enabledCount,
      disabledCount,
      categoryStats,
      recentExecutions,
      priorityStats
    ] = await Promise.all([
      Automation.countDocuments(),
      Automation.countDocuments({ enabled: true }),
      Automation.countDocuments({ enabled: false }),
      Automation.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]),
      Automation.countDocuments({
        lastRun: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
      }),
      Automation.aggregate([
        { $group: { _id: '$priority', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ])
    ]);
    
    const stats = {
      total: totalCount,
      enabled: enabledCount,
      disabled: disabledCount,
      categories: categoryStats.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      recentExecutions,
      priorityDistribution: priorityStats.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {})
    };
    
    console.log('AutomationService: Successfully retrieved automation statistics');
    return stats;
  } catch (error) {
    console.error('AutomationService: Error getting automation statistics:', error.message);
    console.error('AutomationService: Full error:', error);
    throw new Error(`Failed to get automation statistics: ${error.message}`);
  }
}

/**
 * Execute automation by ID (for manual triggers)
 */
async function executeAutomation(id) {
  console.log(`AutomationService: Manually executing automation with ID: ${id}`);
  
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }
    
    const automation = await Automation.findById(id);
    
    if (!automation) {
      throw new Error(`Automation with ID ${id} not found`);
    }
    
    if (!automation.enabled) {
      throw new Error(`Automation "${automation.name}" is currently disabled`);
    }
    
    // Update execution tracking
    automation.lastRun = new Date();
    automation.executionCount = (automation.executionCount || 0) + 1;
    await automation.save();
    
    console.log(`AutomationService: Automation "${automation.name}" executed successfully`);
    return {
      success: true,
      message: `Automation "${automation.name}" executed successfully`,
      automation: automation.toObject(),
      executedActions: automation.actions.length
    };
  } catch (error) {
    console.error(`AutomationService: Error executing automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);
    
    if (error.message.includes('not found') || error.message.includes('Invalid') ||
        error.message.includes('disabled')) {
      throw error;
    }
    throw new Error(`Failed to execute automation: ${error.message}`);
  }
}

module.exports = {
  getAllAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  toggleAutomation,
  createAutomationFromText,
  getAutomationStats,
  executeAutomation
};