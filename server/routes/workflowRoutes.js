const express = require('express');
const router = express.Router();
const workflowService = require('../services/workflowService');
const { requireUser, requireAdmin } = require('./middlewares/auth');

router.use(requireUser());
const admin = requireAdmin();

function parsePositiveInt(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const numeric = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, numeric));
}

function parseOptionalHours(value) {
  if (value == null || value === '') {
    return null;
  }

  return parsePositiveInt(value, 24, 1, 24 * 365);
}

router.get('/', async (req, res) => {
  try {
    const workflows = await workflowService.getAllWorkflows();
    return res.status(200).json({
      success: true,
      workflows,
      count: workflows.length
    });
  } catch (error) {
    console.error('GET /api/workflows - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch workflows'
    });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await workflowService.getWorkflowStats();
    return res.status(200).json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('GET /api/workflows/stats - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch workflow statistics'
    });
  }
});

router.get('/runtime-telemetry', async (req, res) => {
  try {
    const workflowId = typeof req.query.workflowId === 'string' && req.query.workflowId.trim()
      ? req.query.workflowId.trim()
      : null;
    const hours = parseOptionalHours(req.query.hours);
    const telemetry = await workflowService.getWorkflowRuntimeTelemetry(workflowId, { hours });

    return res.status(200).json({
      success: true,
      telemetry
    });
  } catch (error) {
    const statusCode = error.message.includes('Invalid') ? 400 : error.message.includes('not found') ? 404 : 500;
    console.error('GET /api/workflows/runtime-telemetry - Error:', error.message);
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to fetch workflow runtime telemetry'
    });
  }
});

router.get('/runtime-history', async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 50, 1, 100);
    const page = parsePositiveInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const hours = parseOptionalHours(req.query.hours);
    const result = await workflowService.getWorkflowRuntimeHistory(null, { limit, page, hours });
    return res.status(200).json({
      success: true,
      history: result.history,
      count: result.history.length,
      pagination: result.pagination,
      timeRange: result.timeRange
    });
  } catch (error) {
    console.error('GET /api/workflows/runtime-history - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch workflow runtime history'
    });
  }
});

router.get('/runtime-history/:id', async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 50, 1, 100);
    const page = parsePositiveInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const hours = parseOptionalHours(req.query.hours);
    const result = await workflowService.getWorkflowRuntimeHistory(req.params.id, { limit, page, hours });
    return res.status(200).json({
      success: true,
      history: result.history,
      count: result.history.length,
      pagination: result.pagination,
      timeRange: result.timeRange
    });
  } catch (error) {
    const statusCode = error.message.includes('Invalid') ? 400 : error.message.includes('not found') ? 404 : 500;
    console.error(`GET /api/workflows/runtime-history/${req.params.id} - Error:`, error.message);
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to fetch workflow runtime history'
    });
  }
});

router.get('/running', async (req, res) => {
  try {
    const limit = Number.parseInt(String(req.query.limit ?? '25'), 10);
    const executions = await workflowService.getRunningWorkflowExecutions(limit);
    return res.status(200).json({
      success: true,
      executions,
      count: executions.length
    });
  } catch (error) {
    console.error('GET /api/workflows/running - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch running workflows'
    });
  }
});

router.post('/', admin, async (req, res) => {
  try {
    const workflow = await workflowService.createWorkflow(req.body || {}, {
      source: req.body?.source || 'manual'
    });
    return res.status(201).json({
      success: true,
      message: 'Workflow created successfully',
      workflow
    });
  } catch (error) {
    const statusCode = error.message.includes('required') ? 400 : 500;
    console.error('POST /api/workflows - Error:', error.message);
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to create workflow'
    });
  }
});

router.post('/create-from-text', admin, async (req, res) => {
  try {
    const { text, roomContext = null, source = 'chat' } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Workflow text description is required'
      });
    }

    const result = await workflowService.createWorkflowFromText(text.trim(), roomContext, source);
    return res.status(result?.handledDirectCommand ? 200 : 201).json(result);
  } catch (error) {
    console.error('POST /api/workflows/create-from-text - Error:', error.message);
    const statusCode = error.message.includes('required') ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to create workflow from text'
    });
  }
});

router.post('/:id/revise-from-text', admin, async (req, res) => {
  try {
    const { text, roomContext = null, source = 'chat' } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Workflow text description is required'
      });
    }

    const result = await workflowService.reviseWorkflowFromText(req.params.id, text.trim(), roomContext, source);
    return res.status(200).json(result);
  } catch (error) {
    console.error(`POST /api/workflows/${req.params.id}/revise-from-text - Error:`, error.message);
    const statusCode = error.message.includes('Invalid') || error.message.includes('required')
      ? 400
      : error.message.includes('not found')
        ? 404
        : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to revise workflow from text'
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const workflow = await workflowService.getWorkflowById(req.params.id);
    return res.status(200).json({
      success: true,
      workflow
    });
  } catch (error) {
    const statusCode = error.message.includes('Invalid') ? 400 : error.message.includes('not found') ? 404 : 500;
    console.error(`GET /api/workflows/${req.params.id} - Error:`, error.message);
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to fetch workflow'
    });
  }
});

router.put('/:id', admin, async (req, res) => {
  try {
    const workflow = await workflowService.updateWorkflow(req.params.id, req.body || {});
    return res.status(200).json({
      success: true,
      message: 'Workflow updated successfully',
      workflow
    });
  } catch (error) {
    const statusCode = error.message.includes('Invalid') || error.message.includes('required') ? 400 : error.message.includes('not found') ? 404 : 500;
    console.error(`PUT /api/workflows/${req.params.id} - Error:`, error.message);
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to update workflow'
    });
  }
});

router.put('/:id/toggle', admin, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    const result = await workflowService.toggleWorkflow(req.params.id, enabled);
    return res.status(200).json({
      success: true,
      message: result.message,
      workflow: result.workflow
    });
  } catch (error) {
    const statusCode = error.message.includes('boolean') || error.message.includes('Invalid') ? 400 : error.message.includes('not found') ? 404 : 500;
    console.error(`PUT /api/workflows/${req.params.id}/toggle - Error:`, error.message);
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to toggle workflow'
    });
  }
});

router.post('/:id/execute', async (req, res) => {
  try {
    const result = await workflowService.executeWorkflow(req.params.id, {
      triggerType: 'manual',
      triggerSource: 'manual',
      context: req.body?.context || {}
    });
    return res.status(200).json({
      success: result.success,
      ...result
    });
  } catch (error) {
    const statusCode = error.message.includes('disabled') ? 400 : error.message.includes('Invalid') ? 400 : error.message.includes('not found') ? 404 : 500;
    console.error(`POST /api/workflows/${req.params.id}/execute - Error:`, error.message);
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to execute workflow'
    });
  }
});

router.delete('/:id', admin, async (req, res) => {
  try {
    const result = await workflowService.deleteWorkflow(req.params.id);
    return res.status(200).json(result);
  } catch (error) {
    const statusCode = error.message.includes('Invalid') ? 400 : error.message.includes('not found') ? 404 : 500;
    console.error(`DELETE /api/workflows/${req.params.id} - Error:`, error.message);
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to delete workflow'
    });
  }
});

module.exports = router;
