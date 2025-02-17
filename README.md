# sport_reserve

## 簡介

本專案目的為了能夠快速預訂新北市政府羽球場地，因此，只要登入新北市政府地區運動中心的會員後，透過該專案即能夠快速預約七天之內運動中心的羽球場地，目前僅提供**三重與板橋**。

## 技術棧

- **程式語言**：JavaScript、HTML、CSS、Python
- **後端框架**：Flask
- **版本控制**：Git

## 系統功能

- 預訂羽球場地
  - 顯示可預定之日期
  - 選擇場館、日期、時間與場地

## 安裝與使用

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
