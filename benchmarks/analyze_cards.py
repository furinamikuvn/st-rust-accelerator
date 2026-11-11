import struct, os, base64

def analyze_png(filepath):
    filesize = os.path.getsize(filepath)
    with open(filepath, 'rb') as f:
        header = f.read(8)
        if header != b'\x89PNG\r\n\x1a\n':
            return None
        
        chunks = {}
        width, height = 0, 0
        text_payload_len = 0
        while True:
            len_bytes = f.read(4)
            if not len_bytes or len(len_bytes) < 4:
                break
            length = struct.unpack('>I', len_bytes)[0]
            chunk_type = f.read(4).decode('latin1', errors='ignore')
            data = f.read(length)
            crc = f.read(4)
            
            chunks[chunk_type] = chunks.get(chunk_type, 0) + length
            if chunk_type == 'IHDR':
                width, height = struct.unpack('>II', data[:8])
            if chunk_type in ('tEXt', 'iTXt', 'zTXt'):
                text_payload_len += length
                
    return {
        'filesize': filesize,
        'dimensions': f"{width}x{height}",
        'idat_bytes': chunks.get('IDAT', 0),
        'text_bytes': text_payload_len,
        'chunks': chunks
    }

char_dir = r"D:\ST\SillyTavern\data\default-user\characters"
sample_cards = [
    'Genshin Impact · Teyvat3.png',
    'Honkai Star Rail.png',
    'Hoàng Thiên Hậu Thổ.png',
    'Genshin Impact.png',
    '原神1.png',
    '【Mira】Re꞉ Zero - Bắt Đầu Lại Ở Thế Giới Khác.png',
    'Thiên Chương Định Mệnh v4.3.png',
    '【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7.png'
]

print(f"| {'Card Name':<42} | {'File Size':<10} | {'Dims':<11} | {'IDAT (Img)':<11} | {'tEXt (Meta)':<12} | {'Meta %':<8} |")
print('|' + '-'*44 + '|' + '-'*12 + '|' + '-'*13 + '|' + '-'*13 + '|' + '-'*14 + '|' + '-'*10 + '|')
for name in sample_cards:
    p = os.path.join(char_dir, name)
    if os.path.exists(p):
        info = analyze_png(p)
        mb = info['filesize'] / (1024*1024)
        idat_mb = info['idat_bytes'] / (1024*1024)
        text_mb = info['text_bytes'] / (1024*1024)
        meta_pct = (info['text_bytes'] / info['filesize']) * 100
        print(f"| {name[:42]:<42} | {mb:>7.2f} MB | {info['dimensions']:^11} | {idat_mb:>7.2f} MB  | {text_mb:>8.2f} MB  | {meta_pct:>7.1f}% |")
