const express = require('express');
const roomService = require('../services/roomService');
const { requireUser, requireAdmin } = require('./middlewares/auth');

const router = express.Router();

router.use(requireUser());

function statusForRoomError(error) {
  if (error?.status) {
    return error.status;
  }
  const message = error?.message || '';
  if (message.includes('not found')) {
    return 404;
  }
  if (message.includes('already exists') || message.includes('assigned hardware')) {
    return 409;
  }
  if (message.includes('required') || message.includes('built-in') || message.includes('different room')) {
    return 400;
  }
  return 500;
}

function sendRoomError(res, error, fallback = 'Room operation failed') {
  res.status(statusForRoomError(error)).json({
    success: false,
    error: error?.message || fallback,
    data: error?.room ? { room: error.room } : undefined
  });
}

router.get('/', async (_req, res) => {
  try {
    const rooms = await roomService.listRooms();
    res.status(200).json({
      success: true,
      message: 'Rooms fetched successfully',
      data: { rooms }
    });
  } catch (error) {
    console.error('GET /api/rooms - Error:', error.message);
    sendRoomError(res, error, 'Failed to fetch rooms');
  }
});

router.post('/', requireAdmin(), async (req, res) => {
  try {
    const rooms = await roomService.createRoom(req.body?.name);
    res.status(201).json({
      success: true,
      message: 'Room created successfully',
      data: { rooms }
    });
  } catch (error) {
    console.error('POST /api/rooms - Error:', error.message);
    sendRoomError(res, error, 'Failed to create room');
  }
});

router.put('/:roomName', requireAdmin(), async (req, res) => {
  try {
    const result = await roomService.renameRoom(req.params.roomName, req.body?.name);
    res.status(200).json({
      success: true,
      message: 'Room renamed successfully',
      data: result
    });
  } catch (error) {
    console.error('PUT /api/rooms/:roomName - Error:', error.message);
    sendRoomError(res, error, 'Failed to rename room');
  }
});

router.delete('/:roomName', requireAdmin(), async (req, res) => {
  try {
    const result = await roomService.deleteRoom(req.params.roomName, {
      reassignTo: req.body?.reassignTo || req.query?.reassignTo
    });
    res.status(200).json({
      success: true,
      message: 'Room deleted successfully',
      data: result
    });
  } catch (error) {
    console.error('DELETE /api/rooms/:roomName - Error:', error.message);
    sendRoomError(res, error, 'Failed to delete room');
  }
});

module.exports = router;
