const fs = require('fs');
const path = 'D:/ST/SillyTavern/data/default-user/characters/Thiên Chương Định Mệnh v4.3.png';

console.log('=== BENCHMARK: INSPECT THIÊN CHƯƠNG ĐỊNH MỆNH v4.3 BINARY ===');
if (!fs.existsSync(path)) {
    console.error('File thẻ không tồn tại:', path);
    process.exit(1);
}

const buf = fs.readFileSync(path);
console.log('Total file size:', (buf.length / (1024*1024)).toFixed(2), 'MB');

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
console.log('Card Name:', d.name);
console.log('JSON Payload Size:', (jsonStr.length / (1024*1024)).toFixed(2), 'MB');

const regex = (d.extensions && d.extensions.regex_scripts) || [];
console.log('Regex scripts count:', regex.length);
let totalRegexChars = 0;
regex.forEach((r, i) => {
    const findLen = (r.findRegex || '').length;
    const repLen = (r.replaceString || '').length;
    totalRegexChars += findLen + repLen;
    console.log(`  Regex [${i}] ${r.scriptName}: find=${findLen}, replace=${repLen}`);
});
console.log('Total Regex Chars:', totalRegexChars);

const th = (d.extensions && d.extensions.tavern_helper) || {};
if (th.scripts) {
    console.log('TavernHelper scripts count:', th.scripts.length);
    th.scripts.forEach((s, i) => {
        const code = s.content || s.code || '';
        console.log(`  TH Script [${i}] ${s.name || s.id}: length=${code.length}`);
    });
}
if (th.variables) {
    console.log('TH variables size:', JSON.stringify(th.variables).length, 'bytes');
}
const wb = d.character_book || {};
if (wb.entries) {
    console.log('Worldbook entries count:', wb.entries.length);
    console.log('Worldbook size:', JSON.stringify(wb).length, 'bytes');
}
