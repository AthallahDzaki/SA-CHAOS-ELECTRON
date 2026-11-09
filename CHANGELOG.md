# Changelog - SA-CHAOS Desktop

All notable changes and release notes for **SA-CHAOS Desktop** are documented in this file.

---

## [1.0.61] - 2026-10-07

### Added
- **New Vote Config Page (`/vote-config`)**:
  - Dedicated desktop UI page to configure and monitor TikTok Live Voting.
  - Real-time live vote monitor with countdown timers, vote percentage bars, and quick test controls (*Start Voting Now* & *Reset Vote Round*).
  - OBS Browser Source overlay integration (`http://localhost:9001/overlay/vote` or official HTTPS URLs), configurable display styles (*Bars* or *Cards*), cooldown auto-hide, chime/fanfare audio effects, and scaling.
- **Configurable Gift Vote Points (+X Points)**:
  - **Quick Preset Slots 1, 2, 3**: Map gifts directly to Option #1 (Rose), Option #2 (Coffee), and Option #3 (GG) with custom bonus (+X) points.
  - **Custom Gift Point Rules Table**: Add point rules for any TikTok gift (Whale, Lion, Doughnut, etc.) with targeted options:
    - *Option #1*, *Option #2*, or *Option #3*.
    - *Follow Viewer's Chat Vote (User's Pick)*: Gift automatically boosts the option previously chosen by the viewer in chat.
    - *Distribute to All Options*.
  - Streak Combo Multiplier: Option to multiply points by the gift streak/count.
  - Basic vote settings: Vote On/Off toggle, vote duration & cooldown (seconds), chat vote points (#1, #2, #3), and repeat gift allowance.
- **Debug Menu (In-Game Effect Debugger)**:
  - New `/debug-menu` page to execute any Chaos Mod effect directly into GTA San Andreas.
  - Custom duration slider, randomizer trigger, and 6 one-click preset buttons (*Fly Away*, *Explosions*, *Rainbow Car*, *Super Speed*, *Low Gravity*, *Mega Punch*).
  - Live execution history log.
  - Positioned at the **very bottom** of the sidebar menu.
- **Tutorial Page Updates**:
  - Comprehensive guide updates for new features: Spinning Wheel, Game Mod AutoUpdater, TikTok Live Voting & Gift Points (+X Pts), Gift Combo Streaks, IndoFinity Gateway, and Debug Menu.

### Fixed
- **Safe Legacy Mod Cleanup in AutoUpdater**:
  - Automatic removal of obsolete `Chaos-DE.js` in GTA SA Definitive Edition game folder during update/install.
  - Strict preservation of active `Chaos-DE[mem].js` to prevent accidental deletion or overwrite.
- **Vote Round Reset Bug**:
  - Fixed voter ID reset (`votePickerUID` & `votePickerExclusiveUID`) at the end of each round so viewers can participate in subsequent rounds without lockouts.

---

## [1.0.59] - 2026-09-24

### Added
- **Discord Rich Presence (Classic & Definitive Edition)**:
  - Discord Rich Presence integration on SA-Chaos Classic (`TrilogyChaosMod.SA.asi`) and Definitive Edition (`CleoWebSocket64.cleo`).
  - Playtime elapsed tracking and mod artwork.
  - Dynamic **"Live Now!"** button linking directly to the streamer's TikTok profile.
  - **"Want to Buy?"** button directing to the official mod website.
- **TOS & Revenue Tracking Info Updates**:
  - First-time installation detection displaying an interactive modal for Terms of Service (TOS) and TikTok Diamond/Coin revenue tracking transparency, with a quick-access "TOS & Revenue" button on the Dashboard.
- **Spinning Wheel Platform Selector & Custom Labels**:
  - Support for OBS Studio vs TikTok LIVE Studio platform selection with setup guides and custom label naming for individual wheel effect slices.

### Improved
- **System Stability Improvements**:
  - Improved background communication reliability and game client synchronization optimizations.

---

## [1.0.56] - 2026-09-08

### Added
- **Native Mod Hash Checker**:
  - Direct integrity and version verification of game mod files (Classic / DE) in Electron using SHA-256 and MD5 hashing.
- **Auto Sync & Safe Extraction**:
  - Dashboard Auto Updater now updates game mod files natively via Electron while preserving existing audio and token files.

### Fixed
- **AutoUpdater JSON Redirection Error**:
  - Migrated all updater communication endpoints to HTTPS to eliminate Cloudflare 301 HTML redirect parsing errors.

---

## [1.0.52] - 2026-09-07

### Added
- **Modern Spinning Wheel OBS Overlay**:
  - Transparent Browser Source overlay (`/overlay/spinwheel`) with smooth canvas animation, Web Audio SFX (ticking & fanfare), confetti particles, and real-time winner announcement.
- **Multi-Trigger Wheel of Fortune**:
  - Wheel can be spun via TikTok Gifts (Spinning Wheel effect), chat commands (`!spin`, `!putar`, `!dospin`), Saweria donations, or manual Test Spin button in the app.
- **Live Canvas Preview & Wheel Management**:
  - Interactive preview canvas in Spinwheel Config, spin duration & audio controls, auto-hide mode, per-row table delete, and OBS link generator.
- **Per-Gift Custom Duration**:
  - Configure individual duration for each TikTok gift in Gift Config, with automatic fallback to global duration.
- **Combo Delay Setting**:
  - Adjustable delay interval (Chain Delay ms) between combo chain effects in General Settings.
- **Full Internationalization (i18n) Support**:
  - Complete Indonesian & English localization for Spinwheel Config, slice tables, and overlay winner announcements.
