# Restore the pre-Mart landing page

The complete previous landing page is preserved in `index-before-marts.html`. All its original media and `support.js` remain in place. Open `/index-before-marts.html` to preview it.

To restore the old landing page:

```sh
cp index-before-marts.html index.html
git add index.html
git commit -m "Restore pre-Mart landing page"
git push origin main
```

GitHub Pages deploys pushes to main. This changes only the landing page; the new assets can remain for a later switch back. The pre-update tracked baseline was commit `7e59745`.

## Before the website-specific video cuts and Mart animation

The first Mart landing page is preserved by Git tag `landing-before-web-cuts-2026-10-23` (commit `65f7ac8`). Restore only its page with:

```sh
git restore --source landing-before-web-cuts-2026-10-23 -- index.html
git add index.html
git commit -m "Restore first Mart landing page"
git push origin main
```

Its original media remain in place. The original supplied demo is unchanged at `assets/marts/demo.mp4`. The four website-specific videos can be regenerated with `python3 scripts/render-web-clips.py` (requires ffmpeg); each has a poster for loading and paused playback.

## Before the clarity, layout, and performance review

The previous scroll-based landing page is preserved at tag `landing-before-review-2026-10-23` (commit `94f62d8`). Its media and `support.js` remain in place. To restore:

```sh
git restore --source landing-before-review-2026-10-23 -- index.html assets/marts/tv-demo.mp4 assets/marts/tv-demo-poster.jpg assets/marts/create-loop.mp4 assets/marts/create-loop-poster.jpg scripts/render-web-clips.py
git add index.html assets/marts/tv-demo.mp4 assets/marts/tv-demo-poster.jpg assets/marts/create-loop.mp4 assets/marts/create-loop-poster.jpg scripts/render-web-clips.py
git commit -m "Restore landing page before clarity review"
git push origin main
```

Additional files from the review can remain; the restored page does not reference them.

## Before the three-beat version — October 25, 2026

The complete preceding landing page is preserved at tag `landing-before-three-beats-2026-10-25` (commit `e05aacd`). To restore the previous page and its controller:

```sh
git restore --source landing-before-three-beats-2026-10-25 -- index.html landing.js
git add index.html landing.js
git commit -m "Restore landing page before three-beat revision"
git push origin main
```

This revision changes only the landing-page content, layout, and playback controller. The original fashion reel, edited product demos, signup endpoint, and earlier rollback points remain available.

## Before the portrait demo — October 25, 2026

The three-beat page with the horizontal product player is preserved at tag `landing-before-portrait-demo-2026-10-25` (commit `ec18ea6`). To restore it:

```sh
git restore --source landing-before-portrait-demo-2026-10-25 -- index.html landing.js
git add index.html landing.js
git commit -m "Restore horizontal product demo"
git push origin main
```

The portrait version plays the original, unedited `eura_demo.mp4` supplied in Documents/eura_mockups. The identical website copy is `assets/marts/demo.mp4`.

## Before responsive opening and unframed demo — October 25, 2026

Restore the preceding page (commit `13f605f`) with:

```sh
git restore --source 13f605f -- index.html
git add index.html
git commit -m "Restore landing page before responsive refinement"
git push origin main
```

The original demo file is unchanged.

## Before larger TV and simplified waitlist

Restore `index.html` from commit `782108d` to undo this revision:

```sh
git restore --source 782108d -- index.html
git add index.html
git commit -m "Restore previous TV size and waitlist copy"
git push origin main
```

## Before demo-only second beat

Restore the prior copy and demo size with `git restore --source d5f1efd -- index.html`, then commit and push `index.html`.

## Before the “Less for you, more by you” opening

Restore `index.html` from commit `d2ebb7c` to return to the previous slogan and description, then commit and push that file.

## Before the October 26 demo replacement

Restore the previous video, poster, and page with `git restore --source 9a38089 -- assets/marts/demo.mp4 assets/marts/original-demo-poster.jpg index.html`, then commit those files and push.

## Before the revised caption-layout demo

Restore the previous demo with `git restore --source 665f12f -- assets/marts/demo.mp4 assets/marts/original-demo-poster.jpg index.html`, then commit those files and push.

## Before the background-matched demo

Restore the previous video and presentation with `git restore --source df34538 -- assets/marts/demo.mp4 assets/marts/original-demo-poster.jpg index.html`, then commit those files and push.

## Before demo revision 53a54475

Restore the previous demo with `git restore --source dc9a440 -- assets/marts/demo.mp4 assets/marts/original-demo-poster.jpg index.html`, then commit those files and push.

## Before restored TV cursor effects

Restore `index.html` and `landing.js` from commit `8e16830` to undo the cursor-effect restoration and replay-button removal.

## Before restored TV power animation

Restore `index.html` and `landing.js` from commit `3eba10f` to undo this power-animation revision.
