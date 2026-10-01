FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000 9229
# nodemon (not plain `node`): Tilt's live_update `sync()` only copies changed files into the
# running container, it doesn't restart the process. Something inside the container has to watch
# for that and restart on its own - nodemon here, the language-appropriate equivalent elsewhere
# (uvicorn --reload for Python, air for Go, Spring DevTools for Java). See docs/debugging.md.
# -L/--legacy-watch: Tilt's sync writes files via tar extraction, which doesn't reliably fire the
# inotify events nodemon's default watcher relies on - polling does, at the cost of a short delay.
CMD ["npx", "nodemon", "-L", "--watch", "src", "--inspect=0.0.0.0:9229", "src/index.js"]
