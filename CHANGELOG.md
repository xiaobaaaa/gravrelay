# Release notes

## 0.2.12

- Support the signed Antigravity 2.32.2 macOS app and its native SSH workspace panels.

## 0.2.11

- Fix the Projects sidebar when many SSH conversations are expanded. SSH and local projects share Antigravity's native scroll area; only the Projects heading stays pinned, so local projects remain reachable.
- Add SSH to Antigravity 2.32.1's Create Project dialog. Configure your own hosts under Settings → Connections, then choose a host and remote folder.
- Include the previously installed native terminal, built-in browser, and split-view adapters for Antigravity 2.32.1. Remote browser forwards reconnect independently of the CLI connection.
- Keep existing SSH hosts, projects, conversations, and remote CLI tasks during an add-on update.

Verified on macOS with signed Antigravity 2.32.1 and official Antigravity CLI 1.5.8 on Linux. Native-panel availability depends on the app version and remote capabilities. The sidebar fix was checked after an app restart with local projects visible below expanded SSH conversations; the remote CLI process remained running.

### Install or update

Download `gravrelay-v0.2.11.zip` from this release and verify it with `SHA256SUMS`. Extract it, quit Antigravity, and run:

```sh
sh install.sh
sh install.sh doctor
```

Open Antigravity again. Existing host and project settings are reused. New installations start with an empty host list. Antigravity, Node.js, Python, and the official remote CLI are installed separately; see the README for requirements and setup.
