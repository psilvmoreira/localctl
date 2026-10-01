FROM mcr.microsoft.com/dotnet/sdk:8.0

# openssh-server: Visual Studio and Rider don't support attaching to a raw TCP debug-adapter
# server the way VS Code does (via netcoredbg) - their remote debugging is SSH-based. This lets
# either IDE's native "Attach to Process > SSH" feature reach the process directly.
RUN apt-get update && apt-get install -y openssh-server \
    && mkdir /var/run/sshd \
    && echo 'root:localdev' | chpasswd \
    && sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#Port 22/Port 2222/' /etc/ssh/sshd_config

WORKDIR /app
COPY . .
RUN dotnet restore

EXPOSE 5000 2222
# dotnet watch: Tilt's live-sync only copies changed files into the container, it doesn't restart
# anything - `dotnet watch` picks up the change and, for most edits, patches the running process
# in place via .NET's built-in Hot Reload (no restart, so an attached debugger stays connected).
# Only changes Hot Reload can't apply in-place (new method signatures, new types) fall back to a
# full restart, same caveat every other language here has.
CMD service ssh start && dotnet watch run --urls http://0.0.0.0:5000 --non-interactive
