# Qlik Migration Tool - Ready-to-Build Executables

## Get Your .exe and .dmg in 5 Minutes

This repository automatically builds clickable executables for Windows and macOS using GitHub Actions. **No coding required.**

---

## Step-by-Step Instructions

### 1. Create a GitHub Account (if you don't have one)
Go to https://github.com and sign up (free)

### 2. Create a New Repository
1. Click the **+** button in the top right → **New repository**
2. Name it `qlik-migration-tool`
3. Keep it **Public** (required for free GitHub Actions)
4. Click **Create repository**

### 3. Upload These Files
1. Click **"uploading an existing file"** link
2. Drag and drop ALL files from this ZIP (keep the folder structure!)
3. Click **Commit changes**

### 4. Wait for Build (2-3 minutes)
1. Click the **Actions** tab at the top
2. You'll see "Build Executables" running
3. Wait for green checkmarks ✓

### 5. Download Your Executables
1. Click on the completed workflow run
2. Scroll down to **Artifacts**
3. Download:
   - `QlikMigrationTool-Windows` → Contains the .exe
   - `QlikMigrationTool-macOS-Intel` → Contains .dmg for older Macs
   - `QlikMigrationTool-macOS-AppleSilicon` → Contains .dmg for M1/M2/M3 Macs

### 6. Distribute!
Share the .exe and .dmg files with your users. They just double-click to run!

---

## What Users Experience

1. **Double-click** the .exe or open the .dmg
2. A small terminal window opens (this is the server)
3. **Browser opens automatically** to the app
4. Log in with Qlik Cloud tenant URL and API key
5. Use the migration wizard
6. Close the terminal when done

---

## File Structure

```
qlik-migration-tool/
├── .github/
│   └── workflows/
│       └── build.yml      ← GitHub Actions build config
├── src/
│   └── app.js             ← The application
├── package.json           ← Dependencies
└── README.md              ← This file
```

---

## Re-Building After Changes

Any time you push changes to the repository, GitHub automatically rebuilds the executables. Just download the new artifacts!

---

## Troubleshooting

### "Actions" tab not visible
Make sure your repository is public, or upgrade to GitHub Pro for private repos.

### Build failed
Click on the failed run to see the error. Usually it's a syntax error in the code.

### macOS says "app is damaged"
Run this in Terminal: `xattr -cr /path/to/Qlik\ Migration\ Tool`

### Windows "protected your PC" warning
Click "More info" → "Run anyway"

---

## Questions?

The app runs entirely on the user's computer. No data is sent anywhere except to the user's own Qlik Cloud tenant.
