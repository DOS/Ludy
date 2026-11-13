<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Chrome Web Store images

These are the images for the Ludy extension's Chrome Web Store listing (item `emfhpcbmdbbeomfkdadbellllngmlhmf`). The owner uploads them from the developer dashboard. The listing texts, the privacy answers and the steps are in [the extension store runbook](../../../docs/runbooks/extension-store.md).

| File | Store field | Size |
|---|---|---|
| `vi-1-screenshot-1280x800.jpg`, `vi-2-…`, `vi-3-…` | Screenshots, Vietnamese listing | 1280 x 800 |
| `en-1-screenshot-1280x800.jpg`, `en-2-…`, `en-3-…` | Screenshots, English listing | 1280 x 800 |
| `vi-small-tile-440x280.jpg`, `en-small-tile-440x280.jpg` | Small promo tile | 440 x 280 |
| `vi-marquee-1400x560.jpg`, `en-marquee-1400x560.jpg` | Marquee promo tile | 1400 x 560 |
| `../icons/icon-128.png` | Store icon | 128 x 128 |

Other brand files that can be useful for the listing:
- `apps/web/public/brand/ludy-icon-512.png`, a 512 x 512 icon.
- `apps/web/public/brand/ludy-mark.svg`, the vector mark.

All images are JPEG with no alpha channel, because the store refuses transparency.

- Screenshots 1 and 2 are the real popup. The script loads it unpacked in Chromium against the e2e fake Ludy, so it holds no customer data. The fake server's local address is shown as `https://app.ludy.vn`, the address a Ludy Cloud member sees.
- Screenshot 3, the consent step, is text only. The consent form needs the `tabCapture` permission, which automation cannot grant.

## Regenerate

Regenerate the images after the popup changes, then upload the new set:

```
pnpm install --frozen-lockfile --filter "@crove/extension..."
cd apps/extension
node scripts/build.mjs
node scripts/store-art.mjs
```

The script writes into this folder. Where Playwright's bundled browser is not installed, set `CHROMIUM_PATH` to a Chromium binary, as the e2e tests do. Change the headlines and bullets in `scripts/store-art.mjs`, and keep them true to what the extension does.
