from flask import Flask, request, Response
import json
import requests
import re
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


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


@app.route("/api/reserve_api", methods=["POST"])
def reserve_api():
    try:
        data = request.form.to_dict()
        
        court_mapping = {
            83: ("場地5-1", "羽A"),
            84: ("場地5-2", "羽B"),
            1074: ("場地5-3", "羽C"),
            1075: ("場地5-4", "羽D"),
            87: ("場地5-5", "羽E"),
            88: ("場地5-6", "羽F")
        }
        ticket_number = 0
        
        hours = int(data["hours"])
        if hours > 2:
            return makeJsonResponse(400, "hours must be less than 2")

        arr_result = []
        is_second_time = False
        for qpid in court_mapping:
            if data["place"] == "SC":
                court = court_mapping[qpid][0]
                pre_url = "https://fe.xuanen.com.tw/fe01.aspx?"
                replace_url = pre_url.split("fe01")[0]
            elif data["place"] == "BQ":
                court = court_mapping[qpid][1]
                pre_url = "https://www.cjcf.com.tw/CG01.aspx?"
                replace_url = pre_url.split("CG01")[0]
            else:
                return makeJsonResponse(400, "place must be SC or BQ")
            result = {
                "QPid": qpid,
                "QTime": int(data["QTime"]),
                "date": data["date"],
                "place": data["place"],
                "session_id": data["session_id"],
            }
            if is_second_time:
                result["QTime"] += 1

            url, err = get_url(result, pre_url, replace_url)
            if err is not None and err != "預約失敗":
                return makeJsonResponse(400, err)
            elif err is None:
                arr_result.append({
                    "date": data["date"],
                    "court": court,
                    "QTime": int(result["QTime"]),
                    "url": url
                })
                ticket_number += 1
                if ticket_number == hours:
                    break
                is_second_time = True
                # 預約場地第二個時段
                result["QTime"] += 1
                url2, err2 = get_url(result, pre_url, replace_url)
                if err2 is None:
                    arr_result.append({
                        "date": data["date"],
                        "court": court,
                        "QTime": int(result["QTime"]),
                        "url": url2
                    })
                    break
                elif err2 != "預約失敗":
                    return makeJsonResponse(400, err2)

        return makeJsonResponse(200, "該時段已經沒有場地" if not arr_result else arr_result)
    except Exception as e:
        return makeJsonResponse(400, str(e))

def get_url(result, pre_url, replace_url):

    QPid = result["QPid"]
    QTime = result["QTime"]
    date = result["date"]
    session_id = result["session_id"]
    place = result["place"]

    url = f"{pre_url}module=net_booking&files=booking_place&StepFlag=25&QPid={QPid}&QTime={QTime}&PT=1&D={date}"
    # url = f"{pre_url}module=net_booking&files=booking_place&StepFlag=2&PT=1&D=2024/12/25&D2=2"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7",
        "Cache-Control": "max-age=0",
        "Cookie": f"ASP.NET_SessionId={session_id}"
    }
    response = requests.get(url, headers = headers)
    if response.status_code == 200:
        match = re.search(r"window\.location\.href='([^']*)'", response.text)
        if match:
            redirect_url = match.group(1)
            if "&X=1" in redirect_url:
                if place == "SC":
                    redirect_url = redirect_url.replace("../../../", replace_url)
                else:
                    redirect_url = redirect_url.replace("../../../", replace_url)
                print(redirect_url)
                return redirect_url, None
            elif "&X=2":
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