from flask import Flask, request, Response, send_from_directory
import json
import requests
import re
import time
from datetime import datetime, timedelta, timezone
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
# 共用連線，省去每次預約重新建立 TLS 連線的時間
http = requests.Session()


@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/style.css")
def style():
    return send_from_directory(".", "style.css")


@app.route("/api/test", methods=["POST"])
def test():
    post_data = request.form.to_dict()
    print(post_data)
    data = [{
        "date": "2025/02/16",
        "court": "場地5-1",
        "QTime": 1, 
        "url": "https://www.cjcf.com.tw/CG01.aspx?module=net_booking&files=booking_place&StepFlag=25&QPid=83&QTime=1&PT=1&D=2025/02/16"
    }]
    
    return makeJsonResponse(200, data)


TW = timezone(timedelta(hours=8))
SITES = {
    "SC": "https://fe.xuanen.com.tw/fe01.aspx?",
    "LZ": "https://bcc.xuanen.com.tw/cc01.aspx?",
}
# 列表頁中可預約的格子：預約「羽5-3 18:00~19:00」？')){Step3Action(1074,18)}
# 可預約到幾天後：三重今天～7 天後，蘆洲今天～6 天後
ADVANCE_DAYS = {"SC": 7, "LZ": 6}
SLOT_RE = re.compile(r"預約「(\S+) [^」]*」？'\)\)\{Step3Action\((\d+),(\d+)\)")


class LoginError(Exception):
    pass


@app.route("/api/reserve_api", methods=["POST"])
def reserve_api():
    try:
        data = request.form.to_dict()

        hours = int(data["hours"])
        if hours > 2:
            return makeJsonResponse(400, "hours must be less than 2")
        if data["place"] not in SITES:
            return makeJsonResponse(400, "place must be SC or LZ")

        pre_url = SITES[data["place"]]
        cookie = data["cookie"]
        qtime = int(data["QTime"])
        qtimes = list(range(qtime, qtime + hours))

        if data.get("schedule") == "1":
            date, slots = wait_and_get_available(pre_url, cookie, qtimes, ADVANCE_DAYS[data["place"]])
            if slots is None:
                return makeJsonResponse(400, f"00:00 後 20 秒內 {date} 仍未開放")
        else:
            date = data["date"]
            slots = get_available(pre_url, cookie, date, qtimes)
            if slots is None:
                return makeJsonResponse(400, f"{date} 尚未開放預約")

        booked, err = book(pre_url, cookie, date, qtimes, slots)
        if not booked:
            return makeJsonResponse(400, err or "該時段已經沒有場地")
        return makeJsonResponse(200, booked)
    except LoginError:
        return makeJsonResponse(400, "登入逾期，請更新 Cookie")
    except Exception as e:
        return makeJsonResponse(400, str(e))


def wait_and_get_available(pre_url, cookie, qtimes, advance_days):
    """等到下一個 00:00 開放最後一天的場地，回傳 (date, slots)"""
    now = datetime.now(TW)
    open_at = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    date = (open_at + timedelta(days=advance_days)).strftime("%Y/%m/%d")

    # 開放前 10 秒先確認登入狀態，順便建立連線
    time.sleep(max(0, (open_at - timedelta(seconds=10) - datetime.now(TW)).total_seconds()))
    if get_available(pre_url, cookie, now.strftime("%Y/%m/%d"), qtimes) is None:
        raise LoginError()

    time.sleep(max(0, (open_at - datetime.now(TW)).total_seconds()))
    deadline = open_at + timedelta(seconds=20)
    while True:
        try:
            slots = get_available(pre_url, cookie, date, qtimes)
        except LoginError:
            slots = None
        if slots is not None or datetime.now(TW) > deadline:
            return date, slots
        time.sleep(0.5)


def get_available(pre_url, cookie, date, qtimes):
    """查詢列表頁，回傳 {QTime: [(QPid, 場地名稱), ...]}；該日尚未開放時回傳 None"""
    slots = {}
    opened = False
    # D2：1=早上(06~12) 2=下午(12~18) 3=晚上(18~22)
    for d2 in sorted({1 if t < 12 else 2 if t < 18 else 3 for t in qtimes}):
        url = f"{pre_url}module=net_booking&files=booking_place&StepFlag=2&PT=1&D={date}&D2={d2}"
        response = http.get(url, headers=make_headers(cookie), timeout=10)
        if "ContentPlaceHolder1_Step2_data" not in response.text:
            raise LoginError()
        found = SLOT_RE.findall(response.text)
        if found or 'title="已被預約"' in response.text:
            opened = True
        for court, qpid, t in found:
            slots.setdefault(int(t), []).append((int(qpid), court))
    return slots if opened else None


def book(pre_url, cookie, date, qtimes, slots):
    """依序預約每個時段，2 小時優先同一面場地；回傳 (已預約清單, 錯誤訊息)"""
    booked = []
    for i, qtime in enumerate(qtimes):
        candidates = slots.get(qtime, [])
        if booked:
            # 第二小時優先選第一小時訂到的場地
            prefer = {booked[0]["QPid"]}
        else:
            # 第一小時優先選下一小時也有空的場地
            prefer = {q for q, _ in slots.get(qtimes[-1], [])} if len(qtimes) > 1 else set()
        candidates = sorted(candidates, key=lambda s: s[0] not in prefer)

        for qpid, court in candidates:
            url, err = get_url(pre_url, cookie, qpid, qtime, date)
            if err is None:
                booked.append({"date": date, "court": court, "QTime": qtime, "QPid": qpid, "url": url})
                break
            if err != "預約失敗":
                return booked, err
    return booked, None


def make_headers(cookie):
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Encoding": "gzip, deflate",  # requests 無法解 br/zstd
        "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7",
        "Cache-Control": "max-age=0",
        "Cookie": cookie
    }


def get_url(pre_url, cookie, qpid, qtime, date):
    url = f"{pre_url}module=net_booking&files=booking_place&StepFlag=25&QPid={qpid}&QTime={qtime}&PT=1&D={date}"
    response = http.get(url, headers=make_headers(cookie), timeout=10)
    if response.status_code == 200:
        match = re.search(r"window\.location\.href='([^']*)'", response.text)
        if match:
            redirect_url = match.group(1)
            if "&X=1" in redirect_url:
                redirect_url = redirect_url.replace("../../../", pre_url.rsplit("/", 1)[0] + "/")
                print(redirect_url)
                return redirect_url, None
            elif "&X=2" in redirect_url:
                return None, "預約失敗"
            else:
                return None, "超過預約次數"
        else:
            return None, "無法獲取預約頁面"
    return None, "登入逾期"

def makeJsonResponse(code, message):
    return Response(json.dumps({"code": code, "message": message}, default=str), status=code, content_type="application/json;charset=utf-8")

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8081)