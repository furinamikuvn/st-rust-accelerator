const fs = require('fs');
const path = require('path');

const testFile = "C:\\Users\\ADMIN\\.gemini\\antigravity\\brain\\0c5e347c-bf70-4df3-9de2-38d030c30fec\\scratch\\io_bench_test.jsonl";

// Create 34MB mock content
const dummyMsg = JSON.stringify({
    name: "User",
    is_user: true,
    mes: "Xin chào Tawa, chúng ta đang kiểm tra tốc độ ghi đĩa thực tế của SillyTavern trên Windows!".repeat(5),
    extra: { token_count: 150 }
});

const lines = [];
// Line 0 is 30MB
lines.push(JSON.stringify({ chat_metadata: { data: "x".repeat(30 * 1024 * 1024) } }));
for (let i = 0; i < 50; i++) {
    lines.push(dummyMsg);
}

const fullChatStr = lines.join('\n');
console.log(`Generated chat payload: ${(fullChatStr.length / 1024 / 1024).toFixed(2)} MB`);

// 1. Measure full rewrite (ST current behavior: trySaveChat)
const runs = 5;
let totalFullMs = 0;
for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fs.writeFileSync(testFile, fullChatStr, 'utf8');
    totalFullMs += (performance.now() - start);
}
console.log(`Current ST full rewrite time (average of ${runs} runs): ${(totalFullMs / runs).toFixed(2)} ms`);

// 2. Measure append-only (1 message delta)
let totalAppendMs = 0;
for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fs.appendFileSync(testFile, '\n' + dummyMsg, 'utf8');
    totalAppendMs += (performance.now() - start);
}
console.log(`Append-Only delta write time (average of ${runs} runs): ${(totalAppendMs / runs).toFixed(3)} ms`);

// Clean up
try { fs.unlinkSync(testFile); } catch {}
