# sport_reserve

## 簡介

本專案目的為了能夠快速預訂新北市政府羽球場地，因此，只要登入新北市政府地區運動中心的會員後，透過該專案即能夠快速預約七天之內運動中心的羽球場地，目前僅提供**三重與蘆洲**。

## 技術棧

- **程式語言**：JavaScript、HTML、CSS、Python
- **後端框架**：Flask
- **版本控制**：Git

## 系統功能

- 預訂羽球場地
  - 顯示可預定之日期
  - 選擇場館、日期、時間與場地

## Chrome 擴充功能（建議）

不需要 Docker，直接使用瀏覽器在官網的登入狀態預約。

### 安裝

1. 下載本專案（Clone 或下載 ZIP 後解壓縮）
2. Chrome 網址列輸入 `chrome://extensions`（Edge 為 `edge://extensions`）
3. 開啟右上角「開發人員模式」
4. 點「載入未封裝項目」，選擇專案中的 `extension` 資料夾

### 使用

1. 點瀏覽器工具列的羽毛球圖示，開啟預約頁
2. 選擇場館，若顯示「未登入」，點「前往官網登入」並在官網完成登入
3. 回到預約頁（會自動重新確認登入），選擇日期、時段後按「立即預約」
4. 預約成功後點「前往訂單付款」完成付款

可預約範圍：三重為今天～7 天後，蘆洲為今天～6 天後。

## Docker 版本（舊）

### 1. 環境需求

- Docker
- Git

### 2. 安裝步驟

1. Clone 專案至本地端

   ```bash
   git clone https://github.com/kyle0903/sport_reserve.git
   cd sport_reserve

   ```

2. 建立專案 Docker 映像檔：

   ```docker
   docker build . -t="sport_reserve:dev" -f Dockerfile.dev
   ```

### 3. 伺服器啟動

- 執行專案 Docker Container ( 後端 API`http://localhost:8081`)：
  ```docker
  docker run -d -v [sport_reserve path]:/app -p 8081:8081 -e PYTHONUNBUFFERED=1 "sport_reserve:dev"
  ```
