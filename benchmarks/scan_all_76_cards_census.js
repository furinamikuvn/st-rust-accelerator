const fs = require('fs');
const path = require('path');

console.log('=== BENCHMARK: 76 CARDS GROUND TRUTH CENSUS ===');
const charDir = 'D:/ST/SillyTavern/data/default-user/characters';
const otherDir = 'D:/tao card ST/卡与插件与世界书';

function extractCardJson(filePath) {
    try {
        const buf = fs.readFileSync(filePath);
        let pos = 8;
        while (pos < buf.length) {
            const len = buf.readUInt32BE(pos);
            const type = buf.slice(pos + 4, pos + 8).toString('ascii');
            if (type === 'tEXt') {
                const data = buf.slice(pos + 8, pos + 8 + len);
                const nullIdx = data.indexOf(0);
                const keyword = data.slice(0, nullIdx).toString('ascii');
                if (keyword === 'ccv3' || keyword === 'chara') {
                    const val = data.slice(nullIdx + 1).toString('utf8');
                    return Buffer.from(val, 'base64').toString('utf8');
                }
            }
            pos += 12 + len;
        }
    } catch (e) {
        return null;
    }
    return null;
}

const targetFiles = [];
if (fs.existsSync(charDir)) {
    fs.readdirSync(charDir).filter(f => f.endsWith('.png')).forEach(f => targetFiles.push(path.join(charDir, f)));
}
if (fs.existsSync(otherDir)) {
    fs.readdirSync(otherDir).filter(f => f.endsWith('.png')).forEach(f => targetFiles.push(path.join(otherDir, f)));
}

let totalCards = 0;
let cardsWithCanvas = 0;
let cardsWithWebGL = 0;
let cardsWithKeyframes = 0;
let cardsWithBackdrop = 0;
let cardsWithRegex = 0;
let cardsWithTH = 0;
let cardsWithBigWB = 0;

const outlierCards = [];

targetFiles.forEach(file => {
    totalCards++;
    const stat = fs.statSync(file);
    const fileName = path.basename(file);
    const jsonStr = extractCardJson(file);
    if (!jsonStr) return;

    const hasCanvas = (jsonStr.match(/<canvas/gi) || []).length;
    const hasWebGL = (jsonStr.match(/getContext\(['"]webgl['"]/gi) || []).length;
    const hasKeyframes = (jsonStr.match(/@keyframes/gi) || []).length;
    const hasBackdrop = (jsonStr.match(/backdrop-filter/gi) || []).length;

    let regexCount = 0;
    let thCount = 0;
    let wbCount = 0;

    try {
        const card = JSON.parse(jsonStr);
        const d = card.data || card;
        if (d.extensions && d.extensions.regex_scripts) regexCount = d.extensions.regex_scripts.length;
        if (d.extensions && d.extensions.tavern_helper && d.extensions.tavern_helper.scripts) thCount = d.extensions.tavern_helper.scripts.length;
        if (d.character_book && d.character_book.entries) wbCount = d.character_book.entries.length;
    } catch (e) {}

    if (hasCanvas > 0) cardsWithCanvas++;
    if (hasWebGL > 0) cardsWithWebGL++;
    if (hasKeyframes > 0) cardsWithKeyframes++;
    if (hasBackdrop > 0) cardsWithBackdrop++;
    if (regexCount > 0) cardsWithRegex++;
    if (thCount > 0) cardsWithTH++;
    if (wbCount > 100) cardsWithBigWB++;

    if (hasCanvas > 0 || hasKeyframes > 20 || stat.size > 20*1024*1024) {
        outlierCards.push({
            name: fileName.substring(0, 32),
            fileMb: (stat.size / (1024*1024)).toFixed(1),
            canvas: hasCanvas,
            webgl: hasWebGL,
            keyframes: hasKeyframes,
            backdrop: hasBackdrop,
            regexScripts: regexCount,
            wbEntries: wbCount
        });
    }
});

console.log(`• Tổng số thẻ khảo sát: ${totalCards}`);
console.log(`• Thẻ có Canvas (<canvas): ${cardsWithCanvas} (${((cardsWithCanvas/totalCards)*100).toFixed(1)}%)`);
console.log(`• Thẻ có WebGL: ${cardsWithWebGL} (${((cardsWithWebGL/totalCards)*100).toFixed(1)}%)`);
console.log(`• Thẻ có CSS Keyframes: ${cardsWithKeyframes} (${((cardsWithKeyframes/totalCards)*100).toFixed(1)}%)`);
console.log(`• Thẻ có Backdrop-filter: ${cardsWithBackdrop} (${((cardsWithBackdrop/totalCards)*100).toFixed(1)}%)`);
console.log(`• Thẻ có Regex Scripts: ${cardsWithRegex} (${((cardsWithRegex/totalCards)*100).toFixed(1)}%)`);
console.log(`• Thẻ có TavernHelper: ${cardsWithTH} (${((cardsWithTH/totalCards)*100).toFixed(1)}%)`);
console.log(`• Thẻ có Worldbook >100 entries: ${cardsWithBigWB} (${((cardsWithBigWB/totalCards)*100).toFixed(1)}%)`);

console.log('\n=== CÁC THẺ NGOẠI LỆ / TẢI NẶNG ĐẶC BIỆT ===');
console.table(outlierCards);
