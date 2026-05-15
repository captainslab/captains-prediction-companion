import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const NWS_API_BASE_URL = 'https://api.weather.gov';

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function makeEnvelope({
  status,
  checkedAtUtc,
  cachePath,
  records = [],
  warnings = [],
  errors = [],
  sourceUrls = [],
}) {
  return {
    source_id: 'weather',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `weather_environment_${checkedAtUtc}`,
    cache_path: cachePath,
    required: true,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function readMlbGamesFromDiscovery(filePath) {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return { records: [], warning: `MLB official discovery file not found at ${filePath}.` };
  }

  try {
    const payload = JSON.parse(readFileSync(absolutePath, 'utf8'));
    return { records: safeArray(payload.records), warning: null };
  } catch (error) {
    return {
      records: [],
      warning: `Could not parse MLB official discovery file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function fixtureRecords({ checkedAtUtc, runDate }) {
  return [
    {
      query_type: 'game_weather_environment',
      game_pk: 100001,
      game_date: runDate,
      game: 'Alpha City Aces at Beta Town Bears',
      venue: 'Placeholder Park',
      checked_at_utc: checkedAtUtc,
      temperature: 72,
      temperature_unit: 'F',
      wind_speed: 9,
      wind_speed_unit: 'mph',
      wind_direction: 'out to left-center',
      precipitation_risk: 0.15,
      roof_status: null,
      weather_note: 'Fixture weather record only; no live weather source was called.',
      source_urls: [],
    },
  ];
}

function gameCoordinates(game) {
  return (
    game.venue_coordinates ??
    game.weather_coordinates ??
    game.venue?.coordinates ??
    null
  );
}

function pointUrlForCoordinates(coordinates) {
  const latitude = Number(coordinates?.latitude ?? coordinates?.lat);
  const longitude = Number(coordinates?.longitude ?? coordinates?.lon ?? coordinates?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return `${NWS_API_BASE_URL}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

function normalizeForecastPeriod({ game, checkedAtUtc, pointUrl, forecastUrl, period }) {
  return {
    query_type: 'game_weather_environment',
    game_pk: game.game_pk ?? null,
    game_date: game.game_date ?? null,
    game: `${game.away_team ?? 'Unknown Away'} at ${game.home_team ?? 'Unknown Home'}`,
    venue: game.venue ?? null,
    checked_at_utc: checkedAtUtc,
    temperature: typeof period?.temperature === 'number' ? period.temperature : null,
    temperature_unit: period?.temperatureUnit ?? null,
    wind_speed: period?.windSpeed ?? null,
    wind_speed_unit: null,
    wind_direction: period?.windDirection ?? null,
    precipitation_risk: period?.probabilityOfPrecipitation?.value ?? null,
    roof_status: game.roof_status ?? null,
    weather_note: period?.shortForecast ?? 'Live NWS forecast period captured; no pick or model recommendation created.',
    source_urls: [pointUrl, forecastUrl].filter(Boolean),
  };
}

export function fixtureWeatherEnvelope({
  runDate,
  checkedAtUtc = '2026-05-15T14:00:00.000Z',
  outputDir,
}) {
  return makeEnvelope({
    status: 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/weather_adapter.json`,
    records: fixtureRecords({ checkedAtUtc, runDate }),
    warnings: ['Fixture mode: no live weather source was called.'],
    sourceUrls: [NWS_API_BASE_URL],
  });
}

export async function fetchWeatherReadonly({
  runDate,
  outputDir,
  fixturesOnly = true,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  mlbGames = null,
  mlbDiscoveryPath = `${outputDir}/mlb_official_adapter.json`,
} = {}) {
  const checkedAtUtc = isoNow(now);
  if (fixturesOnly) {
    return fixtureWeatherEnvelope({ runDate, checkedAtUtc, outputDir });
  }

  const warnings = [];
  const errors = [];
  const records = [];
  const sourceUrls = [NWS_API_BASE_URL];
  let games = safeArray(mlbGames);
  if (games.length === 0) {
    const discovery = readMlbGamesFromDiscovery(mlbDiscoveryPath);
    games = discovery.records;
    if (discovery.warning) warnings.push(discovery.warning);
  }

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/weather_adapter.json`,
      warnings,
      errors: ['No fetch implementation available for live-readonly weather request.'],
      sourceUrls,
    });
  }

  for (const game of games) {
    const pointUrl = pointUrlForCoordinates(gameCoordinates(game));
    if (!pointUrl) {
      warnings.push(
        `No venue coordinates available for ${game.away_team ?? 'unknown away'} at ${game.home_team ?? 'unknown home'}; no weather record created.`,
      );
      continue;
    }

    sourceUrls.push(pointUrl);
    try {
      const pointResponse = await fetchImpl(pointUrl, {
        method: 'GET',
        headers: {
          accept: 'application/geo+json,application/json',
          'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
        },
      });
      if (!pointResponse.ok) {
        warnings.push(`NWS points endpoint returned HTTP ${pointResponse.status} for ${pointUrl}.`);
        continue;
      }

      const pointPayload = await pointResponse.json();
      const forecastUrl = pointPayload?.properties?.forecastHourly ?? pointPayload?.properties?.forecast ?? null;
      if (!forecastUrl) {
        warnings.push(`NWS points response did not include a forecast URL for ${pointUrl}.`);
        continue;
      }

      sourceUrls.push(forecastUrl);
      const forecastResponse = await fetchImpl(forecastUrl, {
        method: 'GET',
        headers: {
          accept: 'application/geo+json,application/json',
          'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
        },
      });
      if (!forecastResponse.ok) {
        warnings.push(`NWS forecast endpoint returned HTTP ${forecastResponse.status} for ${forecastUrl}.`);
        continue;
      }

      const forecastPayload = await forecastResponse.json();
      const period = safeArray(forecastPayload?.properties?.periods)[0] ?? null;
      if (!period) {
        warnings.push(`NWS forecast returned no periods for ${forecastUrl}.`);
        continue;
      }

      records.push(normalizeForecastPeriod({ game, checkedAtUtc, pointUrl, forecastUrl, period }));
    } catch (error) {
      warnings.push(`Weather lookup failed for ${pointUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (records.length === 0) {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/weather_adapter.json`,
      warnings: [
        ...warnings,
        'No usable live weather records were returned; MLB schedule context was not emitted as weather evidence.',
      ],
      errors,
      sourceUrls,
    });
  }

  return makeEnvelope({
    status: warnings.length > 0 ? 'degraded' : 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/weather_adapter.json`,
    records,
    warnings: [
      ...warnings,
      'Live read-only weather records are environment inputs only, not final model evidence or recommendations.',
    ],
    errors,
    sourceUrls,
  });
}
