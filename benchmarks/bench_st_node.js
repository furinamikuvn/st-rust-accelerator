const fs = require('fs');

const path = "D:\\tao card ST\\卡与插件与世界书\\Genshin_Impact_Teyvat_P160_Vi.json";
const raw = fs.readFileSync(path, 'utf8');
const data = JSON.parse(raw);
const entries = data.data.character_book.entries;

const haystack = `
Hôm nay Lữ Hành Giả và Paimon cùng nhau đi đến Thành Mondstadt để gặp Đội Kỵ Sĩ Tây Phong. 
Tại đó, Jean và Lisa đang thảo luận về Phong Ma Long Dvalin và sự đe dọa của Giáo Đoàn Vực Sâu. 
Amber vừa trở về sau chuyến tuần tra tại Rừng Danh Vọng và Hồ Sao Rơi, cô ấy mang theo một số thông tin 
về các Hilichurl và Pháp Sư Vực Sâu đang tụ tập quanh Đền Sư Tử. 
Diluc tại Quán Rượu Đuôi Mèo cũng đang bí mật điều tra sự xuất hiện của Fatui và các Quan Chấp Chính.
Venti đang ngồi gảy đàn lia bài ca cổ xưa về Phong Thần Barbatos tại quảng trường trước Đại Giáo Đường.
`;

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Warm up V8
for (let i = 0; i < 3; i++) {
    for (const entry of entries) {
        for (const k of (entry.keys || [])) {
            k.toLowerCase();
        }
    }
}

const runs = 20;
const start = performance.now();
let totalMatched = 0;

for (let r = 0; r < runs; r++) {
    const matched = [];
    const haystackLower = haystack.toLowerCase();
    for (const entry of entries) {
        let isMatched = false;
        for (const k of (entry.keys || [])) {
            if (!k) continue;
            const kLower = k.toLowerCase();
            const words = kLower.split(/\s+/);
            if (words.length > 1) {
                if (haystackLower.includes(kLower)) {
                    isMatched = true;
                    break;
                }
            } else {
                const regex = new RegExp(`(?:^|\\W)(${escapeRegex(kLower)})(?:$|\\W)`);
                if (regex.test(haystackLower)) {
                    isMatched = true;
                    break;
                }
            }
        }
        if (isMatched) matched.push(entry.id);
    }
    totalMatched = matched.length;
}

const elapsedMs = (performance.now() - start) / runs;
console.log(`V8 Node.js ST WI Scan Time: ${elapsedMs.toFixed(3)} ms per scan`);
console.log(`Matched entries: ${totalMatched}`);
