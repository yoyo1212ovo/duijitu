const fs = require("fs");
const path = require("path");

const RENDER_URL = (process.env.RENDER_URL || "https://duijitu.onrender.com").replace(/\/$/, "");
const OUTPUT = path.join(__dirname, "..", "web", "data", "channel-mapping.json");

async function main() {
  const response = await fetch(RENDER_URL + "/api/channel-mapping");
  if (!response.ok) throw new Error("Render mapping request failed: HTTP " + response.status);

  const data = await response.json();
  const records = Array.isArray(data && data.records) ? data.records : [];
  if (records.length === 0) throw new Error("Render mapping response is empty");

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records
  };

  const tmp = OUTPUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, OUTPUT);
  console.log("synced channel mapping records:", records.length);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
