import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const API_BASE = process.env.KMA_API_BASE || "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const OUTPUT_PATH = resolve(process.env.WEATHER_OUTPUT_PATH || "personal-work/2026/01-vacation/data/weather.json");
const KST_OFFSET = 9 * 60 * 60 * 1000;
const serviceKey = process.env.KMA_SERVICE_KEY?.trim();

const locations = [
  { id: "gyeongju", name: "경주", stay: "8/19-8/23", nx: 100, ny: 91 },
  { id: "resom", name: "충남 리솜", stay: "8/25-8/26", nx: 55, ny: 100 },
  { id: "gwangju", name: "광주", stay: "8/26-8/28", nx: 60, ny: 74 }
];

if (!serviceKey) {
  throw new Error("KMA_SERVICE_KEY is not configured.");
}

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
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.search = new URLSearchParams({
    serviceKey: decodedKey(),
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

async function fetchLocation(location) {
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
    console.error(`[${locations[index].id}] ${result.reason?.message || result.reason || "unknown KMA error"}`);
    const fallback = previous?.locations?.find(location => location.id === locations[index].id);
    if (fallback) return { ...fallback, stale: true };
    return { ...locations[index], error: "날씨 정보를 불러오지 못했습니다." };
  });

  if (results.every(result => result.status === "rejected")) {
    throw new Error("All KMA requests failed; keeping the last successful weather file.");
  }

  const output = {
    status: "ok",
    updatedAt: new Date().toISOString(),
    source: "기상청 단기예보 조회서비스",
    updateIntervalMinutes: 60,
    locations: nextLocations
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Updated weather for ${nextLocations.filter(location => !location.error).length}/${locations.length} locations.`);
}

await main();
