# Responsive landing-page checks

## October 27: larger mobile TV experiment

The approved supporting copy now explicitly connects two examples with “you could” and “or.” On portrait screens up to 600 px wide, the TV uses the screen width with 8 px side insets and an 8 px top inset. The height-fit logic remains active for desktop and the two-column landscape layout is retained.

Checked 11 viewport sizes in the in-app browser: 320 × 568, 360 × 640, 375 × 667, 390 × 844, 430 × 932, 600 × 800, 568 × 320, 844 × 390, 601 × 800, 928 × 705, and 1440 × 700. No horizontal page overflow or TV/copy overlap was observed. At 390 × 844 and 430 × 932 the opening signup still fits within the viewport. At shorter portrait sizes and 600 × 800, the taller opening requires normal vertical scrolling, intentionally prioritizing the requested TV size.

The October 26 results below describe the preceding height-fit layout and are preserved as historical verification, rather than claims that the experimental version keeps every signup above the fold.

## October 26: viewport-height fit

Checked October 26, 2026 in the in-app browser using 35 explicit CSS viewport sizes. These are browser viewport checks, not physical-device or cross-browser certification.

## Results

- No horizontal page overflow or TV/copy overlap at any tested size.
- Demo and bottom signup form remain within the page width at every size.
- The first signup fits within the viewport in 34 of 35 cases. At 320 × 480 the first beat is 556 px tall and scrolls normally; readable text and usable controls are preserved instead of clipping the section.
- Short landscape windows use two columns. Portrait phones and normal desktop windows retain the centered vertical composition.
- Tablet closing forms stack below the headline, giving the email input sufficient room.
- Checked mobile demo pause/resume: paused at 11.76 seconds after leaving, resumed at 12.0087 seconds on return.
- Checked desktop scroll shutdown at 21 px scroll: the TV was off with its cabinet still fully in view (top 1 px).

## Viewports

| Width × height | Opening layout | First signup fits |
| --- | --- | --- |
| 320 × 480 | Centered stack | Natural vertical scrolling |
| 320 × 568 | Centered stack | Yes |
| 360 × 640 | Centered stack | Yes |
| 375 × 667 | Centered stack | Yes |
| 390 × 844 | Centered stack | Yes |
| 430 × 932 | Centered stack | Yes |
| 520 × 320 | Two columns | Yes |
| 568 × 320 | Two columns | Yes |
| 600 × 800 | Centered stack | Yes |
| 601 × 800 | Centered stack | Yes |
| 639 × 560 | Two columns | Yes |
| 640 × 560 | Two columns | Yes |
| 667 × 375 | Two columns | Yes |
| 768 × 1024 | Centered stack | Yes |
| 820 × 1180 | Centered stack | Yes |
| 844 × 390 | Two columns | Yes |
| 900 × 501 | Two columns | Yes |
| 900 × 560 | Two columns | Yes |
| 900 × 561 | Centered stack | Yes |
| 901 × 700 | Centered stack | Yes |
| 928 × 705 | Centered stack | Yes |
| 932 × 430 | Two columns | Yes |
| 1024 × 500 | Two columns | Yes |
| 1024 × 600 | Centered stack | Yes |
| 1024 × 768 | Centered stack | Yes |
| 1280 × 600 | Centered stack | Yes |
| 1280 × 720 | Centered stack | Yes |
| 1366 × 650 | Centered stack | Yes |
| 1366 × 768 | Centered stack | Yes |
| 1440 × 700 | Centered stack | Yes |
| 1440 × 900 | Centered stack | Yes |
| 1512 × 840 | Centered stack | Yes |
| 1856 × 705 | Centered stack | Yes |
| 1920 × 1080 | Centered stack | Yes |
| 2560 × 1440 | Centered stack | Yes |
