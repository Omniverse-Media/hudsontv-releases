# Releasing Harbor Desktop

Workflow: `.github/workflows/harbor-desktop-release.yml`. CI (`harbor-ci.yml`) runs daemon tests, desktop tests,
`npm audit` and a daemon Docker build on every push/PR touching `harbor/`.

## Build locally (no GitHub)
Installers must be built on the OS they target: a Mac builds the `.dmg`, Windows builds the `.exe`
(Linux cannot produce either; electron-builder needs macOS tooling or Wine).
```
cd harbor/desktop
npm ci
npm test
npm run dist:mac     # on a Mac  -> dist/Harbor-<ver>-mac-arm64.dmg and -x64.dmg
npm run dist:win     # on Windows -> dist/Harbor-<ver>-win-x64.exe
```
Unsigned unless you export `CSC_LINK` / `CSC_KEY_PASSWORD` (see Signing below). On a Mac without a Developer ID
certificate set `CSC_IDENTITY_AUTO_DISCOVERY=false` so it does not look for one.

## Build installers on GitHub
* **Try it:** GitHub > Actions > "Harbor Desktop installers" > Run workflow (on any branch). Download the
  `harbor-mac` / `harbor-windows` artifacts. Nothing is published.
* **Release:** bump `version` in `harbor/desktop/package.json`, commit, then
  `git tag harbor-v0.1.0 && git push origin harbor-v0.1.0`. The tag must match the version or the build fails.
  Installers plus `SHA256SUMS-*.txt` land on a **draft** release for you to review and publish.

Outputs: `Harbor-<ver>-mac-x64.dmg`, `Harbor-<ver>-mac-arm64.dmg` (+ zips), `Harbor-<ver>-win-x64.exe`.

## Unsigned builds (default)
* **macOS:** Gatekeeper blocks it. Install, then right-click the app > Open, or run
  `xattr -dr com.apple.quarantine /Applications/Harbor.app`.
* **Windows:** SmartScreen shows "Windows protected your PC". Click More info > Run anyway.

Fine for your own machines; sign before giving it to anyone else.

## Signing (optional; add as repository secrets)
| Secret | What |
|---|---|
| `MAC_CSC_LINK` | base64 of your Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization (Apple Developer Program, $99/yr) |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | base64 `.pfx` code-signing certificate |

With `MAC_CSC_LINK` set, macOS builds are signed with hardened runtime. For notarization, also add
`"mac": { "notarize": true }` to the `build` block in `package.json` once the Apple secrets exist.
