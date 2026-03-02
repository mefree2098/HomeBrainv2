const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const insteonService = require('../services/insteonService');

test('resolveConnectionTarget supports serial:// scheme for USB PLM endpoints', () => {
  const resolved = insteonService.resolveConnectionTarget('serial:///dev/ttyUSB0');

  assert.equal(resolved.transport, 'serial');
  assert.equal(resolved.serialPath, '/dev/ttyUSB0');
  assert.equal(resolved.label, '/dev/ttyUSB0');
});

test('resolveConnectionTarget keeps /dev/serial/by-id endpoints as serial', () => {
  const resolved = insteonService.resolveConnectionTarget('/dev/serial/by-id/usb-Insteon_PLM-if00-port0');

  assert.equal(resolved.transport, 'serial');
  assert.equal(resolved.serialPath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
});

test('resolveConnectionTarget parses host:port shorthand as tcp', () => {
  const resolved = insteonService.resolveConnectionTarget('192.168.1.50:9761');

  assert.equal(resolved.transport, 'tcp');
  assert.equal(resolved.host, '192.168.1.50');
  assert.equal(resolved.port, 9761);
});

test('listLocalSerialPorts merges serialport list entries with /dev/serial/by-id aliases', async (t) => {
  const originalLoadSerialPortModule = insteonService._loadSerialPortModule;
  const originalGetSerialByIdEntries = insteonService._getSerialByIdEntries;

  t.after(() => {
    insteonService._loadSerialPortModule = originalLoadSerialPortModule;
    insteonService._getSerialByIdEntries = originalGetSerialByIdEntries;
  });

  insteonService._loadSerialPortModule = () => ({
    list: async () => ([
      {
        path: '/dev/ttyUSB0',
        manufacturer: 'FTDI',
        vendorId: '0403',
        productId: '6001'
      }
    ])
  });

  insteonService._getSerialByIdEntries = async () => ([
    {
      symlinkPath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0',
      resolvedPath: '/dev/ttyUSB0'
    }
  ]);

  const ports = await insteonService.listLocalSerialPorts();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].path, '/dev/ttyUSB0');
  assert.equal(ports[0].stablePath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
  assert.equal(ports[0].likelyInsteon, true);
});

test('_validateSerialEndpoint surfaces missing device with detected endpoint hints', async (t) => {
  const originalListLocalSerialPorts = insteonService.listLocalSerialPorts;
  const originalAccess = fs.promises.access;

  t.after(() => {
    insteonService.listLocalSerialPorts = originalListLocalSerialPorts;
    fs.promises.access = originalAccess;
  });

  insteonService.listLocalSerialPorts = async () => ([
    { path: '/dev/ttyUSB0', stablePath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0', aliases: [] }
  ]);

  fs.promises.access = async () => {
    const error = new Error('not found');
    error.code = 'ENOENT';
    throw error;
  };

  await assert.rejects(
    insteonService._validateSerialEndpoint('/dev/ttyUSB9'),
    /does not exist.*\/dev\/serial\/by-id\/usb-Insteon_PLM-if00-port0/i
  );
});

test('_validateSerialEndpoint includes stable path when ttyUSB path is used', async (t) => {
  const originalListLocalSerialPorts = insteonService.listLocalSerialPorts;
  const originalAccess = fs.promises.access;

  t.after(() => {
    insteonService.listLocalSerialPorts = originalListLocalSerialPorts;
    fs.promises.access = originalAccess;
  });

  insteonService.listLocalSerialPorts = async () => ([
    { path: '/dev/ttyUSB0', stablePath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0', aliases: [] }
  ]);
  fs.promises.access = async () => {};

  const result = await insteonService._validateSerialEndpoint('/dev/ttyUSB0');
  assert.equal(result.serialPath, '/dev/ttyUSB0');
  assert.equal(result.stablePath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
});
