const crypto = require('node:crypto');

const DASHBOARD_WIDGET_TYPES = [
  'hero',
  'summary',
  'security',
  'favorite-scenes',
  'favorite-devices',
  'weather',
  'voice-command',
  'device'
];

const DASHBOARD_WIDGET_SIZES = ['small', 'medium', 'large', 'full'];
const DASHBOARD_FAVORITE_DEVICE_SIZES = ['small', 'medium', 'large'];
const DASHBOARD_WEATHER_LOCATION_MODES = ['saved', 'custom', 'auto'];

const DEFAULT_WIDGET_ORDER = [
  { type: 'hero', title: 'Welcome Home', size: 'full' },
  { type: 'summary', title: 'System Summary', size: 'full' },
  { type: 'security', title: 'Security Center', size: 'medium' },
  { type: 'favorite-scenes', title: 'Quick Scenes', size: 'large' },
  { type: 'voice-command', title: 'Voice Commands', size: 'large' }
];

function createDashboardEntityId(prefix) {
  const randomPart = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : crypto.randomBytes(8).toString('hex');

  return `${prefix}-${randomPart}`;
}

function sanitizeTitle(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeWidgetSettings(type, settings) {
  const normalized = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? { ...settings }
    : {};

  if (type === 'device') {
    if (typeof normalized.deviceId !== 'string' || !normalized.deviceId.trim()) {
      return null;
    }

    return {
      deviceId: normalized.deviceId.trim()
    };
  }

  if (type === 'favorite-devices') {
    const favoriteDeviceSizes = normalized.favoriteDeviceSizes
      && typeof normalized.favoriteDeviceSizes === 'object'
      && !Array.isArray(normalized.favoriteDeviceSizes)
      ? Object.entries(normalized.favoriteDeviceSizes).reduce((accumulator, [deviceId, size]) => {
        const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';
        const normalizedSize = typeof size === 'string' ? size.trim() : '';
        if (!normalizedDeviceId || !DASHBOARD_FAVORITE_DEVICE_SIZES.includes(normalizedSize)) {
          return accumulator;
        }

        accumulator[normalizedDeviceId] = normalizedSize;
        return accumulator;
      }, {})
      : {};

    return Object.keys(favoriteDeviceSizes).length > 0
      ? { favoriteDeviceSizes }
      : {};
  }

  if (type === 'weather') {
    const weatherLocationMode = typeof normalized.weatherLocationMode === 'string'
      ? normalized.weatherLocationMode.trim()
      : '';
    const weatherLocationQuery = typeof normalized.weatherLocationQuery === 'string'
      ? normalized.weatherLocationQuery.trim()
      : '';

    if (weatherLocationMode === 'custom') {
      return weatherLocationQuery
        ? { weatherLocationMode, weatherLocationQuery }
        : { weatherLocationMode: 'saved' };
    }

    if (DASHBOARD_WEATHER_LOCATION_MODES.includes(weatherLocationMode)) {
      return { weatherLocationMode };
    }

    return { weatherLocationMode: 'saved' };
  }

  return {};
}

function normalizeWidget(widget, index = 0) {
  if (!widget || typeof widget !== 'object') {
    return null;
  }

  const type = typeof widget.type === 'string' ? widget.type.trim() : '';
  if (!DASHBOARD_WIDGET_TYPES.includes(type)) {
    return null;
  }

  const defaultDescriptor = DEFAULT_WIDGET_ORDER.find((entry) => entry.type === type);
  const title = sanitizeTitle(widget.title, defaultDescriptor?.title ?? type);
  const size = DASHBOARD_WIDGET_SIZES.includes(widget.size) ? widget.size : (defaultDescriptor?.size ?? 'medium');
  const settings = normalizeWidgetSettings(type, widget.settings);

  if (settings === null) {
    return null;
  }

  const widgetId = typeof widget.id === 'string' && widget.id.trim()
    ? widget.id.trim()
    : createDashboardEntityId(`widget-${index + 1}`);

  return {
    id: widgetId,
    type,
    title,
    size,
    minimized: Boolean(widget.minimized),
    settings
  };
}

function createDefaultDashboardView(name = 'Main Dashboard') {
  return {
    id: createDashboardEntityId('view'),
    name,
    widgets: DEFAULT_WIDGET_ORDER.map((widget, index) => ({
      id: createDashboardEntityId(`widget-${index + 1}`),
      type: widget.type,
      title: widget.title,
      size: widget.size,
      minimized: false,
      settings: {}
    }))
  };
}

function normalizeDashboardView(view, index = 0) {
  if (!view || typeof view !== 'object') {
    return null;
  }

  const hasExplicitWidgets = Array.isArray(view.widgets);
  const widgets = hasExplicitWidgets
    ? view.widgets
        .map((widget, widgetIndex) => normalizeWidget(widget, widgetIndex))
        .filter(Boolean)
    : [];

  const fallbackView = createDefaultDashboardView(index === 0 ? 'Main Dashboard' : `Dashboard ${index + 1}`);
  const normalizedWidgets = hasExplicitWidgets ? widgets : fallbackView.widgets;
  const viewId = typeof view.id === 'string' && view.id.trim() ? view.id.trim() : fallbackView.id;

  return {
    id: viewId,
    name: sanitizeTitle(view.name, index === 0 ? 'Main Dashboard' : `Dashboard ${index + 1}`),
    widgets: normalizedWidgets
  };
}

function normalizeDashboardViews(views) {
  if (!Array.isArray(views) || views.length === 0) {
    return [createDefaultDashboardView()];
  }

  const normalized = views
    .map((view, index) => normalizeDashboardView(view, index))
    .filter(Boolean);

  if (normalized.length === 0) {
    return [createDefaultDashboardView()];
  }

  const usedIds = new Set();

  return normalized.map((view, index) => {
    let nextId = view.id;
    if (usedIds.has(nextId)) {
      nextId = createDashboardEntityId(`view-${index + 1}`);
    }
    usedIds.add(nextId);

    const widgetIds = new Set();
    const widgets = view.widgets.map((widget, widgetIndex) => {
      let widgetId = widget.id;
      if (widgetIds.has(widgetId)) {
        widgetId = createDashboardEntityId(`widget-${widgetIndex + 1}`);
      }
      widgetIds.add(widgetId);

      return {
        ...widget,
        id: widgetId
      };
    });

    return {
      ...view,
      id: nextId,
      widgets
    };
  });
}

module.exports = {
  DASHBOARD_FAVORITE_DEVICE_SIZES,
  DASHBOARD_WEATHER_LOCATION_MODES,
  DASHBOARD_WIDGET_SIZES,
  DASHBOARD_WIDGET_TYPES,
  createDashboardEntityId,
  createDefaultDashboardView,
  normalizeDashboardView,
  normalizeDashboardViews,
  normalizeWidget
};
