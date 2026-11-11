const fs = require('fs');

if (global.gc) {
    global.gc();
}

const path = "D:\\ST\\SillyTavern\\data\\default-user\\chats\\Genshin Impact · Teyvat3\\Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms.jsonl";

function getMem() {
    return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
}

console.log(`Initial Heap: ${getMem()} MB`);

const fd = fs.openSync(path, 'r');
const buffer = Buffer.alloc(36 * 1024 * 1024);
const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
fs.closeSync(fd);

// Find newline
const newlineIdx = buffer.indexOf(10);
const line0Str = buffer.toString('utf8', 0, newlineIdx);

console.log(`After reading Line 0 String (${(line0Str.length / 1024 / 1024).toFixed(2)} MB chars): Heap = ${getMem()} MB`);

const parsed = JSON.parse(line0Str);

console.log(`After JSON.parse(Line 0): Heap = ${getMem()} MB`);

// Now let's measure deep clone (klona)
function simpleClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

const clone = simpleClone(parsed);
console.log(`After Cloning Line 0: Heap = ${getMem()} MB`);
