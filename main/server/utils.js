import { execSync } from "child_process";
import { spawn } from "child_process";
import { join } from "path";
import { writeFileSync, unlinkSync } from "fs";
import os from "os";
import net from "net";

export async function findAvailablePort(startPort) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(startPort, () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                resolve(findAvailablePort(startPort + 1));
            } else {
                resolve(startPort);
            }
        });
    });
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function killProcess(processName) {
    const command = `taskkill /f /im ${processName}`;
    try {
        execSync(command);
        return true;
    }
    catch (err) {
        return false;
    }
}

export async function runProcessAndWaitToExit(processName, callback) {
    return new Promise((resolve, reject) => {
        // Spawn Process (Display It)
        const child = spawn(processName, [], { stdio: ["pipe", "inherit", "inherit"] });

        child.stdin.write("OK");

        child.stdin.end();

        child.on("error", (err) => {
            reject(err);
        })

        child.on("exit", (code) => {
            if (code === 0) {
                callback();
                resolve();
            } else {
                reject(new Error(`Process exited with code ${code}`));
            }
        });
    });
}

export function findRunningProcess(processName) {
    const command = `tasklist /fi "imagename eq ${processName}"`;
    try {
        const output = execSync(command).toString();
        return output.toLowerCase().includes(processName.toLowerCase());
    } catch (err) {
        return false;
    }
}

export async function runPowerShell(psScript) {
    return new Promise((resolve, reject) => {
        const psFile = join(os.tmpdir(), "temp_script_" + Date.now() + ".ps1");
        writeFileSync(psFile, psScript);

        let output = "";
        let errorOutput = "";
        
        const child = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", psFile]);

        child.stdout.on("data", (data) => {
            output += data.toString();
        });

        child.stderr.on("data", (data) => {
            errorOutput += data.toString();
        });

        child.on("exit", (code) => {
            try { unlinkSync(psFile); } catch (e) {}
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(`PowerShell exited with code ${code}: ${errorOutput.trim()}`));
            }
        });

        child.stdin.end();
    });
}

export async function runBat(scriptContent) {
    return new Promise((resolve, reject) => {
        const batchFile = join(os.tmpdir(), "temp_script_" + Date.now() + ".bat");
        writeFileSync(batchFile, scriptContent);

        let output = "";
        let errorOutput = "";

        const child = spawn("cmd.exe", ["/c", batchFile]);

        child.stdout.on("data", (data) => {
            output += data.toString();
        });

        child.stderr.on("data", (data) => {
            errorOutput += data.toString();
        });

        child.on("exit", (code) => {
            try { unlinkSync(batchFile); } catch (e) {}
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(
                    new Error(
                        `Batch script exited with code ${code}: ${errorOutput.trim()}`
                    )
                );
            }
        });
    });
}

export async function SelectGTASA() {
    try {
        let messageCMD = `
            echo MsgBox "For Auto Update, You Must Choose Your GTA SA Executable (One Time Only)." \
            ^& vbNewLine ^& vbNewLine ^& "File Picker Sometimes Takes a Few Seconds to Load..." \
            ^& vbNewLine ^& vbNewLine ^& "Press OK and Be Patient", 64, "Auto Update Notice" > "%temp%\\msgbox.vbs"
            cscript //nologo "%temp%\\msgbox.vbs"
            del "%temp%\\msgbox.vbs"
            exit /b
        `;
        await runBat(messageCMD);
        let fileSelectCMD = `
            Add-Type -AssemblyName System.Windows.Forms
            $openFileDialog = New-Object System.Windows.Forms.OpenFileDialog
            $openFileDialog.Filter = "GTASA Executable|gta_sa.exe;SanAndreas.exe"
            $openFileDialog.Title = "Select GTASA Executable"
            $openFileDialog.InitialDirectory = "${process.cwd()}"
            $openFileDialog.ShowDialog() | Out-Null
            $openFileDialog.FileName;
        `
        return await runPowerShell(fileSelectCMD) || "empty";
    } catch (err) {
        return "empty";
    }
}

export const getDifference = (s, t) => {
    s = [...s].sort();
    t = [...t].sort();
    return t.find((char, i) => char !== s[i]);
};
