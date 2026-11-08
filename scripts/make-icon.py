#!/usr/bin/env python3
"""Generate the Periscope macOS app icon (build/icon.png, 1024x1024 RGBA)."""

from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter


S = 4  # 4x supersampling factor (4096x4096 working canvas)
FINAL_SIZE = 1024
CANVAS = FINAL_SIZE * S


def hex_rgba(hex_str: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_str.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_color(
    c1: tuple[int, int, int, int],
    c2: tuple[int, int, int, int],
    t: float,
) -> tuple[int, int, int, int]:
    t = max(0.0, min(1.0, t))
    return (
        int(round(lerp(c1[0], c2[0], t))),
        int(round(lerp(c1[1], c2[1], t))),
        int(round(lerp(c1[2], c2[2], t))),
        int(round(lerp(c1[3], c2[3], t))),
    )


def macos_squircle_polygon(
    cx: float,
    cy: float,
    half_size: float,
    radius: float,
    steps_per_corner: int = 120,
) -> list[tuple[float, float]]:
    """Generate a macOS Big Sur+ continuous-corner squircle polygon.

    Combines straight side segments with continuous-curvature superellipse
    corners of radius `radius` (185px at 824x824) so the sides stay crisp
    while the corner transition has zero curvature jump.
    """
    # Corner superellipse span is slightly wider than circular radius for G2 continuity
    span = radius * 1.18
    inner = half_size - span
    n = 2.65  # Superellipse exponent for the corner quadrant

    pts: list[tuple[float, float]] = []
    quadrants = [
        (1.0, -1.0, 0.0, math.pi / 2.0),     # top-right (in screen coords: +x, -y)
        (1.0, 1.0, 0.0, math.pi / 2.0),      # bottom-right (+x, +y)
        (-1.0, 1.0, 0.0, math.pi / 2.0),     # bottom-left (-x, +y)
        (-1.0, -1.0, 0.0, math.pi / 2.0),    # top-left (-x, -y)
    ]

    for q_idx, (sx, sy, _, _) in enumerate(quadrants):
        for i in range(steps_per_corner + 1):
            u = i / steps_per_corner
            # Order the angle so perimeter walks clockwise:
            # TR: top -> right; BR: right -> bottom; BL: bottom -> left; TL: left -> top
            if q_idx in (0, 2):
                theta = u * (math.pi / 2.0)
                dx = inner + span * (math.sin(theta) ** (2.0 / n))
                dy = inner + span * (math.cos(theta) ** (2.0 / n))
            else:
                theta = u * (math.pi / 2.0)
                dx = inner + span * (math.cos(theta) ** (2.0 / n))
                dy = inner + span * (math.sin(theta) ** (2.0 / n))
            pts.append((cx + sx * dx, cy + sy * dy))
    return pts


def make_vertical_gradient(
    width: int,
    height: int,
    stops: list[tuple[float, tuple[int, int, int, int]]],
) -> Image.Image:
    """Create a vertical gradient RGBA image of size (width, height)."""
    strip = Image.new("RGBA", (1, height))
    px = strip.load()
    for y in range(height):
        t = y / max(1, height - 1)
        color = stops[-1][1]
        for idx in range(len(stops) - 1):
            t0, c0 = stops[idx]
            t1, c1 = stops[idx + 1]
            if t <= t1:
                local_t = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
                local_t = local_t * local_t * (3.0 - 2.0 * local_t)
                color = lerp_color(c0, c1, local_t)
                break
        px[0, y] = color
    return strip.resize((width, height), resample=Image.Resampling.NEAREST)


def add_radial_glow(
    base: Image.Image,
    center: tuple[float, float],
    radius: float,
    inner_color: tuple[int, int, int, int],
) -> None:
    """Composite a smooth radial glow centered at `center` onto `base`."""
    scale = 4
    gw = base.width // scale
    gh = base.height // scale
    cx, cy = center[0] / scale, center[1] / scale
    r = radius / scale

    glow = Image.new("RGBA", (gw, gh), (0, 0, 0, 0))
    gpx = glow.load()

    x0 = max(0, int(cx - r))
    x1 = min(gw, int(cx + r) + 1)
    y0 = max(0, int(cy - r))
    y1 = min(gh, int(cy + r) + 1)

    r_sq = r * r
    ir, ig, ib, ia = inner_color
    for y in range(y0, y1):
        dy = y - cy
        dy_sq = dy * dy
        for x in range(x0, x1):
            dx = x - cx
            d_sq = dx * dx + dy_sq
            if d_sq < r_sq:
                u = 1.0 - math.sqrt(d_sq) / r
                alpha = int(ia * (u * u * (3.0 - 2.0 * u)))
                if alpha > 0:
                    gpx[x, y] = (ir, ig, ib, alpha)

    glow_full = glow.resize(base.size, resample=Image.Resampling.BICUBIC)
    base.alpha_composite(glow_full)


def build_icon() -> Image.Image:
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

    tile_size = 824 * S
    half_tile = tile_size / 2.0
    corner_r = 185 * S
    cx = cy = CANVAS / 2.0

    # 1. Subtle macOS Big Sur+ drop shadow on the transparent margin
    shadow_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    shadow_pts_ambient = macos_squircle_polygon(cx, cy + 14 * S, half_tile, corner_r)
    shadow_draw.polygon(shadow_pts_ambient, fill=hex_rgba("#040814", 110))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=22 * S))

    contact_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    contact_draw = ImageDraw.Draw(contact_layer)
    shadow_pts_contact = macos_squircle_polygon(
        cx, cy + 6 * S, half_tile - 2 * S, corner_r
    )
    contact_draw.polygon(shadow_pts_contact, fill=hex_rgba("#040814", 85))
    contact_layer = contact_layer.filter(ImageFilter.GaussianBlur(radius=8 * S))

    canvas.alpha_composite(shadow_layer)
    canvas.alpha_composite(contact_layer)

    # 2. Squircle mask for the main 824x824 tile
    tile_mask = Image.new("L", (CANVAS, CANVAS), 0)
    mask_draw = ImageDraw.Draw(tile_mask)
    tile_pts = macos_squircle_polygon(cx, cy, half_tile, corner_r)
    mask_draw.polygon(tile_pts, fill=255)

    # 3. Rich oceanic background gradient (luminous teal upper sea to deep midnight abyss)
    tile_bg = make_vertical_gradient(
        CANVAS,
        CANVAS,
        [
            (0.00, hex_rgba("#16697A")),
            (0.32, hex_rgba("#133B5C")),
            (0.68, hex_rgba("#0F1E3E")),
            (1.00, hex_rgba("#090E22")),
        ],
    )

    # Ambient cyan-teal glow behind the lens & transcript stage
    add_radial_glow(
        tile_bg,
        center=(610 * S, 450 * S),
        radius=400 * S,
        inner_color=hex_rgba("#2EC4B6", 115),
    )
    # Subtle warm indigo depth at the bottom-left
    add_radial_glow(
        tile_bg,
        center=(300 * S, 820 * S),
        radius=360 * S,
        inner_color=hex_rgba("#1E1B4B", 120),
    )

    # Subtle sonar range arcs centered on the periscope lens
    lens_cx, lens_cy = 486 * S, 356 * S
    arcs_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    arcs_draw = ImageDraw.Draw(arcs_layer)
    for r_arc, alpha in ((190 * S, 36), (285 * S, 26), (380 * S, 16)):
        bbox = (
            lens_cx - r_arc,
            lens_cy - r_arc,
            lens_cx + r_arc,
            lens_cy + r_arc,
        )
        arcs_draw.arc(
            bbox,
            start=-38,
            end=58,
            fill=hex_rgba("#7CE8FF", alpha),
            width=3 * S,
        )
    tile_bg.alpha_composite(arcs_layer)

    # 4. Luminous beam projecting from the periscope lens toward the transcript lines
    beam_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    beam_draw = ImageDraw.Draw(beam_layer)
    beam_poly = [
        (lens_cx + 10 * S, lens_cy - 56 * S),
        (865 * S, 220 * S),
        (865 * S, 690 * S),
        (lens_cx + 10 * S, lens_cy + 56 * S),
    ]
    beam_draw.polygon(beam_poly, fill=hex_rgba("#38BDF8", 48))
    beam_layer = beam_layer.filter(ImageFilter.GaussianBlur(radius=18 * S))

    beam_fade = make_vertical_gradient(
        CANVAS,
        CANVAS,
        [
            (0.0, (255, 255, 255, 255)),
            (0.45, (255, 255, 255, 230)),
            (0.88, (255, 255, 255, 55)),
            (1.0, (255, 255, 255, 0)),
        ],
    ).rotate(90, expand=False)
    beam_layer.putalpha(
        ImageChops.multiply(beam_layer.getchannel("A"), beam_fade.getchannel("A"))
    )
    tile_bg.alpha_composite(beam_layer)

    # 5. Bold stacked transcript bars on the right (reads cleanly at 16x16)
    bars_shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    bars_sdraw = ImageDraw.Draw(bars_shadow)
    bars_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    bars_draw = ImageDraw.Draw(bars_layer)
    bars_sheen = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    sheen_draw = ImageDraw.Draw(bars_sheen)

    bar_h = 48 * S
    bar_r = 24 * S
    transcript_rows = [
        # (x0, y0, x1, color_hex)
        (564 * S, 282 * S, 822 * S, "#F0F9FF"),
        (564 * S, 376 * S, 766 * S, "#5EEAD4"),
        (564 * S, 470 * S, 834 * S, "#FF9F68"),
        (564 * S, 564 * S, 730 * S, "#BAE6FD"),
    ]
    for x0, y0, x1, col in transcript_rows:
        y1 = y0 + bar_h
        bars_sdraw.rounded_rectangle(
            (x0, y0 + 8 * S, x1, y1 + 8 * S),
            radius=bar_r,
            fill=hex_rgba("#040A18", 125),
        )
        bars_draw.rounded_rectangle(
            (x0, y0, x1, y1),
            radius=bar_r,
            fill=hex_rgba(col, 255),
        )
        # Subtle white specular highlight on the top half of each bar (composited properly)
        sheen_draw.rounded_rectangle(
            (x0 + 10 * S, y0 + 5 * S, x1 - 10 * S, y0 + 16 * S),
            radius=5 * S,
            fill=hex_rgba("#FFFFFF", 95),
        )

    bars_shadow = bars_shadow.filter(ImageFilter.GaussianBlur(radius=10 * S))
    bars_layer.alpha_composite(bars_sheen)
    tile_bg.alpha_composite(bars_shadow)
    tile_bg.alpha_composite(bars_layer)

    # 6. Bold Periscope Glyph (left/center-left)
    peri_mask = Image.new("L", (CANVAS, CANVAS), 0)
    pm_draw = ImageDraw.Draw(peri_mask)

    tube_w = 130 * S
    shaft_cx = 304 * S
    bend_cy = 356 * S
    shaft_bottom = 846 * S
    head_right = 462 * S

    # Vertical shaft from bottom up to the elbow
    pm_draw.rounded_rectangle(
        (
            shaft_cx - tube_w // 2,
            bend_cy - tube_w // 2,
            shaft_cx + tube_w // 2,
            shaft_bottom,
        ),
        radius=tube_w // 2,
        fill=255,
    )
    # Horizontal scope head
    pm_draw.rounded_rectangle(
        (
            shaft_cx - tube_w // 2,
            bend_cy - tube_w // 2,
            head_right,
            bend_cy + tube_w // 2,
        ),
        radius=tube_w // 2,
        fill=255,
    )
    # Flared optical bezel housing at the front of the head
    bezel_x0 = 414 * S
    bezel_x1 = 486 * S
    bezel_half_h = 86 * S
    pm_draw.rounded_rectangle(
        (
            bezel_x0,
            bend_cy - bezel_half_h,
            bezel_x1,
            bend_cy + bezel_half_h,
        ),
        radius=28 * S,
        fill=255,
    )

    # Drop shadow under the periscope body
    peri_shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ps_fill = Image.new("RGBA", (CANVAS, CANVAS), hex_rgba("#030712", 160))
    shifted_mask = ImageChops.offset(peri_mask, 10 * S, 16 * S)
    peri_shadow.paste(ps_fill, (0, 0), shifted_mask)
    peri_shadow = peri_shadow.filter(ImageFilter.GaussianBlur(radius=16 * S))
    tile_bg.alpha_composite(peri_shadow)

    # Metallic blue-silver gradient for the periscope body
    peri_grad = make_vertical_gradient(
        CANVAS,
        CANVAS,
        [
            (0.00, hex_rgba("#F8FAFC")),
            (0.28, hex_rgba("#E2EEFF")),
            (0.55, hex_rgba("#B8D0F0")),
            (0.85, hex_rgba("#7FA2D4")),
            (1.00, hex_rgba("#5273A8")),
        ],
    )
    peri_body = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    peri_body.paste(peri_grad, (0, 0), peri_mask)

    # Structural collar rings on the shaft + warm coral-amber beacon band
    collar_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    c_draw = ImageDraw.Draw(collar_layer)
    c_draw.rectangle(
        (
            shaft_cx - tube_w // 2,
            552 * S,
            shaft_cx + tube_w // 2,
            596 * S,
        ),
        fill=hex_rgba("#FF6B4A", 245),
    )
    c_draw.rectangle(
        (
            shaft_cx - tube_w // 2,
            544 * S,
            shaft_cx + tube_w // 2,
            552 * S,
        ),
        fill=hex_rgba("#1E355E", 175),
    )
    c_draw.rectangle(
        (
            shaft_cx - tube_w // 2,
            596 * S,
            shaft_cx + tube_w // 2,
            604 * S,
        ),
        fill=hex_rgba("#1E355E", 175),
    )
    # Dark optical neck seam right behind the bezel
    c_draw.rectangle(
        (
            398 * S,
            bend_cy - tube_w // 2,
            414 * S,
            bend_cy + tube_w // 2,
        ),
        fill=hex_rgba("#1E355E", 195),
    )
    collar_clipped = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    collar_clipped.paste(collar_layer, (0, 0), peri_mask)
    peri_body.alpha_composite(collar_clipped)

    # Crisp top-left rim highlight on the periscope tube for depth
    rim_inner = ImageChops.offset(peri_mask, 4 * S, 6 * S)
    rim_mask = ImageChops.subtract(peri_mask, rim_inner)
    rim_layer = Image.new("RGBA", (CANVAS, CANVAS), hex_rgba("#FFFFFF", 150))
    peri_rim = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    peri_rim.paste(rim_layer, (0, 0), rim_mask)
    peri_body.alpha_composite(peri_rim)

    tile_bg.alpha_composite(peri_body)

    # 7. Glowing Optical Lens (on the front of the periscope bezel)
    # Use separate composited layers so semi-transparent highlights blend cleanly
    add_radial_glow(
        tile_bg,
        center=(lens_cx + 8 * S, lens_cy),
        radius=120 * S,
        inner_color=hex_rgba("#00F5D4", 145),
    )

    lens_base = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    lb_draw = ImageDraw.Draw(lens_base)

    # Outer dark naval rim around the lens
    rx_outer, ry_outer = 45 * S, 78 * S
    lb_draw.ellipse(
        (
            lens_cx - rx_outer,
            lens_cy - ry_outer,
            lens_cx + rx_outer,
            lens_cy + ry_outer,
        ),
        fill=hex_rgba("#0F2342", 255),
    )

    # Glowing cyan glass core
    rx_glass, ry_glass = 33 * S, 64 * S
    lb_draw.ellipse(
        (
            lens_cx - rx_glass,
            lens_cy - ry_glass,
            lens_cx + rx_glass,
            lens_cy + ry_glass,
        ),
        fill=hex_rgba("#00F5D4", 255),
    )

    # Inner deeper cyan optical depth ellipse
    lb_draw.ellipse(
        (
            lens_cx - 20 * S,
            lens_cy - 42 * S,
            lens_cx + 25 * S,
            lens_cy + 48 * S,
        ),
        fill=hex_rgba("#06B6D4", 255),
    )

    # Bright cyan-white core hot-spot
    lb_draw.ellipse(
        (
            lens_cx - 12 * S,
            lens_cy - 36 * S,
            lens_cx + 12 * S,
            lens_cy + 10 * S,
        ),
        fill=hex_rgba("#A5F3FC", 255),
    )

    # Crisp white top-left lens specular reflection dot
    lb_draw.ellipse(
        (
            lens_cx - 15 * S,
            lens_cy - 48 * S,
            lens_cx + 4 * S,
            lens_cy - 22 * S,
        ),
        fill=hex_rgba("#FFFFFF", 255),
    )

    tile_bg.alpha_composite(lens_base)

    # 8. Subtle top-edge inner glass highlight and bottom inner shadow on the squircle tile
    eroded_top = ImageChops.offset(tile_mask, 0, 3 * S)
    top_border_mask = ImageChops.subtract(tile_mask, eroded_top)
    top_border_fade = make_vertical_gradient(
        CANVAS,
        CANVAS,
        [
            (0.00, hex_rgba("#A5F3FC", 160)),
            (0.25, hex_rgba("#A5F3FC", 45)),
            (1.00, hex_rgba("#A5F3FC", 0)),
        ],
    )
    top_highlight = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    top_highlight.paste(top_border_fade, (0, 0), top_border_mask)
    tile_bg.alpha_composite(top_highlight)

    eroded_bottom = ImageChops.offset(tile_mask, 0, -3 * S)
    bottom_border_mask = ImageChops.subtract(tile_mask, eroded_bottom)
    bottom_shade = Image.new("RGBA", (CANVAS, CANVAS), hex_rgba("#020617", 120))
    bottom_edge = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    bottom_edge.paste(bottom_shade, (0, 0), bottom_border_mask)
    tile_bg.alpha_composite(bottom_edge)

    # Apply the squircle mask to the tile content and composite over the shadowed canvas
    clipped_tile = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    clipped_tile.paste(tile_bg, (0, 0), tile_mask)
    canvas.alpha_composite(clipped_tile)

    # Downsample 4096 -> 1024 with LANCZOS for crisp anti-aliased edges
    return canvas.resize((FINAL_SIZE, FINAL_SIZE), resample=Image.Resampling.LANCZOS)


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    out_dir = repo_root / "build"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "icon.png"

    icon = build_icon()
    icon.save(out_path, format="PNG", optimize=True)
    print(f"Saved {out_path} ({icon.width}x{icon.height} {icon.mode})")


if __name__ == "__main__":
    main()
