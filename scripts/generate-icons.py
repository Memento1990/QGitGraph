"""Generate original, deterministic application icons without external assets."""
import struct
import zlib
from pathlib import Path


def icon(size):
    pixels = bytearray(size * size * 4)
    points = [(0.31, 0.24), (0.31, 0.74), (0.70, 0.38)]
    segments = [(points[0], points[1]), (points[1], points[2])]
    for y in range(size):
        for x in range(size):
            px, py = (x + 0.5) / size, (y + 0.5) / size
            color = (29, 31, 35, 255)
            for a, b in segments:
                dx, dy = b[0] - a[0], b[1] - a[1]
                t = max(0, min(1, ((px-a[0])*dx + (py-a[1])*dy) / (dx*dx + dy*dy)))
                if (px-a[0]-t*dx)**2 + (py-a[1]-t*dy)**2 < 0.001:
                    color = (109, 175, 239, 255)
            for i, (cx, cy) in enumerate(points):
                distance = (px - cx)**2 + (py - cy)**2
                if distance < 0.006:
                    color = (109, 175, 239, 255) if i < 2 else (115, 205, 156, 255)
                if distance < 0.0014:
                    color = (29, 31, 35, 255)
            if (px < 0.10 or px > 0.90) and (py < 0.10 or py > 0.90):
                cx = 0.10 if px < 0.5 else 0.90
                cy = 0.10 if py < 0.5 else 0.90
                if (px-cx)**2 + (py-cy)**2 > 0.01:
                    color = (0, 0, 0, 0)
            offset = (y * size + x) * 4
            pixels[offset:offset + 4] = bytes(color)
    raw = b''.join(b'\0' + pixels[y*size*4:(y+1)*size*4] for y in range(size))
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('output')
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    for size, filename in [(32, '32x32.png'), (128, '128x128.png'), (256, '128x128@2x.png')]:
        (output / filename).write_bytes(icon(size))
    images = [(size, icon(size)) for size in (16, 32, 48, 256)]
    directory = bytearray(struct.pack('<HHH', 0, 1, len(images)))
    data = bytearray()
    for size, image in images:
        directory.extend(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(image), 6 + 16*len(images) + len(data)))
        data.extend(image)
    (output / 'icon.ico').write_bytes(directory + data)


if __name__ == '__main__':
    main()
