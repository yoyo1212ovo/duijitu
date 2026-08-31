const fs = require("fs");
const path = require("path");
const { fetchLiveChannelSummary } = require("../web/mabang");

const ROOT = path.join(__dirname, "..");
const HISTORY_PATH = process.env.HISTORY_FILE
  ? path.resolve(process.env.HISTORY_FILE)
  : path.join(ROOT, "web", "data", "live-history.json");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = match[2].replace(/^["']|["']$/g, "");
  }
}

function readHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return { days: {}, updatedAt: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return { days: {}, updatedAt: null };
    return {
      days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
      updatedAt: parsed.updatedAt || null,
      lastFetchedAt: parsed.lastFetchedAt || null,
      lastStartDate: parsed.lastStartDate || null,
      lastEndDate: parsed.lastEndDate || null
    };
  } catch (err) {
    throw new Error("读取历史文件失败: " + err.message);
  }
}

async function main() {
  loadEnvFile(path.join(ROOT, ".env"));
  loadEnvFile(path.join(ROOT, "web", ".env"));

  if (!process.env.MABANG_APP_KEY || !process.env.MABANG_APP_TOKEN) {
    throw new Error("缺少 MABANG_APP_KEY / MABANG_APP_TOKEN");
  }

  const result = await fetchLiveChannelSummary();
  const history = readHistory();

  if (!result.dailySummary || !result.dailySummary.byDate) {
    throw new Error("马帮接口没有返回可归档的每日汇总数据");
  }

  for (const [date, record] of Object.entries(result.dailySummary.byDate)) {
    history.days[date] = record;
  }

  history.updatedAt = new Date().toISOString();
  history.lastFetchedAt = result.fetchedAt || history.lastFetchedAt || null;
  history.lastStartDate = result.startDate || history.lastStartDate || null;
  history.lastEndDate = result.endDate || history.lastEndDate || null;

  const dir = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = HISTORY_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2), "utf8");
  fs.renameSync(tmp, HISTORY_PATH);

  const dates = Object.keys(history.days).sort();
  const dayTotal = dates.reduce((sum, date) => {
    const channels = history.days[date].channels || {};
    return sum + Object.values(channels).reduce((a, b) => a + Number(b || 0), 0);
  }, 0);

  console.log("archived days:", dates.join(", "));
  console.log("archived total:", dayTotal);
  console.log("history file:", HISTORY_PATH);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
