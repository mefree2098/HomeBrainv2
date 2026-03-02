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

test('_normalizeInsteonAddress normalizes separator formats', () => {
  assert.equal(insteonService._normalizeInsteonAddress('aa.bb.cc'), 'AABBCC');
  assert.equal(insteonService._normalizeInsteonAddress('aa bb cc'), 'AABBCC');
  assert.equal(insteonService._normalizeInsteonAddress('aa-bb-cc'), 'AABBCC');
});

test('_parseISYImportPayload parses and deduplicates mixed payload formats', () => {
  const parsed = insteonService._parseISYImportPayload({
    deviceIds: ['aa.bb.cc', '11.22.33', 'AABBCC'],
    rawDeviceList: 'Kitchen 44.55.66\nInvalid XYZ\n11-22-33',
    group: 2,
    retries: 0
  });

  assert.equal(parsed.devices.length, 3);
  assert.equal(parsed.devices[0].address, 'AABBCC');
  assert.equal(parsed.devices[1].address, '112233');
  assert.equal(parsed.devices[2].address, '445566');
  assert.equal(parsed.duplicateCount, 2);
  assert.equal(parsed.options.group, 2);
  assert.equal(parsed.options.retries, 0);
});

test('_parseISYImportPayload rejects out-of-range group values', () => {
  assert.throws(
    () => insteonService._parseISYImportPayload({ deviceIds: ['AA.BB.CC'], group: 300 }),
    /group must be an integer between 0 and 255/i
  );
});

test('_parseISYTopologyPayload parses scene topology with mixed address formats', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    dryRun: true,
    scenes: [
      {
        name: 'Movie Lights',
        group: 3,
        controller: 'gw',
        responders: [
          { id: 'aa.bb.cc', level: 20, ramp: 2000 },
          '11-22-33'
        ]
      }
    ]
  });

  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.scenes[0].controller, 'gw');
  assert.equal(parsed.scenes[0].group, 3);
  assert.equal(parsed.scenes[0].responders[0].id, 'AABBCC');
  assert.equal(parsed.scenes[0].responders[1].id, '112233');
  assert.equal(parsed.options.dryRun, true);
});

test('_parseISYTopologyPayload converts linkRecords into scene operations', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    dryRun: true,
    linkRecords: [
      {
        controller: 'gw',
        group: 5,
        responder: 'AA.BB.CC'
      },
      {
        controller: 'gw',
        group: 5,
        responder: { id: '11.22.33', level: 40 }
      }
    ]
  });

  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.scenes[0].group, 5);
  assert.equal(parsed.scenes[0].responders.length, 2);
});

test('_parseISYTopologyPayload rejects missing responders', () => {
  assert.throws(
    () => insteonService._parseISYTopologyPayload({
      scenes: [{ name: 'Broken', group: 1, controller: 'gw', responders: [] }]
    }),
    /no valid isy scene topology entries/i
  );
});

test('_parseISYNodesXml parses device and group membership from ISY xml', () => {
  const xml = `
    <nodes>
      <node flag="0">
        <address>AA BB CC</address>
        <name>Kitchen Dimmer</name>
        <family>1</family>
        <type>1.2.3</type>
        <parent>0</parent>
        <enabled>true</enabled>
      </node>
      <group flag="0">
        <address>0010</address>
        <name>Movie Scene</name>
        <parent>0</parent>
        <link type="1">AA.BB.CC</link>
        <link type="0">11.22.33</link>
      </group>
    </nodes>
  `;

  const parsed = insteonService._parseISYNodesXml(xml);
  assert.equal(parsed.devices.length, 1);
  assert.equal(parsed.devices[0].normalizedAddress, 'AABBCC');
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].controllers, ['AABBCC']);
  assert.deepEqual(parsed.groups[0].members.sort(), ['112233', 'AABBCC']);
});

test('_parseISYProgramsXml parses non-folder programs', () => {
  const xml = `
    <programs>
      <program id="0001" parentId="0000" folder="false" enabled="true" runAtStartup="true" status="true">
        <name>Evening Lights</name>
        <lastRunTime>2026/03/01 20:30:00</lastRunTime>
      </program>
      <program id="0002" parentId="0000" folder="true" status="true">
        <name>Folder</name>
      </program>
    </programs>
  `;

  const programs = insteonService._parseISYProgramsXml(xml);
  assert.equal(programs.length, 1);
  assert.equal(programs[0].id, '0001');
  assert.equal(programs[0].name, 'Evening Lights');
  assert.equal(programs[0].enabled, true);
});

test('_buildTopologyScenesFromISYGroups creates scene entries per controller', () => {
  const scenes = insteonService._buildTopologyScenesFromISYGroups([
    {
      address: '0010',
      name: 'Movie Scene',
      members: ['AABBCC', '112233'],
      controllers: ['AABBCC']
    }
  ]);

  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].controller, 'AABBCC');
  assert.equal(scenes[0].responders.length, 1);
  assert.equal(scenes[0].responders[0].id, '112233');
  assert.ok(Number.isInteger(scenes[0].group));
});
