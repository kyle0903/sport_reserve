// 預約邏輯：直接用瀏覽器的登入狀態（cookie）打運動中心網站

export const SITES = {
  SC: { name: "三重", base: "https://fe.xuanen.com.tw/fe01.aspx", sports: ["badminton", "pickleball"] },
  LZ: { name: "蘆洲", base: "https://bcc.xuanen.com.tw/cc01.aspx", sports: ["badminton"] },
  BQ: { name: "板橋", base: "https://bbq.xuanen.com.tw/bq01.aspx", sports: ["badminton"] },
};
// 網站的運動代碼（網址中的 PT）
export const SPORTS = {
  badminton: { name: "羽球", pt: 1 },
  pickleball: { name: "匹克球", pt: 13 },
};
// 可預約到幾天後：三重今天～7 天後，蘆洲、板橋今天～6 天後
export const ADVANCE_DAYS = { SC: 7, LZ: 6, BQ: 6 };


export class LoginError extends Error {
  constructor() {
    super("尚未登入或登入逾期，請先到官網登入");
  }
}

// 用本地時間格式化，避免 toISOString() 在台灣早上 8 點前少一天；格式與網站相同 YYYY/MM/DD
export function formatDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

/** 下一個 00:00（新的一天開放的時間） */
export function nextOpenAt(now = new Date()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d;
}

/** 下一個 00:00 會開放的日期 */
export function nextOpenDate(place, now = new Date()) {
  const d = nextOpenAt(now);
  d.setDate(d.getDate() + ADVANCE_DAYS[place]);
  return d;
}

export const loginUrl = (place) => `${SITES[place].base}?module=login_page&files=login&PT=1`;
export const payUrl = (place) => `${SITES[place].base}?Module=member&files=orderx_mt`;
const listUrl = (place, sport, date, d2) =>
  `${SITES[place].base}?module=net_booking&files=booking_place&StepFlag=2&PT=${SPORTS[sport].pt}&D=${date}&D2=${d2}`;

// 已知的場地代碼（QPid 固定不變）；00:00 排程會直接用來送出預約，省掉一次查詢
export const DEFAULT_COURTS = {
  "SC|badminton": [[83, "羽5-1"], [84, "羽5-2"], [1074, "羽5-3"], [1075, "羽5-4"], [87, "羽5-5"], [88, "羽5-6"]],
  "LZ|badminton": [[83, "羽A"], [84, "羽B"], [1074, "羽C"], [1075, "羽D"], [87, "羽E"], [88, "羽F"]],
};

async function get(url, fetchImpl, now = Date.now) {
  const sentAt = +now();
  const response = await fetchImpl(url, { credentials: "include", cache: "no-store" });
  const receivedAt = +now();
  // 未登入時會被導回登入頁
  if (response.url.includes("login_page")) throw new LoginError();
  // 官網回應的 Date 標頭（精確到秒），用來校正電腦與官網的時間差
  const serverTime = Date.parse(response.headers?.get?.("date") ?? "");
  return { ok: response.ok, text: await response.text(), timing: { sentAt, receivedAt, serverTime } };
}

/**
 * 估計「官網時間 − 電腦時間」。
 * Date 標頭只到秒：官網當下時間落在 [H, H+1000)，且發生在送出到收到之間，
 * 所以每次回應都能把時間差限縮在 (H − 收到時間, H + 1000 − 送出時間)，多次取交集會越來越準。
 */
export class ClockSync {
  lo = -Infinity;
  hi = Infinity;
  add({ sentAt, receivedAt, serverTime }) {
    if (!Number.isFinite(serverTime)) return;
    const lo = serverTime - receivedAt;
    const hi = serverTime + 1000 - sentAt;
    // 跟之前的範圍兜不起來（例如電腦中途校時）就重新開始
    if (lo > this.hi || hi < this.lo) [this.lo, this.hi] = [lo, hi];
    else [this.lo, this.hi] = [Math.max(this.lo, lo), Math.min(this.hi, hi)];
  }
  get offset() {
    return Number.isFinite(this.lo) ? Math.round((this.lo + this.hi) / 2) : 0;
  }
}

/**
 * 查詢月曆頁（同時確認登入），回傳 { name, days, timing }。
 * days：Map(日期 YYYY/MM/DD => "open" 可預約 | "full" 額滿 | "closed" 休館)，
 * 每格以底色表示：#87C675 可預約、#efa159 額滿、白色為不在預約範圍內，其他顏色視為休館。
 */
export async function getCalendar(place, sport, fetchImpl = fetch, now = Date.now) {
  const url = `${SITES[place].base}?module=net_booking&files=booking_place&PT=${SPORTS[sport].pt}`;
  const { text, timing } = await get(url, fetchImpl, now);
  const name = text.match(/id="lab_Name">([^<]+?)\s*您好/)?.[1];
  if (!name || !text.includes("ContentPlaceHolder1_Date_Lab")) throw new LoginError();
  const days = new Map();
  // 依「2026年10月」標題切成各月份，再逐格讀底色與日期
  const months = text.split(/(\d{4})年(\d{1,2})月/);
  for (let i = 1; i + 2 < months.length; i += 3) {
    const [year, month, body] = [months[i], months[i + 1].padStart(2, "0"), months[i + 2]];
    for (const [, color, day] of body.matchAll(/<td bgcolor="([^"]+)"[^>]*>\s*<table[^>]*>\s*<tr>\s*<td[^>]*class="tWord">\s*(\d{1,2})\s*<\/td>/gi)) {
      const c = color.toLowerCase();
      if (c === "white" || c === "#ffffff") continue;
      days.set(`${year}/${month}/${day.padStart(2, "0")}`, c === "#87c675" ? "open" : c === "#efa159" ? "full" : "closed");
    }
  }
  return { name, days, timing };
}

// 列表頁依序出現：時段標題「18:00~19:00」、各場地的「可預約」按鈕或「已被預約」圖示
const ROW_RE = /(\d{2}):00~\d{2}:00<\/td>|預約「(\S+) [^」]*」？'\)\)\{Step3Action\((\d+),(\d+)\)|title="已被預約"/g;

/** 解析列表頁：free 為可預約的場地，totals 為 Map(整點 => 場地總數) */
function parseList(text) {
  const free = [];
  const totals = new Map();
  let hour = null;
  for (const [, header, court, qpid, t] of text.matchAll(ROW_RE)) {
    if (header) {
      hour = +header;
      continue;
    }
    const h = court ? +t : hour;
    if (court) free.push({ qpid: +qpid, court, qtime: +t });
    if (h !== null) totals.set(h, (totals.get(h) || 0) + 1);
  }
  return { free, totals, opened: free.length > 0 || text.includes('title="已被預約"') };
}

async function fetchDay(place, sport, date, qtimes, fetchImpl) {
  // D2：1=早上(06~12) 2=下午(12~18) 3=晚上(18~22)
  const periods = [...new Set(qtimes.map((t) => (t < 12 ? 1 : t < 18 ? 2 : 3)))].sort();
  const pages = await Promise.all(periods.map((d2) => get(listUrl(place, sport, date, d2), fetchImpl)));
  const slots = new Map();
  const totals = new Map();
  let opened = false;
  for (const { text } of pages) {
    if (!text.includes("ContentPlaceHolder1_Step2_data")) throw new LoginError();
    const page = parseList(text);
    opened ||= page.opened;
    for (const { qpid, court, qtime } of page.free) {
      if (!slots.has(qtime)) slots.set(qtime, []);
      slots.get(qtime).push({ qpid, court });
    }
    for (const [h, n] of page.totals) totals.set(h, n);
  }
  return opened ? { slots, totals } : null;
}

/** 查詢列表頁（早上、下午、晚上同時查），回傳 Map(QTime => [{ qpid, court }])；該日尚未開放時回傳 null */
export async function getAvailable(place, sport, date, qtimes, fetchImpl = fetch) {
  return (await fetchDay(place, sport, date, qtimes, fetchImpl))?.slots ?? null;
}

/** 查詢一整天：{ slots: Map(整點 => [{ qpid, court }]), totals: Map(整點 => 場地總數) }；尚未開放回傳 null */
export function getDay(place, sport, date, fetchImpl = fetch) {
  return fetchDay(place, sport, date, [6, 12, 18], fetchImpl);
}

/**
 * 送出一個時段的預約，依官網轉址的 X 判斷結果：
 * { ok: true } 成功(X=1)｜{ code: "taken" } 已被訂走(X=2)｜
 * { code: "not_open" } 還不能訂(X=0，例如尚未開放，官網會顯示「系統異常，錯誤代碼:Cod01」)｜{ code: "error", message }
 */
async function bookOne(place, sport, qpid, qtime, date, fetchImpl) {
  const url = `${SITES[place].base}?module=net_booking&files=booking_place&StepFlag=25&QPid=${qpid}&QTime=${qtime}&PT=${SPORTS[sport].pt}&D=${date}`;
  const { ok, text } = await get(url, fetchImpl);
  if (!ok) return { code: "error", message: "登入逾期" };
  const target = text.match(/window\.location\.href='([^']*)'/)?.[1];
  const alertText = text.match(/alert\('([^']*)'\)/)?.[1];
  if (!target) return { code: "error", message: alertText || "無法獲取預約頁面" };
  if (target.includes("&X=1")) return { ok: true };
  if (target.includes("&X=2")) return { code: "taken" };
  if (target.includes("&X=0")) return { code: "not_open", message: alertText || "官網回應系統異常" };
  return { code: "error", message: alertText || "超過預約次數" };
}

/** 依序預約每個時段，2 小時優先同一面場地；回傳 { booked, error } */
export async function book(place, sport, date, qtimes, slots, fetchImpl = fetch) {
  const booked = [];
  for (const qtime of qtimes) {
    // 第一小時優先選下一小時也有空的場地；第二小時優先選第一小時訂到的場地
    const prefer = booked.length
      ? new Set([booked[0].qpid])
      : new Set(qtimes.length > 1 ? (slots.get(qtimes.at(-1)) || []).map((s) => s.qpid) : []);
    const candidates = [...(slots.get(qtime) || [])].sort((a, b) => prefer.has(b.qpid) - prefer.has(a.qpid));

    for (const { qpid, court } of candidates) {
      const result = await bookOne(place, sport, qpid, qtime, date, fetchImpl);
      if (result.ok) {
        booked.push({ date, court, qtime, qpid });
        break;
      }
      if (result.code !== "taken") return { booked, error: result.message };
    }
  }
  return { booked, error: null };
}

const toQtimes = (qtime, hours) => Array.from({ length: hours }, (_, i) => qtime + i);

async function bookOrThrow(place, sport, date, qtimes, slots, fetchImpl) {
  const { booked, error } = await book(place, sport, date, qtimes, slots, fetchImpl);
  if (!booked.length) throw new Error(error || "該時段已經沒有場地");
  return booked;
}

/**
 * 查空位並預約；成功回傳已預約清單，失敗丟出錯誤。
 * cachedSlots：剛查過的空位（例如 1 分鐘內），有給就直接拿來送出，省掉一次查詢；都被搶走才重新查。
 */
export async function reserve(place, sport, date, qtime, hours, fetchImpl = fetch, cachedSlots = null) {
  const qtimes = toQtimes(qtime, hours);
  if (cachedSlots) {
    const { booked, error } = await book(place, sport, date, qtimes, cachedSlots, fetchImpl);
    if (booked.length) return booked;
    if (error) throw new Error(error);
  }
  const slots = await getAvailable(place, sport, date, qtimes, fetchImpl);
  if (!slots) throw new Error(`${date} 尚未開放預約`);
  return bookOrThrow(place, sport, date, qtimes, slots, fetchImpl);
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

const KEEPALIVE_MS = 10 * 60 * 1000;
const DIRECT_RETRY_MS = 300;
const DIRECT_TRIES = 6; // 約 1.5 秒內還不能訂就改回查空位

/**
 * 等到官網的下一個 00:00，預約新開放那天的場地。
 * - 送出時與等待期間每 10 分鐘確認登入（同時保持登入不閒置逾期，並校正電腦與官網的時間差），開放前 10 秒再確認一次。
 * - 00:00 一到，若知道場地代碼（knownCourts），隨機挑一面直接送出預約，省掉查詢；
 *   回應「還不能訂」就每 0.3 秒再送，約 1.5 秒後仍不行、或場地被訂走，就改回查空位再預約。
 * - 查空位時若頁面還沒更新，每 0.5 秒重試，最多 20 秒。
 * onClock(offsetMs) 回報時間差；onCheck({ at, next }) 回報每次確認登入的時間與下次預計時間（最後一次 next 為 null）；
 * onPhase("sending") 在開始送出時通知；now / sleep / random 可替換，方便測試。
 */
export async function reserveAtOpen(place, sport, qtime, hours, {
  signal, fetchImpl = fetch, now = () => new Date(), sleep = abortableSleep,
  knownCourts = [], onClock = () => {}, onCheck = () => {}, onPhase = () => {}, random = Math.random,
} = {}) {
  const openAt = nextOpenAt(now());
  const date = formatDate(nextOpenDate(place, now()));
  const clock = new ClockSync();
  // 官網時間換算成電腦時間
  const localTime = (serverTime) => serverTime - clock.offset;
  // 分段睡，避免單次長時間計時誤差
  const sleepUntil = async (t) => {
    while (+now() < t) await sleep(Math.min(t - +now(), 30000), signal);
  };
  const confirmLogin = async () => {
    const { timing } = await getCalendar(place, sport, fetchImpl, () => +now());
    clock.add(timing);
    onClock(clock.offset);
  };

  await confirmLogin();
  const finalCheckAt = () => localTime(+openAt - 10000);
  // 間隔加上 0～1 秒的隨機時間，讓每次比對落在一秒內的不同位置，時間差會估得更準
  const nextKeepalive = () => +now() + KEEPALIVE_MS + Math.floor(random() * 1000);
  let nextCheckAt = nextKeepalive();
  const reportCheck = () => onCheck({ at: new Date(+now()), next: new Date(Math.min(nextCheckAt, finalCheckAt())) });
  reportCheck();
  while (+now() < finalCheckAt()) {
    await sleepUntil(Math.min(nextCheckAt, finalCheckAt()));
    if (+now() >= finalCheckAt()) break;
    let ok = false;
    try {
      await confirmLogin();
      ok = true;
    } catch (e) {
      // 登出就提早停止；網路暫時錯誤則略過，等下一次確認
      if (e instanceof LoginError) throw e;
    }
    nextCheckAt = nextKeepalive();
    if (ok) reportCheck();
  }
  await confirmLogin();
  onCheck({ at: new Date(+now()), next: null });
  await sleepUntil(localTime(+openAt));
  onPhase("sending");

  const qtimes = toQtimes(qtime, hours);

  // 直接送出：隨機挑一面已知場地，避免大家都搶第一面
  if (knownCourts.length) {
    const { qpid, court } = knownCourts[Math.floor(random() * knownCourts.length)];
    let result;
    for (let i = 0; i < DIRECT_TRIES; i++) {
      result = await bookOne(place, sport, qpid, qtimes[0], date, fetchImpl);
      if (result.code !== "not_open") break;
      await sleep(DIRECT_RETRY_MS, signal);
    }
    if (result.ok) {
      const booked = [{ date, court, qtime: qtimes[0], qpid }];
      if (qtimes.length === 1) return booked;
      // 第二小時：先試同一面，不行再查空位找別面
      const second = await bookOne(place, sport, qpid, qtimes[1], date, fetchImpl);
      if (second.ok) return [...booked, { date, court, qtime: qtimes[1], qpid }];
      const slots = await getAvailable(place, sport, date, [qtimes[1]], fetchImpl);
      const rest = slots ? (await book(place, sport, date, [qtimes[1]], slots, fetchImpl)).booked : [];
      return [...booked, ...rest];
    }
  }

  // 查空位再預約
  const deadline = localTime(+openAt) + 20000;
  let slots = null;
  while (true) {
    try {
      slots = await getAvailable(place, sport, date, qtimes, fetchImpl);
    } catch (e) {
      if (!(e instanceof LoginError)) throw e;
    }
    if (slots || +now() >= deadline) break;
    await sleep(500, signal);
  }
  if (!slots) throw new Error(`00:00 後 20 秒內 ${date} 仍未開放`);
  return bookOrThrow(place, sport, date, qtimes, slots, fetchImpl);
}
