const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const { ROLES } = require('../../shared/config/roles');
const platformDeployService = require('../services/platformDeployService');

router.use(requireUser([ROLES.ADMIN]));

router.get('/presets', async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      presets: platformDeployService.getDeployPresets()
    });
  } catch (error) {
    console.error('GET /api/platform-deploy/presets - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch deploy presets'
    });
  }
});

router.get('/status', async (req, res) => {
  try {
    const [repo, latestJob, runningJob, pendingRestart] = await Promise.all([
      platformDeployService.getRepoStatus(),
      platformDeployService.getLatestJob(),
      platformDeployService.getRunningJob(),
      platformDeployService.readPendingRestart()
    ]);
    const runtime = await platformDeployService.getRuntimeInfo(repo);

    return res.status(200).json({
      success: true,
      repo,
      runtime,
      pendingRestart,
      latestJob,
      running: Boolean(runningJob)
    });
  } catch (error) {
    console.error('GET /api/platform-deploy/status - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch deploy status'
    });
  }
});

router.get('/health', async (req, res) => {
  try {
    const health = await platformDeployService.getDeployHealth(req.app);
    return res.status(200).json({
      success: true,
      ...health
    });
  } catch (error) {
    console.error('GET /api/platform-deploy/health - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch deployment health'
    });
  }
});

router.get('/jobs/:jobId', async (req, res) => {
  try {
    const job = await platformDeployService.readJob(req.params.jobId);
    return res.status(200).json({
      success: true,
      job
    });
  } catch (error) {
    const notFound = error.code === 'ENOENT';
    if (notFound) {
      return res.status(404).json({
        success: false,
        message: 'Deployment job not found'
      });
    }

    console.error(`GET /api/platform-deploy/jobs/${req.params.jobId} - Error:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch deployment job'
    });
  }
});

router.post('/run', async (req, res) => {
  try {
    const job = await platformDeployService.startDeploy(req.body || {}, req.user?.email || req.user?._id || 'unknown');
    return res.status(202).json({
      success: true,
      job
    });
  } catch (error) {
    if (error.code === 'DEPLOY_RUNNING') {
      return res.status(409).json({
        success: false,
        message: error.message,
        job: error.job || null
      });
    }

    if (error.code === 'REPO_DIRTY') {
      return res.status(409).json({
        success: false,
        message: error.message,
        repoStatus: error.repoStatus || null
      });
    }

    console.error('POST /api/platform-deploy/run - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to start deployment'
    });
  }
});

router.post('/restart-services', async (req, res) => {
  try {
    await platformDeployService.triggerServiceRestart(null, {
      actor: req.user?.email || req.user?._id || 'unknown',
      source: 'manual'
    });
    return res.status(202).json({
      success: true,
      message: 'Service restart command queued. Status will update after the new backend boots.'
    });
  } catch (error) {
    console.error('POST /api/platform-deploy/restart-services - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to restart services'
    });
  }
});

module.exports = router;
