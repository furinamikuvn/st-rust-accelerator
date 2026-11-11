import os, zlib, json

path = r"D:\ST\SillyTavern\data\default-user\chats\Genshin Impact · Teyvat3\Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms.jsonl"
raw_bytes = os.path.getsize(path)

with open(path, 'rb') as f:
    content = f.read()

# Test zlib (deflate)
compressed_zlib = zlib.compress(content, level=1) # fast level 1 (comparable to lz4)
compressed_zlib_high = zlib.compress(content, level=6)

print(f"Raw chat file size: {raw_bytes / 1024 / 1024:.2f} MB ({raw_bytes:,} bytes)")
print(f"Fast Compressed (Level 1): {len(compressed_zlib) / 1024 / 1024:.2f} MB ({len(compressed_zlib):,} bytes) -> Ratio: {len(compressed_zlib)/raw_bytes*100:.1f}%")
print(f"Standard Compressed (Level 6): {len(compressed_zlib_high) / 1024 / 1024:.2f} MB ({len(compressed_zlib_high):,} bytes) -> Ratio: {len(compressed_zlib_high)/raw_bytes*100:.1f}%")
