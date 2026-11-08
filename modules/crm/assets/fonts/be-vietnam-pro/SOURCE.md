# Be Vietnam Pro, for the quote PDF (#2695)

The quote PDF embeds this font so Vietnamese text shows and copies correctly. Nothing is fetched at run time and no npm package is used: the six
files below are committed as they came, and `modules/crm/src/pdf/fonts.ts` reads them from disk.

- **Font:** Be Vietnam Pro, regular (400) and bold (700), by the Be Vietnam Pro Project Authors, https://github.com/bettergui/BeVietnamPro
- **License:** SIL Open Font License 1.1, in `OFL.txt` next to the files. Embedding the font in a document is allowed by the license; the files are not
  modified, renamed or sold on their own.
- **Where the files came from:** the npm package `@fontsource/be-vietnam-pro` 5.3.0 (`files/be-vietnam-pro-<subset>-<weight>-normal.woff`), fetched once
  on 2026-11-08 from https://registry.npmjs.org/@fontsource/be-vietnam-pro/-/be-vietnam-pro-5.3.0.tgz
  (sha256 of the package tarball `f9e048a263d92f46fbf417aeb41e18bc3c22b3d85365f9347b06eebd3fc1f3ac`). Fontsource builds each subset from Google Fonts'
  copy of the font. The repository does not depend on that package.
- **Why WOFF 1 and three subsets:** WOFF 1 is a zlib wrapper around a TrueType font, which Node's `zlib` unwraps without a library (WOFF 2 needs a
  decoder for its glyph transform). The three subsets together hold every Vietnamese letter, the digits, the punctuation a quote uses and the dong sign
  (a test checks this against the characters the document writes).

| File | sha256 |
| --- | --- |
| `be-vietnam-pro-latin-400-normal.woff` | `c0190200223755a3c52bb47b9cf6c3604f19288599cfbbe5026904d5d439f7d7` |
| `be-vietnam-pro-latin-ext-400-normal.woff` | `efff7513dcb30c597007e5d55f8fe5563d0023b276b120b711fad71e0845a9d5` |
| `be-vietnam-pro-vietnamese-400-normal.woff` | `4d50c7991ca377aef28fb1fb24d4ce7ea64d69f6bd2661e7e74fb9d9fef11dc0` |
| `be-vietnam-pro-latin-700-normal.woff` | `f44cc3417bd1fcbddaaec0c02d5383dfcf34a16ef1fc32f8cf179ea4a468861b` |
| `be-vietnam-pro-latin-ext-700-normal.woff` | `f3e8165ac1f16aa7967f7368ebc2b1189acc54abf540312ff97463ed9205af21` |
| `be-vietnam-pro-vietnamese-700-normal.woff` | `4fa311d11645e588ac98d0e665920fd55eb0eb624c600d9e5dd007f4b9d5159c` |

`fonts.ts` checks these hashes when it loads a file, so a changed file is refused rather than embedded.
