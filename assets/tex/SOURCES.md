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

## How they were made

From the 1K JPG downloads, with ImageMagick and cwebp (lossy WebP, `-q` 62–80,
`-m 6 -sharp_yuv`); the 512 px files are Lanczos reductions of the 1024 px ones.

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
