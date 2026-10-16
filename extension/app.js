import { SITES, ADVANCE_DAYS, LoginError, loginUrl, payUrl, checkLogin, reserve } from "./reserve.js";

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

function radio(name, value, html, checked, className) {
  const label = document.createElement("label");
  if (className) label.className = className;
  label.innerHTML = `<input type="radio" name="${name}" value="${value}" ${checked ? "checked" : ""} /><span>${html}</span>`;
  return label;
}

// 用本地時間格式化，避免 toISOString() 在台灣早上 8 點前少一天；格式與網站相同 YYYY/MM/DD
function formatDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function formatDay(d) {
  return `${d.getMonth() + 1}/${d.getDate()} 週${WEEKDAYS[d.getDay()]}`;
}

// 依場館產生可預約日期，預設選最後一天
let renderedDays = null;
function renderDates(days) {
  if (days === renderedDays) return;
  renderedDays = days;
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

const currentPlace = () => new FormData(form).get("place");

// 依目前選擇更新：日期範圍、2 小時的第二格標示、摘要列
function refresh() {
  const data = new FormData(form);
  renderDates(ADVANCE_DAYS[data.get("place")]);

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

  const dayText = form.querySelector('input[name="date"]:checked').closest("label").dataset.text;
  document.getElementById("summaryText").textContent =
    `${SITES[data.get("place")].name} · ${dayText} · ${start}:00–${start + hours}:00`;
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
// 從官網登入完點回面板時自動重新確認（側邊欄切換分頁時不會隱藏，所以看的是焦點）
window.addEventListener("focus", () => {
  if (!loginStatus.classList.contains("ok")) updateLogin();
});
refresh();
updateLogin();

function setLoading(on) {
  form.classList.toggle("loading", on);
  form.querySelectorAll("input, button").forEach((el) => (el.disabled = on));
  if (!on) refresh(); // 還原 21:00 的停用狀態
}

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

  showError("");
  setLoading(true);
  try {
    const booked = await reserve(place, data.get("date"), Number(data.get("QTime")), Number(data.get("hours")));
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
    console.error(error);
    showError(error.message);
    if (error instanceof LoginError) updateLogin();
  } finally {
    setLoading(false);
  }
});

document.getElementById("againButton").addEventListener("click", () => {
  formResult.hidden = true;
  form.hidden = false;
});
