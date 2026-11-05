# Installing GravRelay with an agent

These steps are for an agent that the user has asked to install GravRelay on their Mac.

1. Confirm the Mac has Google Antigravity, Node.js 22 or newer, and Python 3.9 or newer.
2. Download the [release ZIP](https://github.com/xiaobaaaa/gravrelay/releases/latest) and verify it against the release checksum. You can also clone the matching Git tag.
3. From the extracted or cloned directory, run `sh install.sh doctor` to verify the signed Antigravity build and local dependencies. This release supports Antigravity 2.29.0.
4. Run `sh install.sh` and repeat the doctor check. An update requires Antigravity to be closed so its current work is preserved.
5. In Antigravity, open **Settings → Connections**. Use the user's existing SSH alias, or ask for the hostname, username and port for **Add Manually**. The installed bridge starts with no preset hosts.
6. Once the host connects, use **Projects → New SSH Project** to choose a remote folder. Google sign-in and SSH host-key verification require the user.

Run the installer as the desktop user. Existing host settings, SSH configuration and workspace data stay separate from the release package. Use `sh install.sh uninstall` to disable the bridge.
