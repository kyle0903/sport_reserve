// 預約邏輯：直接用瀏覽器的登入狀態（cookie）打運動中心網站

export const SITES = {
  SC: { name: "三重", base: "https://fe.xuanen.com.tw/fe01.aspx" },
  LZ: { name: "蘆洲", base: "https://bcc.xuanen.com.tw/cc01.aspx" },
};
// 可預約到幾天後：三重今天～7 天後，蘆洲今天～6 天後
export const ADVANCE_DAYS = { SC: 7, LZ: 6 };

// 列表頁中可預約的格子：預約「羽5-3 18:00~19:00」？')){Step3Action(1074,18)}
const SLOT_RE = /預約「(\S+) [^」]*」？'\)\)\{Step3Action\((\d+),(\d+)\)/g;

export class LoginError extends Error {
  constructor() {
    super("尚未登入或登入逾期，請先到官網登入");
  }
}

export const loginUrl = (place) => `${SITES[place].base}?module=login_page&files=login&PT=1`;
export const payUrl = (place) => `${SITES[place].base}?Module=member&files=orderx_mt`;
const listUrl = (place, date, d2) =>
  `${SITES[place].base}?module=net_booking&files=booking_place&StepFlag=2&PT=1&D=${date}&D2=${d2}`;

async function get(url, fetchImpl) {
  const response = await fetchImpl(url, { credentials: "include", cache: "no-store" });
  // 未登入時會被導回登入頁
  if (response.url.includes("login_page")) throw new LoginError();
  return { ok: response.ok, text: await response.text() };
}

/** 確認登入狀態，回傳網站上顯示的名字（例如「吳○凱」） */
export async function checkLogin(place, date, fetchImpl = fetch) {
  const { text } = await get(listUrl(place, date, 1), fetchImpl);
  const match = text.match(/id="lab_Name">([^<]+?)\s*您好/);
  if (!match) throw new LoginError();
  return match[1];
}

/** 查詢列表頁，回傳 Map(QTime => [{ qpid, court }])；該日尚未開放時回傳 null */
export async function getAvailable(place, date, qtimes, fetchImpl = fetch) {
  const slots = new Map();
  let opened = false;
  // D2：1=早上(06~12) 2=下午(12~18) 3=晚上(18~22)
  const periods = [...new Set(qtimes.map((t) => (t < 12 ? 1 : t < 18 ? 2 : 3)))].sort();
  for (const d2 of periods) {
    const { text } = await get(listUrl(place, date, d2), fetchImpl);
    if (!text.includes("ContentPlaceHolder1_Step2_data")) throw new LoginError();
    const found = [...text.matchAll(SLOT_RE)];
    if (found.length || text.includes('title="已被預約"')) opened = true;
    for (const [, court, qpid, t] of found) {
      if (!slots.has(+t)) slots.set(+t, []);
      slots.get(+t).push({ qpid: +qpid, court });
    }
  }
  return opened ? slots : null;
}

async function bookOne(place, qpid, qtime, date, fetchImpl) {
  const url = `${SITES[place].base}?module=net_booking&files=booking_place&StepFlag=25&QPid=${qpid}&QTime=${qtime}&PT=1&D=${date}`;
  const { ok, text } = await get(url, fetchImpl);
  if (!ok) return "登入逾期";
  const match = text.match(/window\.location\.href='([^']*)'/);
  if (!match) return "無法獲取預約頁面";
  if (match[1].includes("&X=1")) return null;
  if (match[1].includes("&X=2")) return "預約失敗";
  return "超過預約次數";
}

/** 依序預約每個時段，2 小時優先同一面場地；回傳 { booked, error } */
export async function book(place, date, qtimes, slots, fetchImpl = fetch) {
  const booked = [];
  for (const qtime of qtimes) {
    // 第一小時優先選下一小時也有空的場地；第二小時優先選第一小時訂到的場地
    const prefer = booked.length
      ? new Set([booked[0].qpid])
      : new Set(qtimes.length > 1 ? (slots.get(qtimes.at(-1)) || []).map((s) => s.qpid) : []);
    const candidates = [...(slots.get(qtime) || [])].sort((a, b) => prefer.has(b.qpid) - prefer.has(a.qpid));

    for (const { qpid, court } of candidates) {
      const error = await bookOne(place, qpid, qtime, date, fetchImpl);
      if (error === null) {
        booked.push({ date, court, qtime, qpid });
        break;
      }
      if (error !== "預約失敗") return { booked, error };
    }
  }
  return { booked, error: null };
}

/** 查空位並預約；成功回傳已預約清單，失敗丟出錯誤 */
export async function reserve(place, date, qtime, hours, fetchImpl = fetch) {
  const qtimes = Array.from({ length: hours }, (_, i) => qtime + i);
  const slots = await getAvailable(place, date, qtimes, fetchImpl);
  if (!slots) throw new Error(`${date} 尚未開放預約`);
  const { booked, error } = await book(place, date, qtimes, slots, fetchImpl);
  if (!booked.length) throw new Error(error || "該時段已經沒有場地");
  return booked;
}
