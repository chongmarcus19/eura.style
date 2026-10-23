# Eura landing-page review — October 23, 2026

The page’s job is to make a new shopper understand the idea, see what it does, and join the early-access list. It cannot establish the quality of the actual finds or prove demand; those need shopper trials.

## Findings and changes

| Criterion | Finding before refinement | Resulting change |
| --- | --- | --- |
| Product and value | “Your own store” had character, but could imply selling. The fashion reel appeared before the actual product, and “Mart” was unexplained. | Product demo appears immediately. Opening copy explicitly says clothes you can buy and defines a Mart as a personal store of finds, with references, budget, refinement, and recurring discovery. |
| Clarity and restraint | Several beats repeated ownership, rules, and new finds. A 500-viewport-height hero and a 330-viewport-height product sequence made a short explanation into a long scroll. | Four sections with distinct jobs: proposition/demo, examples of separate Marts, selectable Create/Refine/Return demonstrations, early-access signup. Removed the repeated slogan beat, repeated arrival labels, pinned-scroll sequences, and unused media machinery. |
| Visual quality | The TV was distinctive. Absolute positioning and resize-driven animations could overlap the first headline and TV. Product cards had vague labels. | Kept the walnut TV, cream/green palette, editorial type, dot grid, physical power control, and replay dial. Used normal responsive layout, concrete example rules, restrained entrances, and readable native-size phone framing. |
| Distinctiveness | The TV established personality, but its strongest first impression was generic fashion footage. | The TV now demonstrates the product from arrival. The visual identity serves the product explanation. Visitors can explore the three-step interaction without scroll choreography. |
| Scaling | Six example images totaled 4,896,916 bytes. React, a template runtime, GSAP, hidden media, animation loops, and viewport calculations supported a mostly static page. | Six compressed copies total 75,414 bytes (98.5% smaller). Static semantic HTML plus a small controller replaces the landing page’s React/template/GSAP dependency chain. Images load lazily; feature clips load on demand; offscreen video pauses. Original assets and the old runtime remain for rollback. |

## Iteration and verification

- Inspected desktop and phone layouts, including a 320 px viewport; corrected mobile description positioning and phone video sizing found during review.
- Recut the start of the TV/creation clips to avoid an inherited transition ghost at the opening.
- Verified keyboard tab navigation and correct selected-panel state, including horizontal tabs on phones and vertical tabs on larger screens.
- Reduced-motion and data-saving preferences suppress automatic playback; explicit play still works. Controls remain keyboard accessible.
- Checked signup success, duplicate-request prevention, existing signup, server failure, and network failure with a local behavior harness. No real signup was sent. The existing endpoint and email-only request format are preserved.
- Signup errors preserve the email, requests time out, and the submit button recovers. There is an email-contact fallback when JavaScript is disabled.
- Verified local assets, JavaScript syntax, and patch formatting.

## Limits and next evidence

This is a qualitative usability and implementation review, not an A/B test or proof of conversion improvement. The frontend changes do not establish backend capacity under traffic, integration reliability, or product-selection quality. The next useful evidence is five unaided first-time explanations followed by real briefs and concierge trials; track completed briefs and repeat engagement as well as email signups.

## Rollback

The state before this review is commit `94f62d8` and tag `landing-before-review-2026-10-23`. See ROLLBACK.md. Original mockups and demo media remain intact.
