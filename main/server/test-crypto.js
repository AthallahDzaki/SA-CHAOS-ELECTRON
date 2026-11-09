
import { readJson, writeJson } from "./shared.js";
import fs from "fs";
import path from "path";

const testPath = path.join(process.cwd(), "test.json");
console.log("Writing plain json...");
fs.writeFileSync(testPath, JSON.stringify({ hello: "world", old_data: true }), "utf8");

console.log("Reading (migration) json...");
let data = readJson(testPath, null);
console.log("Data:", data);

console.log("Checking if file is encrypted...");
let content = fs.readFileSync(testPath, "utf8");
console.log("Encrypted content (preview):", content.substring(0, 30));

console.log("Reading encrypted json...");
let data2 = readJson(testPath, null);
console.log("Data2:", data2);

