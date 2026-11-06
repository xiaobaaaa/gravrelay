# GravRelay

GravRelay adds SSH workspaces to the existing Antigravity Projects sidebar on macOS. Select a remote folder, then use its projects and conversations from the same app window. Enabled hosts connect automatically when the app starts and retry after a disconnection.

This release works with the signed Google Antigravity **2.29.0** app. It uses Antigravity's local development interface, so it is a version-specific add-on outside the official plugin system.

## Install

You need Antigravity 2.29.0, Node.js 22 or newer, and Python 3.9 or newer on your Mac. The remote host must run Linux x86-64, including WSL. It needs Bash, Python 3, OpenSSH with local forwarding, curl, OpenSSL, iproute2, coreutils and util-linux.

Download and extract the [release ZIP](https://github.com/xiaobaaaa/gravrelay/releases/latest), then run this from the extracted folder in Terminal.

```sh
sh install.sh
```

You can also install directly from the release tag.

```sh
git clone --branch v0.1.5 --depth 1 https://github.com/xiaobaaaa/gravrelay.git
cd gravrelay
sh install.sh
```

Open Antigravity and go to **Settings → Connections → Add**. Choose an alias from your own SSH config or enter a name, hostname, username and port with **Add Manually**. A new installation starts with an empty host list. The bridge uses noninteractive SSH authentication. Use Terminal to verify an unfamiliar host key before connecting.

Once the host is connected, choose **Projects → New SSH Project**. Select the host and folder in the folder picker. Saved projects and conversations load automatically after their host connects. Complete Google sign-in in your browser if the remote workspace asks for it.

Hover over a project or conversation for its shortcuts and options. SSH projects support copying the project name, opening Project Settings, starting a conversation, and deleting the project. SSH conversations support renaming, pinning, marking read or unread, copying details, splitting, archiving, and deleting. Use the sidebar's **Display Options → Archived Only** to restore or permanently delete an archived conversation. Deleting a project removes its conversations on the SSH host and keeps the source folder.

The Linux workspace is downloaded from Google's public build storage on first use. Its hash and the workspace connection's TLS fingerprint are checked against the release manifest.

## Install with an AI agent

Copy this request into an AI coding agent running on your Mac.

> Install GravRelay from https://github.com/xiaobaaaa/gravrelay. Read AGENTS_INSTALL.md, check my Antigravity version, install the compatible release, and run the doctor check. Keep my existing SSH configuration and workspaces.

## Options

Run `sh install.sh doctor` to check the signed Antigravity build, local runtime versions and the LaunchAgent. Use `--app '/path/to/Antigravity.app'` or `--node '/path/to/node'` if your installation is outside the usual paths.

The remote host needs access to Google services. If it needs to use an HTTP proxy already listening on your Mac, set its port explicitly.

```sh
sh install.sh --proxy-port 8080
```

This forwards the proxy through SSH to a loopback address on the remote host. Use `--proxy-port 0` to disable it again. Existing proxy settings on either computer are managed separately.

## Update or disable

Quit Antigravity and run `sh install.sh` from the new release to update the add-on. The installer updates its LaunchAgent and reuses your saved host and project settings. Check the supported app version before updating Antigravity.

Run `sh install.sh uninstall` with Antigravity closed to unload and remove the LaunchAgent. Saved host settings, project records and remote workspaces remain available for reinstalling. The user-local runtime files are under `~/Library/Application Support/Antigravity SSH Settings/releases`. Existing remote processes can finish independently of the sidebar integration.

## Where it runs

The LaunchAgent runs under your macOS account. The bridge attaches to the original app's verified loopback debugging port and keeps the native Projects sidebar in place. Workspace traffic uses SSH tunnels. The bridge keeps conversation summaries in memory and saves only host configuration and project records in its user-local settings folder.

The release contains the bridge source and installer. The original Antigravity app and the Linux workspace binary come from Google separately.
