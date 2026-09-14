#!/usr/bin/env python3

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont


WIDTH = 1920
HEIGHT = 1080
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "sources" / "overlays"
OUT.mkdir(parents=True, exist_ok=True)

REGULAR = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def font(size: int, bold: bool = False):
    return ImageFont.truetype(BOLD if bold else REGULAR, size=size)


def wrap(draw: ImageDraw.ImageDraw, text: str, text_font, max_width: int):
    lines = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if draw.textbbox((0, 0), candidate, font=text_font)[2] <= max_width:
                current = candidate
            else:
                if current:
                    lines.append(current)
                current = word
        if current:
            lines.append(current)
    return lines


def make_background():
    image = Image.new("RGB", (WIDTH, HEIGHT))
    pixels = image.load()
    top = (8, 25, 42)
    bottom = (3, 11, 21)
    for y in range(HEIGHT):
        amount = y / max(1, HEIGHT - 1)
        color = tuple(round(top[i] * (1 - amount) + bottom[i] * amount) for i in range(3))
        for x in range(WIDTH):
            pixels[x, y] = color

    glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((-180, -250, 780, 710), fill=(34, 211, 238, 55))
    glow_draw.ellipse((1250, 80, 2130, 960), fill=(59, 130, 246, 45))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    image = Image.alpha_composite(image.convert("RGBA"), glow)

    grid = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    for x in range(0, WIDTH, 48):
        grid_draw.line((x, 0, x, HEIGHT), fill=(148, 218, 255, 10), width=1)
    for y in range(0, HEIGHT, 48):
        grid_draw.line((0, y, WIDTH, y), fill=(148, 218, 255, 10), width=1)
    image = Image.alpha_composite(image, grid)
    image.save(OUT / "background.png")


def badge(draw, x, y, text, fill, outline):
    badge_font = font(16, bold=True)
    box = draw.textbbox((0, 0), text, font=badge_font)
    width = box[2] - box[0] + 28
    draw.rounded_rectangle((x, y, x + width, y + 34), radius=17, fill=fill, outline=outline, width=1)
    draw.text((x + 14, y + 8), text, font=badge_font, fill=(225, 249, 255, 255))
    return x + width + 10


PANELS = [
    {
        "file": "panel-01.png",
        "number": "01",
        "section": "DASHBOARD",
        "headline": "Live weather\nat a glance",
        "detail": "Your everyday weather summary starts on the main Dashboard.",
        "caption": "HomeBrain brings your local forecast and live environmental sensors together in one place.",
    },
    {
        "file": "panel-02.png",
        "number": "02",
        "section": "CLIMATE CARD",
        "headline": "Today’s\nconditions",
        "detail": "Forecast, indoor air, wind, rainfall, pressure, and today’s outlook.",
        "caption": "On the Dashboard, the Climate card shows current weather, indoor air quality, wind, rainfall, pressure, and today’s outlook.",
    },
    {
        "file": "panel-03.png",
        "number": "03",
        "section": "OPEN WEATHER",
        "headline": "Weather\nCommand Deck",
        "detail": "Select the cloud-and-sun icon in the side menu.",
        "caption": "Select Weather in the side menu to open the Weather Command Deck.",
    },
    {
        "file": "panel-04.png",
        "number": "04",
        "section": "FUSED SOURCES",
        "headline": "Forecast plus\nlive sensors",
        "detail": "Saved-location forecast, Tempest station telemetry, and indoor-air readings.",
        "caption": "The deck combines your saved-location forecast with live Tempest station readings and indoor air data.",
    },
    {
        "file": "panel-05.png",
        "number": "05",
        "section": "SUMMARY CARDS",
        "headline": "Key readings\nin one view",
        "detail": "Daily outlook, indoor temperature, wind, pressure, rainfall, charts, and history.",
        "caption": "Use the summary cards for the daily outlook, indoor temperature, wind, pressure, and rainfall.",
    },
    {
        "file": "panel-06.png",
        "number": "06",
        "section": "REFRESH",
        "headline": "Request the\nlatest readings",
        "detail": "Refresh asks connected weather and air systems for their newest data.",
        "caption": "Select Refresh whenever you want the latest readings from your connected systems.",
    },
    {
        "file": "panel-07.png",
        "number": "07",
        "section": "COMPLETE",
        "headline": "Weather system\nready",
        "detail": "A single view for forecast context and live environmental telemetry.",
        "caption": "That is the HomeBrain weather system.",
    },
]


def make_panel(config):
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    x0, y0, x1, y1 = 1416, 28, 1896, 1052

    draw.rounded_rectangle((x0, y0, x1, y1), radius=34, fill=(8, 20, 35, 244), outline=(76, 201, 240, 105), width=2)
    draw.rounded_rectangle((x0 + 2, y0 + 2, x0 + 10, y1 - 2), radius=5, fill=(34, 211, 238, 225))

    draw.text((x0 + 38, y0 + 34), "HOMEBRAIN QUICK GUIDE", font=font(16, bold=True), fill=(103, 232, 249, 255))
    draw.text((x0 + 38, y0 + 66), "Weather System", font=font(42, bold=True), fill=(245, 251, 255, 255))

    bx = x0 + 38
    bx = badge(draw, bx, y0 + 126, "LIVE FREESTONE DATA", (8, 95, 112, 190), (45, 212, 191, 170))
    badge(draw, x0 + 38, y0 + 170, "TEMPEST + FORECAST", (23, 67, 110, 200), (96, 165, 250, 150))
    badge(draw, x0 + 38, y0 + 214, "INDOOR AIR", (20, 83, 69, 200), (52, 211, 153, 150))

    draw.line((x0 + 38, y0 + 278, x1 - 38, y0 + 278), fill=(148, 218, 255, 55), width=1)
    draw.text((x0 + 38, y0 + 310), config["number"], font=font(24, bold=True), fill=(34, 211, 238, 255))
    draw.text((x0 + 92, y0 + 314), config["section"], font=font(16, bold=True), fill=(158, 202, 224, 255))

    headline_font = font(39, bold=True)
    headline_lines = config["headline"].split("\n")
    draw.multiline_text((x0 + 38, y0 + 358), "\n".join(headline_lines), font=headline_font, fill=(245, 251, 255, 255), spacing=4)

    detail_font = font(22)
    detail_lines = wrap(draw, config["detail"], detail_font, 390)
    draw.multiline_text((x0 + 38, y0 + 468), "\n".join(detail_lines), font=detail_font, fill=(174, 210, 228, 255), spacing=8)

    caption_top = y0 + 670
    draw.rounded_rectangle((x0 + 26, caption_top, x1 - 26, y1 - 28), radius=24, fill=(18, 40, 62, 245), outline=(97, 193, 226, 70), width=1)
    draw.text((x0 + 50, caption_top + 26), "NARRATION", font=font(15, bold=True), fill=(103, 232, 249, 255))
    caption_font = font(28)
    caption_lines = wrap(draw, config["caption"], caption_font, 376)
    draw.multiline_text((x0 + 50, caption_top + 62), "\n".join(caption_lines), font=caption_font, fill=(240, 248, 252, 255), spacing=10)

    draw.text((x0 + 50, y1 - 55), "Actual signed-in iPad capture", font=font(16), fill=(135, 174, 194, 255))
    image.save(OUT / config["file"])


def make_tap_ring(filename: str, center: tuple[int, int], radius: int):
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    x, y = center
    glow_draw.ellipse((x - radius - 18, y - radius - 18, x + radius + 18, y + radius + 18), fill=(34, 211, 238, 95))
    glow = glow.filter(ImageFilter.GaussianBlur(16))
    image = Image.alpha_composite(image, glow)
    draw = ImageDraw.Draw(image)
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=(240, 253, 255, 245), width=5)
    draw.ellipse((x - radius + 8, y - radius + 8, x + radius - 8, y + radius - 8), outline=(34, 211, 238, 230), width=4)
    image.save(OUT / filename)


if __name__ == "__main__":
    make_background()
    for panel in PANELS:
        make_panel(panel)
    make_tap_ring("tap-weather.png", (72, 151), 30)
    make_tap_ring("tap-refresh.png", (1330, 128), 38)
    print(f"Wrote overlays to {OUT}")
