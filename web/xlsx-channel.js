// Low-memory xlsx channel-summary parser.
// Reads only the ZIP entries it needs and streams worksheet rows,
// avoiding the multi-GB intermediate arrays produced by the xlsx package.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { StringDecoder } = require("string_decoder");

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseZipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd > 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd <= 0) throw new Error("not a valid xlsx file");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      localOff: buf.readUInt32LE(p + 42)
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateZipEntry(buf, entry) {
  const nameLen = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const start = entry.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.csize);
  return entry.method === 8 ? zlib.inflateRawSync(raw) : raw;
}

function parseSharedStrings(buf, entries) {
  const entry = entries.find(e => e.name === "xl/sharedStrings.xml");
  if (!entry) return null;

  const xml = inflateZipEntry(buf, entry).toString("utf8");
  const shared = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = "";
    let t;
    while ((t = tRe.exec(m[1]))) text += t[1];
    shared.push(decodeXml(text));
  }
  return shared;
}

function cellText(cellXml, shared) {
  const type = (cellXml.match(/\bt="([^"]+)"/) || [])[1] || "n";
  if (type === "inlineStr") {
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let text = "";
    let m;
    while ((m = tRe.exec(cellXml))) text += m[1];
    return decodeXml(text).trim();
  }

  const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
  if (!v) return "";
  const raw = decodeXml(v[1]);
  if (type === "s") return shared ? (shared[Number(raw)] || "") : "";
  return raw.trim();
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function colLetters(col) {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseDateValue(val) {
  if (val == null || val === "") return null;
  if (typeof val === "number" || /^\d+(\.\d+)?$/.test(String(val))) {
    const n = Number(val);
    const d = new Date((n - 25569) * 86400000);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  let m = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  m = str.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function startOfWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function weekInfo(dateStr) {
  const parts = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const jan4 = new Date(Date.UTC(start.getUTCFullYear(), 0, 4));
  const jan4Mon = startOfWeek(jan4);
  const week = Math.round((start - jan4Mon) / 604800000) + 1;
  const pad = n => String(n).padStart(2, "0");
  return {
    key: start.toISOString().slice(0, 10),
    label: pad(start.getUTCMonth() + 1) + "-" + pad(start.getUTCDate()) + "~" + pad(end.getUTCMonth() + 1) + "-" + pad(end.getUTCDate()),
    iso: start.getUTCFullYear() + "-W" + String(week).padStart(2, "0")
  };
}

async function parseWorksheet(buf, entry, shared) {
  const nameLen = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const start = entry.localOff + 30 + nameLen + extraLen;
  const compressed = buf.subarray(start, start + entry.csize);

  const decoder = new StringDecoder("utf8");
  const inflater = zlib.createInflateRaw();

  const out = {
    data: {},
    totalByChannel: {},
    weeklySeries: {},
    countryWeeklySeries: {},
    weekLabels: {},
    allWeekSet: new Set()
  };

  let tail = "";
  let cols = null;
  let foundSheet = false;

  function extractCell(rowXml, col) {
    if (col < 0) return "";
    const prefix = '<c r="' + colLetters(col);
    let idx = rowXml.indexOf(prefix);
    while (idx >= 0) {
      const next = rowXml[idx + prefix.length];
      if (next >= "0" && next <= "9") break;
      idx = rowXml.indexOf(prefix, idx + prefix.length);
    }
    if (idx < 0) return "";
    const end = rowXml.indexOf("</c>", idx);
    if (end < 0) return "";
    return cellText(rowXml.slice(idx, end + 5), shared);
  }

  function processRow(rowXml) {
    if (!cols) {
      const cells = [];
      const cellRe = /<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
      let m;
      while ((m = cellRe.exec(rowXml))) {
        const ref = (m[1].match(/\br="([A-Z]+)\d+"/) || [])[1];
        if (!ref) continue;
        cells.push({ col: colIndex(ref), text: cellText(m[0], shared) });
      }

      let channelCol = -1;
      let countryCol = -1;
      let timeCol = -1;
      for (const c of cells) {
        if (c.text === "物流渠道" && channelCol < 0) channelCol = c.col;
        else if (c.text === "国家" && countryCol < 0) countryCol = c.col;
        else if (timeCol < 0 && c.text && (c.text.includes("时间") || c.text.includes("日期") || c.text.toLowerCase().includes("date"))) timeCol = c.col;
      }

      if (channelCol < 0 || countryCol < 0) {
        cols = { skip: true };
        return;
      }

      cols = { channelCol, countryCol, timeCol };
      foundSheet = true;
      return;
    }

    if (cols.skip) return;

    const channel = extractCell(rowXml, cols.channelCol);
    const country = extractCell(rowXml, cols.countryCol);
    if (!channel || !country) return;

    if (!out.data[channel]) out.data[channel] = {};
    out.data[channel][country] = (out.data[channel][country] || 0) + 1;

    if (cols.timeCol >= 0) {
      const dateStr = parseDateValue(extractCell(rowXml, cols.timeCol));
      if (dateStr) {
        const info = weekInfo(dateStr);
        out.allWeekSet.add(info.key);
        out.weekLabels[info.key] = info.label;

        if (!out.weeklySeries[channel]) out.weeklySeries[channel] = {};
        out.weeklySeries[channel][info.key] = (out.weeklySeries[channel][info.key] || 0) + 1;

        if (!out.countryWeeklySeries[channel]) out.countryWeeklySeries[channel] = {};
        if (!out.countryWeeklySeries[channel][country]) out.countryWeeklySeries[channel][country] = {};
        out.countryWeeklySeries[channel][country][info.key] = (out.countryWeeklySeries[channel][country][info.key] || 0) + 1;
      }
    }
  }

  return new Promise((resolve, reject) => {
    inflater.on("data", chunk => {
      tail += decoder.write(chunk);
      let rowStart = tail.indexOf("<row ");
      while (rowStart >= 0) {
        const rowEnd = tail.indexOf("</row>", rowStart);
        if (rowEnd < 0) break;
        processRow(tail.slice(rowStart, rowEnd + 6));
        tail = tail.slice(rowEnd + 6);
        rowStart = tail.indexOf("<row ");
      }
    });
    inflater.on("error", reject);
    inflater.on("end", () => {
      tail += decoder.end();
      resolve(foundSheet ? out : null);
    });
    inflater.end(compressed);
  });
}

async function parseChannelSummary(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".xlsx") return null;

  const buf = fs.readFileSync(filePath);
  const entries = parseZipEntries(buf);
  const shared = parseSharedStrings(buf, entries);
  const worksheets = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));

  const agg = {
    data: {},
    totalByChannel: {},
    weeklySeries: {},
    countryWeeklySeries: {},
    weekLabels: {},
    allWeekSet: new Set()
  };

  let found = false;
  for (const entry of worksheets) {
    const one = await parseWorksheet(buf, entry, shared);
    if (!one) continue;
    found = true;

    for (const ch in one.data) {
      if (!agg.data[ch]) agg.data[ch] = {};
      for (const cn in one.data[ch]) {
        agg.data[ch][cn] = (agg.data[ch][cn] || 0) + one.data[ch][cn];
      }
    }
    for (const ch in one.weeklySeries) {
      if (!agg.weeklySeries[ch]) agg.weeklySeries[ch] = {};
      Object.assign(agg.weeklySeries[ch], one.weeklySeries[ch]);
    }
    for (const ch in one.countryWeeklySeries) {
      if (!agg.countryWeeklySeries[ch]) agg.countryWeeklySeries[ch] = {};
      for (const cn in one.countryWeeklySeries[ch]) {
        if (!agg.countryWeeklySeries[ch][cn]) agg.countryWeeklySeries[ch][cn] = {};
        Object.assign(agg.countryWeeklySeries[ch][cn], one.countryWeeklySeries[ch][cn]);
      }
    }
    Object.assign(agg.weekLabels, one.weekLabels);
    one.allWeekSet.forEach(w => agg.allWeekSet.add(w));
  }

  if (!found) return null;

  const channels = Object.keys(agg.data).sort();
  const countrySet = new Set();
  channels.forEach(ch => Object.keys(agg.data[ch]).forEach(c => countrySet.add(c)));
  const countries = [...countrySet].sort();

  const totalByChannel = {};
  channels.forEach(ch => {
    totalByChannel[ch] = Object.values(agg.data[ch] || {}).reduce((a, b) => a + b, 0);
  });

  return {
    channels,
    countries,
    data: agg.data,
    totalByChannel,
    weeklySeries: Object.keys(agg.weeklySeries).length > 0 ? agg.weeklySeries : null,
    countryWeeklySeries: Object.keys(agg.countryWeeklySeries).length > 0 ? agg.countryWeeklySeries : null,
    allWeeks: [...agg.allWeekSet].sort(),
    weekLabels: agg.weekLabels
  };
}

module.exports = { parseChannelSummary };