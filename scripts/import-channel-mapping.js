const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const ROOT = path.join(__dirname, "..");
const INPUT = process.env.CHANNEL_MAPPING_XLSX || "D:/working/马帮物流渠道校准9.9.xlsx";
const OUTPUT = path.join(ROOT, "web", "data", "channel-mapping.json");
const HISTORY_FILE = path.join(ROOT, "web", "data", "live-history.json");

function clean(value) {
  if (value == null) return "";
  return String(value).trim();
}

function main() {
  if (!fs.existsSync(INPUT)) throw new Error("missing input: " + INPUT);
  const workbook = XLSX.readFile(INPUT);
  const sheet = workbook.Sheets["Sheet1"];
  if (!sheet) throw new Error("Sheet1 not found");

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  const records = [];
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const sourceName = clean(row[0]);
    if (!sourceName) continue;
    if (seen.has(sourceName)) continue;
    seen.add(sourceName);
    records.push({
      id: "map-" + i,
      sourceName,
      providerChannel: clean(row[1]),
      provider: clean(row[2]),
      displayName: clean(row[3]),
      status: clean(row[3]) ? "mapped" : "unmapped",
      enabled: Boolean(clean(row[3]))
    });
  }

  if (fs.existsSync(HISTORY_FILE)) {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    const bySource = new Map(records.map((record) => [record.sourceName, record]));
    let dynamicIndex = records.length + 1;
    for (const day of Object.values(history.days || {})) {
      for (const channel of Object.keys(day.channels || {})) {
        if (bySource.has(channel)) continue;
        bySource.set(channel, {
          id: "map-unknown-" + dynamicIndex++,
          sourceName: channel,
          providerChannel: "",
          provider: "",
          displayName: "",
          status: "unmapped",
          enabled: false
        });
      }
    }
    records.length = 0;
    records.push(...bySource.values());
  }

  const output = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const tmp = OUTPUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2));
  fs.renameSync(tmp, OUTPUT);
  console.log(`Wrote ${records.length} mapping records to ${OUTPUT}`);
  console.log(`Mapped: ${records.filter((record) => record.status === "mapped").length}`);
  console.log(`Unmapped: ${records.filter((record) => record.status === "unmapped").length}`);
}

main();
