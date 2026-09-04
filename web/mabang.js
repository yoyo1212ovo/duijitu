const crypto = require("crypto");

const DEFAULT_GATEWAY = "https://gwapi.mabangerp.com/api/v2";
const DEFAULT_ACTION = "order-get-order-list-new";
const PAGE_SIZE = 200;
const MAX_PAGES = 2000;
const DEFAULT_MAX_PAGES_PER_WINDOW = 500;
const MAX_LIVE_LOOKBACK_DAYS = 7;
const REQUEST_TIMEOUT_MS = Number(process.env.MABANG_TIMEOUT_MS) || 15000;

function pad(n) {
  return String(n).padStart(2, "0");
}

function toDateTime(value) {
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime(date) {
  const d = toDateTime(date);
  if (!d) return "";
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
  );
}

function parseDateValue(value) {
  if (value == null || value === "") return null;

  if (typeof value === "number") {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const d = new Date(excelEpoch + value * 86400000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  const str = String(value).trim();
  if (!str) return null;

  const m = str.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return m[1] + "-" + pad(m[2]) + "-" + pad(m[3]);

  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) {
    const iso = d.toISOString();
    if (iso.startsWith("0000")) return null;
    return iso.slice(0, 10);
  }

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
  const parts = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const jan4 = new Date(Date.UTC(start.getUTCFullYear(), 0, 4));
  const jan4Mon = startOfWeek(jan4);
  const week = Math.round((start - jan4Mon) / 604800000) + 1;
  return {
    key: start.toISOString().slice(0, 10),
    label: pad(start.getUTCMonth() + 1) + "-" + pad(start.getUTCDate()) + "~" + pad(end.getUTCMonth() + 1) + "-" + pad(end.getUTCDate()),
    iso: start.getUTCFullYear() + "-W" + String(week).padStart(2, "0")
  };
}

function signBody(body, appToken) {
  const content = JSON.stringify(body);
  const authorization = crypto.createHmac("sha256", appToken).update(content, "utf8").digest("hex");
  return { content, authorization };
}

async function mabangRequest({ appKey, appToken, gateway, action, data, signal }) {
  if (!appKey || !appToken) {
    throw new Error("缺少马帮接口配置：MABANG_APP_KEY 或 MABANG_APP_TOKEN 未设置");
  }

  const body = {
    api: action || DEFAULT_ACTION,
    appkey: appKey,
    data: data || {},
    timestamp: Math.floor(Date.now() / 1000).toString()
  };

  const { content, authorization } = signBody(body, appToken);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(gateway || DEFAULT_GATEWAY, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Authorization: authorization
      },
      body: content,
      signal: controller.signal
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("马帮接口返回非 JSON 数据：" + text.slice(0, 300));
    }

    if (!response.ok) {
      throw new Error("马帮接口 HTTP " + response.status + "：" + (json.message || text.slice(0, 300)));
    }

    if (json && typeof json.code !== "undefined" && !["0", "200"].includes(String(json.code))) {
      throw new Error(json.message || json.msg || ("马帮接口错误码 " + json.code));
    }

    // Some versions return code=0 together with a non-null message and null data when the
    // upstream gateway fails. Treat that as an upstream error instead of empty data.
    if (json && json.message && (json.data == null || json.data === "")) {
      const normalized = String(json.message);
      if (!/成功|共.*页|当前/.test(normalized)) {
        throw new Error(normalized);
      }
    }

    return json;
  } catch (err) {
    if (!(signal && signal.aborted) && controller.signal.aborted) {
      throw new Error("马帮接口请求超时（" + Math.round(REQUEST_TIMEOUT_MS / 1000) + "秒），可能是马帮内部网关故障，请稍后重试");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeOrder(value) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.some((key) => /order|platform|logistics|express|country|buyer|track|ship|create|status/i.test(key));
}

function findOrderArray(value, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(looksLikeOrder)) return value;
    let best = [];
    for (const item of value) {
      const found = findOrderArray(item, depth + 1);
      if (found.length > best.length) best = found;
    }
    return best;
  }
  if (!isObject(value)) return [];

  const preferredKeys = ["order", "orders", "orderList", "list", "rows", "records", "data"];
  let best = [];
  for (const key of preferredKeys) {
    const found = findOrderArray(value[key], depth + 1);
    if (found.length > best.length) best = found;
  }
  for (const key of Object.keys(value)) {
    if (preferredKeys.includes(key)) continue;
    const found = findOrderArray(value[key], depth + 1);
    if (found.length > best.length) best = found;
  }
  return best;
}

function firstString(order, keys) {
  for (const key of keys) {
    const value = order[key];
    if (value == null || value === "") continue;
    if (typeof value === "number") return String(value);
    if (typeof value === "string") {
      const text = value.trim();
      if (text) return text;
    }
    if (isObject(value)) {
      const nested = firstString(value, Object.keys(value));
      if (nested) return nested;
    }
  }
  return "";
}

function extractChannel(order) {
  return firstString(order, [
    "myLogisticsChannelName",
    "myLogisticsName",
    "logisticsName",
    "logisticsChannelName",
    "logisticsChannel",
    "logisticsLineName",
    "logisticsMethodName",
    "channelName",
    "expressName",
    "expressCompanyName",
    "logisticsCompanyName",
    "shippingName",
    "shippingMethodName",
    "shippingChannelName",
    "deliveryName",
    "channel",
    "logistics",
    "logisticsLine",
    "routeName",
    "transportName",
    "warehouseName",
    "tWarehourseCode"
  ]);
}

function extractCountry(order) {
  return firstString(order, [
    "countryNameCN",
    "countryNameEN",
    "countryName",
    "countryNameEn",
    "countryCn",
    "countryEn",
    "buyerCountry",
    "receiverCountry",
    "receiverCountryName",
    "receiverCountryCode",
    "shipToCountry",
    "shippingCountry",
    "destinationCountry",
    "shipCountry",
    "country",
    "countryCode"
  ]);
}

function extractDate(order) {
  const keys = [
    "createDate",
    "orderCreateTime",
    "createTime",
    "createdTime",
    "orderTime",
    "platformOrderTime",
    "payTime",
    "shipTime",
    "updateTime",
    "update_time",
    "addTime",
    "date"
  ];
  for (const key of keys) {
    const parsed = parseDateValue(order[key]);
    if (parsed) return parsed;
  }

  for (const key of Object.keys(order)) {
    if (!/time|date|create/i.test(key)) continue;
    const parsed = parseDateValue(order[key]);
    if (parsed) return parsed;
  }
  return null;
}

function extractShippingDate(order) {
  const keys = [
    "transportTime",
    "expressTime",
    "shipTime",
    "shipDate",
    "quickPickTime"
  ];
  for (const key of keys) {
    const parsed = parseDateValue(order[key]);
    if (parsed) return parsed;
  }
  return null;
}

function normalizeDateOnly(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.getFullYear() + "-" + pad(value.getMonth() + 1) + "-" + pad(value.getDate());
  }
  return parseDateValue(value);
}

function filterOrdersByShippingDateRange(orders, startDate, endDate) {
  const start = normalizeDateOnly(startDate);
  const end = normalizeDateOnly(endDate);
  if (!start && !end) return orders;

  return orders.filter((order) => {
    const shippingDate = extractShippingDate(order);
    if (!shippingDate) return false;
    if (start && shippingDate < start) return false;
    if (end && shippingDate > end) return false;
    return true;
  });
}

function aggregateOrders(orders) {
  const data = {};
  const weeklySeries = {};
  const countryWeeklySeries = {};
  const dailySeries = {};
  const countryDailySeries = {};
  const weekLabels = {};
  const dayLabels = {};
  const allWeekSet = new Set();
  const allDaySet = new Set();
  let datedCount = 0;

  for (const order of orders) {
    const channel = extractChannel(order);
    const country = extractCountry(order);
    if (!channel || !country) continue;

    const dateStr = extractShippingDate(order);
    if (!dateStr) continue;
    if (!data[channel]) data[channel] = {};
    data[channel][country] = (data[channel][country] || 0) + 1;

    const info = weekInfo(dateStr);
    datedCount++;
    allDaySet.add(dateStr);
    allWeekSet.add(info.key);
    dayLabels[dateStr] = dateStr.slice(5);
    weekLabels[info.key] = info.label;

    if (!weeklySeries[channel]) weeklySeries[channel] = {};
    weeklySeries[channel][info.key] = (weeklySeries[channel][info.key] || 0) + 1;

    if (!countryWeeklySeries[channel]) countryWeeklySeries[channel] = {};
    if (!countryWeeklySeries[channel][country]) countryWeeklySeries[channel][country] = {};
    countryWeeklySeries[channel][country][info.key] = (countryWeeklySeries[channel][country][info.key] || 0) + 1;

    if (!dailySeries[channel]) dailySeries[channel] = {};
    dailySeries[channel][dateStr] = (dailySeries[channel][dateStr] || 0) + 1;

    if (!countryDailySeries[channel]) countryDailySeries[channel] = {};
    if (!countryDailySeries[channel][country]) countryDailySeries[channel][country] = {};
    countryDailySeries[channel][country][dateStr] = (countryDailySeries[channel][country][dateStr] || 0) + 1;
  }

  if (Object.keys(data).length === 0) return null;

  const channels = Object.keys(data).sort();
  const countrySet = new Set();
  for (const channel of channels) {
    for (const country of Object.keys(data[channel])) countrySet.add(country);
  }

  const totalByChannel = {};
  for (const channel of channels) {
    totalByChannel[channel] = Object.values(data[channel]).reduce((a, b) => a + b, 0);
  }

  return {
    channels,
    countries: [...countrySet].sort(),
    data,
    totalByChannel,
    weeklySeries: datedCount > 0 ? weeklySeries : null,
    countryWeeklySeries: datedCount > 0 ? countryWeeklySeries : null,
    allWeeks: [...allWeekSet].sort(),
    weekLabels,
    dailySeries: datedCount > 0 ? dailySeries : null,
    countryDailySeries: datedCount > 0 ? countryDailySeries : null,
    allDays: [...allDaySet].sort(),
    dayLabels
  };
}

function aggregateDailyOrders(orders) {
  const byDate = {};

  for (const order of orders) {
    const channel = extractChannel(order);
    const country = extractCountry(order);
    if (!channel || !country) continue;

    const dateStr = extractShippingDate(order);
    if (!dateStr) continue;

    if (!byDate[dateStr]) byDate[dateStr] = { channels: {}, countries: {} };
    const day = byDate[dateStr];

    day.channels[channel] = (day.channels[channel] || 0) + 1;
    if (!day.countries[channel]) day.countries[channel] = {};
    day.countries[channel][country] = (day.countries[channel][country] || 0) + 1;
  }

  return {
    allDays: Object.keys(byDate).sort(),
    byDate
  };
}

function findTotal(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  if (!isObject(value)) return null;

  const keys = ["total", "totalCount", "count", "totalNum", "totalSize"];
  for (const key of keys) {
    const found = findTotal(value[key]);
    if (found != null) return found;
  }
  return null;
}

function findTotalPages(response) {
  const data = response && response.data;
  const total = findTotal(data) ?? findTotal(response);
  if (total != null && total > 0) {
    const pageSize = (data && data.pageSize) || (data && data.page_size) || PAGE_SIZE;
    return Math.max(1, Math.ceil(total / pageSize));
  }
  return null;
}

function buildDateRange(query = {}) {
  const endDate = toDateTime(query.endDate) || new Date();
  const requestedStart = toDateTime(query.startDate);
  const earliestStart = new Date(endDate.getTime() - MAX_LIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const startDate = !requestedStart || requestedStart.getTime() < earliestStart.getTime()
    ? earliestStart
    : requestedStart;
  return { startDate, endDate };
}

function buildTimeWindows(startDate, endDate) {
  const windows = [];
  const max = endDate.getTime();
  const step = 24 * 60 * 60 * 1000;
  let cursor = new Date(startDate.getTime());

  while (cursor.getTime() < max) {
    const windowEnd = new Date(Math.min(max, cursor.getTime() + step));
    windows.push({ startDate: new Date(cursor), endDate: windowEnd });
    cursor = new Date(windowEnd.getTime());
  }

  return windows;
}

async function fetchOrderListPage({ appKey, appToken, gateway, action, cursor, startDate, endDate, status, signal }) {
  // This action does not expose a transportTime query parameter, so fetch by create time and group by shipping time during aggregation.
  const params = {
    createDateStart: formatDateTime(startDate),
    createDateEnd: formatDateTime(endDate)
  };
  if (status != null) params.status = status;
  if (cursor) params.cursor = cursor;

  return mabangRequest({
    appKey,
    appToken,
    gateway,
    action,
    data: params,
    signal
  });
}

async function fetchLiveOrders(options = {}) {
  const {
    appKey = process.env.MABANG_APP_KEY,
    appToken = process.env.MABANG_APP_TOKEN,
    gateway = process.env.MABANG_API_GATEWAY || DEFAULT_GATEWAY,
    action = process.env.MABANG_ORDER_ACTION || DEFAULT_ACTION,
    startDate: startDateInput,
    endDate: endDateInput,
    statuses: statusesInput,
    maxPages = Number(process.env.MABANG_MAX_PAGES) || DEFAULT_MAX_PAGES_PER_WINDOW,
    signal
  } = options;

  if (!appKey || !appToken) {
    throw new Error("缺少马帮接口配置：MABANG_APP_KEY 或 MABANG_APP_TOKEN 未设置");
  }

  const { startDate, endDate } = buildDateRange({ startDate: startDateInput, endDate: endDateInput });
  const statuses = Array.isArray(statusesInput) && statusesInput.length > 0
    ? statusesInput.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [3, 7];
  const apiEnd = new Date(Math.min(Date.now(), endDate.getTime() + 24 * 60 * 60 * 1000));
  const seen = new Set();
  const orders = [];
  const windows = buildTimeWindows(startDate, apiEnd);

  async function fetchWindow(window, status) {
    const windowOrders = [];
    let cursor = null;

    for (let page = 0; page < maxPages; page++) {
      const response = await fetchOrderListPage({
        appKey,
        appToken,
        gateway,
        action,
        cursor,
        startDate: window.startDate,
        endDate: window.endDate,
        status,
        signal
      });

      const pageOrders = findOrderArray(response);
      for (const order of pageOrders) {
        windowOrders.push(order);
      }

      const payload = response && response.data;
      const hasNext = payload && payload.hasNext;
      const nextCursor = payload && payload.nextCursor;
      if (!hasNext || !nextCursor) break;
      cursor = nextCursor;
    }

    return windowOrders;
  }

  const jobs = [];
  for (const window of windows) {
    for (const status of statuses) jobs.push({ window, status });
  }

  const concurrency = Math.min(4, Math.max(1, jobs.length));
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < jobs.length) {
      const job = jobs[nextIndex++];
      const windowOrders = await fetchWindow(job.window, job.status);
      for (const order of windowOrders) {
        const key = order.platformOrderId || order.salesRecordNumber || order.trackNumber || JSON.stringify(order);
        if (seen.has(key)) continue;
        seen.add(key);
        orders.push(order);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return { orders, total: orders.length, startDate, endDate };
}

async function fetchLiveChannelSummary(options = {}) {
  const shippingStartDate = normalizeDateOnly(options.shippingDateStart || options.startDate);
  const shippingEndDate = normalizeDateOnly(options.shippingDateEnd || options.endDate);
  const queryStartDate = options.queryStartDate || options.startDate;
  const queryEndDate = options.queryEndDate || options.endDate;
  const { orders, total: rawTotal } = await fetchLiveOrders({ ...options, startDate: queryStartDate, endDate: queryEndDate });
  const filteredOrders = filterOrdersByShippingDateRange(orders, shippingStartDate, shippingEndDate);
  const channelSummary = aggregateOrders(filteredOrders);
  const dailySummary = aggregateDailyOrders(filteredOrders);
  return {
    source: "mabang",
    action: options.action || process.env.MABANG_ORDER_ACTION || DEFAULT_ACTION,
    fetchedAt: new Date().toISOString(),
    startDate: shippingStartDate,
    endDate: shippingEndDate,
    total: filteredOrders.length,
    rawTotal,
    channelSummary,
    dailySummary
  };
}

module.exports = {
  mabangRequest,
  fetchLiveOrders,
  fetchLiveChannelSummary,
  aggregateOrders,
  aggregateDailyOrders,
  filterOrdersByShippingDateRange,
  findOrderArray
};
