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

function writeHistory(historyFile, history) {
  const tmpFile = historyFile + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(history, null, 2));
  fs.renameSync(tmpFile, historyFile);
}

async function fetchRangeWithRetry(options, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchLiveChannelSummary(options);
    } catch (err) {
      lastError = err;
      console.log(`  attempt ${attempt}/${attempts} failed: ${err && err.message ? err.message : err}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
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
  if (shippingStartDate > shippingEndDate) throw new Error("shipping start date must be before or equal to end date");
  if (queryStartDate > queryEndDate) throw new Error("query start date must be before or equal to end date");

  const historyFile = path.join(__dirname, "..", "web", "data", "live-history.json");
  const history = fs.existsSync(historyFile)
    ? JSON.parse(fs.readFileSync(historyFile, "utf8"))
    : { days: {} };
  history.days = history.days && typeof history.days === "object" ? history.days : {};

  console.log(`Fetching query=${queryStartDate}..${queryEndDate} shipping=${shippingStartDate}..${shippingEndDate}`);
  const result = await fetchRangeWithRetry({
    startDate: shippingStartDate,
    endDate: shippingEndDate,
    queryStartDate,
    queryEndDate,
    statuses: [3, 7]
  });
  const daily = result && result.dailySummary && result.dailySummary.byDate ? result.dailySummary.byDate : {};
  for (const [day, record] of Object.entries(daily)) history.days[day] = record;

  history.updatedAt = new Date().toISOString();
  history.lastFetchedAt = history.updatedAt;
  history.lastStartDate = shippingStartDate;
  history.lastEndDate = shippingEndDate;
  writeHistory(historyFile, history);

  const savedTotals = Object.fromEntries(Object.entries(daily).map(([day, record]) => {
    const total = Object.values(record && record.channels || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    return [day, total];
  }));
  console.log(`Saved range total=${result.total || 0} days=${JSON.stringify(savedTotals)}`);

  console.log(`Wrote ${historyFile}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
