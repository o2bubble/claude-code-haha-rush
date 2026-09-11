"""Generate Claude Code app icons — modern geometric design."""
from PIL import Image, ImageDraw, ImageFilter
import math, os, struct

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "gui", "src-tauri", "icons")

# Color palette
BG_TOP = (30, 30, 60)        # dark indigo
BG_BOT = (18, 18, 40)        # deeper navy
CHEVRON_CYAN = (0, 229, 255)
CHEVRON_BLUE = (80, 160, 255)
DOT_COLORS = [(0, 229, 255), (100, 180, 255), (180, 130, 255)]


def lerp(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def draw_squircle(draw, size, margin, radius):
    """Draw a smooth rounded rectangle (squircle approximation)."""
    r = int(radius)
    draw.rounded_rectangle([margin, margin, size - margin, size - margin],
                           radius=r, fill=(30, 30, 55))


def draw_gradient_bg(img, size):
    """Vertical gradient background."""
    margin = int(size * 0.04)
    r = int(size * 0.22)
    pixels = img.load()
    for y in range(size):
        t = y / size
        color = lerp(BG_TOP, BG_BOT, t * 0.8)
        for x in range(size):
            # Check if inside squircle
            mx, my = margin + r, margin + r
            inside = True
            # Simple squircle test — check corners
            for qx, qy in [(margin, margin), (size - margin, margin),
                            (margin, size - margin), (size - margin, size - margin)]:
                dx, dy = x - qx, y - qy
                # Rotate 45° to check rounded corner
                # Simplify: just use distance from corner centers
                dist = math.sqrt((x - qx)**2 + (y - qy)**2)
                if (x < qx and qx == margin) or (x > qx and qx == size - margin):
                    pass
            # Actually let's just check pixel distance from squircle
            # For corners, check distance from corner circle centers
            if x < margin + r and y < margin + r:
                if math.sqrt((x - (margin + r))**2 + (y - (margin + r))**2) > r:
                    inside = False
            elif x > size - margin - r and y < margin + r:
                if math.sqrt((x - (size - margin - r))**2 + (y - (margin + r))**2) > r:
                    inside = False
            elif x < margin + r and y > size - margin - r:
                if math.sqrt((x - (margin + r))**2 + (y - (size - margin - r))**2) > r:
                    inside = False
            elif x > size - margin - r and y > size - margin - r:
                if math.sqrt((x - (size - margin - r))**2 + (y - (size - margin - r))**2) > r:
                    inside = False
            elif x < margin or x > size - margin or y < margin or y > size - margin:
                inside = False

            if inside:
                pixels[x, y] = (*color, 255)


def draw_chevron(draw, size):
    """Draw a bold stylized '>' chevron with glow."""
    cx = size * 0.44
    cy = size * 0.50
    length = size * 0.32
    height = size * 0.24
    thick = max(3, int(size * 0.095))

    # Upper arm points
    x1, y1 = cx + length * 0.85, cy - height
    x2, y2 = cx - length * 0.25, cy - thick * 0.3
    x3, y3 = cx - length * 0.15, cy + thick * 0.3
    x4, y4 = cx + length * 0.85, cy - height + thick
    # Lower arm points
    x5, y5 = cx + length * 0.85, cy + height
    x6, y6 = cx - length * 0.15, cy + thick * 0.3
    x7, y7 = cx - length * 0.25, cy - thick * 0.3
    x8, y8 = cx + length * 0.85, cy + height - thick

    # Glow halo (larger, semi-transparent)
    glow_expand = max(2, size * 0.03)
    glow_color = CHEVRON_CYAN + (25,)
    draw.polygon([
        (x1 - glow_expand, y1 - glow_expand),
        (x2 - glow_expand * 0.5, y2 - glow_expand * 0.5),
        (x3 - glow_expand * 0.5, y3 + glow_expand * 0.5),
        (x4 - glow_expand, y4 + glow_expand),
    ], fill=glow_color)
    draw.polygon([
        (x5 - glow_expand, y5 + glow_expand),
        (x6 - glow_expand * 0.5, y6 + glow_expand * 0.5),
        (x7 - glow_expand * 0.5, y7 - glow_expand * 0.5),
        (x8 - glow_expand, y8 - glow_expand),
    ], fill=glow_color)

    # Upper arm — cyan top, gradient to blue
    gradient_steps = max(2, thick // 2)
    for i in range(gradient_steps):
        t = i / gradient_steps
        color = lerp(CHEVRON_CYAN, CHEVRON_BLUE, t)
        alpha = 255 - int(60 * t)
        offset = i * (thick / gradient_steps) * 0.6
        draw.polygon([
            (x1, y1 + offset),
            (x2, y2 + offset * 0.3),
            (x3, y3 + offset * 0.3),
            (x4, y4 + offset),
        ], fill=color + (alpha,))

    # Lower arm — blue
    for i in range(gradient_steps):
        t = 0.3 + i / gradient_steps * 0.7
        color = lerp(CHEVRON_CYAN, CHEVRON_BLUE, t)
        alpha = 240 - int(30 * i / gradient_steps)
        offset = i * (thick / gradient_steps) * 0.6
        draw.polygon([
            (x5, y5 - offset),
            (x6, y6 - offset * 0.3),
            (x7, y7 - offset * 0.3),
            (x8, y8 - offset),
        ], fill=color + (alpha,))


def draw_dots(draw, size):
    """Draw accent dots (AI sparkle)."""
    cx = size * 0.44
    cy = size * 0.50
    length = size * 0.26
    height = size * 0.20
    dot_r = max(1.5, size * 0.022)

    positions = [
        (cx + length * 1.1, cy - height * 0.7),
        (cx + length * 1.3, cy + height * 0.05),
        (cx + length * 1.05, cy + height * 0.75),
    ]
    for (dx, dy), color in zip(positions, DOT_COLORS):
        # Glow halo
        for gr in range(int(dot_r * 3), int(dot_r), -1):
            alpha = int(40 * (1 - (gr - dot_r) / (dot_r * 2)))
            if alpha > 0:
                draw.ellipse([dx - gr, dy - gr, dx + gr, dy + gr],
                            fill=color + (alpha,))
        # Core
        draw.ellipse([dx - dot_r, dy - dot_r, dx + dot_r, dy + dot_r],
                    fill=color + (220,))


def draw_inner_ring(draw, size):
    """Subtle inner border for depth."""
    margin = int(size * 0.04)
    r = int(size * 0.22)
    w = max(1, size // 80)
    draw.rounded_rectangle([margin + w, margin + w, size - margin - w, size - margin - w],
                           radius=r - w,
                           outline=(255, 255, 255, 35), width=w)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # Gradient background
    draw_gradient_bg(img, size)
    draw = ImageDraw.Draw(img)
    # Inner ring
    draw_inner_ring(draw, size)
    # Chevron
    draw_chevron(draw, size)
    # Dots
    draw_dots(draw, size)
    return img


def save_ico(path, images):
    """Save multi-resolution ICO properly."""
    # PIL's ICO save is finicky — save largest as ICO with append_images
    sorted_imgs = sorted(images, key=lambda x: x[0], reverse=True)
    main_size = sorted_imgs[0][0]
    main_img = sorted_imgs[0][1]
    rest = [img for _, img in sorted_imgs[1:]]
    if rest:
        ico_sizes = [(s, s) for s, _ in sorted_imgs]
        # PIL ICO format with sizes expects the main image and append_images
        main_img.save(path, format="ICO", sizes=ico_sizes, append_images=rest)
    else:
        main_img.save(path, format="ICO")


def main():
    os.makedirs(OUT, exist_ok=True)

    # PNG outputs
    targets = [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]
    for name, s in targets:
        img = make_icon(s)
        img.save(os.path.join(OUT, name), "PNG")
        print(f"  {name} ({s}x{s}) — {os.path.getsize(os.path.join(OUT, name))} bytes")

    # ICO with multiple sizes
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [(s, make_icon(s)) for s in ico_sizes]
    ico_path = os.path.join(OUT, "icon.ico")
    save_ico(ico_path, images)
    print(f"  icon.ico ({'×'.join(str(s) for s in ico_sizes)}) — {os.path.getsize(ico_path)} bytes")

    print(f"\nSaved to {OUT}")


if __name__ == "__main__":
    main()
