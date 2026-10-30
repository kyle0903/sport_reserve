import {
  SITES, SPORTS, ADVANCE_DAYS, LoginError, loginUrl, payUrl, getDay, getCalendar, reserve, reserveAtOpen, DEFAULT_COURTS,
  formatDate, nextOpenAt, nextOpenDate,
} from "./reserve.js";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const PERIODS = [
  ["早上", 6, 11],
  ["下午", 12, 17],
  ["晚上", 18, 21],
];
const FEW_LEFT = 2; // 剩這麼少就用橘色提醒
// 自動搶提示用的線條時鐘（跟主題同色）
const CLOCK_ICON = `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 5.8V10l2.8 1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const form = document.getElementById("reservationForm");
const dateChips = document.getElementById("dateChips");
const errorBox = document.getElementById("errorBox");
const formResult = document.getElementById("formResult");
const resultContent = document.getElementById("resultContent");
const avatar = document.getElementById("avatar");
const avatarText = document.getElementById("avatarText");
const scheduleToggle = document.getElementById("scheduleToggle");
const scheduleButton = document.getElementById("scheduleButton");
const scheduleTarget = document.getElementById("scheduleTarget");
const submitLabel = document.getElementById("submitLabel");
const waiting = document.getElementById("waiting");
const countdownText = document.getElementById("countdownText");
const clockChip = document.getElementById("clockChip");
const checkText = document.getElementById("checkText");

function radio(name, value, html, checked, className) {
  const label = document.createElement("label");
  if (className) label.className = className;
  label.innerHTML = `<input type="radio" name="${name}" value="${value}" ${checked ? "checked" : ""} /><span>${html}</span>`;
  return label;
}

function formatDay(d) {
  return `${d.getMonth() + 1}/${d.getDate()} 週${WEEKDAYS[d.getDay()]}`;
}

// 依場館產生可預約日期，預設選最後一天；面板開著跨過午夜時會重新產生
let renderedKey = null;
function renderDates(days) {
  const key = `${days}-${formatDate(new Date())}`;
  if (key === renderedKey) return;
  renderedKey = key;
  dateChips.innerHTML = "";
  dateChips.style.setProperty("--n", days + 1);
  for (let i = 0; i <= days; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const label = radio("date", formatDate(d), `<small>${i === 0 ? "今天" : WEEKDAYS[d.getDay()]}</small><b>${d.getDate()}</b>`, i === days, "day");
    label.dataset.text = formatDay(d);
    dateChips.appendChild(label);
  }
}

const timeChips = document.getElementById("timeChips");
PERIODS.forEach(([name, from, to]) => {
  const group = document.createElement("div");
  group.className = "period";
  group.innerHTML = `<span class="period-name">${name}</span><div class="times"></div>`;
  for (let h = from; h <= to; h++) {
    group.querySelector(".times").appendChild(radio("QTime", h, `<b>${h}:00</b><i class="dots"></i>`, h === 19, "time"));
  }
  timeChips.appendChild(group);
});

// 記住上次的選擇，下次打開不用重選（運動不記，每次預設羽球）
const SAVED_FIELDS = ["place", "QTime", "hours"];
try {
  const saved = JSON.parse(localStorage.getItem("sport_reserve") || "{}");
  SAVED_FIELDS.forEach((name) => {
    const el = form.querySelector(`input[name="${name}"][value="${saved[name]}"]`);
    if (el) el.checked = true;
  });
} catch (e) {}

// 不用 FormData：預約中選項會被停用，FormData 會略過停用的欄位
const checkedValue = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
const currentPlace = () => checkedValue("place");

// 登入狀態：checking 確認中 / ok 已登入 / bad 未登入
let loginState = "checking";

// 空位查詢結果：availKey 是「場館|運動|日期」
let availKey = null;
let availCounts = null; // Map(整點 => 剩幾面)
let availTotals = null; // Map(整點 => 場地總數)
let availSlots = null; // 原始空位 Map(整點 => [{ qpid, court }])，按預約時 1 分鐘內直接沿用
let availAt = 0;
const CACHE_MS = 60 * 1000;

// 查過的月曆與各日期空位保留 3 分鐘（存在瀏覽器，關掉面板再打開也還在），減少打官網的次數；
// 點右上角頭像或預約完成後會清掉重查
const CACHE_TTL = 3 * 60 * 1000;
const cache = {
  get(key) {
    try {
      const value = JSON.parse(localStorage.getItem(`cache:${key}`));
      return value && Date.now() - value.at < CACHE_TTL ? value : null;
    } catch (e) {
      return null;
    }
  },
  set(key, data) {
    try {
      // 順便清掉過期的
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("cache:") && !this.get(k.slice(6))) localStorage.removeItem(k);
      }
      localStorage.setItem(`cache:${key}`, JSON.stringify({ at: Date.now(), ...data }));
    } catch (e) {}
  },
  clear() {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("cache:")) localStorage.removeItem(k);
    } catch (e) {}
  },
};
let availRequest = 0;
// 月曆查詢結果：calendarKey 是「場館|運動」，calendar 是 Map(日期 => open / full / closed)
let calendarKey = null;
let calendar = null;
let calendarRequest = 0;
// 查時段後發現全部都滿的「場館|運動|日期」（官網月曆有時仍顯示可預約，例如當天時段都已被訂走）
const slotFullDates = new Set();
const currentAvailKey = () => `${checkedValue("place")}|${checkedValue("sport")}|${checkedValue("date")}`;
const availNote = document.getElementById("availNote");
const submitButton = document.getElementById("submitButton");

// 一格代表一面場地：可預約的亮起來
function dotsHtml(left, total) {
  return Array.from({ length: total }, (_, i) => `<i${i < left ? ' class="free"' : ""}></i>`).join("");
}

// 預約內容的文字（等待畫面也會用到）
function summaryText() {
  const place = checkedValue("place");
  const sport = checkedValue("sport");
  const start = Number(checkedValue("QTime"));
  const hours = Number(checkedValue("hours"));
  const day = scheduleToggle.checked
    ? formatDay(nextOpenDate(place))
    : form.querySelector('input[name="date"]:checked')?.closest("label").dataset.text ?? "沒有可預約的日期";
  return `${SITES[place].name}・${SPORTS[sport].name}・${day}${checkedValue("QTime") ? `・${start}:00–${start + hours}:00` : ""}`;
}

// 依目前選擇更新畫面
function refresh() {
  // 沒有這項運動的場館不能選（例如匹克球只有三重），選到的話切回三重
  const sport = checkedValue("sport");
  form.querySelectorAll('input[name="place"]').forEach((el) => {
    el.disabled = !SITES[el.value].sports.includes(sport);
  });
  if (form.querySelector('input[name="place"]:checked').disabled) form.querySelector('input[name="place"][value="SC"]').checked = true;
  const place = checkedValue("place");
  renderDates(ADVANCE_DAYS[place]);

  // 自動搶模式：日期換成「將搶哪一天」，按鈕文字跟著變
  const scheduled = scheduleToggle.checked;
  dateChips.hidden = scheduled;
  scheduleTarget.hidden = !scheduled;
  scheduleTarget.innerHTML = `<b>${CLOCK_ICON}00:00 自動搶 ${formatDay(nextOpenDate(place))}</b><br />選好時段後按下方按鈕，開放瞬間自動送出`;
  scheduleButton.classList.toggle("on", scheduled);
  scheduleButton.textContent = scheduled ? "← 立即預約" : "00:00 自動搶";
  submitLabel.textContent = scheduled ? "設定 00:00 自動搶 →" : "立即預約 →";

  // 日期：額滿、休館停用（依官網月曆與查過的時段）
  const days = calendarKey === `${place}|${sport}` ? calendar : null;
  const dateInputs = [...dateChips.querySelectorAll("input")];
  const previousDate = dateInputs.findIndex((input) => input.checked);
  dateInputs.forEach((input) => {
    let status = days?.get(input.value);
    if (slotFullDates.has(`${place}|${sport}|${input.value}`)) status = "full";
    input.disabled = status === "full" || status === "closed";
    input.closest("label").classList.toggle("full", status === "full");
    input.closest("label").classList.toggle("closed", status === "closed");
  });
  // 原本選的日期不能選了：改選之後最近可預約的日期，沒有就往前找
  const checkedDate = dateInputs[previousDate];
  if (checkedDate?.disabled) {
    const enabled = dateInputs.filter((input) => !input.disabled);
    const next = enabled.find((input) => dateInputs.indexOf(input) > previousDate) || enabled.at(-1);
    checkedDate.checked = false;
    if (next) next.checked = true;
  }

  // 時段：已滿停用、下方點點表示每面場地；2 小時不能從 21:00 開始
  const hours = Number(checkedValue("hours"));
  const counts = !scheduled && availKey === currentAvailKey() ? availCounts : null;
  const timeInputs = [...form.querySelectorAll('input[name="QTime"]')];
  const previous = Number(checkedValue("QTime") ?? form.dataset.lastQtime ?? 19);
  timeInputs.forEach((input) => {
    const h = Number(input.value);
    const left = counts ? counts.get(h) : null;
    input.disabled = left === 0 || (h === 21 && hours === 2);
    input.closest("label").classList.toggle("full", left === 0);
    const dots = input.nextElementSibling.querySelector(".dots");
    const total = counts ? Math.max(availTotals.get(h) || 0, left) : 0;
    dots.innerHTML = dotsHtml(left || 0, total);
    dots.classList.toggle("few", left > 0 && left <= FEW_LEFT);
  });
  // 原本選的時段不能選了：改選之後最近有空位的時段，沒有就往前找
  const current = form.querySelector('input[name="QTime"]:checked');
  if (!current || current.disabled) {
    const enabled = timeInputs.filter((input) => !input.disabled);
    const next = enabled.find((input) => Number(input.value) >= previous) || enabled.at(-1);
    if (current) current.checked = false;
    if (next) next.checked = true;
  }
  if (checkedValue("QTime")) form.dataset.lastQtime = checkedValue("QTime");
  const start = Number(checkedValue("QTime"));
  form.querySelectorAll(".time").forEach((label) => {
    label.classList.toggle("in-range", hours === 2 && Number(label.querySelector("input").value) === start + 1);
  });

  const checking = timeChips.classList.contains("checking");
  const allFull = counts && timeInputs.every((input) => input.disabled);
  // 查詢空位中：時段暫時不能點（不算已滿，也不改選），也先不能預約
  if (checking) timeInputs.forEach((input) => (input.disabled = true));
  submitButton.disabled = form.classList.contains("loading") || !checkedValue("QTime") || (!scheduled && !checkedValue("date")) || (!scheduled && checking);
  availNote.textContent = scheduled
    ? "自動搶的那天還沒開放，無法事先查空位"
    : !checkedValue("date")
      ? "這段期間都已經滿了"
      : loginState !== "ok"
        ? "登入後會顯示每個時段的空位"
        : checking
          ? "查詢空位中…"
          : allFull
            ? "這天已經全滿了"
            : counts
              ? "一格代表一面場地，亮綠為可預約，橘色表示快沒了"
              : "";

  // 大卡片：預約內容與可搶的場地數
  document.getElementById("heroMeta").textContent = summaryText().split("・").slice(0, 3).join("・");
  document.getElementById("heroTime").textContent = checkedValue("QTime") ? `${start}:00` : "--:--";
  document.getElementById("heroEnd").textContent = checkedValue("QTime") ? `– ${start + hours}:00` : "";
  let count = "–";
  let countLabel = "登入後顯示空位";
  if (scheduled) [count, countLabel] = ["?", "開放後才知道"];
  else if (loginState === "ok" && checking) [count, countLabel] = ["…", "查詢中"];
  else if (loginState === "ok" && !checkedValue("QTime")) [count, countLabel] = ["0", "這天已全滿"];
  else if (counts) {
    if (hours === 2) {
      // 兩小時都空著的場地才算可以連打
      const second = new Set((availSlots.get(start + 1) || []).map((s) => s.qpid));
      count = String((availSlots.get(start) || []).filter((s) => second.has(s.qpid)).length);
      countLabel = "面場地可連打 2 小時";
    } else {
      count = String(counts.get(start) || 0);
      countLabel = "面場地可搶";
    }
  }
  document.getElementById("heroCount").textContent = count;
  document.getElementById("heroCountLabel").textContent = countLabel;
}

// 查詢目前選的日期每個時段還剩幾面場地（已登入、非排程時）
function applyDay(key, slots, totals, at) {
  const [place, sport] = key.split("|");
  availKey = key;
  availSlots = slots;
  availTotals = totals;
  availAt = at;
  rememberCourts(place, sport, slots);
  availCounts = new Map();
  for (let h = 6; h <= 21; h++) availCounts.set(h, slots.get(h)?.length || 0);
  if ([...availCounts.values()].every((n) => n === 0)) slotFullDates.add(key);
  else slotFullDates.delete(key);
}

async function updateAvailability(force = false) {
  if (scheduleToggle.checked || loginState !== "ok" || form.classList.contains("loading")) return;
  if (!checkedValue("date")) return; // 所有日期都額滿或休館
  const key = currentAvailKey();
  if (!force && key === availKey) return;
  const cached = !force && cache.get(`day:${key}`);
  if (cached) {
    applyDay(key, new Map(cached.slots), new Map(cached.totals), cached.at);
    refresh();
    updateAvailability(); // 這天全滿時日期會被改選，接著看新的日期
    return;
  }
  const [place, sport, date] = key.split("|");
  availKey = key;
  availCounts = null;
  const id = ++availRequest;
  timeChips.classList.add("checking");
  refresh();
  try {
    const day = await getDay(place, sport, date);
    if (id !== availRequest) return;
    if (day) {
      applyDay(key, day.slots, day.totals, Date.now());
      cache.set(`day:${key}`, { slots: [...day.slots], totals: [...day.totals] });
    }
  } catch (e) {
    if (id !== availRequest) return;
    availKey = null;
    if (e instanceof LoginError) updateLogin(true);
  } finally {
    if (id === availRequest) {
      timeChips.classList.remove("checking");
      refresh();
      updateAvailability(); // 這天全滿時日期會被改選，接著查新的日期
    }
  }
}

// 場地代碼：內建的加上查詢時記下來的，00:00 排程直接拿來送出預約
function knownCourts(place, sport) {
  const courts = new Map((DEFAULT_COURTS[`${place}|${sport}`] || []).map(([qpid, court]) => [qpid, court]));
  try {
    for (const [qpid, court] of JSON.parse(localStorage.getItem(`courts:${place}|${sport}`) || "[]")) courts.set(qpid, court);
  } catch (e) {}
  return [...courts].map(([qpid, court]) => ({ qpid, court }));
}
function rememberCourts(place, sport, slots) {
  const courts = new Map(knownCourts(place, sport).map(({ qpid, court }) => [qpid, court]));
  for (const list of slots.values()) for (const { qpid, court } of list) courts.set(qpid, court);
  try {
    localStorage.setItem(`courts:${place}|${sport}`, JSON.stringify([...courts]));
  } catch (e) {}
}

// 右上角頭像：已登入顯示名字最後一個字，未登入變成「登入」按鈕
function setLoginState(state, { name = "", message = "" } = {}) {
  loginState = state;
  avatar.className = `avatar ${state}`;
  const place = SITES[currentPlace()].name;
  avatarText.textContent = state === "ok" ? name.slice(-1) : state === "bad" ? "登入" : "";
  avatar.title = state === "ok"
    ? `${name}（${place}）・點一下重新查詢空位`
    : state === "bad"
      ? message || `尚未登入，點一下前往${place}官網登入`
      : "確認登入中…";
}

// 確認目前場館的登入狀態（讀月曆頁，同時拿到月曆）
let loginCheckId = 0;
async function updateLogin(force = false) {
  const place = currentPlace();
  const sport = checkedValue("sport");
  const id = ++loginCheckId;
  const cached = force !== true && cache.get(`cal:${place}|${sport}`);
  if (cached) {
    calendarKey = `${place}|${sport}`;
    calendar = new Map(cached.days);
    setLoginState("ok", { name: cached.name });
    refresh();
    updateAvailability();
    return;
  }
  setLoginState("checking");
  try {
    const { name, days } = await getCalendar(place, sport);
    if (id !== loginCheckId) return;
    calendarKey = `${place}|${sport}`;
    calendar = days;
    cache.set(`cal:${place}|${sport}`, { name, days: [...days] });
    setLoginState("ok", { name });
    refresh();
    updateAvailability();
  } catch (e) {
    if (id !== loginCheckId) return;
    setLoginState("bad", { message: e instanceof LoginError ? "" : `無法連線：${e.message}` });
    if (e instanceof LoginError) cache.clear();
    availKey = null;
    availCounts = null;
    calendarKey = null;
    calendar = null;
    refresh();
  }
}

// 查詢目前場館、運動的月曆（每天是否額滿、休館）
async function updateCalendar(force = false) {
  if (loginState !== "ok" || form.classList.contains("loading")) return;
  const key = `${checkedValue("place")}|${checkedValue("sport")}`;
  if (!force && key === calendarKey) return;
  const [place, sport] = key.split("|");
  calendarKey = key;
  calendar = null;
  const id = ++calendarRequest;
  const cached = !force && cache.get(`cal:${key}`);
  if (cached) {
    calendar = new Map(cached.days);
    refresh();
    updateAvailability();
    return;
  }
  try {
    const { name, days } = await getCalendar(place, sport);
    if (id !== calendarRequest) return;
    calendar = days;
    cache.set(`cal:${key}`, { name, days: [...days] });
  } catch (e) {
    if (id !== calendarRequest) return;
    calendarKey = null;
    if (e instanceof LoginError) updateLogin(true);
  }
  refresh();
  updateAvailability(); // 選的日期可能因額滿被改選
}

form.addEventListener("change", (e) => {
  const before = currentPlace();
  refresh();
  if (currentPlace() !== before || e.target.name === "place") updateLogin();
  else {
    updateCalendar();
    updateAvailability();
  }
});

// 頭像：已登入時重新查詢，未登入時開官網登入頁
avatar.addEventListener("click", () => {
  if (loginState === "bad") {
    window.open(loginUrl(currentPlace()), "_blank", "noopener");
    return;
  }
  if (loginState !== "ok") return;
  availKey = null;
  calendarKey = null;
  slotFullDates.clear();
  cache.clear();
  updateLogin(true);
});

// 00:00 自動搶：切換模式
scheduleButton.addEventListener("click", () => {
  scheduleToggle.checked = !scheduleToggle.checked;
  refresh();
  updateAvailability();
});

// 官網分頁載入完成（例如登入、登出後跳轉）時立即重新確認
let tabCheckTimer = null;
globalThis.chrome?.tabs?.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url || form.classList.contains("loading")) return;
  if (loginState === "ok") return; // 已登入就不用每換一頁都確認
  if (new URL(tab.url).host !== new URL(SITES[currentPlace()].base).host) return;
  clearTimeout(tabCheckTimer);
  tabCheckTimer = setTimeout(() => updateLogin(true), 300);
});
// 從官網登入完點回面板時自動重新確認（側邊欄切換分頁時不會隱藏，所以看的是焦點）
window.addEventListener("focus", () => {
  if (form.classList.contains("loading")) return;
  refresh();
  if (loginState !== "ok") updateLogin(true);
});
refresh();
updateLogin();

// ---------- 排程等待畫面 ----------
let countdownTimer = null;
let clockOffset = 0; // 官網時間 − 電腦時間（毫秒）
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// 時間差標籤：+1.0s 代表官網比電腦快 1 秒（會提早送出）
function updateClockChip() {
  const sec = Math.abs(clockOffset) / 1000;
  clockChip.hidden = false;
  clockChip.textContent = Math.abs(clockOffset) < 300 ? "±0s" : `${clockOffset > 0 ? "+" : "−"}${sec.toFixed(1)}s`;
  clockChip.title = Math.abs(clockOffset) < 300
    ? "電腦時間與官網一致"
    : `電腦比官網${clockOffset > 0 ? "慢" : "快"} ${sec.toFixed(1)} 秒，將${clockOffset > 0 ? "提早" : "延後"}送出，在官網 00:00 準時送達`;
}

// 步驟：scheduled 已排程 → waiting 等待開放 → sending 送出預約 → done 完成
const STEPS = ["stepScheduled", "stepWaiting", "stepSending", "stepDone"];
function setStep(active) {
  const index = STEPS.indexOf(active);
  STEPS.forEach((id, i) => {
    const el = document.getElementById(id);
    el.classList.toggle("done", i < index);
    el.classList.toggle("active", i === index);
  });
  // 等待時 logo 打瞌睡，開始送出就醒來
  document.body.classList.toggle("sleeping", active === "stepWaiting");
}

function startCountdown(openAt) {
  const tick = () => {
    const s = Math.max(0, Math.ceil((openAt - clockOffset - new Date()) / 1000));
    countdownText.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

let abortController = null;
function setLoading(on, scheduled = false) {
  form.classList.toggle("loading", on);
  // 排程等待時收起表單，只顯示步驟卡片
  form.classList.toggle("schedule-waiting", on && scheduled);
  form.querySelectorAll("input, button").forEach((el) => (el.disabled = on));
  waiting.hidden = !(on && scheduled);
  document.getElementById("cancelButton").disabled = false;
  clearInterval(countdownTimer);
  if (!on) {
    document.body.classList.remove("sleeping");
    refresh(); // 還原 21:00 的停用狀態
  }
}

document.getElementById("cancelButton").addEventListener("click", () => {
  abortController?.abort(new DOMException("已取消排程", "AbortError"));
});

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const place = data.get("place");
  const sport = data.get("sport");
  try {
    const toSave = {};
    SAVED_FIELDS.forEach((name) => (toSave[name] = data.get(name)));
    localStorage.setItem("sport_reserve", JSON.stringify(toSave));
  } catch (e) {}

  const scheduled = scheduleToggle.checked;
  const qtime = Number(data.get("QTime"));
  const hours = Number(data.get("hours"));
  const summary = summaryText();
  showError("");
  setLoading(true, scheduled);
  try {
    let booked;
    if (scheduled) {
      abortController = new AbortController();
      clockOffset = 0;
      clockChip.hidden = true;
      checkText.textContent = "確認登入中…";
      document.getElementById("waitSummary").textContent = summary;
      setStep("stepWaiting");
      startCountdown(nextOpenAt());
      booked = await reserveAtOpen(place, sport, qtime, hours, {
        signal: abortController.signal,
        knownCourts: knownCourts(place, sport),
        onClock: (offset) => {
          clockOffset = offset;
          updateClockChip();
        },
        onCheck: ({ at, next }) => {
          checkText.textContent = next
            ? `上次確認登入 ${hhmm(at)} ✓・下次 ${hhmm(next)}`
            : `開放前最後確認 ${hhmm(at)} ✓`;
        },
        onPhase: () => {
          clearInterval(countdownTimer);
          countdownText.textContent = "00:00:00";
          setStep("stepSending");
        },
      });
      setStep("stepDone");
    } else {
      // 1 分鐘內剛查過這天的空位就直接沿用，省掉一次查詢
      const cached = availKey === `${place}|${sport}|${data.get("date")}` && Date.now() - availAt < CACHE_MS ? availSlots : null;
      booked = await reserve(place, sport, data.get("date"), qtime, hours, fetch, cached);
    }
    resultContent.innerHTML = "";
    booked.forEach((item) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="ticket-time">${item.qtime}:00<small>– ${item.qtime + 1}:00</small></div>
        <div class="ticket-info"><b>${item.court}</b><small>${SITES[place].name}${SPORTS[sport].name}・${item.date}</small></div>`;
      resultContent.appendChild(li);
    });
    document.getElementById("payLink").href = payUrl(place);
    form.hidden = true;
    formResult.hidden = false;
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      showError(error.message);
    }
    if (error instanceof LoginError) {
      cache.clear();
      updateLogin(true);
    }
  } finally {
    abortController = null;
    setLoading(false);
    // 預約完狀態會改變，重新查月曆與空位
    updateCalendar(true);
    updateAvailability(true);
  }
});

document.getElementById("againButton").addEventListener("click", () => {
  formResult.hidden = true;
  form.hidden = false;
});
