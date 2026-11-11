import json, time, re

path = r"D:\tao card ST\卡与插件与世界书\Genshin_Impact_Teyvat_P160_Vi.json"
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)

cb = data['data'].get('character_book', {})
entries = cb.get('entries', [])

haystack = """
Hôm nay Lữ Hành Giả và Paimon cùng nhau đi đến Thành Mondstadt để gặp Đội Kỵ Sĩ Tây Phong. 
Tại đó, Jean và Lisa đang thảo luận về Phong Ma Long Dvalin và sự đe dọa của Giáo Đoàn Vực Sâu. 
Amber vừa trở về sau chuyến tuần tra tại Rừng Danh Vọng và Hồ Sao Rơi, cô ấy mang theo một số thông tin 
về các Hilichurl và Pháp Sư Vực Sâu đang tụ tập quanh Đền Sư Tử. 
Diluc tại Quán Rượu Đuôi Mèo cũng đang bí mật điều tra sự xuất hiện của Fatui và các Quan Chấp Chính.
Venti đang ngồi gảy đàn lia bài ca cổ xưa về Phong Thần Barbatos tại quảng trường trước Đại Giáo Đường.
"""

def escape_regex(s):
    return re.escape(s)

# ST Algorithm simulation:
# For each entry, for each key:
# if matchWholeWords:
#    keyWords = key.split()
#    if len > 1: haystack.includes(key)
#    else: new RegExp("(?:^|\W)(" + escape(key) + ")(?:$|\W)").test(haystack)

start_time = time.perf_counter()
matched_entries = []

for _ in range(10): # 10 runs
    matched_entries.clear()
    for entry in entries:
        keys = entry.get('keys', [])
        is_matched = False
        for k in keys:
            if not k: continue
            k_lower = k.lower()
            haystack_lower = haystack.lower()
            words = k_lower.split()
            if len(words) > 1:
                if k_lower in haystack_lower:
                    is_matched = True
                    break
            else:
                pat = r"(?:^|\W)(" + re.escape(k_lower) + r")(?:$|\W)"
                if re.search(pat, haystack_lower):
                    is_matched = True
                    break
        if is_matched:
            matched_entries.append(entry.get('comment', entry.get('id', '')))

elapsed_ms = (time.perf_counter() - start_time) / 10 * 1000
print(f"ST Python Equivalent Scan Time: {elapsed_ms:.2f} ms per scan")
print(f"Matched entries count: {len(matched_entries)}")
