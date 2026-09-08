"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const {
  getCaseByCaseNumber,
  searchProperties,
  getCourtCodes,
} = require("court-auction-notice-search");

admin.initializeApp();
setGlobalOptions({ region: "asia-northeast3", maxInstances: 1 });

const MIN_UPSTREAM_GAP_MS = 2400;
const RESULT_CACHE_MS = 6 * 60 * 60 * 1000;
let lastUpstreamAt = 0;
let upstreamQueue = Promise.resolve();
let courtCodeCache = null;
let courtCodeCacheAt = 0;
const resultCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pacedUpstreamCall(fn) {
  const run = upstreamQueue.then(async () => {
    const wait = Math.max(0, MIN_UPSTREAM_GAP_MS - (Date.now() - lastUpstreamAt));
    if (wait) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastUpstreamAt = Date.now();
    }
  });
  upstreamQueue = run.catch(() => {});
  return run;
}

function cleanString(value, max = 500) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeCaseNumber(value) {
  return cleanString(value, 80)
    .replace(/\s+/g, "")
    .replace(/[‐‑‒–—−-]/g, "")
    .replace(/\(\d+\)$/g, "")
    .toLowerCase();
}

function normalizeYmd(value) {
  const s = cleanString(value, 80);
  let m = s.match(/(20\d{2})[^0-9]?(\d{1,2})[^0-9]?(\d{1,2})/);
  if (!m) return "";
  const y = m[1], mo = String(Number(m[2])).padStart(2, "0"), d = String(Number(m[3])).padStart(2, "0");
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return "";
  return `${y}-${mo}-${d}`;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = cleanString(value, 120).replace(/,/g, "");
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function primitiveEntries(value, prefix = "", out = [], depth = 0) {
  if (depth > 5 || value == null) return out;
  if (["string", "number", "boolean"].includes(typeof value)) {
    out.push([prefix, value]);
    return out;
  }
  if (Array.isArray(value)) {
    value.slice(0, 80).forEach((v, i) => primitiveEntries(v, `${prefix}[${i}]`, out, depth + 1));
    return out;
  }
  if (typeof value === "object") {
    Object.entries(value).slice(0, 120).forEach(([k, v]) => primitiveEntries(v, prefix ? `${prefix}.${k}` : k, out, depth + 1));
  }
  return out;
}

function firstByKey(entries, regex, predicate = () => true) {
  for (const [key, value] of entries) {
    if (regex.test(key) && predicate(value, key)) return value;
  }
  return null;
}

function extractCaseNumber(item) {
  const entries = primitiveEntries(item);
  const direct = item?.caseNumber || item?.printCaseNumber || item?.printCsNo || item?.caseNo || item?.csNo || item?.saNo;
  if (direct) return cleanString(direct, 80);
  const found = firstByKey(entries, /(case.?number|printcsno|caseno|csno|sano|사건번호)/i, (v) => /\d/.test(String(v)));
  return cleanString(found, 80);
}

function extractCourtCode(item) {
  const entries = primitiveEntries(item);
  const direct = item?.courtCode || item?.cortOfcCd || item?.courtOfficeCode || item?.raw?.cortOfcCd;
  if (direct) return cleanString(direct, 30);
  return cleanString(firstByKey(entries, /(court.?code|cortofccd|court.?office.?code)/i), 30);
}

function extractCourtName(item) {
  const entries = primitiveEntries(item);
  const direct = item?.courtName || item?.cortOfcNm || item?.courtOfficeName || item?.raw?.cortOfcNm;
  if (direct) return cleanString(direct, 100);
  return cleanString(firstByKey(entries, /(court.?name|cortofcnm|court.?office.?name|법원)/i), 100);
}

function extractAddress(item) {
  const entries = primitiveEntries(item);
  const direct = item?.address || item?.realSt || item?.location || item?.raw?.realSt;
  if (direct) return cleanString(direct, 500);
  return cleanString(firstByKey(entries, /(address|realst|소재지|주소)/i), 500);
}

function extractAppraisal(item) {
  const entries = primitiveEntries(item);
  const direct = Number(item?.appraisedPrice || item?.appraisal || item?.gamevalAmt || item?.raw?.gamevalAmt || 0);
  if (direct > 0) return direct;
  return numberValue(firstByKey(entries, /(apprais|gameval|감정)/i, (v) => numberValue(v) > 0));
}

function extractMinimumPrice(item) {
  const entries = primitiveEntries(item);
  const direct = Number(item?.minimumSalePrice || item?.minimumPrice || item?.minmaePrice || item?.raw?.minmaePrice || 0);
  if (direct > 0) return direct;
  return numberValue(firstByKey(entries, /(minimum.*price|minmae|최저.*(가|가격)|최저매각)/i, (v) => numberValue(v) > 0));
}

function normalizedAddressTokens(value) {
  return cleanString(value, 500)
    .normalize("NFKC")
    .replace(/[()\[\],.]/g, " ")
    .split(/\s+/)
    .filter((x) => x.length >= 2)
    .slice(0, 20);
}

function addressScore(a, b) {
  const aa = normalizedAddressTokens(a), bb = new Set(normalizedAddressTokens(b));
  if (!aa.length || !bb.size) return 0;
  return aa.reduce((n, token) => n + (bb.has(token) ? 1 : 0), 0) / Math.max(aa.length, bb.size);
}

async function getCourtCodeList() {
  if (courtCodeCache && Date.now() - courtCodeCacheAt < 24 * 60 * 60 * 1000) return courtCodeCache;
  const response = await pacedUpstreamCall(() => getCourtCodes());
  courtCodeCache = Array.isArray(response?.items) ? response.items : [];
  courtCodeCacheAt = Date.now();
  return courtCodeCache;
}

async function resolveCourtFromName(courtName) {
  const wanted = cleanString(courtName, 100).replace(/\s+/g, "");
  if (!wanted) return null;
  const courts = await getCourtCodeList();
  let best = null;
  for (const c of courts) {
    const names = [c?.name, c?.branchName].map((x) => cleanString(x, 100).replace(/\s+/g, "")).filter(Boolean);
    let score = 0;
    for (const name of names) {
      if (name === wanted) score = Math.max(score, 100);
      else if (name.includes(wanted) || wanted.includes(name)) score = Math.max(score, 70);
    }
    if (score && (!best || score > best.score)) best = { score, code: cleanString(c?.code, 30), name: cleanString(c?.branchName || c?.name, 100) };
  }
  return best?.code ? best : null;
}

async function discoverCourtByProperty({ caseNumber, auctionDate, address, appraisal, minimumSalePrice }) {
  if (!auctionDate) return null;
  const query = {
    saleDate: { from: auctionDate, to: auctionDate },
    page: 1,
    pageSize: 100,
    fallback: false,
  };
  if (appraisal > 0) query.appraisedPriceRange = { min: Math.max(0, appraisal - 10000), max: appraisal + 10000 };
  if (minimumSalePrice > 0) query.priceRange = { min: Math.max(0, minimumSalePrice - 10000), max: minimumSalePrice + 10000 };

  const response = await pacedUpstreamCall(() => searchProperties(query));
  const items = Array.isArray(response?.items) ? response.items : [];
  const wantedCase = normalizeCaseNumber(caseNumber);
  const matches = items
    .map((item) => {
      const foundCase = normalizeCaseNumber(extractCaseNumber(item));
      let score = foundCase && wantedCase && foundCase === wantedCase ? 100 : 0;
      if (!score) return null;
      const foundAppraisal = extractAppraisal(item), foundMin = extractMinimumPrice(item);
      if (appraisal > 0 && foundAppraisal > 0 && Math.abs(appraisal - foundAppraisal) <= 10000) score += 15;
      if (minimumSalePrice > 0 && foundMin > 0 && Math.abs(minimumSalePrice - foundMin) <= 10000) score += 15;
      score += addressScore(address, extractAddress(item)) * 20;
      return { item, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!matches.length) return null;
  const chosen = matches[0].item;
  const code = extractCourtCode(chosen);
  if (!code) return null;
  return { code, name: extractCourtName(chosen), property: chosen };
}

function rowDate(row) {
  const entries = primitiveEntries(row);
  const priority = [
    /(sale.?date|auction.?date|dspsl.*ymd|bid.*date|매각기일|기일)/i,
    /(date|ymd)/i,
  ];
  for (const regex of priority) {
    for (const [key, value] of entries) {
      if (!regex.test(key)) continue;
      const d = normalizeYmd(value);
      if (d) return d;
    }
  }
  for (const [, value] of entries) {
    const d = normalizeYmd(value);
    if (d) return d;
  }
  return "";
}

function classifyStatus(text) {
  const s = cleanString(text, 4000);
  if (/매각불허가|불허가/.test(s)) return { status: "cancelled", label: "매각불허가", final: true };
  if (/취하/.test(s)) return { status: "withdrawn", label: "취하", final: true };
  if (/정지/.test(s)) return { status: "stopped", label: "정지", final: true };
  if (/변경|연기/.test(s)) return { status: "changed", label: /연기/.test(s) ? "연기" : "변경", final: true };
  if (/취소/.test(s)) return { status: "cancelled", label: "취소", final: true };
  // '매각기일' 같은 일반 문구를 매각완료로 오인하지 않도록 완료 표현만 인정합니다.
  if (/낙찰|최고가매수|매각(?:결정|허가|성립|완료|됨)|(?:^|[:|·\s])매각(?:$|[(:|·\s])/.test(s)) return { status: "sold", label: "매각", final: true };
  if (/유찰/.test(s)) return { status: "failed", label: "유찰", final: true };
  return { status: "pending", label: "결과 대기", final: false };
}

function extractWinningBid(entries, statusText) {
  const strongKey = /(winning|successful|낙찰가|낙찰가격|매각가격|매각대금|최고가.*(금액|가격)|최고가매수.*(금액|가격))/i;
  for (const [key, value] of entries) {
    if (!strongKey.test(key)) continue;
    const n = numberValue(value);
    if (n >= 10000) return Math.round(n);
  }
  const snippets = entries
    .map(([key, value]) => `${key} ${String(value)}`)
    .filter((s) => /(낙찰|매각|최고가매수)/.test(s) && /\d/.test(s));
  for (const s of snippets) {
    const m = s.replace(/,/g, "").match(/(?:낙찰가(?:격)?|매각(?:가격|대금)?|최고가매수(?:신고)?(?:금액)?)\D{0,20}(\d{5,})/);
    if (m) return Number(m[1]);
  }
  const m = cleanString(statusText, 4000).replace(/,/g, "").match(/(?:낙찰가(?:격)?|매각(?:가격|대금)?|최고가매수(?:신고)?(?:금액)?)\D{0,20}(\d{5,})/);
  return m ? Number(m[1]) : 0;
}

function extractBidderCount(entries, statusText) {
  const keyRegex = /(bidder|bidders|bid.*count|입찰자|응찰자|응찰.*수|입찰.*수)/i;
  for (const [key, value] of entries) {
    if (!keyRegex.test(key)) continue;
    const n = numberValue(value);
    if (Number.isFinite(n) && n >= 1 && n <= 10000) return Math.round(n);
  }
  const m = cleanString(statusText, 4000).match(/(?:입찰자|응찰자)\s*(?:수)?\s*[:：]?\s*(\d{1,4})\s*명?/);
  return m ? Number(m[1]) : 0;
}

function normalizeScheduleResult(caseResponse, auctionDate, appraisal) {
  const schedule = Array.isArray(caseResponse?.schedule) ? caseResponse.schedule : [];
  const rows = schedule.map((row) => {
    const entries = primitiveEntries(row);
    const text = entries.map(([k, v]) => `${k}:${String(v)}`).join(" | ");
    const statusText = entries
      .filter(([k, v]) => /(result|rslt|status|stat|결과|진행상태)/i.test(k) || /^(매각|낙찰|유찰|변경|연기|취하|정지|취소|매각불허가)(?:$|[ (])/i.test(cleanString(v, 200)))
      .map(([k, v]) => `${k}:${String(v)}`).join(" | ");
    const cls = classifyStatus(statusText || text);
    return { row, entries, text, statusText, date: rowDate(row), ...cls };
  });

  const targetDate = normalizeYmd(auctionDate);
  const exact = rows.filter((r) => r.date === targetDate);
  let chosen = exact.find((r) => r.final) || exact[exact.length - 1] || null;
  if (!chosen) {
    const past = rows.filter((r) => r.date && (!targetDate || r.date <= targetDate)).sort((a, b) => b.date.localeCompare(a.date));
    chosen = past.find((r) => r.final) || past[0] || rows.find((r) => r.final) || rows[rows.length - 1] || null;
  }

  const caseEntries = primitiveEntries(caseResponse?.caseInfo || {});
  const caseText = caseEntries.map(([k, v]) => `${k}:${String(v)}`).join(" | ");
  if (!chosen) {
    const cls = classifyStatus(caseText);
    chosen = { entries: caseEntries, text: caseText, date: targetDate, ...cls };
  }

  let { status, label: statusLabel, final } = chosen;
  if (!final) {
    const cls = classifyStatus(`${chosen.text} | ${caseText}`);
    status = cls.status; statusLabel = cls.label; final = cls.final;
  }

  const winningBidPrice = status === "sold" ? extractWinningBid(chosen.entries, chosen.text) : 0;
  const bidderCount = extractBidderCount(chosen.entries, chosen.text);
  const nextDates = rows.map((r) => r.date).filter((d) => d && targetDate && d > targetDate).sort();
  const nextAuctionDate = nextDates[0] || "";
  const summaryValues = chosen.entries
    .filter(([key, value]) => /(결과|매각|낙찰|유찰|변경|취하|기일|date|result|bid)/i.test(key) || /(매각|낙찰|유찰|변경|취하|정지|취소)/.test(String(value)))
    .map(([, value]) => cleanString(value, 120))
    .filter(Boolean);
  const rawSummary = [...new Set(summaryValues)].slice(0, 8).join(" · ").slice(0, 700);
  const winningRate = appraisal > 0 && winningBidPrice > 0 ? winningBidPrice / appraisal * 100 : 0;

  return {
    status,
    statusLabel,
    final,
    resultDate: chosen.date || targetDate,
    winningBidPrice,
    bidderCount,
    winningRate,
    nextAuctionDate,
    rawSummary,
  };
}

async function resolveCourt(payload) {
  const givenCode = cleanString(payload.courtCode, 30);
  if (givenCode) return { code: givenCode, name: cleanString(payload.courtName, 100), method: "saved-code" };

  const named = await resolveCourtFromName(payload.courtName);
  if (named) return { ...named, method: "court-name" };

  const discovered = await discoverCourtByProperty(payload);
  if (discovered) return { ...discovered, method: "property-search" };
  return null;
}

function errorPayload(error) {
  const code = cleanString(error?.code || error?.name || "LOOKUP_ERROR", 80);
  const rawMessage = cleanString(error?.message || "법원 매각결과를 조회하지 못했습니다.", 500);
  if (/BLOCKED/i.test(code) || /ipcheck|차단/i.test(rawMessage)) {
    return { status: 429, code: "BLOCKED", message: "법원경매정보 사이트가 자동조회 요청을 일시 차단했습니다. 자동 재시도하지 않고 중단했습니다." };
  }
  if (/BUDGET_EXCEEDED/i.test(code)) return { status: 429, code, message: "법원 조회 안전 호출 한도에 도달했습니다. 잠시 뒤 다시 조회해주세요." };
  if (/PLAYWRIGHT_UNAVAILABLE/i.test(code)) return { status: 503, code, message: "법원 자유검색의 브라우저 보조 조회가 필요한 상태입니다. 저장된 법원명이 있는 물건부터 조회해주세요." };
  return { status: 502, code, message: rawMessage };
}

exports.courtAuctionResult = onRequest(
  {
    region: "asia-northeast3",
    cors: true,
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 1,
  },
  async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST 요청만 지원합니다." });

    try {
      const authHeader = cleanString(req.headers.authorization, 5000);
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!token) return res.status(401).json({ ok: false, message: "Firebase 로그인이 필요합니다." });
      await admin.auth().verifyIdToken(token);

      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (body.action !== "lookup") return res.status(400).json({ ok: false, message: "지원하지 않는 요청입니다." });

      const payload = {
        caseNumber: cleanString(body.caseNumber, 80),
        auctionDate: normalizeYmd(body.auctionDate),
        address: cleanString(body.address, 500),
        appraisal: Math.max(0, Number(body.appraisal) || 0),
        minimumSalePrice: Math.max(0, Number(body.minimumSalePrice) || 0),
        courtCode: cleanString(body.courtCode, 30),
        courtName: cleanString(body.courtName, 100),
      };
      if (!payload.caseNumber || !payload.auctionDate) return res.status(400).json({ ok: false, message: "사건번호와 매각기일이 필요합니다." });

      const cacheKey = [normalizeCaseNumber(payload.caseNumber), payload.auctionDate, payload.courtCode, payload.courtName].join("|");
      const cached = resultCache.get(cacheKey);
      if (cached && Date.now() - cached.at < RESULT_CACHE_MS) return res.json({ ok: true, cached: true, result: cached.result });

      const court = await resolveCourt(payload);
      if (!court?.code) {
        return res.status(422).json({
          ok: false,
          code: "COURT_NOT_RESOLVED",
          message: "사건번호가 중복될 수 있어 법원을 확정하지 못했습니다. 옥션원 원문에 법원명이 포함된 물건은 다음 저장/원문 재분석 후 자동조회됩니다.",
        });
      }

      const caseResponse = await pacedUpstreamCall(() => getCaseByCaseNumber({
        courtCode: court.code,
        caseNumber: payload.caseNumber,
      }));

      if (!caseResponse?.found) {
        return res.status(404).json({ ok: false, code: "CASE_NOT_FOUND", message: "해당 법원에서 사건번호를 찾지 못했습니다." });
      }

      const normalized = normalizeScheduleResult(caseResponse, payload.auctionDate, payload.appraisal);
      const result = {
        ...normalized,
        caseNumber: payload.caseNumber,
        courtCode: court.code,
        courtName: cleanString(court.name || extractCourtName(caseResponse?.caseInfo) || payload.courtName, 100),
        lookupMethod: court.method,
      };
      resultCache.set(cacheKey, { at: Date.now(), result });
      if (resultCache.size > 200) {
        const oldest = [...resultCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
        oldest.forEach(([key]) => resultCache.delete(key));
      }
      return res.json({ ok: true, result });
    } catch (error) {
      console.error("courtAuctionResult lookup failed", error);
      const out = errorPayload(error);
      return res.status(out.status).json({ ok: false, code: out.code, message: out.message });
    }
  }
);
