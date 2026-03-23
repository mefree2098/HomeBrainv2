const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDefaultDashboardView,
  normalizeDashboardViews
} = require('../utils/dashboardViews');

test('normalizeDashboardViews creates a default dashboard when input is empty', () => {
  const views = normalizeDashboardViews([]);

  assert.equal(views.length, 1);
  assert.equal(views[0].name, 'Main Dashboard');
  assert.deepEqual(
    views[0].widgets.map((widget) => widget.type),
    ['hero', 'summary', 'security', 'favorite-scenes', 'favorite-devices', 'voice-command']
  );
});

test('normalizeDashboardViews drops invalid widgets and preserves valid device widgets', () => {
  const fallbackView = createDefaultDashboardView('Ignored');
  const [view] = normalizeDashboardViews([
    {
      id: 'kitchen',
      name: 'Kitchen iPad',
      widgets: [
        {
          id: 'security',
          type: 'security',
          title: 'Security Center',
          size: 'medium',
          minimized: false
        },
        {
          id: 'broken-device',
          type: 'device',
          title: 'Broken Device',
          size: 'small',
          minimized: false,
          settings: {}
        },
        {
          id: 'favorite-device',
          type: 'device',
          title: 'Sink Pendant',
          size: 'small',
          minimized: true,
          settings: {
            deviceId: 'device-123'
          }
        },
        {
          id: 'unsupported',
          type: 'not-real',
          title: 'Nope',
          size: 'small'
        }
      ]
    }
  ]);

  assert.equal(view.id, 'kitchen');
  assert.equal(view.name, 'Kitchen iPad');
  assert.deepEqual(
    view.widgets.map((widget) => widget.id),
    ['security', 'favorite-device']
  );
  assert.deepEqual(view.widgets[1].settings, { deviceId: 'device-123' });
  assert.equal(view.widgets[1].minimized, true);
  assert.notEqual(view.widgets[0].id, fallbackView.widgets[0].id);
});
