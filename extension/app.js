import {
  SITES, SPORTS, ADVANCE_DAYS, LoginError, loginUrl, payUrl, getAvailable, getCalendar, reserve, reserveAtOpen, DEFAULT_COURTS,
  formatDate, nextOpenAt, nextOpenDate,
} from "./reserve.js";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const PERIODS = [
  ["🌤", "早上", 6, 11],
  ["☀️", "下午", 12, 17],
  ["🌙", "晚上", 18, 21],
];

const form = document.getElementById("reservationForm");
const dateChips = document.getElementById("dateChips");
const errorBox = document.getElementById("errorBox");
const formResult = document.getElementById("formResult");
const resultContent = document.getElementById("resultContent");
const loginStatus = document.getElementById("loginStatus");
const loginText = document.getElementById("loginText");
const loginLink = document.getElementById("loginLink");
const scheduleToggle = document.getElementById("scheduleToggle");
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
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const label = radio(
      "date",
      formatDate(d),
      `<small>${i === 0 ? "今天" : "週" + WEEKDAYS[d.getDay()]}</small><b>${d.getDate()}</b><small>${d.getMonth() + 1}月</small>`,
      i === days,
      weekend ? "day weekend" : "day"
    );
    label.dataset.text = formatDay(d);
    dateChips.appendChild(label);
  }
}

const timeChips = document.getElementById("timeChips");
PERIODS.forEach(([icon, name, from, to]) => {
  const group = document.createElement("div");
  group.className = "period";
  group.innerHTML = `<span class="period-name"><i>${icon}</i>${name}</span><div class="times"></div>`;
  for (let h = from; h <= to; h++) {
    group.querySelector(".times").appendChild(radio("QTime", h, `${h}:00`, h === 19, "time"));
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

// 空位查詢結果：availKey 是「場館|運動|日期」，availCounts 是 Map(整點 => 剩幾面場地)
let availKey = null;
let availCounts = null;
let availSlots = null; // 原始空位 Map(整點 => [{ qpid, court }])，按預約時 1 分鐘內直接沿用
let availAt = 0;
const CACHE_MS = 60 * 1000;
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

// 依目前選擇更新：可選場館、日期範圍、排程說明、2 小時的第二格標示、摘要列
function refresh() {
  // 沒有這項運動的場館不能選（例如匹克球只有三重），選到的話切回三重
  const sport = form.querySelector('input[name="sport"]:checked').value;
  form.querySelectorAll('input[name="place"]').forEach((el) => {
    el.disabled = !SITES[el.value].sports.includes(sport);
  });
  const checkedPlace = form.querySelector('input[name="place"]:checked');
  if (checkedPlace.disabled) form.querySelector('input[name="place"][value="SC"]').checked = true;

  const data = new FormData(form);
  const place = data.get("place");
  renderDates(ADVANCE_DAYS[place]);

  const scheduled = scheduleToggle.checked;
  dateChips.hidden = scheduled;
  document.getElementById("scheduleHint").textContent = scheduled
    ? `請於 00:00 前送出，將預約 ${formatDay(nextOpenDate(place))}`
    : "開放瞬間自動送出，送出後請保持面板開著";

  // 日期：額滿標紅、休館標灰並停用（依官網月曆）
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

  // 時段：已滿變灰並停用、有空位顯示剩幾面；2 小時不能從 21:00 開始
  const hours = Number(data.get("hours"));
  const counts = !scheduled && availKey === currentAvailKey() ? availCounts : null;
  const timeInputs = [...form.querySelectorAll('input[name="QTime"]')];
  const previous = Number(checkedValue("QTime") ?? form.dataset.lastQtime ?? 19);
  timeInputs.forEach((input) => {
    const h = Number(input.value);
    const left = counts ? counts.get(h) : null;
    input.disabled = left === 0 || (h === 21 && hours === 2);
    input.closest("label").classList.toggle("full", left === 0);
    input.nextElementSibling.dataset.left = left ? `剩 ${left}` : "";
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

  const allFull = counts && timeInputs.every((input) => input.disabled);
  submitButton.disabled = form.classList.contains("loading") || !checkedValue("QTime") || (!scheduled && !checkedValue("date"));
  availNote.textContent = scheduled
    ? "排程時那天還沒開放，無法事先查空位"
    : !checkedValue("date")
      ? "這段期間都已經滿了 😢"
      : !loginStatus.classList.contains("ok")
        ? "登入後會顯示每個時段的空位"
        : timeChips.classList.contains("checking")
          ? "查詢空位中…"
          : allFull
            ? "這天已經全滿了 😢"
            : counts
              ? "灰色為已滿，數字為剩餘場地數"
              : "";

  const start = Number(checkedValue("QTime"));
  form.querySelectorAll(".time").forEach((label) => {
    const h = Number(label.querySelector("input").value);
    label.classList.toggle("in-range", hours === 2 && h === start + 1);
  });

  const dayText = scheduled
    ? formatDay(nextOpenDate(place))
    : form.querySelector('input[name="date"]:checked')?.closest("label").dataset.text ?? "沒有可預約的日期";
  document.getElementById("summaryText").textContent = checkedValue("QTime")
    ? `${SITES[place].name}${SPORTS[sport].name} · ${dayText} · ${start}:00–${start + hours}:00`
    : `${SITES[place].name}${SPORTS[sport].name} · ${dayText} · 沒有可預約的時段`;
}

// 查詢目前選的日期每個時段還剩幾面場地（已登入、非排程時）
async function updateAvailability(force = false) {
  if (scheduleToggle.checked || !loginStatus.classList.contains("ok") || form.classList.contains("loading")) return;
  if (!checkedValue("date")) return; // 所有日期都額滿或休館
  const key = currentAvailKey();
  if (!force && key === availKey) return;
  const [place, sport, date] = key.split("|");
  availKey = key;
  availCounts = null;
  const id = ++availRequest;
  timeChips.classList.add("checking");
  refresh();
  try {
    // 6、12、18 點分別涵蓋早上、下午、晚上三個時段的列表頁
    const slots = await getAvailable(place, sport, date, [6, 12, 18]);
    if (id !== availRequest) return;
    if (slots) {
      availSlots = slots;
      availAt = Date.now();
      rememberCourts(place, sport, slots);
      availCounts = new Map();
      for (let h = 6; h <= 21; h++) availCounts.set(h, slots.get(h)?.length || 0);
      if ([...availCounts.values()].every((n) => n === 0)) slotFullDates.add(key);
      else slotFullDates.delete(key);
    }
  } catch (e) {
    if (id !== availRequest) return;
    availKey = null;
    if (e instanceof LoginError) updateLogin();
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

// 確認目前場館的登入狀態
let loginCheckId = 0;
async function updateLogin() {
  const place = currentPlace();
  const id = ++loginCheckId;
  loginStatus.className = "status-pill";
  loginStatus.textContent = "確認登入中…";
  loginText.textContent = "";
  loginLink.hidden = true;
  try {
    const sport = checkedValue("sport");
    const { name, days } = await getCalendar(place, sport);
    if (id !== loginCheckId) return;
    calendarKey = `${place}|${sport}`;
    calendar = days;
    loginStatus.className = "status-pill ok";
    loginStatus.textContent = "已登入";
    loginText.textContent = `${name}，可以開始預約囉`;
    refresh();
    updateAvailability();
  } catch (e) {
    if (id !== loginCheckId) return;
    loginStatus.className = "status-pill bad";
    loginStatus.textContent = "未登入";
    loginText.textContent = e instanceof LoginError ? `請先登入${SITES[place].name}官網` : `無法連線：${e.message}`;
    loginLink.href = loginUrl(place);
    loginLink.hidden = false;
    availKey = null;
    availCounts = null;
    calendarKey = null;
    calendar = null;
    refresh();
  }
}

// 查詢目前場館、運動的月曆（每天是否額滿、休館）
async function updateCalendar(force = false) {
  if (!loginStatus.classList.contains("ok") || form.classList.contains("loading")) return;
  const key = `${checkedValue("place")}|${checkedValue("sport")}`;
  if (!force && key === calendarKey) return;
  const [place, sport] = key.split("|");
  calendarKey = key;
  calendar = null;
  const id = ++calendarRequest;
  try {
    const { days } = await getCalendar(place, sport);
    if (id !== calendarRequest) return;
    calendar = days;
  } catch (e) {
    if (id !== calendarRequest) return;
    calendarKey = null;
    if (e instanceof LoginError) updateLogin();
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
// ↻：重新確認登入並重新查月曆與空位
document.getElementById("loginRefresh").addEventListener("click", () => {
  availKey = null;
  calendarKey = null;
  slotFullDates.clear();
  updateLogin();
});
// 官網分頁載入完成（例如登入、登出後跳轉）時立即重新確認
let tabCheckTimer = null;
globalThis.chrome?.tabs?.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url || form.classList.contains("loading")) return;
  if (new URL(tab.url).host !== new URL(SITES[currentPlace()].base).host) return;
  clearTimeout(tabCheckTimer);
  tabCheckTimer = setTimeout(updateLogin, 300);
});
// 從官網登入完點回面板時自動重新確認（側邊欄切換分頁時不會隱藏，所以看的是焦點）
window.addEventListener("focus", () => {
  if (form.classList.contains("loading")) return;
  refresh();
  if (!loginStatus.classList.contains("ok")) updateLogin();
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
  clockChip.textContent = Math.abs(clockOffset) < 300 ? "⏱ ±0s" : `⏱ ${clockOffset > 0 ? "+" : "−"}${sec.toFixed(1)}s`;
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
  // 等待時羽毛球打瞌睡，開始送出就醒來
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
  showError("");
  setLoading(true, scheduled);
  try {
    let booked;
    if (scheduled) {
      abortController = new AbortController();
      clockOffset = 0;
      clockChip.hidden = true;
      checkText.textContent = "確認登入中…";
      document.getElementById("waitSummary").textContent = document.getElementById("summaryText").textContent;
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
    if (error instanceof LoginError) updateLogin();
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
