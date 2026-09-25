// Shared particulate AQI conversion for indoor climate providers.
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function deriveUsAqiFromPm25(pm25) {
  const concentration = toNumber(pm25);
  if (concentration === null || concentration < 0) {
    return null;
  }

  const breakpoints = [
    { cLow: 0.0, cHigh: 9.0, iLow: 0, iHigh: 50 },
    { cLow: 9.1, cHigh: 35.4, iLow: 51, iHigh: 100 },
    { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150 },
    { cLow: 55.5, cHigh: 125.4, iLow: 151, iHigh: 200 },
    { cLow: 125.5, cHigh: 225.4, iLow: 201, iHigh: 300 },
    { cLow: 225.5, cHigh: 500.4, iLow: 301, iHigh: 500 }
  ];

  const bucket = breakpoints.find((entry) => concentration >= entry.cLow && concentration <= entry.cHigh);
  if (!bucket) {
    return 500;
  }

  const aqi = ((bucket.iHigh - bucket.iLow) / (bucket.cHigh - bucket.cLow)) * (concentration - bucket.cLow) + bucket.iLow;
  return Math.round(aqi);
}

function describeAirQuality(aqi, pm25) {
  const value = toNumber(aqi) ?? deriveUsAqiFromPm25(pm25);
  if (value === null) {
    return {
      usAqi: null,
      qualityLabel: 'Unknown',
      qualityCategory: 'unknown',
      qualityAdvice: 'No indoor air quality reading has been received yet.'
    };
  }

  if (value <= 50) {
    return {
      usAqi: Math.round(value),
      qualityLabel: 'Good',
      qualityCategory: 'good',
      qualityAdvice: 'Indoor particulate levels look comfortable.'
    };
  }

  if (value <= 100) {
    return {
      usAqi: Math.round(value),
      qualityLabel: 'Moderate',
      qualityCategory: 'moderate',
      qualityAdvice: 'Indoor air is acceptable, with some sensitivity risk.'
    };
  }

  if (value <= 150) {
    return {
      usAqi: Math.round(value),
      qualityLabel: 'Sensitive',
      qualityCategory: 'sensitive',
      qualityAdvice: 'Sensitive people may notice indoor air quality changes.'
    };
  }

  if (value <= 200) {
    return {
      usAqi: Math.round(value),
      qualityLabel: 'Unhealthy',
      qualityCategory: 'unhealthy',
      qualityAdvice: 'Consider ventilation or filtration checks.'
    };
  }

  return {
    usAqi: Math.round(value),
    qualityLabel: 'Very Unhealthy',
    qualityCategory: 'very_unhealthy',
    qualityAdvice: 'Indoor air needs attention before extended exposure.'
  };
}


module.exports = { deriveUsAqiFromPm25, describeAirQuality };
