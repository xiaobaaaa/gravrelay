# GravRelay

GravRelay adds SSH workspaces to the existing Antigravity Projects sidebar on macOS. Select a remote folder, then use its projects and conversations from the same app window. Enabled hosts connect automatically when the app starts and retry after a disconnection.

This release works with the signed Google Antigravity **2.29.0** app and the official **Antigravity CLI 1.5.3** on Linux. It uses Antigravity's local development interface, so it is a version-specific add-on outside the official plugin system.

Upgrading from 0.1.x: finish the old backend's tasks and follow [the migration steps](#migrate-an-older-gravrelay-workspace) before switching to the CLI profile. The original data is preserved.

## Install

You need Antigravity 2.29.0, Node.js 22 or newer, and Python 3.9 or newer on your Mac. The remote host needs Linux with systemd user services, Bash, Python 3, OpenSSH with local forwarding, OpenSSL, and the official Antigravity CLI. WSL with systemd is supported.

Download and extract the [release ZIP](https://github.com/xiaobaaaa/gravrelay/releases/latest), then run this from the extracted folder in Terminal.

```sh
sh install.sh
```

You can also install directly from the release tag.

```sh
git clone --branch v0.2.3 --depth 1 https://github.com/xiaobaaaa/gravrelay.git
cd gravrelay
sh install.sh
```

Open Antigravity and go to **Settings → Connections → Add**. Choose an alias from your own SSH config or enter a name, hostname, username and port with **Add Manually**. A new installation starts with an empty host list. The bridge uses noninteractive SSH authentication. Use Terminal to verify an unfamiliar host key before connecting.

Install and sign in to the official CLI on the SSH host first. Use Google's [CLI installation instructions](https://antigravity.google/docs/getting-started/) and run the following in the remote login shell:

```sh
agy acp --login
```

GravRelay configures a private local connection token and starts the official CLI background service when needed. An existing CLI service that predates this setup needs a one-time restart after its tasks finish. The app reports this instead of restarting active work.

Once the host is connected, choose **Projects → New SSH Project**. Select the host and folder in the folder picker. Saved projects and conversations load automatically after their host connects. The remote CLI uses its own signed-in account and settings.

The message box uses Antigravity's native permissions picker. It changes the SSH host's default preset, or the project's preset when that project has an override. Available options follow the remote host's sandbox support. GravRelay does not change the selected preset during installation, and does not enable experimental conversation-scoped overrides that the CLI backend rejects.

Hover over a project or conversation for its shortcuts and options. SSH projects support copying the project name, opening Project Settings, starting a conversation, and deleting the project. SSH conversations support renaming, pinning, marking read or unread, copying details, splitting, archiving, and deleting. Use the sidebar's **Display Options → Archived Only** to restore or permanently delete an archived conversation. Deleting a project removes its conversations on the SSH host and keeps the source folder.

SSH file panes show their source host and a Download action. GravRelay adapts the CLI's metadata-only file stat responses so the desktop viewer reads the actual content instead of displaying a blank file. Text, Markdown, code, images and other formats supported by Antigravity keep their native viewers. PDF files use the app's bundled PDF.js renderer, with one page rendered at a time, page navigation and zoom. Antigravity's native display-size limit remains in effect; downloads use the native file service. Formats without a viewer keep a download action. Downloads save a copy on the Mac; the remote source is unchanged.

The remote coding agent runs inside the official Antigravity CLI service. SSH carries authenticated RPC traffic to its loopback listener; the bridge verifies the service process, TLS key, and connection token. The Mac loads the original app's UI assets locally.

## Install with an AI agent

Copy this request into an AI coding agent running on your Mac.

> Install GravRelay from https://github.com/xiaobaaaa/gravrelay. Read AGENTS_INSTALL.md, check my Antigravity version, install the compatible release, and run the doctor check. Keep my existing SSH configuration and workspaces.

## Options

Run `sh install.sh doctor` to check the signed Antigravity build, local runtime versions and the LaunchAgent. Use `--app '/path/to/Antigravity.app'` or `--node '/path/to/node'` if your installation is outside the usual paths.

The remote CLI needs its own working connection to Google services. Its service can use a proxy already configured on the remote machine. A proxy forwarded from the Mac would stop working when the Mac disconnects, so the CLI connection does not create a reverse Mac proxy tunnel.

The CLI manages its own updates. The bridge reuses a running service on reconnect and does not restart active work to apply an update.

## Update or disable

Quit Antigravity and run `sh install.sh` from the new release to update the add-on. The installer updates its LaunchAgent and reuses your saved host and project settings. Check the supported app version before updating Antigravity.

Run `sh install.sh uninstall` with Antigravity closed to unload and remove the LaunchAgent. Saved host settings, project records and remote workspaces remain available for reinstalling. The user-local runtime files are under `~/Library/Application Support/Antigravity SSH Settings/releases`. The remote CLI daemon and its tasks continue independently of the Mac app and SSH transport.

## Where it runs

The LaunchAgent runs under your macOS account. The original Mac app renders the interface. Prompts, tools, file operations, authentication, and conversations belong to the official CLI on the SSH host. Its systemd user service keeps running if the Mac app closes or the SSH transport disconnects.

Each host has a fixed local RPC entrance. Reconnection replaces only its SSH forward, so the UI keeps its address. Sidebar metadata comes from the native UI's real-time subscription. Project and conversation operations use the same remote backend.

Conversations use the CLI's remote data directory, normally ~/.gemini/antigravity-cli. The Linux desktop app has a separate profile by default; this add-on does not merge that desktop profile automatically. When upgrading from the older standalone GravRelay backend, preserve its data and finish its running tasks before migrating conversations. A live task cannot be transferred into another agent process by copying its history.

This remains a version-specific add-on using the app's local development interface. The release contains source and an installer; Google supplies Antigravity and its CLI separately.


## Migrate an older GravRelay workspace

The migration helper runs on the SSH host. Its default mode only reports a plan:

```sh
python3 tools/migrate_legacy.py
```

After the old tasks finish, close the Mac app so its reconnect loop stays idle. Stop the old standalone backend and the CLI service, then run the helper with the apply flag and restart the official CLI service. It refuses to apply while either backend or another agy process is running. It preserves the source profile, backs up existing target files, checks copies and SQLite integrity, and handles committed SQLite WAL data. It copies conversation databases, annotations and artifacts; sign-in credentials are not copied.

## Automated checks and releases

CI runs syntax checks, JavaScript tests, Python tests, and release-package validation on Linux and macOS. It includes the minimum supported Node.js and Python versions and never installs Antigravity or starts remote services.

- **Actions > Release > Run workflow** builds the ZIP, `SHA256SUMS`, and `release-manifest.json` as downloadable Actions artifacts. Manual runs never publish a public release.
- Pushing a `vX.Y.Z` tag reruns CI, verifies the tag matches `install.py` and this README, builds the committed source, uploads and verifies the assets as a draft, then publishes it. Existing published assets are never overwritten.

To release a version, update `RELEASE` in `install.py` and the clone tag in this README, commit, wait for CI, and push the matching tag. No npm account or extra publishing secret is required.

To check the source package locally, commit tracked changes first, then run `python3 tools/build_release.py --output-dir dist`.

The package is the existing source installer. A bundled graphical installer and npm distribution can be added separately.
