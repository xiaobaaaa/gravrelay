# Installing GravRelay with an agent

These steps are for an agent that the user has asked to install GravRelay on their Mac.

1. Confirm the Mac has Google Antigravity, Node.js 22 or newer, and Python 3.9 or newer.
2. Download the [release ZIP](https://github.com/xiaobaaaa/gravrelay/releases/latest) and verify it against the release checksum. You can also clone the matching Git tag.
3. From the extracted or cloned directory, run `sh install.sh doctor` to verify the signed Antigravity build and local dependencies. Supported app versions are listed under `supportedAppVersions` in `runtime/compatibility.json`; keep the version and signature checks intact.
4. Run `sh install.sh` and repeat the doctor check. An update requires Antigravity to be closed so its current work is preserved.
5. In Antigravity, open **Settings → Connections**. Use the user's existing SSH alias, or ask for the hostname, username and port for **Add Manually**. The installed bridge starts with no preset hosts.
6. On the selected SSH host, inspect its remote login shell for the official agy CLI. If missing, install it from https://antigravity.google/cli/install.sh following Google's official instructions. Keep its SHA-512 package verification. Sign in with agy acp --login. Use the existing browser session when appropriate; hand off passwords, MFA, and required user confirmations.
Before upgrading an older installation, inspect the remote standalone profile and run tools/migrate_legacy.py in plan mode. Preserve its running tasks and data. Complete the documented migration before enabling the new CLI workspace.

7. The coding backend is the official CLI systemd user service. Ensure the host has its own working Google/proxy connection. Do not introduce a Mac reverse proxy dependency. Preserve any existing CLI jobs; if its already-running service needs the private connection configuration, arrange its one-time restart after those jobs finish.
8. Once the host connects, use **Projects → New SSH Project** to choose a remote folder. Keep the native Projects workflow and verify a real remote command. Do not silently replace or discard an older GravRelay profile or interrupt its running tasks.

Run the installer as the desktop user. Existing host settings, SSH configuration and workspace data stay separate from the release package. Use `sh install.sh uninstall` to disable the bridge.

Verify that a test task belongs to the official CLI service, then interrupt only the test SSH forward. Confirm that the remote service PID and task survive, the local entrance stays fixed, and the UI reconnects. A green connection indicator alone is not sufficient.
