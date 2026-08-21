# Spike fixtures

Test photographs for the Phase 3.5 segmentation spike and later pipeline work.
Not product assets — these exist so `scripts/spike-segment.ts` and the analyze
pipeline can be exercised against real photographs rather than synthetic
gradients, which cannot answer whether a segmenter resolves "the countertop".

| file | source | why this one |
|---|---|---|
| `kitchen-real.jpg` | Pexels photo 1080721 (Pexels licence, free to use) | A real photograph containing all seven target surfaces: tile floor, painted wall, ceiling with crown moulding, white quartz countertop, grey subway backsplash, many white cabinet doors, windows. Bar stools and dining chairs occlude the floor, which is the Phase 6f occlusion case. |
| `kitchen-cgi.jpg` | Unsplash photo 1600489000022 (Unsplash licence, free to use) | Backup / contrast case. Same surface coverage plus a rug, but it is a CGI render — cleaner planes and simpler lighting than any real upload, so it is the easy case, not the representative one. |

Kept out of `storage/` deliberately: `storage/` is generated output that can be
wiped and regenerated, while these are inputs that would have to be re-downloaded.
