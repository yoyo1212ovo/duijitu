const fs = require("fs");
const path = require("path");
const { fetchLiveChannelSummary } = require("../web/mabang");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = match[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFile(path.join(__dirname, "..", ".env"));
loadEnvFile(path.join(__dirname, ".env"));

function formatChinaDate(value = new Date()) {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(dateStr, amount) {
  const date = new Date(dateStr + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function minDate(a, b) {
  return a < b ? a : b;
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function sumChannels(record) {
  return Object.values(record && record.channels || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function writeHistory(historyFile, history) {
  const tmpFile = historyFile + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(history, null, 2));
  fs.renameSync(tmpFile, historyFile);
}

async function fetchRangeWithRetry(options, attempts = 3) {
  const maxAttempts = Number(process.env.BACKFILL_RETRY_ATTEMPTS) || attempts;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchLiveChannelSummary(options);
    } catch (err) {
      lastError = err;
      console.log(`  attempt ${attempt}/${maxAttempts} failed: ${err && err.message ? err.message : err}`);
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, Math.min(30000, attempt * 5000)));
    }
  }
  throw lastError;
}

async function main() {
  const today = formatChinaDate();
  const shippingStartDate = process.argv[2] || process.env.BACKFILL_START_DATE || addDays(today, -7);
  const shippingEndDate = process.argv[3] || process.env.BACKFILL_END_DATE || today;
  const queryStartDate = process.argv[4] || process.env.BACKFILL_QUERY_START_DATE || shippingStartDate;
  const queryEndDate = process.argv[5] || process.env.BACKFILL_QUERY_END_DATE || shippingEndDate;
  const queryMode = process.argv[6] || process.env.BACKFILL_TIME_FIELD || "shipping";
  const timeField = queryMode === "shipping" ? "expressTime" : "createDate";
  if (shippingStartDate > shippingEndDate) throw new Error("shipping start date must be before or equal to end date");
  if (queryStartDate > queryEndDate) throw new Error("query start date must be before or equal to end date");

  const historyFile = path.join(__dirname, "..", "web", "data", "live-history.json");
  const history = fs.existsSync(historyFile)
    ? JSON.parse(fs.readFileSync(historyFile, "utf8"))
    : { days: {} };
  history.days = history.days && typeof history.days === "object" ? history.days : {};

  console.log(`Fetching query=${queryStartDate}..${queryEndDate} shipping=${shippingStartDate}..${shippingEndDate}`);
  const savedTotals = {};
  let cursor = queryStartDate;

  while (cursor <= queryEndDate) {
    const dayShippingStart = maxDate(shippingStartDate, cursor);
    const dayShippingEnd = minDate(shippingEndDate, cursor);
    if (dayShippingStart <= dayShippingEnd) {
      console.log(`Fetching day ${cursor} (shipping ${dayShippingStart}..${dayShippingEnd})`);
      const result = await fetchRangeWithRetry({
        startDate: dayShippingStart,
        endDate: dayShippingEnd,
        queryStartDate: cursor,
        queryEndDate: cursor,
        timeField,
        allowHistorical: true,
        statuses: [1, 2, 3, 4, 5, 6, 7]
      });

      const daily = result && result.dailySummary && result.dailySummary.byDate ? result.dailySummary.byDate : {};
      for (const [day, record] of Object.entries(daily)) {
        history.days[day] = record;
        savedTotals[day] = sumChannels(record);
      }

      history.updatedAt = new Date().toISOString();
      history.lastFetchedAt = history.updatedAt;
      history.lastStartDate = shippingStartDate;
      history.lastEndDate = shippingEndDate;
      writeHistory(historyFile, history);
      console.log(`  saved day=${cursor} totals=${JSON.stringify(savedTotals)}`);
    } else {
      console.log(`Skipping day ${cursor}: outside shipping range`);
    }

    cursor = addDays(cursor, 1);
  }

  console.log(`Saved range totals=${JSON.stringify(savedTotals)}`);
  console.log(`Wrote ${historyFile}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
