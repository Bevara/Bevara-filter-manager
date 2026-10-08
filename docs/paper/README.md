# Paper material

- `registry-section.tex` — a self-contained section ("Supplying Accessors through a
  Capability-Indexed, Verifiable Registry") written for an ACM `sigconf` paper
  (The Web Conference 2027). It assumes `booktabs`, `listings` and `hyperref`, and
  refers to labels of the MMSys manuscript (`sec:ondemand`, `sec:resolution`,
  `sec:performance`, `sec:setup`, `tab:eager`) — rename them to match your paper.
- `registry-section.bib` — the references it cites.

Reproduce the numbers (Tables 1 and 2 of the section) with:

```bash
node scripts/bench.js --wasm-dir ../Showcase/accessors --json-dir ../filters \
  --only theora,vorbis,ogg,isobmff,liba52,libjxl,libOpenVVC,ffmpeg-hevc,avif,libpng,libjpeg,openjpeg,rfpcm,ffmpeg-flac
```
