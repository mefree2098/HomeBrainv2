const test = require('node:test');
const assert = require('node:assert/strict');

const { serializeDevice } = require('../services/devicePayloadService');

test('serializeDevice removes bulky SmartThings raw payloads from client device summaries', () => {
  const device = {
    _id: 'device-1',
    name: 'Office TV',
    type: 'switch',
    room: 'Office',
    status: false,
    properties: {
      source: 'smartthings',
      smartThingsStatus: {
        components: {
          main: {
            switch: {
              switch: {
                value: 'off',
                timestamp: '2026-05-06T05:00:00.000Z'
              }
            }
          }
        }
      },
      smartThingsComponents: [
        { id: 'main', capabilities: [{ id: 'switch' }, { id: 'powerMeter' }] }
      ],
      smartThingsAttributeValues: {
        byComponent: {
          main: {
            switch: { switch: 'off' }
          },
          aux: {
            switch: { switch: 'on' }
          }
        },
        switch: {
          switch: 'off'
        },
        powerMeter: {
          power: 12.4
        }
      },
      smartThingsAttributeMetadata: {
        byComponent: {
          main: {
            switch: {
              switch: {
                value: 'off',
                unit: null,
                data: null,
                timestamp: '2026-05-06T05:00:00.000Z',
                componentId: 'main',
                capability: 'switch',
                attribute: 'switch'
              }
            }
          },
          aux: {
            switch: {
              switch: {
                value: 'on',
                unit: null,
                timestamp: '2026-05-06T05:01:00.000Z',
                componentId: 'aux',
                capability: 'switch',
                attribute: 'switch'
              }
            }
          }
        },
        powerMeter: {
          power: {
            value: 12.4,
            unit: 'W',
            data: null,
            timestamp: '2026-05-06T05:02:00.000Z',
            componentId: 'main',
            capability: 'powerMeter',
            attribute: 'power'
          }
        }
      }
    }
  };

  const serialized = serializeDevice(device);

  assert.equal(serialized._id, 'device-1');
  assert.equal(serialized.id, 'device-1');
  assert.equal(serialized.properties.smartThingsStatus, undefined);
  assert.equal(serialized.properties.smartThingsComponents, undefined);
  assert.equal(serialized.properties.smartThingsAttributeValues.byComponent.main, undefined);
  assert.deepEqual(serialized.properties.smartThingsAttributeValues.byComponent.aux, {
    switch: { switch: 'on' }
  });
  assert.deepEqual(serialized.properties.smartThingsAttributeMetadata.powerMeter.power, {
    unit: 'W',
    timestamp: '2026-05-06T05:02:00.000Z'
  });
  assert.equal(serialized.properties.smartThingsAttributeMetadata.powerMeter.power.value, undefined);
  assert.equal(serialized.properties.smartThingsAttributeMetadata.powerMeter.power.componentId, undefined);
  assert.equal(serialized.properties.smartThingsAttributeMetadata.byComponent.main, undefined);
});

test('serializeDevice can include raw SmartThings fields for explicit diagnostics', () => {
  const serialized = serializeDevice({
    _id: 'device-2',
    properties: {
      smartThingsStatus: { raw: true },
      smartThingsComponents: [{ id: 'main' }]
    }
  }, { includeRaw: true });

  assert.deepEqual(serialized.properties.smartThingsStatus, { raw: true });
  assert.deepEqual(serialized.properties.smartThingsComponents, [{ id: 'main' }]);
});
