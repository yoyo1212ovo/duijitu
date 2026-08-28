// === JSON file store ===
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseChannelSummary } = require("./xlsx-channel");
const { fetchLiveChannelSummary } = require("./mabang");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

loadEnvFile(path.join(__dirname, "..", ".env"));
loadEnvFile(path.join(__dirname, ".env"));

function readJSON(filename) {
  const p = path.join(DATA_DIR, filename);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return []; }
}
function writeJSON(filename, data) {
  const p = path.join(DATA_DIR, filename);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

const HISTORY_FILE = "live-history.json";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateFromString(value) {
  if (typeof value !== "string") return null;
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getWeekKey(dateStr) {
  const date = dateFromString(dateStr);
  if (!date) return null;
  const day = (date.getUTCDay() + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - day);
  return start.toISOString().slice(0, 10);
}

function getWeekLabel(weekKey) {
  const start = dateFromString(weekKey);
  if (!start) return weekKey;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return pad2(start.getUTCMonth() + 1) + "-" + pad2(start.getUTCDate()) + "~" + pad2(end.getUTCMonth() + 1) + "-" + pad2(end.getUTCDate());
}

function readHistory() {
  const filePath = path.join(DATA_DIR, HISTORY_FILE);
  if (!fs.existsSync(filePath)) return { days: {}, updatedAt: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return { days: {}, updatedAt: null };
    return { days: parsed.days && typeof parsed.days === "object" ? parsed.days : {}, updatedAt: parsed.updatedAt || null };
  } catch {
    return { days: {}, updatedAt: null };
  }
}

function writeHistory(history) {
  writeJSON(HISTORY_FILE, history);
}

function saveLiveHistory(result) {
  if (!result || !result.dailySummary || !result.dailySummary.byDate) return;
  const history = readHistory();
  for (const [date, record] of Object.entries(result.dailySummary.byDate)) {
    history.days[date] = record;
  }
  history.updatedAt = new Date().toISOString();
  history.lastFetchedAt = result.fetchedAt || history.lastFetchedAt || null;
  history.lastStartDate = result.startDate || history.lastStartDate || null;
  history.lastEndDate = result.endDate || history.lastEndDate || null;
  writeHistory(history);
}

function listLiveHistoryWeeks(history) {
  const days = history && history.days ? history.days : {};
  const weeks = {};
  for (const [date, record] of Object.entries(days)) {
    const key = getWeekKey(date);
    if (!key) continue;
    if (!weeks[key]) weeks[key] = { key, total: 0, daysCount: 0 };
    const total = record && record.channels ? Object.values(record.channels).reduce((sum, value) => sum + Number(value || 0), 0) : 0;
    weeks[key].total += total;
    weeks[key].daysCount += 1;
  }
  return Object.values(weeks).sort((a, b) => b.key.localeCompare(a.key)).map((week) => ({
    ...week,
    label: getWeekLabel(week.key),
    startDate: week.key,
    endDate: new Date(dateFromString(week.key).getTime() + 6 * 86400000).toISOString().slice(0, 10)
  }));
}

function buildHistoryWeekSummary(weekKey, history) {
  const days = history && history.days ? history.days : {};
  const entries = Object.entries(days).filter(([date]) => getWeekKey(date) === weekKey).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;

  const data = {};
  const countries = new Set();
  for (const [date, record] of entries) {
    if (!record || !record.channels) continue;
    for (const [channel, total] of Object.entries(record.channels)) {
      if (!data[channel]) data[channel] = {};
      const channelCountries = record.countries && record.countries[channel] ? record.countries[channel] : {};
      for (const [country, count] of Object.entries(channelCountries)) {
        data[channel][country] = (data[channel][country] || 0) + count;
        countries.add(country);
      }
    }
  }

  const channels = Object.keys(data).sort();
  const totalByChannel = {};
  const weeklySeries = {};
  const countryWeeklySeries = {};
  for (const channel of channels) {
    totalByChannel[channel] = Object.values(data[channel]).reduce((sum, value) => sum + value, 0);
    weeklySeries[channel] = { [weekKey]: totalByChannel[channel] };
    countryWeeklySeries[channel] = {};
    for (const country of Object.keys(data[channel])) {
      countryWeeklySeries[channel][country] = { [weekKey]: data[channel][country] };
    }
  }

  const total = channels.reduce((sum, channel) => sum + totalByChannel[channel], 0);
  const start = dateFromString(weekKey);
  const end = new Date(start.getTime() + 6 * 86400000);
  return {
    key: weekKey,
    label: getWeekLabel(weekKey),
    startDate: weekKey,
    endDate: end.toISOString().slice(0, 10),
    total,
    daysCount: entries.length,
    channelSummary: {
      channels,
      countries: [...countries].sort(),
      data,
      totalByChannel,
      weeklySeries,
      countryWeeklySeries,
      allWeeks: [weekKey],
      weekLabels: { [weekKey]: getWeekLabel(weekKey) }
    }
  };
}

// === Express app ===
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const PORT = process.env.PORT || 4567;

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, id + ext);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (/\.xlsx?$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("only .xlsx/.xls allowed"));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// === Auth middleware ===
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "not logged in" });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "session expired" });
  }
}

// === API: Register ===
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  if (username.length < 2 || username.length > 30) return res.status(400).json({ error: "username must be 2-30 chars" });
  if (password.length < 4) return res.status(400).json({ error: "password must be at least 4 chars" });

  const users = readJSON("users.json");
  if (users.find(u => u.username === username)) {
    return res.status(409).json({ error: "username already exists" });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, password: hash, createdAt: new Date().toISOString() };
  users.push(user);
  writeJSON("users.json", users);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, username: user.username } });
});

// === API: Login ===
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const users = readJSON("users.json");
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: "invalid credentials" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "invalid credentials" });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, username: user.username } });
});

// === API: Get current user ===
app.get("/api/me", (req, res) => {
  res.json({ user: { id: "public", username: "访客" } });
});

// === API: Live order data from MABANG ===
app.get("/api/live/channel-summary", async (req, res) => {
  try {
    const startDate = typeof req.query.startDate === "string" && req.query.startDate ? req.query.startDate : undefined;
    const endDate = typeof req.query.endDate === "string" && req.query.endDate ? req.query.endDate : undefined;
    const result = await fetchLiveChannelSummary({ startDate, endDate });
    try { saveLiveHistory(result); } catch (err) { console.error("Save live history failed:", err && err.message ? err.message : err); }
    delete result.dailySummary;
    res.json(result);
  } catch (err) {
    console.error("MABANG live channel summary failed:", err && err.message ? err.message : err);
    res.status(502).json({ error: "马帮实时数据拉取失败: " + ((err && err.message) || err) });
  }
});

// === API: Historical weekly snapshots ===
app.get("/api/live/history", (req, res) => {
  const history = readHistory();
  res.json({ weeks: listLiveHistoryWeeks(history), updatedAt: history.updatedAt || null });
});

app.get("/api/live/history/:weekKey", (req, res) => {
  const weekKey = req.params.weekKey;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return res.status(400).json({ error: "invalid week key" });
  const history = readHistory();
  const snapshot = buildHistoryWeekSummary(weekKey, history);
  if (!snapshot) return res.status(404).json({ error: "week snapshot not found" });
  res.json(snapshot);
});

// === API: Upload Excel ===
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });

  const fileRecord = {
    id: uuidv4(),
    userId: "public",
    originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
    storedName: req.file.filename,
    size: req.file.size,
    uploadedAt: new Date().toISOString()
  };

  const files = readJSON("files.json");
  files.push(fileRecord);
  writeJSON("files.json", files);

  res.json(fileRecord);
});

// === API: List user files ===
app.get("/api/files", (req, res) => {
  const files = readJSON("files.json");
  const sorted = [...files].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(sorted);
});

// === API: Get channel summary without loading unrelated datasets ===
app.get("/api/file/:id/channel-summary", async (req, res) => {
  const files = readJSON("files.json");
  const fileRecord = files.find(f => f.id === req.params.id);
  if (!fileRecord) return res.status(404).json({ error: "file not found" });

  const filePath = path.join(uploadsDir, fileRecord.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file deleted" });

  try {
    let channelSummary = null;
    if (path.extname(fileRecord.storedName).toLowerCase() === ".xlsx") {
      channelSummary = await parseChannelSummary(filePath);
    } else {
      const XLSX = require("xlsx");
      const wb = XLSX.readFile(filePath);
      channelSummary = processChannelSummary(wb);
    }
    res.json({ fileName: fileRecord.originalName, channelSummary });
  } catch (err) {
    res.status(500).json({ error: "parse error: " + err.message });
  }
});

// === API: Get file chart data ===
app.get("/api/file/:id/data", (req, res) => {
  const files = readJSON("files.json");
  const fileRecord = files.find(f => f.id === req.params.id);
  if (!fileRecord) return res.status(404).json({ error: "file not found" });

  const filePath = path.join(uploadsDir, fileRecord.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file deleted" });

  try {
    const XLSX = require("xlsx");
    const wb = XLSX.readFile(filePath);
    const routes = processRoutes(wb);
    const insights = computeInsights(routes);
    const orderVolumes = processOrderVolumes(wb);
    const channelSummary = processChannelSummary(wb);
    res.json({ fileName: fileRecord.originalName, routes, insights, orderVolumes, channelSummary });
  } catch (err) {
    res.status(500).json({ error: "parse error: " + err.message });
  }
});

// === API: Delete file ===
app.delete("/api/file/:id", (req, res) => {
  const files = readJSON("files.json");
  const idx = files.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "file not found" });

  const fileRecord = files[idx];
  const filePath = path.join(uploadsDir, fileRecord.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  files.splice(idx, 1);
  writeJSON("files.json", files);
  res.json({ success: true });
});

// === API: Download file ===
app.get("/api/file/:id/download", (req, res) => {
  const files = readJSON("files.json");
  const fileRecord = files.find(f => f.id === req.params.id);
  if (!fileRecord) return res.status(404).json({ error: "file not found" });

  const filePath = path.join(uploadsDir, fileRecord.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file deleted" });

  res.download(filePath, fileRecord.originalName);
});


// === Export Report ===
app.get("/api/file/:id/export", (req, res) => {
  const files = readJSON("files.json");
  const fileRecord = files.find(f => f.id === req.params.id);
  if (!fileRecord) return res.status(404).json({ error: "file not found" });

  const filePath = path.join(uploadsDir, fileRecord.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file deleted" });

  try {
    const XLSX = require("xlsx");
    const wbIn = XLSX.readFile(filePath);
    const routes = processRoutes(wbIn);
    const insights = computeInsights(routes);
    const orderVolumes = processOrderVolumes(wbIn);

    // Build export workbook
    const wb = XLSX.utils.book_new();

    // Sheet 1: Summary
    const summary = insights.summary;
    const summaryData = [
      ["\u7269\u6D41\u8FD0\u8D39\u5206\u6790\u62A5\u544A", ""],
      ["\u751F\u6210\u65F6\u95F4", new Date().toLocaleString("zh-CN")],
      ["\u539F\u59CB\u6587\u4EF6", fileRecord.originalName],
      ["", ""],
      ["\u6307\u6807", "\u6570\u503C"],
      ["\u7EBF\u8DEF\u603B\u6570", summary.totalRoutes],
      ["\u4EF7\u683C\u53D8\u52A8\u7EBF\u8DEF\u6570", summary.routesWithChanges],
      ["\u5E73\u5747\u6298\u6263\u7387", summary.avgDiscountRate + "%"],
      ["\u6700\u4F18\u6298\u6263\u7EBF\u8DEF", (summary.bestRoute || {}).name || "-"],
      ["\u6700\u4F18\u6298\u6263\u7387", (summary.bestRoute || {}).avgDisc || "-"],
      ["\u9700\u5173\u6CE8\u7EBF\u8DEF", (summary.worstRoute || {}).name || "-"],
      ["\u6700\u4F4E\u6298\u6263\u7387", (summary.worstRoute || {}).avgDisc || "-"],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary["!cols"] = [{wch:25},{wch:40}];
    XLSX.utils.book_append_sheet(wb, wsSummary, "\u6458\u8981\u62A5\u544A");

    // Sheet 2: Per-route analysis
    const analysisData = [["\u7EBF\u8DEF", "\u91CD\u91CF\u6BB5", "\u56FD\u5BB6", "\u5F53\u524D\u516C\u65A4\u8D39", "\u5F53\u524D\u6253\u6298\u524D\u8D39", "\u5F53\u524D\u6298\u6263\u7387", "\u516C\u65A4\u8D39\u8D8B\u52BF", "\u516C\u65A4\u8D39\u53D8\u5316\u5E45\u5EA6", "\u6298\u6263\u8D8B\u52BF", "\u8BAE\u4EF7\u5DEE\u989D", "\u8BAE\u4EF7\u5DEE\u989D\u53D8\u5316", "\u5EFA\u8BAE"]];
    const routeKeys = Object.keys(routes);
    routeKeys.forEach(rk => {
      const route = routes[rk];
      const ri = insights.perRoute[rk];
      if (!ri) return;
      Object.keys(ri.segments).forEach(key => {
        const seg = ri.segments[key];
        const kgTrend = seg.kgFeeTrend.direction === "up" ? "\u2191" : (seg.kgFeeTrend.direction === "down" ? "\u2193" : "\u2194");
        const discTrend = seg.discountTrend.direction === "improving" ? "\u2191\u6269\u5927" : (seg.discountTrend.direction === "worsening" ? "\u2193\u6536\u7A84" : "\u2194\u7A33\u5B9A");
        const gap = seg.gapData ? seg.gapData.lastGap.toFixed(0) : "-";
        const gapChange = seg.gapData ? (seg.gapData.isWidening ? "+" + seg.gapData.changePct + "%" : seg.gapData.changePct + "%") : "-";
        analysisData.push([
          route.routeLabel, key, seg.countryName || "-",
          seg.kgFeeTrend.last, seg.preFeeTrend.last, seg.currentDiscountRate + "%",
          kgTrend + " " + seg.kgFeeTrend.changePct + "%", seg.kgFeeTrend.first + "\u2192" + seg.kgFeeTrend.last,
          discTrend,
          gap, gapChange,
          seg.recommendation
        ]);
      });
    });
    const wsAnalysis = XLSX.utils.aoa_to_sheet(analysisData);
    wsAnalysis["!cols"] = [{wch:30},{wch:15},{wch:8},{wch:12},{wch:15},{wch:12},{wch:15},{wch:18},{wch:12},{wch:12},{wch:15},{wch:35}];
    XLSX.utils.book_append_sheet(wb, wsAnalysis, "\u7EBF\u8DEF\u5206\u6790");

    // Sheet 3: Action items
    const actionData = [["\u4F18\u5148\u7EA7", "\u7C7B\u578B", "\u5EFA\u8BAE\u5185\u5BB9"]];
    (insights.actionItems || []).forEach(item => {
      actionData.push([item.priority, item.type, item.text]);
    });
    const wsAction = XLSX.utils.aoa_to_sheet(actionData);
    wsAction["!cols"] = [{wch:10},{wch:12},{wch:60}];
    XLSX.utils.book_append_sheet(wb, wsAction, "\u884C\u52A8\u5EFA\u8BAE");

    // Sheet 4: Order volumes
    if (orderVolumes) {
      const volData = [["\u7EBF\u8DEF", "\u65E5\u671F", "\u50B2\u98DE\u603B\u5355\u91CF", "SAM\u5355\u91CF", "\u5E97\u94FA\u660E\u7EC6"]];
      Object.keys(orderVolumes).forEach(route => {
        Object.keys(orderVolumes[route]).sort().forEach(date => {
          const v = orderVolumes[route][date];
          const storeDetail = Object.keys(v.stores || {}).sort((a,b) => v.stores[b]-v.stores[a]).map(s => (s||"\u5916\u90E8\u5BA2\u6237") + ":" + v.stores[s]).join("; ");
          volData.push([route, date, v.total, v.samTotal || 0, storeDetail]);
        });
      });
      const wsVol = XLSX.utils.aoa_to_sheet(volData);
      wsVol["!cols"] = [{wch:30},{wch:12},{wch:12},{wch:10},{wch:80}];
      XLSX.utils.book_append_sheet(wb, wsVol, "\u5355\u91CF\u6570\u636E");
    }

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="report.xlsx"');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: "export error: " + err.message });
  }
});

// === SPA fallback ===
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// === Excel processing ===
function serialToDate(serial) {
  const epoch = new Date(1899, 11, 30);
  const d = new Date(epoch.getTime() + serial * 86400000);
  return d.toISOString().slice(0, 10);
}

function formatWeight(minG, maxG) {
  if (maxG >= 1000) {
    const minKg = minG / 1000;
    const maxKg = maxG / 1000;
    return (minKg % 1 === 0 ? minKg.toFixed(0) : minKg.toFixed(1)) + "kg - " + (maxKg % 1 === 0 ? maxKg.toFixed(0) : maxKg.toFixed(1)) + "kg";
  }
  return minG + "g - " + maxG + "g";
}

function processRoutes(wb) {
  const routes = {};
  wb.SheetNames.forEach(name => {
    const ws = wb.Sheets[name];
    const XLSX = require("xlsx");
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (data.length < 2) return;

    const headers = data[0];
    const colIdx = {};
    headers.forEach((h, i) => { if (h) colIdx[h] = i; });

    const required = ["生效时间", "最小重量g", "最大重量g", "公斤费", "打折前公斤费", "物流线路"];
    if (!required.every(k => k in colIdx)) return;

    const rows = data.slice(1).filter(r => r.length > 0 && r[colIdx["生效时间"]] != null);
    const weightGroups = {};
    const countrySet = new Set();

    rows.forEach(row => {
      const minW = row[colIdx["最小重量g"]];
      const maxW = row[colIdx["最大重量g"]];
      const key = formatWeight(minW, maxW);
      const date = serialToDate(row[colIdx["生效时间"]]);
      const kgFee = parseFloat(row[colIdx["公斤费"]]) || 0;
      const preDiscountFee = parseFloat(row[colIdx["打折前公斤费"]]) || 0;
      const countryName = colIdx["国家名称"] != null ? String(row[colIdx["国家名称"]] || "") : "";
      const countryCode = colIdx["国家代码"] != null ? String(row[colIdx["国家代码"]] || "") : "";

      if (countryName) countrySet.add(countryName);

      if (!weightGroups[key]) weightGroups[key] = [];
      weightGroups[key].push({ date, kgFee, preDiscountFee, minW, maxW, countryName, countryCode });
    });

    Object.values(weightGroups).forEach(g => g.sort((a, b) => a.date.localeCompare(b.date)));

    if (Object.keys(weightGroups).length > 0) {
      routes[name] = {
        sheetName: name,
        routeLabel: rows[0] ? String(rows[0][colIdx["物流线路"]] || name) : name,
        weightGroups,
        countries: [...countrySet]
      };
    }
  });
  return routes;
}


// === Analysis Engine ===
function computeInsights(routes) {
  const routeKeys = Object.keys(routes);
  const allInsights = { summary: {}, perRoute: {}, actionItems: [] };
  let allDiscountRates = [];
  let bestRouteAvg = null, worstRouteAvg = null;
  let totalChangedRoutes = 0;

  routeKeys.forEach(rk => {
    const route = routes[rk];
    const groups = route.weightGroups;
    const sk = Object.keys(groups);
    if (sk.length === 0) return;
    allInsights.perRoute[rk] = { routeLabel: route.routeLabel, segments: {}, routeAlerts: [], routeRecommendation: "" };
    let routeDiscountRates = [];
    let routeHasChange = false;

    sk.forEach(key => {
      const pts = groups[key];
      if (pts.length < 1) return;
      const first = pts[0], last = pts[pts.length - 1];
      const kgFeeChange = last.kgFee - first.kgFee;
      const kgFeeChangePct = first.kgFee !== 0 ? ((kgFeeChange / first.kgFee) * 100).toFixed(1) : "0";
      const preChange = last.preDiscountFee - first.preDiscountFee;
      const preChangePct = first.preDiscountFee !== 0 ? ((preChange / first.preDiscountFee) * 100).toFixed(1) : "0";
      const firstDiscount = first.preDiscountFee !== 0 ? ((first.preDiscountFee - first.kgFee) / first.preDiscountFee * 100) : 0;
      const lastDiscount = last.preDiscountFee !== 0 ? ((last.preDiscountFee - last.kgFee) / last.preDiscountFee * 100) : 0;
      const discountChange = lastDiscount - firstDiscount;
      allDiscountRates.push(lastDiscount);
      routeDiscountRates.push(lastDiscount);

      const alerts = [];
      const kgDir = kgFeeChange < -1 ? "down" : (kgFeeChange > 1 ? "up" : "stable");
      const discDir = discountChange > 2 ? "improving" : (discountChange < -2 ? "worsening" : "stable");

      if (Math.abs(parseFloat(kgFeeChangePct)) > 5) {
        routeHasChange = true;
        alerts.push({ type: kgDir === "down" ? "good" : "warning", text: "公斤费" + (kgDir === "down" ? "下降" : "上涨") + kgFeeChangePct + "%（" + first.kgFee + "→" + last.kgFee + "）" });
      }
      if (discDir === "improving") {
        alerts.push({ type: "good", text: "折扣力度加大，折扣率从" + firstDiscount.toFixed(1) + "%升至" + lastDiscount.toFixed(1) + "%" });
      } else if (discDir === "worsening") {
        alerts.push({ type: "warning", text: "折扣力度减弱，折扣率从" + firstDiscount.toFixed(1) + "%降至" + lastDiscount.toFixed(1) + "%" });
      }

      // Detect intermediate jumps
      let maxJump = null;
      for (let i = 1; i < pts.length; i++) {
        const jump = pts[i].kgFee - pts[i-1].kgFee;
        const jumpPct = pts[i-1].kgFee !== 0 ? Math.abs((jump / pts[i-1].kgFee) * 100) : 0;
        if (jumpPct > 8 && (!maxJump || jumpPct > maxJump.pct)) {
          maxJump = { date: pts[i].date, from: pts[i-1].kgFee, to: pts[i].kgFee, change: jump, pct: jumpPct };
        }
      }
      if (maxJump) {
        alerts.push({ type: "info", text: maxJump.date + " 公斤费骤变" + (maxJump.change > 0 ? "+" : "") + maxJump.change.toFixed(0) + "（" + maxJump.from + "→" + maxJump.to + "，幅度" + maxJump.pct.toFixed(1) + "%）" });
      }

      // Gap analysis for negotiation insights
      const firstGap = first.preDiscountFee - first.kgFee;
      const lastGap = last.preDiscountFee - last.kgFee;
      const gapChange = lastGap - firstGap;
      const gapChangePct = firstGap !== 0 ? ((gapChange / firstGap) * 100).toFixed(1) : "0";
      const preDir = preChange > 1 ? "up" : (preChange < -1 ? "down" : "stable");
      const isGapWidening = gapChange > 3 && parseFloat(gapChangePct) > 10;
      const isGapNarrowing = gapChange < -3 && parseFloat(gapChangePct) < -10;
      const isLargeGap = lastGap > 20;

      if (isGapWidening && preDir === "stable") {
        alerts.push({ type: "negotiate", text: "\u8BAE\u4EF7\u7A7A\u95F4\u6269\u5927\uFF1A\u6298\u6263\u5DEE\u989D\u4ECE\u00A5" + firstGap.toFixed(0) + "\u589E\u81F3\u00A5" + lastGap.toFixed(0) + "\uFF08+" + gapChangePct + "%\uFF09\uFF0C\u57FA\u7840\u4EF7\u672A\u53D8\u4F46\u6298\u6263\u5728\u52A0\u6DF1\uFF0C\u8BF4\u660E\u4F9B\u5E94\u5546\u8BAE\u4EF7\u7A7A\u95F4\u5145\u8DB3" });
      } else if (isGapWidening && preDir === "up") {
        alerts.push({ type: "negotiate", text: "\u6298\u6263\u5DEE\u989D\u589E\u5927\uFF08\u00A5" + firstGap.toFixed(0) + "\u2192\u00A5" + lastGap.toFixed(0) + "\uFF09\uFF0C\u4F46\u57FA\u7840\u4EF7\u4E5F\u5728\u4E0A\u6DA8\uFF0C\u5EFA\u8BAE\u4E0E\u4F9B\u5E94\u5546\u8C08\u5224\u9501\u5B9A\u5F53\u524D\u6298\u6263\u6BD4\u4F8B" });
      } else if (isGapNarrowing && kgDir !== "down") {
        alerts.push({ type: "warning", text: "\u6298\u6263\u5DEE\u989D\u7F29\u5C0F\uFF08\u00A5" + firstGap.toFixed(0) + "\u2192\u00A5" + lastGap.toFixed(0) + "\uFF0C-" + Math.abs(parseFloat(gapChangePct)).toFixed(0) + "%\uFF09\uFF0C\u5229\u6DA6\u7A7A\u95F4\u5728\u538B\u7F29" });
      } else if (isLargeGap && preDir === "stable" && !isGapWidening) {
        alerts.push({ type: "negotiate", text: "\u57FA\u7840\u4EF7\u7A33\u5B9A\u4E14\u6298\u6263\u5DEE\u989D\u8F83\u5927\uFF08\u00A5" + lastGap.toFixed(0) + "\uFF09\uFF0C\u5B58\u5728\u8BAE\u4EF7\u7A7A\u95F4\uFF0C\u53EF\u5C1D\u8BD5\u8C08\u5224\u964D\u4F4E\u57FA\u7840\u4EF7" });
      }

      // Recommendation
      let rec = "";
      if (lastDiscount > 30) rec = "\u6298\u6263\u529B\u5EA6\u5927(" + lastDiscount.toFixed(0) + "%)" + (isGapWidening ? "\uFF0C\u4E14\u8BAE\u4EF7\u7A7A\u95F4\u5728\u6269\u5927\uFF0C\u53EF\u4E3B\u52A8\u4E0E\u4F9B\u5E94\u5546\u8C08\u5224\u964D\u4EF7" : "\uFF0C\u53EF\u4F18\u5148\u63A8\u5E7F");
      else if (lastDiscount < 5) rec = "\u6298\u6263\u7387\u6781\u4F4E(" + lastDiscount.toFixed(1) + "%)" + (isLargeGap ? "\uFF0C\u4F46\u7EDD\u5BF9\u5DEE\u989D\u8F83\u5927\uFF0C\u5EFA\u8BAE\u4E0E\u4F9B\u5E94\u5546\u8C08\u5224" : "\uFF0C\u5EFA\u8BAE\u4E0E\u4F9B\u5E94\u5546\u8C08\u5224\u4E89\u53D6\u66F4\u591A\u6298\u6263");
      else if (discDir === "worsening") rec = "\u6298\u6263\u5728\u6536\u7A84\uFF0C\u5173\u6CE8\u540E\u7EED\u8D8B\u52BF\uFF0C\u5FC5\u8981\u65F6\u8BAE\u4EF7";
      else if (kgDir === "up") rec = "\u516C\u65A4\u8D39\u6301\u7EED\u4E0A\u6DA8\uFF0C\u9700\u5173\u6CE8\u6210\u672C\u53D8\u5316" + (isGapWidening ? "\uFF0C\u4F46\u6298\u6263\u5DEE\u989D\u5728\u589E\u5927\uFF0C\u53EF\u5C1D\u8BD5\u8C08\u5224" : "");
      else if (kgDir === "down" && lastDiscount > 15) rec = "\u4EF7\u683C\u4E0B\u884C+\u6298\u6263\u826F\u597D" + (isGapWidening ? "\uFF0C\u4E14\u8BAE\u4EF7\u7A7A\u95F4\u5728\u6269\u5927\uFF0C\u91CD\u70B9\u63A8\u5E7F\u5E76\u6301\u7EED\u8C08\u5224" : "\uFF0C\u91CD\u70B9\u63A8\u5E7F");
      else if (isLargeGap) rec = "\u57FA\u7840\u4EF7\u7A33\u5B9A\u4F46\u5DEE\u989D\u8F83\u5927\uFF08\u00A5" + lastGap.toFixed(0) + "\uFF09\uFF0C\u5EFA\u8BAE\u5C1D\u8BD5\u4E0E\u4F9B\u5E94\u5546\u8C08\u5224\u964D\u4EF7";
      else rec = "\u4EF7\u683C\u7A33\u5B9A\uFF0C\u6301\u7EED\u76D1\u63A7";

      allInsights.perRoute[rk].segments[key] = {
        kgFeeTrend: { first: first.kgFee, last: last.kgFee, change: kgFeeChange, changePct: kgFeeChangePct, direction: kgDir },
        preFeeTrend: { first: first.preDiscountFee, last: last.preDiscountFee, change: preChange, changePct: preChangePct },
        discountTrend: { first: firstDiscount.toFixed(1), last: lastDiscount.toFixed(1), direction: discDir },
        currentDiscountRate: lastDiscount.toFixed(1),
        gapData: { firstGap: firstGap, lastGap: lastGap, change: gapChange, changePct: gapChangePct, isWidening: isGapWidening, isLarge: isLargeGap },
        alerts, recommendation: rec,
        countryName: first.countryName || ""
      };
    });

    if (routeHasChange) totalChangedRoutes++;
    const avgDisc = routeDiscountRates.length > 0 ? (routeDiscountRates.reduce((a,b) => a+b, 0) / routeDiscountRates.length) : 0;
    if (!bestRouteAvg || avgDisc > bestRouteAvg.val) bestRouteAvg = { name: route.routeLabel, val: avgDisc };
    if (!worstRouteAvg || avgDisc < worstRouteAvg.val) worstRouteAvg = { name: route.routeLabel, val: avgDisc };
  });

  // Summary
  const avgAllDisc = allDiscountRates.length > 0 ? (allDiscountRates.reduce((a,b) => a+b, 0) / allDiscountRates.length).toFixed(1) : "0";
  allInsights.summary = {
    totalRoutes: routeKeys.length,
    routesWithChanges: totalChangedRoutes,
    avgDiscountRate: avgAllDisc,
    bestRoute: bestRouteAvg ? { name: bestRouteAvg.name, avgDisc: bestRouteAvg.val.toFixed(1) } : null,
    worstRoute: worstRouteAvg ? { name: worstRouteAvg.name, avgDisc: worstRouteAvg.val.toFixed(1) } : null,
  };

  // Action items
  routeKeys.forEach(rk => {
    const ri = allInsights.perRoute[rk];
    if (!ri) return;
    Object.keys(ri.segments).forEach(key => {
      const seg = ri.segments[key];
      if (seg.currentDiscountRate > 25) {
        allInsights.actionItems.push({ priority: "high", type: "promote", text: ri.routeLabel + " " + key + " 折扣率" + seg.currentDiscountRate + "%，建议优先推广", route: rk, segment: key });
      } else if (seg.discountTrend.direction === "worsening") {
        allInsights.actionItems.push({ priority: "medium", type: "negotiate", text: ri.routeLabel + " " + key + " 折扣收窄至" + seg.currentDiscountRate + "%，建议议价跟进", route: rk, segment: key });
      } else if (seg.kgFeeTrend.direction === "up" && parseFloat(seg.kgFeeTrend.changePct) > 5) {
        allInsights.actionItems.push({ priority: "high", type: "review", text: ri.routeLabel + " " + key + " 公斤费上涨" + seg.kgFeeTrend.changePct + "%，需核实原因", route: rk, segment: key });
      }
      if (seg.gapData && seg.gapData.isWidening && parseFloat(seg.currentDiscountRate) > 15) {
        allInsights.actionItems.push({ priority: "medium", type: "negotiate", text: ri.routeLabel + " " + key + " 折扣差额扩大(+" + seg.gapData.changePct + "%)，议价空间增加，建议与供应商谈判", route: rk, segment: key });
      } else if (seg.gapData && seg.gapData.isLarge && parseFloat(seg.currentDiscountRate) > 10) {
        allInsights.actionItems.push({ priority: "low", type: "negotiate", text: ri.routeLabel + " " + key + " 折扣差额" + seg.gapData.lastGap.toFixed(0) + "，存在议价空间", route: rk, segment: key });
      }
    });
  });
  allInsights.actionItems.sort((a, b) => a.priority === "high" ? -1 : 1);

  return allInsights;
}


// === Order Volume Processing ===
function processOrderVolumes(wb) {
  const ws = wb.Sheets["单量"];
  if (!ws) return null;
  const XLSX = require("xlsx");
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (data.length < 2) return null;

  const headers = data[0];
  const colIdx = {};
  headers.forEach((h, i) => { if (h) colIdx[h] = i; });

  // Required columns: 汇总时间(A), 渠道(M), 店铺(O)
  if (!("汇总时间" in colIdx) || !("渠道" in colIdx) || !("店铺" in colIdx)) return null;

  const rows = data.slice(1).filter(r => r.length > 0 && r[colIdx["汇总时间"]] != null && r[colIdx["渠道"]] != null);

  // Group: route -> date -> { total: count, samTotal: count(stores with name), stores: { storeName: count } }
  const routeData = {};

  rows.forEach(row => {
    const route = String(row[colIdx["渠道"]] || "").trim();
    const serial = row[colIdx["汇总时间"]];
    const store = String(row[colIdx["店铺"]] || "").trim();
    if (!route || serial == null) return;

    const dateEpoch = new Date(1899, 11, 30);
    const date = new Date(dateEpoch.getTime() + serial * 86400000).toISOString().slice(0, 10);

    if (!routeData[route]) routeData[route] = {};
    if (!routeData[route][date]) routeData[route][date] = { total: 0, samTotal: 0, stores: {} };

    routeData[route][date].total++;
    if (store) {
      routeData[route][date].samTotal++;
      routeData[route][date].stores[store] = (routeData[route][date].stores[store] || 0) + 1;
    }
  });

  return routeData;
}

// === Start ===
// === Channel Summary Processing ===
function processChannelSummary(wb) {
  const XLSX = require("xlsx");
  const channelData = {};
  const weeklySeries = {};
  const countryWeeklySeries = {};
  const weekLabels = {};
  const allWeekSet = new Set();

  function parseDate(val) {
    if (val == null) return null;
    if (typeof val === 'number') {
      const d = new Date((val - 25569) * 86400000);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    }
    let str = String(val).trim();
    if (!str) return null;
    const m = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    const m2 = str.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m2) return m2[1] + '-' + m2[2].padStart(2, '0') + '-' + m2[3].padStart(2, '0');
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }

  function startOfWeek(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  function weekInfo(dateStr) {
    const parts = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    const start = startOfWeek(date);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const jan4 = new Date(Date.UTC(start.getUTCFullYear(), 0, 4));
    const jan4Mon = startOfWeek(jan4);
    const week = Math.round((start - jan4Mon) / 604800000) + 1;
    const pad = (n) => String(n).padStart(2, '0');
    const label = pad(start.getUTCMonth() + 1) + '-' + pad(start.getUTCDate()) + '~' + pad(end.getUTCMonth() + 1) + '-' + pad(end.getUTCDate());
    return {
      key: start.toISOString().slice(0, 10),
      label,
      iso: start.getUTCFullYear() + '-W' + String(week).padStart(2, '0')
    };
  }

  wb.SheetNames.forEach(name => {
    const ws = wb.Sheets[name];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (data.length < 2) return;

    const headers = data[0];
    const colIdx = {};
    headers.forEach((h, i) => { if (h && !(h in colIdx)) colIdx[h] = i; });

    if (!("物流渠道" in colIdx) || !("国家" in colIdx)) return;

    let timeCol = null;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (h && (h.includes('时间') || h.includes('日期') || String(h).toLowerCase().includes('date'))) {
        timeCol = i;
        break;
      }
    }

    const rows = data.slice(1).filter(r => r.length > 0 && r[colIdx["物流渠道"]] != null);

    rows.forEach(row => {
      const channel = String(row[colIdx["物流渠道"]] || "").trim();
      const country = String(row[colIdx["国家"]] || "").trim();
      if (!channel || !country) return;

      if (!channelData[channel]) channelData[channel] = {};
      channelData[channel][country] = (channelData[channel][country] || 0) + 1;

      if (timeCol !== null) {
        const dateStr = parseDate(row[timeCol]);
        if (dateStr) {
          const info = weekInfo(dateStr);
          allWeekSet.add(info.key);
          weekLabels[info.key] = info.label;
          if (!weeklySeries[channel]) weeklySeries[channel] = {};
          weeklySeries[channel][info.key] = (weeklySeries[channel][info.key] || 0) + 1;
          if (!countryWeeklySeries[channel]) countryWeeklySeries[channel] = {};
          if (!countryWeeklySeries[channel][country]) countryWeeklySeries[channel][country] = {};
          countryWeeklySeries[channel][country][info.key] = (countryWeeklySeries[channel][country][info.key] || 0) + 1;
        }
      }
    });
  });

  if (Object.keys(channelData).length === 0) return null;

  const channels = Object.keys(channelData).sort();
  const countrySet = new Set();
  channels.forEach(ch => Object.keys(channelData[ch]).forEach(c => countrySet.add(c)));
  const countries = [...countrySet].sort();

  const totalByChannel = {};
  channels.forEach(ch => {
    totalByChannel[ch] = Object.values(channelData[ch] || {}).reduce((a, b) => a + b, 0);
  });

  return {
    channels,
    countries,
    data: channelData,
    totalByChannel,
    weeklySeries: Object.keys(weeklySeries).length > 0 ? weeklySeries : null,
    countryWeeklySeries: Object.keys(countryWeeklySeries).length > 0 ? countryWeeklySeries : null,
    allWeeks: [...allWeekSet].sort(),
    weekLabels
  };
}

// === Start ===
app.listen(PORT, '0.0.0.0', () => {
  console.log("Server running at http://localhost:" + PORT);
  console.log("Data dir:", DATA_DIR);
});
