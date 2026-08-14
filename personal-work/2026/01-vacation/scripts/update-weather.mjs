import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const API_BASE = process.env.KMA_API_BASE || "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const OPEN_METEO_BASE = process.env.OPEN_METEO_API_BASE || "https://api.open-meteo.com/v1/forecast";
const OUTPUT_PATH = resolve(process.env.WEATHER_OUTPUT_PATH || "personal-work/2026/01-vacation/data/weather.json");
const KST_OFFSET = 9 * 60 * 60 * 1000;
const serviceKey = process.env.KMA_SERVICE_KEY?.trim();

const locations = [
  { id: "gyeongju", name: "경주", stay: "8/19-8/23", nx: 100, ny: 91, latitude: 35.8562, longitude: 129.2247 },
  { id: "resom", name: "충남 리솜", stay: "8/25-8/26", nx: 55, ny: 100, latitude: 36.6885, longitude: 126.6626 },
  { id: "gwangju", name: "광주", stay: "8/26-8/28", nx: 60, ny: 74, latitude: 35.146, longitude: 126.923 }
];

function shiftedKst(milliseconds = 0) {
  return new Date(Date.now() + KST_OFFSET + milliseconds);
}

function ymd(date) {
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("");
}

function hm(date) {
  return `${String(date.getUTCHours()).padStart(2, "0")}00`;
}

function observationBase() {
  const date = shiftedKst(-70 * 60 * 1000);
  return { base_date: ymd(date), base_time: hm(date) };
}

function forecastBase() {
  const date = shiftedKst(-20 * 60 * 1000);
  const slots = [2, 5, 8, 11, 14, 17, 20, 23];
  const hour = date.getUTCHours();
  const available = slots.filter(slot => slot <= hour).at(-1);

  if (available !== undefined) {
    return { base_date: ymd(date), base_time: `${String(available).padStart(2, "0")}00` };
  }

  const previousDay = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  return { base_date: ymd(previousDay), base_time: "2300" };
}

function decodedKey() {
  if (!serviceKey) return "";
  if (!serviceKey.includes("%")) return serviceKey;
  try {
    return decodeURIComponent(serviceKey);
  } catch {
    return serviceKey;
  }
}

function apiErrorDetail(body, status) {
  const text = body.trim();
  if (!text) return `empty response (${status})`;

  if (text.startsWith("<")) {
    const tags = ["returnAuthMsg", "resultMsg", "errMsg", "returnReasonCode"];
    const details = tags.flatMap(tag => {
      const match = text.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, "i"));
      return match ? [`${tag}=${match[1].trim()}`] : [];
    });
    return details.length ? details.join(", ") : `XML error response (${status})`;
  }

  return `HTTP ${status}`;
}

async function request(endpoint, params, attempt = 1) {
  if (!serviceKey) throw new Error("KMA_SERVICE_KEY is not configured");
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.search = new URLSearchParams({
    ServiceKey: decodedKey(),
    pageNo: "1",
    numOfRows: "1000",
    dataType: "JSON",
    ...params
  }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    const body = await response.text();

    if (!response.ok || body.trimStart().startsWith("<")) {
      throw new Error(`${endpoint}: ${apiErrorDetail(body, response.status)}`);
    }

    const payload = JSON.parse(body);
    const header = payload?.response?.header;
    if (header?.resultCode !== "00") {
      throw new Error(`${endpoint}: KMA API error ${header?.resultCode || "unknown"} (${header?.resultMsg || "no message"})`);
    }

    return payload?.response?.body?.items?.item || [];
  } catch (error) {
    if (attempt < 3) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * 1_500));
      return request(endpoint, params, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function numberValue(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function precipitationLabel(value) {
  const labels = {
    "0": "강수 없음",
    "1": "비",
    "2": "비 또는 눈",
    "3": "눈",
    "4": "소나기"
  };
  return labels[String(value)] || "강수 없음";
}

function skyLabel(value) {
  return { "1": "맑음", "3": "구름 많음", "4": "흐림" }[String(value)] || "날씨 확인 중";
}

function conditionLabel(point) {
  return String(point.PTY || "0") !== "0" ? precipitationLabel(point.PTY) : skyLabel(point.SKY);
}

function openMeteoCondition(code) {
  const value = Number(code);
  if (value === 0) return "맑음";
  if (value === 1 || value === 2) return "구름 조금";
  if (value === 3 || value === 45 || value === 48) return "흐림";
  if ((value >= 71 && value <= 77) || value === 85 || value === 86) return "눈";
  if ((value >= 51 && value <= 67) || (value >= 80 && value <= 82) || value >= 95) return "비";
  return "날씨 확인 중";
}

function openMeteoIso(value) {
  if (!value) return null;
  return /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}:00+09:00`;
}

async function fetchOpenMeteo(location) {
  const url = new URL(OPEN_METEO_BASE);
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    timezone: "Asia/Seoul",
    forecast_days: "16",
    wind_speed_unit: "ms",
    current: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  }).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
    const data = await response.json();
    if (data?.error) throw new Error(`Open-Meteo: ${data.reason || "unknown error"}`);

    const currentHour = (data.hourly?.time || []).findIndex(time => time >= data.current?.time);
    const start = Math.max(currentHour, 0);
    const hourly = (data.hourly?.time || []).slice(start, start + 8).map((time, offset) => {
      const index = start + offset;
      return {
        at: openMeteoIso(time),
        temperature: numberValue(data.hourly.temperature_2m?.[index]),
        humidity: numberValue(data.hourly.relative_humidity_2m?.[index]),
        precipitationProbability: numberValue(data.hourly.precipitation_probability?.[index]),
        precipitation: numberValue(data.hourly.precipitation?.[index]) ?? 0,
        condition: openMeteoCondition(data.hourly.weather_code?.[index])
      };
    });

    const daily = (data.daily?.time || []).slice(0, 16).map((date, index) => ({
      date,
      min: numberValue(data.daily.temperature_2m_min?.[index]),
      max: numberValue(data.daily.temperature_2m_max?.[index]),
      precipitationProbability: numberValue(data.daily.precipitation_probability_max?.[index]),
      condition: openMeteoCondition(data.daily.weather_code?.[index])
    }));

    return {
      ...location,
      provider: "Open-Meteo Best Match",
      fallback: true,
      current: {
        temperature: numberValue(data.current?.temperature_2m),
        humidity: numberValue(data.current?.relative_humidity_2m),
        windSpeed: numberValue(data.current?.wind_speed_10m),
        rainLastHour: numberValue(data.current?.precipitation) ?? 0,
        condition: openMeteoCondition(data.current?.weather_code)
      },
      hourly,
      daily
    };
  } finally {
    clearTimeout(timeout);
  }
}

function groupForecast(items) {
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.fcstDate}${item.fcstTime}`;
    const point = grouped.get(key) || { date: item.fcstDate, time: item.fcstTime };
    point[item.category] = item.fcstValue;
    grouped.set(key, point);
  }
  return [...grouped.values()].sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}

function isoFromKst(date, time) {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:00+09:00`;
}

function summarizeForecast(items) {
  const nowKey = ymd(shiftedKst()) + String(shiftedKst().getUTCHours()).padStart(2, "0") + "00";
  const points = groupForecast(items).filter(point => `${point.date}${point.time}` >= nowKey);
  const hourly = points.slice(0, 8).map(point => ({
    at: isoFromKst(point.date, point.time),
    temperature: numberValue(point.TMP),
    humidity: numberValue(point.REH),
    precipitationProbability: numberValue(point.POP),
    precipitation: point.PCP || "강수 없음",
    condition: conditionLabel(point)
  }));

  const days = new Map();
  for (const point of points) {
    const day = days.get(point.date) || { date: point.date, temperatures: [], pops: [], points: [] };
    const temperature = numberValue(point.TMP);
    const pop = numberValue(point.POP);
    if (temperature !== null) day.temperatures.push(temperature);
    if (pop !== null) day.pops.push(pop);
    day.points.push(point);
    days.set(point.date, day);
  }

  const daily = [...days.values()].slice(0, 4).map(day => {
    const noon = day.points.find(point => point.time === "1200") || day.points[Math.floor(day.points.length / 2)] || {};
    return {
      date: `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`,
      min: day.temperatures.length ? Math.min(...day.temperatures) : null,
      max: day.temperatures.length ? Math.max(...day.temperatures) : null,
      precipitationProbability: day.pops.length ? Math.max(...day.pops) : null,
      condition: conditionLabel(noon)
    };
  });

  return { hourly, daily };
}

async function fetchKma(location) {
  const observation = observationBase();
  const forecast = forecastBase();
  const common = { nx: String(location.nx), ny: String(location.ny) };
  const [observations, forecasts] = await Promise.all([
    request("getUltraSrtNcst", { ...common, ...observation }),
    request("getVilageFcst", { ...common, ...forecast })
  ]);

  const currentValues = Object.fromEntries(observations.map(item => [item.category, item.obsrValue]));
  const summarized = summarizeForecast(forecasts);
  const nearest = summarized.hourly[0] || {};

  return {
    ...location,
    provider: "기상청 단기예보",
    current: {
      temperature: numberValue(currentValues.T1H),
      humidity: numberValue(currentValues.REH),
      windSpeed: numberValue(currentValues.WSD),
      rainLastHour: numberValue(currentValues.RN1) ?? 0,
      condition: nearest.condition || precipitationLabel(currentValues.PTY)
    },
    ...summarized
  };
}

function mergeDailyForecasts(primary = [], supplement = []) {
  const merged = new Map(supplement.map(day => [day.date, day]));
  for (const day of primary) merged.set(day.date, day);
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 16);
}

async function fetchLocation(location) {
  try {
    const kma = await fetchKma(location);
    try {
      const supplement = await fetchOpenMeteo(location);
      return {
        ...kma,
        daily: mergeDailyForecasts(kma.daily, supplement.daily),
        dailySupplement: "Open-Meteo Best Match"
      };
    } catch (supplementError) {
      console.warn(`[${location.id}] Open-Meteo daily supplement unavailable: ${supplementError?.message || supplementError}`);
      return kma;
    }
  } catch (kmaError) {
    console.warn(`[${location.id}] KMA unavailable: ${kmaError?.message || kmaError}`);
    try {
      return await fetchOpenMeteo(location);
    } catch (openMeteoError) {
      throw new Error(`KMA: ${kmaError?.message || kmaError}; Open-Meteo: ${openMeteoError?.message || openMeteoError}`);
    }
  }
}

async function previousData() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const previous = await previousData();
  const results = await Promise.allSettled(locations.map(fetchLocation));
  const nextLocations = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const errorMessage = result.reason?.message || String(result.reason || "unknown KMA error");
    console.error(`[${locations[index].id}] ${errorMessage}`);
    const fallback = previous?.locations?.find(location => location.id === locations[index].id);
    if (fallback) return { ...fallback, stale: true };
    return { ...locations[index], error: errorMessage };
  });

  const allFailed = results.every(result => result.status === "rejected");
  const hasPreviousWeather = previous?.locations?.some(location => location.current);
  if (allFailed && hasPreviousWeather) {
    throw new Error("All KMA requests failed; keeping the last successful weather file.");
  }

  const output = {
    status: allFailed ? "error" : "ok",
    updatedAt: new Date().toISOString(),
    source: nextLocations.some(location => location.fallback)
      ? "기상청 우선 · Open-Meteo Best Match 대체"
      : nextLocations.some(location => location.dailySupplement)
        ? "기상청 단기예보 · Open-Meteo 장기예보 보완"
        : "기상청 단기예보 조회서비스",
    updateIntervalMinutes: 60,
    locations: nextLocations
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Updated weather for ${nextLocations.filter(location => !location.error).length}/${locations.length} locations.`);
}

await main();
