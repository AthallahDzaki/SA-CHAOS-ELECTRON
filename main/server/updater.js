import { UpdateManager } from 'velopack';
import electronModule from 'electron';
const app = (electronModule && typeof electronModule === 'object' && electronModule.app)
    ? electronModule.app
    : { getVersion: () => '1.0.0' };
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { SelectGTASA } from './utils.js';
import { GeneralConfig, writeJson, APP_DATA_ROOT, OFFICIAL_USER_AGENT } from './shared.js';

if (!global.autoUpdaterSyncStatus) {
    global.autoUpdaterSyncStatus = {
        status: 'idle', // 'idle' | 'checking' | 'downloading' | 'success' | 'error' | 'up_to_date'
        percent: 0,
        message: '',
        error: null,
        updatedAt: Date.now()
    };
}

if (!global.desktopAppUpdateStatus) {
    global.desktopAppUpdateStatus = {
        status: 'idle', // 'idle' | 'checking' | 'available' | 'downloading' | 'up_to_date' | 'error'
        updateAvailable: false,
        currentVersion: typeof app !== 'undefined' && app.getVersion ? app.getVersion() : '1.0.0',
        latestVersion: null,
        percent: 0,
        detail: '',
        error: null,
        updatedAt: Date.now()
    };
}

export async function promptChangeGtaPath(reason = '') {
    console.log(`[AutoUpdater Sync] Token is invalid or missing (${reason}). Prompting user to change game directory...`);
    try {
        let newExecutablePath = await SelectGTASA();
        if (newExecutablePath && newExecutablePath !== 'empty') {
            let newGtaPath = newExecutablePath.replace(/\\(gta_sa\.exe|SanAndreas\.exe)$/i, '');
            if (fs.existsSync(newGtaPath)) {
                if (newExecutablePath.toLowerCase().endsWith('sanandreas.exe')) {
                    GeneralConfig.General.Product = 'SA-CHAOS-DE';
                } else {
                    GeneralConfig.General.Product = 'SA-CHAOS-CLASSIC';
                }
                GeneralConfig.General.GTA_PATH = newGtaPath;
                writeJson(path.join(APP_DATA_ROOT, 'config.json'), GeneralConfig);
                console.log(`[AutoUpdater Sync] Game directory successfully updated to: ${newGtaPath}`);
                
                // Retry sync with the newly selected directory
                return await checkAndSyncAutoUpdaterExe(newGtaPath, false);
            }
        }
    } catch (err) {
        console.error('[AutoUpdater Sync] Error selecting new GTA directory:', err.message);
    }
}

export async function checkAndSyncAutoUpdaterExe(gtaPath, allowPromptOnInvalid = true) {
    if (!gtaPath || gtaPath === 'empty' || !fs.existsSync(gtaPath)) {
        global.autoUpdaterSyncStatus = {
            status: 'error',
            percent: 0,
            message: 'Folder GTA SA tidak valid atau tidak ditemukan.',
            error: 'Folder GTA SA tidak valid atau tidak ditemukan.',
            updatedAt: Date.now()
        };
        if (allowPromptOnInvalid) {
            await promptChangeGtaPath('Folder GTA SA tidak valid atau tidak ditemukan');
        }
        return;
    }

    try {
        global.autoUpdaterSyncStatus = {
            status: 'checking',
            percent: 0,
            message: 'Memeriksa pembaruan AutoUpdater.exe...',
            error: null,
            updatedAt: Date.now()
        };

        const tokenFilePath = path.join(gtaPath, 'ChaosMod', 'token.txt');
        let userToken = '';
        if (fs.existsSync(tokenFilePath)) {
            userToken = fs.readFileSync(tokenFilePath, 'utf8').trim();
        }

        if (!userToken) {
            console.log('[AutoUpdater Sync] No token found in ChaosMod/token.txt');
            global.autoUpdaterSyncStatus = {
                status: 'error',
                percent: 0,
                message: 'Token tidak ditemukan di ChaosMod/token.txt',
                error: 'Token tidak ditemukan di ChaosMod/token.txt',
                updatedAt: Date.now()
            };
            if (allowPromptOnInvalid) {
                await promptChangeGtaPath('Token tidak ditemukan di ChaosMod/token.txt');
            }
            return;
        }

        const autoUpdaterExePath = path.join(gtaPath, 'AutoUpdater.exe');
        let localHash = '';
        let localMd5 = '';
        if (fs.existsSync(autoUpdaterExePath)) {
            const fileBuffer = fs.readFileSync(autoUpdaterExePath);
            localHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            localMd5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
        }

        let project = "CLASSIC";
        if (GeneralConfig?.General?.Product === "SA-CHAOS-DE") {
            project = "DE";
        }

        const apiUrl = `https://updater.sa-chaos.my.id/?type=autoupdater&token=${encodeURIComponent(userToken)}&project=${encodeURIComponent(project)}` + 
                       (localHash ? `&hash=${localHash}` : '') + 
                       (localMd5 ? `&md5=${localMd5}` : '');
        console.log('[AutoUpdater Sync] Checking AutoUpdater.exe status...');

        const response = await axios.get(apiUrl, {
            headers: {
                'User-Agent': OFFICIAL_USER_AGENT
            },
            timeout: 10000
        });

        const data = response.data;
        if (data && data.status === 'up_to_date') {
            console.log('[AutoUpdater Sync] AutoUpdater.exe is already up to date.');
            global.autoUpdaterSyncStatus = {
                status: 'up_to_date',
                percent: 100,
                message: 'AutoUpdater.exe sudah versi terbaru.',
                error: null,
                updatedAt: Date.now()
            };
            return;
        }

        if (data && data.status === 'success' && data.url) {
            const remoteHash = data.hash ? data.hash.toLowerCase() : '';
            if (localHash && remoteHash && localHash.toLowerCase() === remoteHash) {
                console.log('[AutoUpdater Sync] AutoUpdater.exe hash matches server.');
                global.autoUpdaterSyncStatus = {
                    status: 'up_to_date',
                    percent: 100,
                    message: 'AutoUpdater.exe sudah versi terbaru.',
                    error: null,
                    updatedAt: Date.now()
                };
                return;
            }

            console.log('[AutoUpdater Sync] Downloading latest AutoUpdater.exe from S3...');
            global.autoUpdaterSyncStatus = {
                status: 'downloading',
                percent: 0,
                message: 'Mengunduh AutoUpdater.exe...',
                error: null,
                updatedAt: Date.now()
            };

            const downloadRes = await axios.get(data.url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': OFFICIAL_USER_AGENT
                },
                onDownloadProgress: (progressEvent) => {
                    const total = progressEvent.total || (progressEvent.lengthComputable ? progressEvent.total : 0);
                    let percent = 0;
                    if (total > 0) {
                        percent = Math.min(99, Math.round((progressEvent.loaded * 100) / total));
                    } else if (progressEvent.loaded > 0) {
                        percent = Math.min(99, Math.round((progressEvent.loaded * 100) / 750000));
                    }
                    global.autoUpdaterSyncStatus = {
                        status: 'downloading',
                        percent,
                        message: `Mengunduh AutoUpdater.exe (${percent}%)...`,
                        error: null,
                        updatedAt: Date.now()
                    };
                }
            });

            fs.writeFileSync(autoUpdaterExePath, Buffer.from(downloadRes.data));
            console.log('[AutoUpdater Sync] Successfully updated AutoUpdater.exe in:', gtaPath);
            global.autoUpdaterSyncStatus = {
                status: 'success',
                percent: 100,
                message: 'AutoUpdater.exe berhasil diperbarui!',
                error: null,
                updatedAt: Date.now()
            };
        } else {
            const errorMsg = data && data.message ? data.message : 'Unknown response from server';
            console.warn('[AutoUpdater Sync] Server response:', errorMsg);
            global.autoUpdaterSyncStatus = {
                status: 'error',
                percent: 0,
                message: errorMsg,
                error: errorMsg,
                updatedAt: Date.now()
            };
            if (allowPromptOnInvalid && data && (data.status === 'error' || data.status === 403)) {
                await promptChangeGtaPath(`Server response: ${errorMsg}`);
            }
        }
    } catch (e) {
        console.error('[AutoUpdater Sync] Error syncing AutoUpdater.exe:', e.message);
        let errorMsg = e.message;
        if (e.code === 'EBUSY' || e.code === 'EPERM') {
            errorMsg = `File AutoUpdater.exe terkunci atau izin ditolak (${e.code}). Pastikan game/updater ditutup atau jalankan aplikasi sebagai Administrator.`;
        } else if (e.response && e.response.data && e.response.data.message) {
            errorMsg = e.response.data.message;
        }
        global.autoUpdaterSyncStatus = {
            status: 'error',
            percent: 0,
            message: errorMsg,
            error: errorMsg,
            updatedAt: Date.now()
        };
        if (allowPromptOnInvalid && e.response && (e.response.status === 403 || e.response.status === 400)) {
            await promptChangeGtaPath(`HTTP ${e.response.status}: Token Invalid or Expired`);
        }
    }
}

export function findChaosModTarget(gtaPath) {
    const targets = [
        { relPath: "TrilogyChaosMod.SA.asi", project: "CLASSIC" },
        { relPath: "ChaosMod.asi", project: "CLASSIC" },
        { relPath: path.join("scripts", "TrilogyChaosMod.SA.asi"), project: "CLASSIC" },
        { relPath: path.join("scripts", "ChaosMod.asi"), project: "CLASSIC" },
        { relPath: path.join("CLEO", "CLEO_PLUGINS", "CleoWebSocket64.cleo"), project: "DE" },
        { relPath: "CleoWebSocket64.cleo", project: "DE" },
        { relPath: path.join("CLEO", "Chaos-DE[mem].js"), project: "DE" }
    ];

    for (const target of targets) {
        const fullPath = path.join(gtaPath, target.relPath);
        if (fs.existsSync(fullPath)) {
            return { fullPath, relPath: target.relPath, project: target.project };
        }
    }

    let fallbackProject = "CLASSIC";
    if (GeneralConfig?.General?.Product === "SA-CHAOS-DE") {
        fallbackProject = "DE";
    }
    return { fullPath: "", relPath: "", project: fallbackProject };
}

export function removeLegacyModFiles(gtaPath, logger = console.log) {
    if (!gtaPath || !fs.existsSync(gtaPath)) return;
    const legacyTargets = [
        path.join(gtaPath, "CLEO", "Chaos-DE.js"),
        path.join(gtaPath, "Chaos-DE.js"),
        path.join(gtaPath, "scripts", "Chaos-DE.js")
    ];
    for (const targetPath of legacyTargets) {
        if (fs.existsSync(targetPath)) {
            const fileName = path.basename(targetPath);
            // Pastikan BUKAN Chaos-DE[mem].js
            if (fileName.toLowerCase() === "chaos-de[mem].js") continue;
            if (fileName.toLowerCase() === "chaos-de.js") {
                try {
                    fs.unlinkSync(targetPath);
                    logger(`[Mod Sync] Legacy mod Chaos-DE.js berhasil dihapus: ${targetPath}`);
                } catch (e) {
                    logger(`[Mod Sync] Gagal menghapus legacy mod Chaos-DE.js: ${e.message}`);
                }
            }
        }
    }
}

export async function checkAndSyncModFiles(gtaPath, logger = console.log) {
    if (!gtaPath || gtaPath === 'empty' || !fs.existsSync(gtaPath)) {
        logger('[Mod Sync] Folder GTA SA tidak valid atau tidak ditemukan.');
        return { status: 'error', message: 'Folder GTA SA tidak valid atau tidak ditemukan.' };
    }

    try {
        const tokenFilePath = path.join(gtaPath, 'ChaosMod', 'token.txt');
        let userToken = '';
        if (fs.existsSync(tokenFilePath)) {
            userToken = fs.readFileSync(tokenFilePath, 'utf8').trim();
        }

        if (!userToken) {
            logger('[Mod Sync] Token tidak ditemukan di ChaosMod/token.txt');
            return { status: 'error', message: 'Token tidak ditemukan di ChaosMod/token.txt' };
        }

        // Hapus legacy mod jika ada (Chaos-DE.js, bukan Chaos-DE[mem].js)
        removeLegacyModFiles(gtaPath, logger);

        const modTarget = findChaosModTarget(gtaPath);
        let localHash = '';
        let localMd5 = '';
        if (modTarget.fullPath && fs.existsSync(modTarget.fullPath)) {
            const fileBuffer = fs.readFileSync(modTarget.fullPath);
            localHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            localMd5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
            logger(`[Mod Sync] Mod terdeteksi (${modTarget.project}): ${modTarget.relPath}`);
            logger(`[Mod Sync] Hash lokal (SHA-256): ${localHash}`);
        } else {
            logger(`[Mod Sync] Mod belum terpasang. Menyiapkan instalasi baru untuk ${modTarget.project}...`);
        }

        const apiUrl = `https://updater.sa-chaos.my.id/?type=mod&token=${encodeURIComponent(userToken)}&project=${encodeURIComponent(modTarget.project)}` +
                       (localHash ? `&hash=${localHash}` : '') +
                       (localMd5 ? `&md5=${localMd5}` : '');

        logger('[Mod Sync] Memeriksa status mod ke server...');
        const response = await axios.get(apiUrl, {
            headers: {
                'User-Agent': OFFICIAL_USER_AGENT
            },
            timeout: 15000
        });

        const data = response.data;
        if (data && data.status === 'up_to_date') {
            logger(`[Mod Sync] File mod (${modTarget.project}) sudah versi terbaru (Hash cocok).`);
            return { status: 'up_to_date', hash: data.hash || localHash, message: 'Mod sudah versi terbaru' };
        }

        if (data && data.status === 'success' && data.url) {
            const remoteHash = data.hash ? data.hash.toLowerCase() : '';
            if (localHash && remoteHash && localHash.toLowerCase() === remoteHash) {
                logger(`[Mod Sync] Hash cocok dengan server (${remoteHash}). Mod sudah versi terbaru.`);
                return { status: 'up_to_date', hash: remoteHash, message: 'Mod sudah versi terbaru' };
            }

            logger(`[Mod Sync] Mengunduh pembaruan mod (${data.file || 'latest.zip'})...`);
            const downloadRes = await axios.get(data.url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': OFFICIAL_USER_AGENT
                }
            });

            logger('[Mod Sync] Mengekstrak file pembaruan ke folder game...');
            const zip = new AdmZip(Buffer.from(downloadRes.data));
            const zipEntries = zip.getEntries();
            let extractedCount = 0;
            let skippedAudioCount = 0;

            for (const entry of zipEntries) {
                if (entry.isDirectory) continue;
                const entryName = entry.entryName;

                // Skip token.txt agar token milik user tidak tertimpa
                const baseName = path.basename(entryName);
                if (baseName.toLowerCase() === 'token.txt') {
                    continue;
                }

                // Skip legacy mod Chaos-DE.js jika masih ada di arsip zip (jangan skip Chaos-DE[mem].js)
                if (baseName.toLowerCase() === 'chaos-de.js' && baseName.toLowerCase() !== 'chaos-de[mem].js') {
                    logger(`[Mod Sync] Skipping legacy mod in zip: ${entryName}`);
                    continue;
                }

                // Skip audio jika sudah ada
                const normalizedEntry = entryName.replace(/\\/g, '/');
                if (normalizedEntry.toLowerCase().includes('chaosmod/audio/')) {
                    const targetAudioPath = path.join(gtaPath, normalizedEntry);
                    if (fs.existsSync(targetAudioPath)) {
                        skippedAudioCount++;
                        continue;
                    }
                }

                const targetFilePath = path.join(gtaPath, entryName);
                const targetDir = path.dirname(targetFilePath);
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }

                fs.writeFileSync(targetFilePath, entry.getData());
                extractedCount++;
            }

            // Pastikan legacy mod bersih setelah ekstrak update
            removeLegacyModFiles(gtaPath, logger);

            logger(`[Mod Sync] Update mod selesai! (${extractedCount} file diekstrak, ${skippedAudioCount} audio dipertahankan).`);
            return {
                status: 'success',
                extractedCount,
                skippedAudioCount,
                hash: remoteHash,
                message: 'Update mod berhasil dipasang'
            };
        } else {
            const errorMsg = data && data.message ? data.message : 'Unknown response from server';
            logger(`[Mod Sync] Respon server: ${errorMsg}`);
            return { status: 'error', message: errorMsg };
        }
    } catch (err) {
        logger(`[Mod Sync] Gagal sinkronisasi mod: ${err.message}`);
        return { status: 'error', message: err.message };
    }
}

export const UPDATE_CHANNELS = Object.freeze({
    RELEASE: "release",
    BETA: "beta",
});

export function resolveUpdateChannel(config = GeneralConfig) {
    const raw = String(config?.General?.UpdateChannel || "release").trim().toLowerCase();
    return raw === "beta" ? UPDATE_CHANNELS.BETA : UPDATE_CHANNELS.RELEASE;
}

export function getVelopackChannelName(channel) {
    return channel === UPDATE_CHANNELS.BETA ? "beta" : "win";
}

export async function runVelopackUpdater(serverVersion, productCode, onProgress, onComplete) {
    try {
        const selectedChannel = resolveUpdateChannel(GeneralConfig);
        const velopackChannel = getVelopackChannelName(selectedChannel);
        const isBeta = selectedChannel === UPDATE_CHANNELS.BETA;
        const channelLabel = isBeta ? "Beta (Fitur Lebih Awal)" : "Release (Stable)";

        // Jika pengguna secara sadar mengaktifkan P2P Updater (Alpha), gunakan HybridUpdateOrchestrator
        // dengan fallback otomatis ke S3. Jika P2P OFF (default), jalankan 100% kode S3 existing di bawah.
        try {
            const { readPersistedP2PSettings, getGlobalP2POrchestrator } = await import("./p2p/index.js");
            const p2pSettings = readPersistedP2PSettings();
            if (p2pSettings && p2pSettings.p2pUpdaterEnabled === true) {
                p2pSettings.channel = velopackChannel;
                console.log(`[Updater] P2P Alpha enabled by user (Channel: ${channelLabel}). Delegating to HybridUpdateOrchestrator...`);
                const orchestrator = getGlobalP2POrchestrator();
                await orchestrator.updateConfig(p2pSettings);
                const result = await orchestrator.checkForUpdatesAndInstall({
                    onProgress: (prog) => {
                        if (!onProgress) return;
                        const totalMB = prog.totalBytes > 0
                            ? `${(prog.totalBytes / (1024 * 1024)).toFixed(1)} MB`
                            : null;
                        const downloadedMB = prog.transferredBytes > 0
                            ? `${(prog.transferredBytes / (1024 * 1024)).toFixed(1)} MB`
                            : "0.0 MB";
                        const speedStr = prog.speedBps > 0
                            ? ` • ${(prog.speedBps / (1024 * 1024)).toFixed(2)} MB/s`
                            : "";
                        onProgress({
                            status: prog.status || `Checking for updates (S3 - ${channelLabel})`,
                            detail: totalMB
                                ? `${downloadedMB} / ${totalMB} (${prog.percent || 0}%)${speedStr}`
                                : `${prog.percent || 0}%`,
                            percent: prog.percent || 0,
                            totalMB,
                            downloadedMB,
                            sourceCategory: prog.sourceCategory || "S3 (Standard)",
                            isDelta: false,
                            updateTypeLabel: prog.sourceCategory || "Update",
                            channel: selectedChannel,
                        });
                    },
                    onComplete: () => {
                        if (onComplete) setTimeout(() => onComplete(false), 800);
                    }
                });
                if (result && (result.updated || result.reason === "UP_TO_DATE" || result.reason === "NOT_INSTALLED")) {
                    return;
                }
                console.warn("[Updater] Hybrid orchestrator did not complete update; falling back to legacy S3 updater path.");
            }
        } catch (p2pSubsystemErr) {
            console.warn("[Updater] P2P Alpha subsystem error, seamlessly continuing with standard S3 updater:", p2pSubsystemErr.message);
        }

        // Menggunakan perantara PHP untuk men-generate S3 Pre-signed URL yang di-private
        const updateUrl = `https://updater.sa-chaos.my.id/velopack.php/`;
        console.log(`[Updater] Checking for updates on channel: ${channelLabel} [${velopackChannel}]...`);
        if (onProgress) onProgress({ status: `Checking for updates (${channelLabel})...` });
        
        try {
            const um = new UpdateManager();
            um.setUrlOrPath(updateUrl);
            um.setExplicitChannel(velopackChannel);
            um.setAllowDowngrade(true);
            const updateInfo = await um.checkForUpdatesAsync();
            
            if (updateInfo) {
                const targetRelease = updateInfo.targetFullRelease || updateInfo.TargetFullRelease || updateInfo;
                const newVersion = targetRelease.version || targetRelease.Version || "latest";

                // Check remote releases.<channel>.json to determine if a delta package is available for display info
                let isDelta = false;
                let displayBytes = Number(targetRelease.size || 0);
                let matchedDelta = null;

                try {
                    const currentVersion = typeof app !== 'undefined' && app.getVersion ? String(app.getVersion()).replace(/^v/i, '') : '';
                    let releasesRes;
                    try {
                        releasesRes = await axios.get(`${updateUrl}releases.${velopackChannel}.json`, {
                            headers: {
                                'User-Agent': OFFICIAL_USER_AGENT
                            },
                            timeout: 8000
                        });
                    } catch (feedErr) {
                        console.warn(`[Updater] Could not query remote releases.${velopackChannel}.json:`, feedErr.message);
                        if (velopackChannel !== "win") {
                            try {
                                releasesRes = await axios.get(`${updateUrl}releases.win.json`, {
                                    headers: { 'User-Agent': OFFICIAL_USER_AGENT },
                                    timeout: 8000
                                });
                            } catch {}
                        }
                    }
                    const remoteAssets = releasesRes?.data?.Assets || [];
                    
                    // Membaca releases.win.json langsung dari urutan paling terbaru (atas) ke bawah
                    const fullAssets = remoteAssets.filter((a) => String(a.Type).toLowerCase() === "full");
                    const deltaAssets = remoteAssets.filter((a) => String(a.Type).toLowerCase() === "delta");

                    const clean = (v) => String(v || '').replace(/^v/i, '').trim();
                    const targetFull = fullAssets[0];
                    const prev1Full = fullAssets[1]; // Versi basis x-1
                    const prev2Full = fullAssets[2]; // Versi basis x-2

                    // Delta Update dibatasi maksimal dalam jendela 3 versi teratas dari feed (x, x-1, x-2):
                    // - Klien di x-1: butuh 1 delta (delta target x)
                    // - Klien di x-2: butuh 2 delta berantai (delta x-1 + delta x)
                    // - Klien di x-3 atau lebih lama: di luar batas 3 versi, WAJIB Full Update
                    if (currentVersion && targetFull && clean(newVersion) === clean(targetFull.Version)) {
                        const deltaTarget = deltaAssets.find((d) => clean(d.Version) === clean(targetFull.Version));
                        const deltaPrev1 = prev1Full ? deltaAssets.find((d) => clean(d.Version) === clean(prev1Full.Version)) : null;

                        if (prev1Full && clean(currentVersion) === clean(prev1Full.Version) && deltaTarget?.Size) {
                            // Kasus x-1: 1 tahap delta
                            displayBytes = Number(deltaTarget.Size);
                            isDelta = true;
                            console.log(`[Updater] Terdeteksi basis x-1 (v${prev1Full.Version}). Menggunakan delta 1 tahap: ${deltaTarget.FileName} (${(displayBytes / 1024).toFixed(0)} KB)`);
                        } else if (prev2Full && clean(currentVersion) === clean(prev2Full.Version) && deltaTarget?.Size && deltaPrev1?.Size) {
                            // Kasus x-2: 2 tahap delta berantai
                            displayBytes = Number(deltaTarget.Size) + Number(deltaPrev1.Size);
                            isDelta = true;
                            console.log(`[Updater] Terdeteksi basis x-2 (v${prev2Full.Version}). Menggunakan 2 delta berantai: ${deltaPrev1.FileName} + ${deltaTarget.FileName} (${(displayBytes / 1024).toFixed(0)} KB)`);
                        } else {
                            console.log(`[Updater] Client v${currentVersion} berada di luar jendela 3 versi teratas (x: v${targetFull.Version}, x-1: v${prev1Full?.Version || 'none'}, x-2: v${prev2Full?.Version || 'none'}). Mengunduh Full Release.`);
                        }
                    }
                } catch (e) {
                    console.warn(`[Updater] Could not query remote delta size:`, e.message);
                }

                const isLessThanOneMB = displayBytes > 0 && displayBytes < 1024 * 1024;
                const totalDisplay = displayBytes > 0 
                    ? (isLessThanOneMB ? `${(displayBytes / 1024).toFixed(0)} KB` : `${(displayBytes / (1024 * 1024)).toFixed(1)} MB`)
                    : null;
                const updateTypeLabel = isDelta ? "Delta Update" : "Update";

                console.log(`[Updater] New version found: v${newVersion} (${updateTypeLabel} - ${totalDisplay || 'Calculating'}). Downloading...`);
                if (onProgress) {
                    onProgress({
                        status: `Downloading ${updateTypeLabel.toLowerCase()} v${newVersion}...`,
                        detail: totalDisplay ? `Preparing download (${totalDisplay})...` : "Preparing download...",
                        percent: 0,
                        totalMB: totalDisplay,
                        downloadedMB: isLessThanOneMB ? "0 KB" : "0.0 MB",
                        isDelta,
                        updateTypeLabel
                    });
                }
                
                await um.downloadUpdatesAsync(targetRelease, (progress) => {
                    let downloadedDisplay;
                    if (displayBytes > 0) {
                        const bytesDownloaded = displayBytes * (progress / 100);
                        downloadedDisplay = isLessThanOneMB
                            ? `${(bytesDownloaded / 1024).toFixed(0)} KB`
                            : `${(bytesDownloaded / (1024 * 1024)).toFixed(1)} MB`;
                    }

                    let currentStatus = `Downloading update v${newVersion}...`;
                    let currentDetail = totalDisplay ? `${downloadedDisplay || 0} / ${totalDisplay} (${progress}%)` : `${progress}%`;

                    if (isDelta) {
                        if (progress < 25) {
                            currentStatus = `Downloading delta package v${newVersion}...`;
                            currentDetail = totalDisplay ? `${downloadedDisplay || "0 KB"} / ${totalDisplay} (Downloading)` : `Downloading...`;
                        } else if (progress < 95) {
                            currentStatus = `Extracting & applying binary patch v${newVersion}...`;
                            currentDetail = `Patching application files (${progress}%)`;
                        } else {
                            currentStatus = `Verifying update integrity...`;
                            currentDetail = `Finalizing patch (${progress}%)`;
                        }
                    }

                    console.log(`[Updater] ${currentStatus} ${progress}% (${currentDetail})`);
                    if (onProgress) {
                        onProgress({
                            status: currentStatus,
                            detail: currentDetail,
                            percent: progress,
                            totalMB: totalDisplay,
                            downloadedMB: downloadedDisplay,
                            isDelta,
                            updateTypeLabel
                        });
                    }
                });
                
                console.log(`[Updater] Update downloaded. Applying updates and restarting...`);
                if (onProgress) {
                    onProgress({
                        status: "Applying update & restarting...",
                        detail: "Download complete. Restarting application...",
                        percent: 100
                    });
                }
                
                // Allow UI to render the completion state before invoking updater restart
                setTimeout(() => {
                    try {
                        um.applyUpdatesAndRestart(targetRelease);
                    } catch (e) {
                        console.error("[Updater] applyUpdatesAndRestart error:", e);
                        app.quit();
                        setTimeout(() => process.exit(0), 1000);
                    }
                }, 1000);
            } else {
                console.log(`[Updater] App is up to date.`);
                if (onProgress) onProgress({ status: "App is up to date.", percent: 100 });
                if (onComplete) setTimeout(() => onComplete(false), 800); // false = no update applied
            }
        } catch (updateErr) {
            console.error("[Updater] Velopack update failed:", updateErr.message);
            console.log("[Updater] Mengaktifkan Fallback Updater (Metode Cadangan Kedua)...");
            
            const fallbackHandled = await runFallbackUpdater({
                updateUrl,
                onProgress,
                onComplete,
                channel: velopackChannel
            });

            if (!fallbackHandled && onComplete) {
                setTimeout(() => onComplete(false), 800);
            }
        }
    } catch (e) {
        console.error("[Updater] Error during auto-update check:", e.message);
        if (onComplete) setTimeout(() => onComplete(false), 800);
    }
}

// ====================================================================================================
// [CRITICAL CODE NOTICE - DO NOT MODIFY]
// STRICT INSTRUCTION FOR ALL AI ASSISTANTS AND DEVELOPERS:
// DILARANG KERAS MENGUBAH, MENGHAPUS, MERENAME, ATAU MEREFACTOR KODE METODE CADANGAN DI BAWAH INI!
// (THIS BACKUP / SECOND-WAY UPDATER METHOD IS PROTECTED BY USER DIRECTIVE. DO NOT MODIFY!)
// Fungsi di bawah ini adalah JARING PENGAMAN RESMI (FAILSAFE BACKUP UPDATER) jika Velopack mengalami
// error atau kegagalan kapan pun. Modifikasi terhadap fungsi ini dapat merusak mekanisme pemulihan.
// ====================================================================================================

function compareSemver(v1, v2) {
    if (!v1 || !v2) return 0;
    const clean = (v) => String(v).replace(/^v/i, '').trim();
    const p1 = clean(v1).split('.').map((n) => parseInt(n, 10) || 0);
    const p2 = clean(v2).split('.').map((n) => parseInt(n, 10) || 0);
    const maxLen = Math.max(p1.length, p2.length);
    for (let i = 0; i < maxLen; i++) {
        const num1 = p1[i] || 0;
        const num2 = p2[i] || 0;
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }
    return 0;
}

export async function runFallbackUpdater({ updateUrl, onProgress, onComplete, channel = "win" } = {}) {
    console.log("[Backup Updater] Menjalankan metode pembaruan cadangan kedua (Second-Way Updater)...");
    try {
        if (onProgress) {
            onProgress({
                status: "Velopack error: Beralih ke Backup Updater...",
                detail: "Memeriksa paket rilis cadangan di server...",
                percent: 0,
                isDelta: false,
                updateTypeLabel: "Backup Updater"
            });
        }

        const selectedChannel = channel ? (channel === "beta" ? "beta" : "win") : getVelopackChannelName(resolveUpdateChannel(GeneralConfig));
        let releasesRes;
        try {
            releasesRes = await axios.get(`${updateUrl}releases.${selectedChannel}.json`, {
                headers: { 'User-Agent': OFFICIAL_USER_AGENT },
                timeout: 10000
            });
        } catch (feedErr) {
            if (selectedChannel !== "win") {
                console.warn(`[Backup Updater] releases.${selectedChannel}.json tidak ditemukan, beralih ke releases.win.json:`, feedErr.message);
                releasesRes = await axios.get(`${updateUrl}releases.win.json`, {
                    headers: { 'User-Agent': OFFICIAL_USER_AGENT },
                    timeout: 10000
                });
            } else {
                throw feedErr;
            }
        }

        const assets = releasesRes.data?.Assets || [];
        // Membaca releases.win.json langsung dari urutan paling terbaru (atas) ke bawah
        const fullAssets = assets.filter((a) => String(a.Type).toLowerCase() === "full");
        const deltaAssets = assets.filter((a) => String(a.Type).toLowerCase() === "delta");

        const targetFull = fullAssets[0];
        if (!targetFull) {
            console.warn(`[Backup Updater] Tidak ditemukan aset Full pada releases.${selectedChannel}.json / releases.win.json.`);
            return false;
        }

        const remoteVersion = targetFull.Version || targetFull.version;
        const currentVersion = app.getVersion();

        const isNewer = compareSemver(remoteVersion, currentVersion) > 0;
        if (!isNewer) {
            console.log(`[Backup Updater] Versi aplikasi sudah yang terbaru (Lokal: v${currentVersion}, Remote: v${remoteVersion}).`);
            if (onProgress) onProgress({ status: "App is up to date.", percent: 100 });
            if (onComplete) setTimeout(() => onComplete(false), 800);
            return true;
        }

        const fileName = targetFull.FileName || targetFull.fileName;
        const prev1Full = fullAssets[1];
        const prev2Full = fullAssets[2];
        const clean = (v) => String(v || '').replace(/^v/i, '').trim();

        // 2. Deteksi lokasi instalasi Velopack (Update.exe & packages directory)
        const execPath = process.execPath;
        const appDir = path.dirname(execPath);
        const rootAppDir = path.dirname(appDir);
        
        let candidateUpdateExe = path.join(rootAppDir, "Update.exe");
        if (!fs.existsSync(candidateUpdateExe)) {
            candidateUpdateExe = path.join(appDir, "Update.exe");
        }

        let packagesDir = path.join(rootAppDir, "packages");
        if (!fs.existsSync(packagesDir)) {
            try { fs.mkdirSync(packagesDir, { recursive: true }); } catch (e) {}
        }

        const targetDownloadPath = fs.existsSync(packagesDir)
            ? path.join(packagesDir, fileName)
            : path.join(app.getPath("temp"), fileName);

        // Periksa apakah paket Full target sudah ada secara lokal
        if (fs.existsSync(targetDownloadPath) && fs.statSync(targetDownloadPath).size > 10 * 1024 * 1024) {
            console.log(`[Backup Updater] Paket target sudah tersedia secara lokal di ${targetDownloadPath}`);
        } else {
            // Cek apakah paket basis x-1 atau x-2 tersedia di packages untuk rekonstruksi Delta (~1 MB)
            let deltaPatchSuccess = false;
            const deltaTarget = deltaAssets.find((d) => clean(d.Version) === clean(targetFull.Version));
            const deltaPrev1 = prev1Full ? deltaAssets.find((d) => clean(d.Version) === clean(prev1Full.Version)) : null;

            const localPrev1Path = prev1Full ? path.join(packagesDir, prev1Full.FileName || prev1Full.fileName) : null;
            const localPrev2Path = prev2Full ? path.join(packagesDir, prev2Full.FileName || prev2Full.fileName) : null;

            if (fs.existsSync(candidateUpdateExe)) {
                if (localPrev1Path && fs.existsSync(localPrev1Path) && deltaTarget) {
                    try {
                        console.log(`[Backup Updater] Ditemukan basis x-1 (${prev1Full.Version}). Mengunduh delta 1 tahap: ${deltaTarget.FileName}...`);
                        const tempDeltaPath = path.join(packagesDir, deltaTarget.FileName);
                        const deltaRes = await axios({
                            url: `${updateUrl}${deltaTarget.FileName}`,
                            method: 'GET',
                            responseType: 'arraybuffer',
                            headers: { 'User-Agent': OFFICIAL_USER_AGENT },
                            timeout: 60000
                        });
                        fs.writeFileSync(tempDeltaPath, Buffer.from(deltaRes.data));
                        
                        console.log(`[Backup Updater] Merekontruksi ${fileName} via Update.exe patch...`);
                        await new Promise((resolve, reject) => {
                            const cp = spawn(candidateUpdateExe, ["patch", "--old", localPrev1Path, "--delta", tempDeltaPath, "--output", targetDownloadPath], { stdio: 'ignore' });
                            cp.on('exit', (code) => code === 0 && fs.existsSync(targetDownloadPath) ? resolve() : reject(new Error(`Exit ${code}`)));
                            cp.on('error', reject);
                        });
                        deltaPatchSuccess = true;
                        try { fs.unlinkSync(tempDeltaPath); } catch (_) {}
                        console.log(`[Backup Updater] Rekonstruksi delta 1 tahap BERHASIL!`);
                    } catch (e) {
                        console.warn(`[Backup Updater] Delta patch 1 tahap gagal:`, e.message);
                    }
                } else if (localPrev2Path && fs.existsSync(localPrev2Path) && deltaTarget && deltaPrev1) {
                    try {
                        console.log(`[Backup Updater] Ditemukan basis x-2 (${prev2Full.Version}). Mengunduh 2 delta berantai...`);
                        const tempDeltaPrev1 = path.join(packagesDir, deltaPrev1.FileName);
                        const tempDeltaTarget = path.join(packagesDir, deltaTarget.FileName);

                        const [d1Res, d2Res] = await Promise.all([
                            axios({ url: `${updateUrl}${deltaPrev1.FileName}`, method: 'GET', responseType: 'arraybuffer', headers: { 'User-Agent': OFFICIAL_USER_AGENT }, timeout: 60000 }),
                            axios({ url: `${updateUrl}${deltaTarget.FileName}`, method: 'GET', responseType: 'arraybuffer', headers: { 'User-Agent': OFFICIAL_USER_AGENT }, timeout: 60000 })
                        ]);
                        fs.writeFileSync(tempDeltaPrev1, Buffer.from(d1Res.data));
                        fs.writeFileSync(tempDeltaTarget, Buffer.from(d2Res.data));

                        console.log(`[Backup Updater] Merekontruksi ${fileName} via 2 delta berantai...`);
                        await new Promise((resolve, reject) => {
                            const cp = spawn(candidateUpdateExe, ["patch", "--old", localPrev2Path, "--delta", tempDeltaPrev1, "--delta", tempDeltaTarget, "--output", targetDownloadPath], { stdio: 'ignore' });
                            cp.on('exit', (code) => code === 0 && fs.existsSync(targetDownloadPath) ? resolve() : reject(new Error(`Exit ${code}`)));
                            cp.on('error', reject);
                        });
                        deltaPatchSuccess = true;
                        try { fs.unlinkSync(tempDeltaPrev1); } catch (_) {}
                        try { fs.unlinkSync(tempDeltaTarget); } catch (_) {}
                        console.log(`[Backup Updater] Rekonstruksi 2 delta berantai BERHASIL!`);
                    } catch (e) {
                        console.warn(`[Backup Updater] Delta patch 2 tahap gagal:`, e.message);
                    }
                }
            }

            // Jika delta patch tidak memungkinkan atau gagal, download Full Package secara streaming
            if (!deltaPatchSuccess) {
                const totalBytes = Number(targetFull.Size || targetFull.size || 0);
                const totalDisplay = totalBytes > 0 ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : "Calculating...";
                console.log(`[Backup Updater] Mengunduh Full Package: v${remoteVersion} (${fileName}, ${totalDisplay})...`);

                const writer = fs.createWriteStream(targetDownloadPath);
                let downloadedBytes = 0;

                const downloadRes = await axios({
                    url: `${updateUrl}${fileName}`,
                    method: 'GET',
                    responseType: 'stream',
                    headers: { 'User-Agent': OFFICIAL_USER_AGENT },
                    timeout: 180000
                });

                await new Promise((resolve, reject) => {
                    downloadRes.data.on('data', (chunk) => {
                        downloadedBytes += chunk.length;
                        if (totalBytes > 0 && onProgress) {
                            const percent = Math.min(99, Math.round((downloadedBytes * 100) / totalBytes));
                            const dlMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
                            onProgress({
                                status: `[Backup Updater] Mengunduh pembaruan v${remoteVersion}...`,
                                detail: `${dlMB} MB / ${totalDisplay} (${percent}%)`,
                                percent,
                                totalMB: totalDisplay,
                                downloadedMB: `${dlMB} MB`,
                                isDelta: false,
                                updateTypeLabel: "Backup Update"
                            });
                        }
                    });

                    downloadRes.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                    downloadRes.data.on('error', reject);
                });
            }
        }

        console.log(`[Backup Updater] File pembaruan berhasil diunduh ke: ${targetDownloadPath}`);

        if (onProgress) {
            onProgress({
                status: `[Backup Updater] Menerapkan update v${remoteVersion}...`,
                detail: "Menerapkan update dan me-restart aplikasi...",
                percent: 100
            });
        }

        // 4. Eksekusi pembaruan:
        // Jika Update.exe ada (instalasi standar Velopack), jalankan perintah apply bawaan Velopack
        if (fs.existsSync(candidateUpdateExe)) {
            console.log(`[Backup Updater] Menerapkan update via ${candidateUpdateExe}...`);
            const child = spawn(candidateUpdateExe, [
                "apply",
                "--package", targetDownloadPath,
                "--restart",
                "--waitPid", String(process.pid)
            ], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
        } else {
            // Jika portable / dev, download installer SA-CHAOS-win-Setup.exe langsung ke temp
            console.warn(`[Backup Updater] Update.exe tidak terdeteksi. Mencoba fallback ke installer Setup.exe...`);
            const tempSetupPath = path.join(app.getPath("temp"), "SA-CHAOS-win-Setup.exe");
            const setupDownloadRes = await axios({
                url: `${updateUrl}SA-CHAOS-win-Setup.exe`,
                method: 'GET',
                responseType: 'stream',
                headers: { 'User-Agent': OFFICIAL_USER_AGENT },
                timeout: 180000
            });
            const setupWriter = fs.createWriteStream(tempSetupPath);
            await new Promise((resolve, reject) => {
                setupDownloadRes.data.pipe(setupWriter);
                setupWriter.on('finish', resolve);
                setupWriter.on('error', reject);
                setupDownloadRes.data.on('error', reject);
            });
            const childSetup = spawn(tempSetupPath, ["--silent"], {
                detached: true,
                stdio: 'ignore'
            });
            childSetup.unref();
        }

        setTimeout(() => {
            try {
                app.quit();
                setTimeout(() => process.exit(0), 1000);
            } catch (err) {
                process.exit(0);
            }
        }, 1200);

        return true;
    } catch (fallbackErr) {
        console.error("[Backup Updater] Gagal menjalankan backup updater:", fallbackErr.message);
        return false;
    }
}

export async function checkAndSyncDesktopApp(autoInstall = false) {
    try {
        if (!global.desktopAppUpdateStatus) {
            global.desktopAppUpdateStatus = {
                status: 'idle',
                updateAvailable: false,
                currentVersion: typeof app !== 'undefined' && app.getVersion ? app.getVersion() : '1.0.0',
                latestVersion: null,
                percent: 0,
                detail: '',
                error: null,
                updatedAt: Date.now()
            };
        }

        global.desktopAppUpdateStatus.status = 'checking';
        global.desktopAppUpdateStatus.updatedAt = Date.now();
        
        const selectedChannel = resolveUpdateChannel(GeneralConfig);
        const velopackChannel = getVelopackChannelName(selectedChannel);
        const updateUrl = `https://updater.sa-chaos.my.id/velopack.php/`;
        let releasesRes;
        try {
            releasesRes = await axios.get(`${updateUrl}releases.${velopackChannel}.json`, {
                headers: { 'User-Agent': OFFICIAL_USER_AGENT },
                timeout: 10000
            });
        } catch (feedErr) {
            if (velopackChannel !== "win") {
                console.warn(`[Desktop Sync] releases.${velopackChannel}.json tidak ditemukan, beralih ke releases.win.json:`, feedErr.message);
                releasesRes = await axios.get(`${updateUrl}releases.win.json`, {
                    headers: { 'User-Agent': OFFICIAL_USER_AGENT },
                    timeout: 10000
                });
            } else {
                throw feedErr;
            }
        }

        const assets = releasesRes.data?.Assets || [];
        // Membaca releases.win.json langsung dari urutan paling terbaru (atas) ke bawah
        const fullAssets = assets.filter((a) => String(a.Type).toLowerCase() === "full");
        const deltaAssets = assets.filter((a) => String(a.Type).toLowerCase() === "delta");

        const targetFull = fullAssets[0];
        if (!targetFull) return false;

        const remoteVersion = targetFull.Version || targetFull.version;
        const currentVersion = typeof app !== 'undefined' && app.getVersion ? app.getVersion() : '1.0.0';
        const isNewer = compareSemver(remoteVersion, currentVersion) > 0;

        const prev1Full = fullAssets[1];
        const prev2Full = fullAssets[2];
        const clean = (v) => String(v || '').replace(/^v/i, '').trim();

        let displaySizeBytes = Number(targetFull.Size || targetFull.size || 0);
        let updateType = "Full Update";

        if (isNewer) {
            const deltaTarget = deltaAssets.find((d) => clean(d.Version) === clean(targetFull.Version));
            const deltaPrev1 = prev1Full ? deltaAssets.find((d) => clean(d.Version) === clean(prev1Full.Version)) : null;

            if (prev1Full && clean(currentVersion) === clean(prev1Full.Version) && deltaTarget?.Size) {
                displaySizeBytes = Number(deltaTarget.Size);
                updateType = "Delta Patch (1 tahap)";
            } else if (prev2Full && clean(currentVersion) === clean(prev2Full.Version) && deltaTarget?.Size && deltaPrev1?.Size) {
                displaySizeBytes = Number(deltaTarget.Size) + Number(deltaPrev1.Size);
                updateType = "Delta Patch (2 tahap)";
            }
        }

        const sizeDisplay = displaySizeBytes > 0 && displaySizeBytes < 1024 * 1024
            ? `${(displaySizeBytes / 1024).toFixed(0)} KB`
            : `${(displaySizeBytes / (1024 * 1024)).toFixed(1)} MB`;

        global.desktopAppUpdateStatus = {
            status: isNewer ? 'available' : 'up_to_date',
            updateAvailable: isNewer,
            channel: selectedChannel,
            currentVersion,
            latestVersion: remoteVersion,
            fileName: targetFull.FileName || targetFull.fileName,
            sizeBytes: displaySizeBytes,
            sizeMB: sizeDisplay,
            updateType,
            percent: 0,
            detail: isNewer ? `Versi baru v${remoteVersion} (${updateType}: ~${sizeDisplay}) tersedia.` : `Aplikasi sudah versi terbaru (v${currentVersion}).`,
            error: null,
            updatedAt: Date.now()
        };

        console.log(`[Desktop Sync] Pengecekan versi selesai (Channel: ${selectedChannel}): v${currentVersion} -> v${remoteVersion} (Update tersedia: ${isNewer})`);

        if (isNewer && autoInstall) {
            console.log(`[Desktop Sync] Memulai instalasi otomatis fallback untuk v${remoteVersion}...`);
            await runFallbackUpdater({
                updateUrl,
                channel: velopackChannel,
                onProgress: (p) => {
                    global.desktopAppUpdateStatus.status = 'downloading';
                    global.desktopAppUpdateStatus.percent = p.percent || 0;
                    global.desktopAppUpdateStatus.detail = p.detail || '';
                    global.desktopAppUpdateStatus.updatedAt = Date.now();
                }
            });
        }

        return isNewer;
    } catch (err) {
        console.warn(`[Desktop Sync] Gagal mengecek update desktop:`, err.message);
        if (global.desktopAppUpdateStatus) {
            global.desktopAppUpdateStatus.status = 'error';
            global.desktopAppUpdateStatus.error = err.message;
            global.desktopAppUpdateStatus.updatedAt = Date.now();
        }
        return false;
    }
}


