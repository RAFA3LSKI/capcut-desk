# CapCut Desk

Make AI videos (Seedance) with your own CapCut account and credits. Every clip keeps its "Ai" label.

1. Download the zip for your computer from [Releases](https://github.com/RAFA3LSKI/capcut-desk/releases/latest): `mac-arm64` (Apple Silicon: M1 or newer), `mac-x64` (Intel Mac), or `windows-x64` (untested).
2. Unzip. On Mac, drag **CapCut Desk** into Applications.
3. First open on Mac: double-click it, click Done on the warning, then System Settings > Privacy & Security > scroll down > **Open Anyway**. On Windows: More info > Run anyway.
4. Press **Connect CapCut** and approve in your own browser. Your password is never shared with anyone.
5. Type a prompt, check the price shown, press generate. Start with a 2-second 480p clip (2 credits) to try it.
6. Updates: when a new version exists, a bar at the top says so. Download it and replace the app; your account and clips stay.

Several accounts: Account > **Add account** signs in another CapCut account (use it when one runs out of credits). **Switch** picks which one makes new videos; **Remove** forgets only the sign-in. History and clips of every account stay, and you can filter by account. If a sign-in expires, press **Reconnect** on that account. AI assistants get a `switch_account` tool.

Developers: `app/` is the code (`node app/main.mjs`), `sh packaging/build.sh` builds the zips, `sh release.sh` tags and uploads a release (bump `app/version.mjs` first).
