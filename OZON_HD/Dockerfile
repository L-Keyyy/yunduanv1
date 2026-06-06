# 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
FROM node:20-alpine

WORKDIR /app

# 安装上货模块依赖
COPY package*.json ./
RUN npm ci --production 2>/dev/null || npm install --production

# 安装后端服务依赖
COPY server/package*.json ./server/
RUN cd server && (npm ci --production 2>/dev/null || npm install --production)

# 复制全部源码
COPY . .

EXPOSE 3000

CMD ["node", "server/index.js"]
