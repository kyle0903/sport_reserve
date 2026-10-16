import {
  SITES, ADVANCE_DAYS, LoginError, loginUrl, payUrl, checkLogin, reserve, reserveAtOpen,
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
const statusText = document.getElementById("statusText");

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

// 記住上次的選擇，下次打開不用重選
const SAVED_FIELDS = ["place", "QTime", "hours"];
try {
  const saved = JSON.parse(localStorage.getItem("sport_reserve") || "{}");
  SAVED_FIELDS.forEach((name) => {
    const el = form.querySelector(`input[name="${name}"][value="${saved[name]}"]`);
    if (el) el.checked = true;
  });
} catch (e) {}

// 不用 FormData：預約中選項會被停用，FormData 會略過停用的欄位
const currentPlace = () => form.querySelector('input[name="place"]:checked').value;

// 依目前選擇更新：日期範圍、排程說明、2 小時的第二格標示、摘要列
function refresh() {
  const data = new FormData(form);
  const place = data.get("place");
  renderDates(ADVANCE_DAYS[place]);

  const scheduled = scheduleToggle.checked;
  dateChips.hidden = scheduled;
  document.getElementById("scheduleHint").textContent = scheduled
    ? `請於 00:00 前送出，將預約 ${formatDay(nextOpenDate(place))}`
    : "開放瞬間自動送出，送出後請保持面板開著";

  const hours = Number(data.get("hours"));
  // 2 小時不能從 21:00 開始
  const last = form.querySelector('input[name="QTime"][value="21"]');
  last.disabled = hours === 2;
  if (last.disabled && last.checked) form.querySelector('input[name="QTime"][value="20"]').checked = true;

  const start = Number(new FormData(form).get("QTime"));
  form.querySelectorAll(".time").forEach((label) => {
    const h = Number(label.querySelector("input").value);
    label.classList.toggle("in-range", hours === 2 && h === start + 1);
  });

  const dayText = scheduled
    ? formatDay(nextOpenDate(place))
    : form.querySelector('input[name="date"]:checked').closest("label").dataset.text;
  document.getElementById("summaryText").textContent =
    `${SITES[place].name} · ${dayText} · ${start}:00–${start + hours}:00`;
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
    const name = await checkLogin(place, formatDate(new Date()));
    if (id !== loginCheckId) return;
    loginStatus.className = "status-pill ok";
    loginStatus.textContent = "已登入";
    loginText.textContent = `${name}，可以開始預約囉`;
  } catch (e) {
    if (id !== loginCheckId) return;
    loginStatus.className = "status-pill bad";
    loginStatus.textContent = "未登入";
    loginText.textContent = e instanceof LoginError ? `請先登入${SITES[place].name}官網` : `無法連線：${e.message}`;
    loginLink.href = loginUrl(place);
    loginLink.hidden = false;
  }
}

form.addEventListener("change", (e) => {
  refresh();
  if (e.target.name === "place") updateLogin();
});
document.getElementById("loginRefresh").addEventListener("click", updateLogin);
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

// 排程倒數
let countdownTimer = null;
function startCountdown(openAt, dayText) {
  const pad = (n) => String(n).padStart(2, "0");
  const tick = () => {
    const s = Math.max(0, Math.ceil((openAt - new Date()) / 1000));
    statusText.innerHTML = s > 0
      ? `距離開放 <b>${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}</b><br />將預約 ${dayText}・每 10 分鐘自動確認登入<br />請保持面板開著、電腦不要睡眠`
      : "已開放，正在預約…";
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

let abortController = null;
function setLoading(on, scheduled = false) {
  form.classList.toggle("loading", on);
  form.querySelectorAll("input, button").forEach((el) => (el.disabled = on));
  waiting.hidden = !(on && scheduled);
  document.getElementById("cancelButton").disabled = false;
  clearInterval(countdownTimer);
  if (!on) refresh(); // 還原 21:00 的停用狀態
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
      startCountdown(nextOpenAt(), formatDay(nextOpenDate(place)));
      booked = await reserveAtOpen(place, qtime, hours, { signal: abortController.signal });
    } else {
      booked = await reserve(place, data.get("date"), qtime, hours);
    }
    resultContent.innerHTML = "";
    booked.forEach((item) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="ticket-time">${item.qtime}:00<small>– ${item.qtime + 1}:00</small></div>
        <div class="ticket-info"><b>${item.court}</b><small>${SITES[place].name}・${item.date}</small></div>`;
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
  }
});

document.getElementById("againButton").addEventListener("click", () => {
  formResult.hidden = true;
  form.hidden = false;
});
