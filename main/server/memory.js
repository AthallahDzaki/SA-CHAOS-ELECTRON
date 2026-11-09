import memoryjs from "memoryjs";
import ora from "ora";
import { findRunningProcess } from "./utils.js";

export function DebugMemory() {
    console.log("[DEBUG] Memory Debugging");
    const processName = "gta_sa.exe";
    let process = null;
    let loading = ora("Waiting for process..."), loadingDone = false;
    loading.spinner.interval = 50;
    loading.start();
    setInterval(async () => {
        if (findRunningProcess("gta_sa.exe") == false) {
            return;
        }

        if (loadingDone == false) {
            loading.succeed("GTA SA Found!");
            loadingDone = true;
        }

        if (!process) {
            process = memoryjs.openProcess(processName);
            return;
        }
        const state = memoryjs.readMemory(
            process.handle,
            0xc8d4c0,
            "int32"
        );
        console.log(`Game State : ${state}`);
    }, 1000);
}
