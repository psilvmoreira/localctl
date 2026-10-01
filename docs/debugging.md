# Debugging

Set `"debug": { "enabled": true, "port": <port>, "type": "<node|python|go|java|dotnet>" }` in
`.local/config.json`. Tilt reads this and adds the port to its `port_forwards`, so the debug port
on the pod is reachable at `localhost:<port>` the moment `localctl app up` is running — no manual
`kubectl port-forward` needed.

Your Dockerfile's `CMD`/`ENTRYPOINT` is what actually starts the process in debug mode; `.local/
config.json` only controls what gets exposed and forwarded.

## Node.js

**Dockerfile**
```dockerfile
# nodemon, not plain `node`: Tilt's live-sync only copies changed files into the container, it
# doesn't restart the process. -L/--legacy-watch: sync writes via tar extraction, which doesn't
# reliably fire the inotify events nodemon's default watcher relies on - polling does.
CMD ["npx", "nodemon", "-L", "--watch", "src", "--inspect=0.0.0.0:9229", "src/index.js"]
```

**.local/config.json**
```json
"debug": { "enabled": true, "port": 9229, "type": "node" }
```

**VSCode `launch.json`**
```json
{
  "type": "node",
  "request": "attach",
  "name": "Attach to local-dev pod",
  "address": "localhost",
  "port": 9229,
  "localRoot": "${workspaceFolder}/src",
  "remoteRoot": "/app/src",
  "restart": true
}
```

## Python (debugpy)

**Dockerfile**
```dockerfile
# --reload: Tilt's live-sync only copies changed files into the container, it doesn't restart the
# process - uvicorn's --reload (via `watchfiles`) watches for that itself.
# WATCHFILES_FORCE_POLLING: sync writes files via tar extraction, which doesn't reliably fire the
# inotify events watchfiles relies on by default - polling does.
ENV WATCHFILES_FORCE_POLLING=true
CMD ["python", "-m", "debugpy", "--listen", "0.0.0.0:5678", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
```

**.local/config.json**
```json
"debug": { "enabled": true, "port": 5678, "type": "python" }
```

**VSCode `launch.json`**
```json
{
  "type": "debugpy",
  "request": "attach",
  "name": "Attach to local-dev pod",
  "connect": { "host": "localhost", "port": 5678 },
  "pathMappings": [{ "localRoot": "${workspaceFolder}/app", "remoteRoot": "/app/app" }]
}
```

Note `debugpy` pauses process startup only if you pass `--wait-for-client`; omit it if you don't
want the container to block until a debugger attaches.

## Go (delve)

**Dockerfile**
```dockerfile
RUN go install github.com/go-delve/delve/cmd/dlv@latest
CMD ["dlv", "exec", "./main", "--headless", "--listen=0.0.0.0:2345", "--api-version=2", "--accept-multiclient"]
```

**.local/config.json**
```json
"debug": { "enabled": true, "port": 2345, "type": "go" }
```

**VSCode `launch.json`**
```json
{
  "type": "go",
  "request": "attach",
  "mode": "remote",
  "name": "Attach to local-dev pod",
  "host": "127.0.0.1",
  "port": 2345
}
```

## Java (JDWP)

**Dockerfile**
```dockerfile
ENV JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
CMD ["java", "-jar", "app.jar"]
```

**.local/config.json**
```json
"debug": { "enabled": true, "port": 5005, "type": "java" }
```

**VSCode `launch.json`**
```json
{
  "type": "java",
  "request": "attach",
  "name": "Attach to local-dev pod",
  "hostName": "localhost",
  "port": 5005
}
```

## .NET

.NET's own debugger (`vsdbg`) isn't TCP-native the way the others above are — VS Code normally
drives it by running a command like `kubectl exec` as a subprocess and talking over stdio, and
neither Visual Studio's nor Rider's "Docker" attach dialog can see a process nested inside a k3s
pod (they only enumerate top-level containers on your local Docker daemon). Two different setups
depending on your IDE:

**VS Code**: use [netcoredbg](https://github.com/Samsung/netcoredbg) instead of vsdbg — it speaks
the same protocol but supports a plain TCP listen mode, fitting the same pattern as every language
above.

```dockerfile
RUN curl -sSL https://github.com/Samsung/netcoredbg/releases/latest/download/netcoredbg-linux-amd64.tar.gz \
    | tar -xz -C /opt
CMD ["/opt/netcoredbg/netcoredbg", "--server", "--interpreter=vscode", "--port=4711", \
     "--", "dotnet", "/out/YourApi.dll"]
```
```json
"debug": { "enabled": true, "port": 4711, "type": "dotnet" }
```
```json
{
  "name": "Attach to local-dev pod",
  "type": "coreclr",
  "request": "attach",
  "debugServer": 4711
}
```

**Visual Studio / Rider**: neither supports the `debugServer` TCP-attach trick above — their
remote debugging is SSH-based. Run an SSH server in the image instead (see
`examples/dotnet-api/Dockerfile` for the full, tested version):

```dockerfile
RUN apt-get update && apt-get install -y openssh-server \
    && mkdir /var/run/sshd \
    && echo 'root:localdev' | chpasswd \
    && sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#Port 22/Port 2222/' /etc/ssh/sshd_config
CMD service ssh start && dotnet watch run --urls http://0.0.0.0:5000 --non-interactive
```
```json
"debug": { "enabled": true, "port": 2222, "type": "dotnet" }
```

Then in either IDE: **Attach to Process → SSH**, host `localhost`, port `2222`, user `root`,
password `localdev`. Each IDE deploys its own debugger bridge over that connection itself.

**Hot Reload, not just live-sync**: `dotnet watch` uses .NET 6+'s built-in Hot Reload, which
patches most code changes into the *already-running* process — no restart, so an attached
debugger stays connected through the edit. Verified directly against `examples/dotnet-api`: after
changing an endpoint's logic, the pod's name and restart count were unchanged (`RESTARTS: 0`
throughout) and the container logged `dotnet watch 🔥 Hot reload of changes succeeded`, with the
new logic live within seconds. This is a genuine advantage over the restart-based model every
other language on this page uses — Hot Reload only falls back to a full restart for changes it
can't patch in place (new method signatures, new types), at which point the same reconnect caveat
as Node/Python applies.

**What's verified above**: the whole container-side setup (SSH server starts and is reachable
through Tilt's forwarded port with a real SSH banner exchange; Hot Reload confirmed with zero pod
restarts) was tested live against `examples/dotnet-api`. What's *not* verified: actually clicking
through Visual Studio's or Rider's own Attach-to-Process-via-SSH dialog to a live breakpoint — that
part is standard, documented IDE behavior, not something tested in this repo's own history.

## Logs

`localctl app logs <name> -f` tails a single app's logs. For cross-app/aggregated log search, enable
the cluster-wide logging addon (`localctl addons enable logging`) and browse
`https://grafana.local.test` — Loki is pre-wired as the default datasource.
