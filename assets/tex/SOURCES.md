# Texture sources

Photo-scanned textures for furniture and the less common finishes. Every one is
CC0 (public domain): no attribution needed, listed here so they can be traced and
remade. `1024/` holds the high-quality set and `512/` the light one that phones
load (src/textures.js). The finishes from the example's photos (plank floor,
rift oak, quartz, subway and porcelain tile) are drawn in code in
src/materials.js instead.

| Files | Source | License |
| --- | --- | --- |
| `walnut-color`, `walnut-height` | Poly Haven, [Walnut Veneer](https://polyhaven.com/a/walnut_veneer) (Jenelle van Heerden), 1.8 m square | CC0 |
| `fabric-tone` | ambientCG, [Fabric030](https://ambientcg.com/view?id=Fabric030) | CC0 |
| `linen-tone` | ambientCG, [Fabric036](https://ambientcg.com/view?id=Fabric036) | CC0 |
| `rug-tone` | ambientCG, [Carpet014](https://ambientcg.com/view?id=Carpet014) | CC0 |
| `carpet-height` | ambientCG, [Carpet016](https://ambientcg.com/view?id=Carpet016), 1.7 m square | CC0 |
| `leather-height`, `leather-rough` | ambientCG, [Leather029](https://ambientcg.com/view?id=Leather029) | CC0 |
| `marble-color` | ambientCG, [Marble005](https://ambientcg.com/view?id=Marble005) | CC0 |
| `concrete-color`, `concrete-height` | ambientCG, [Concrete016](https://ambientcg.com/view?id=Concrete016) | CC0 |
| `velvet-tone`, `velvet-rough` | Poly Haven, [Velour Velvet](https://polyhaven.com/a/velour_velvet) (colormass, Rico Cilliers), 0.284 × 0.274 m | CC0 |
| `boucle-tone` | Poly Haven, [Wool Boucle](https://polyhaven.com/a/wool_boucle) (colormass, Rico Cilliers), 0.315 × 0.390 m | CC0 |
| `rattan-color`, `rattan-height` | ambientCG, [Wicker010A](https://ambientcg.com/view?id=Wicker010A), about 0.26 m square (no size given: 48 strands of about 5 mm) | CC0 |
| `jute-tone` | Poly Haven, [Hessian 230](https://polyhaven.com/a/hessian_230) (colormass, Rico Cilliers), 0.269 × 0.267 m | CC0 |
| `travertine-color`, `travertine-height` | ambientCG, [Travertine005](https://ambientcg.com/view?id=Travertine005), 1.2 m square | CC0 |
| `slate-color`, `slate-height` | ambientCG, [Rock015](https://ambientcg.com/view?id=Rock015), about 1 m square (no size given) | CC0 |
| `granite-color` | ambientCG, [Granite002A](https://ambientcg.com/view?id=Granite002A), about 0.5 m square (no size given: grains of 2–5 mm) | CC0 |
| `terrazzo-color` | ambientCG, [Terrazzo009](https://ambientcg.com/view?id=Terrazzo009), about 0.6 m square (no size given: chips up to 3.5 cm) | CC0 |
| `ash-color`, `ash-height` | Poly Haven, [Ash Veneer](https://polyhaven.com/a/ash_veneer) (Jenelle van Heerden), 1 m square | CC0 |
| `herringbone-color`, `herringbone-height` | Poly Haven, [Herringbone Parquet](https://polyhaven.com/a/herringbone_parquet) (Sergej Majboroda, Jenelle van Heerden), 3.4 m square | CC0 |
| `hex-color`, `hex-height` | ambientCG, [Tiles071](https://ambientcg.com/view?id=Tiles071), 0.45 m square | CC0 |
| `zellige-color`, `zellige-height` | ambientCG, [Tiles020](https://ambientcg.com/view?id=Tiles020), 16 × 16 tiles (no size given: 1.6 m at 10 cm zellige) | CC0 |

## How they were made

From the 1K JPG downloads, with ImageMagick and cwebp (lossy WebP, `-q` 62–80,
`-m 6 -sharp_yuv`); the 512 px files are Lanczos reductions of the 1024 px ones.
Scans that aren't square (velvet, bouclé, jute) are squeezed to 1024 px square,
so set their repeat to the size above, which isn't square either.

- **`-tone`**: the color map's luminance with its coarse blotches removed
  (subtract a 40–140 px blur, wrapping at the edges), so they don't repeat
  across a surface; then spread around a mean of 0.8. The material's color
  tints it (src/materials.js `TONE`). These double as height pictures.
- **`-height`**: the displacement map, coarse detail removed the same way (a
  24–40 px blur), stretched to full range and softened by half a pixel. Normal
  maps (and the walnut and concrete roughness) are worked out from these in
  the browser.
- **`-rough`**: the roughness map, stretched and mapped to 0.6–1.0; it
  multiplies the material's roughness.
- **Walnut** is turned 90° so the grain runs along u (across a table, along a
  drawer front) and darkened to an oiled walnut (linear R×0.5, G×0.46, B×0.45,
  then a little more contrast).
- **Concrete** is lightened to a warm pale gray (linear R×1.8, G×1.58, B×1.35)
  and its clouding halved, toward the sealed slab the code drew before.
- **Bouclé**'s tone comes from the scan's height, which has the loops alone: its
  color is a houndstooth check.
- **Travertine** is lifted from the scan's dark brown to a warm beige (each
  channel moved to a mean of sRGB 0.80, 0.72, 0.60, its spread around the mean
  ×1.5). Its height is the flat honed face with the pits sunk into it.
- **Ash** is lightened to a pale natural ash (linear R×1.45, G×1.58, B×1.42);
  its grain already runs along u. The height is from Poly Haven's 16-bit PNG
  displacement, as the JPG one has only 13 gray levels.
- **Zellige** is turned from the scan's pool turquoise to a soft green
  (`-modulate 118,45,80`: lightness ×1.18, saturation ×0.45, hue −36°). Its
  height keeps each tile's own tilt, as handmade tiles sit.
- **Herringbone, slate, granite and rattan** have their clouding halved (a
  60–80 px blur's departure from each channel's mean), so the darker patches
  don't repeat across a floor.
