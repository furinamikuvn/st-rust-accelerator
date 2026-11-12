const fs = require('fs');
const path = 'D:/ST/SillyTavern/data/default-user/characters/Thiên Chương Định Mệnh v4.3.png';

console.log('=== BENCHMARK: DEEP AUDIT REGEX [13] 844KB HTML TEMPLATE ===');
const buf = fs.readFileSync(path);
let pos = 8;
let jsonStr = '';
while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    if (type === 'tEXt') {
        const data = buf.slice(pos + 8, pos + 8 + len);
        const nullIdx = data.indexOf(0);
        const keyword = data.slice(0, nullIdx).toString('ascii');
        if (keyword === 'ccv3' || keyword === 'chara') {
            const val = data.slice(nullIdx + 1).toString('utf8');
            jsonStr = Buffer.from(val, 'base64').toString('utf8');
            break;
        }
    }
    pos += 12 + len;
}

const card = JSON.parse(jsonStr);
const d = card.data || card;
const r13 = d.extensions.regex_scripts[13];
const rep = r13.replaceString || '';

console.log('Regex [13] Name:', r13.scriptName);
console.log('findRegex pattern:', r13.findRegex);
console.log('replaceString character count:', rep.length, 'bytes');

const canvasCount = (rep.match(/<canvas/gi) || []).length;
const scriptCount = (rep.match(/<script/gi) || []).length;
const styleCount = (rep.match(/<style/gi) || []).length;
const rAFCount = (rep.match(/requestAnimationFrame/gi) || []).length;
const keyframeCount = (rep.match(/@keyframes/gi) || []).length;
const backdropCount = (rep.match(/backdrop-filter/gi) || []).length;
const boxShadowCount = (rep.match(/box-shadow/gi) || []).length;
const transformRotateCount = (rep.match(/transform:\s*rotate/gi) || []).length;

console.log(`• Thẻ <canvas>: ${canvasCount}`);
console.log(`• Thẻ <script>: ${scriptCount}`);
console.log(`• Thẻ <style>: ${styleCount}`);
console.log(`• Lệnh requestAnimationFrame: ${rAFCount}`);
console.log(`• Animation @keyframes: ${keyframeCount}`);
console.log(`• Hiệu ứng backdrop-filter: ${backdropCount}`);
console.log(`• Lớp box-shadow: ${boxShadowCount}`);
console.log(`• Phép xoay transform rotate: ${transformRotateCount}`);

// Test V8 replace performance & garbage generation
const sampleChatMsg = '<dream>「Thử nghiệm kích hoạt hội thoại độc giả với template 844KB」</dream>';
const regexMatcher = new RegExp(r13.findRegex.replace(/^\/|\/[a-z]*$/g, ''), 'g');

const start = performance.now();
const res = sampleChatMsg.replace(regexMatcher, rep);
const elapsed = performance.now() - start;

console.log(`• Thời gian chạy V8 String Replace 1 lượt: ${elapsed.toFixed(2)} ms`);
console.log(`• Kích thước chuỗi HTML kết quả sau khi replace: ${(res.length / 1024).toFixed(2)} KB`);
